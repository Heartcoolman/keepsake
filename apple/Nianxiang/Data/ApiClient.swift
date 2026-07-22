import Foundation

/// Thin client over the server /api/v1 contract. Mirrors the Android ApiClient:
/// single-flight token refresh on 401, one retry per request, SSE v1 envelope streaming.
final class ApiClient: @unchecked Sendable {
    let session: SessionStore
    private let urlSession: URLSession
    private let decoder = JSONCoding.decoder
    private let refreshGate = AsyncSemaphore(value: 1)

    init(session: SessionStore) {
        self.session = session
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        urlSession = URLSession(configuration: config)
    }

    static func newEntryId() -> String { UUID().uuidString.lowercased() }

    // MARK: - Request plumbing

    private func makeRequest(
        path: String,
        method: String = "GET",
        query: [URLQueryItem] = [],
        body: Data? = nil,
        contentType: String? = nil,
        authorized: Bool = true
    ) throws -> URLRequest {
        guard var components = URLComponents(string: session.getBaseUrl() + path) else {
            throw ApiError(status: 0, code: "VALIDATION", message: "服务器地址无效")
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else {
            throw ApiError(status: 0, code: "VALIDATION", message: "服务器地址无效")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if authorized, let token = session.getAccess() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    /// On 401: refresh once (single-flight; a concurrent refresh's new token is reused) and signal retry.
    private func refreshIfNeeded(status: Int) async -> Bool {
        guard status == 401 else { return false }
        let tokenBefore = session.getAccess()
        await refreshGate.wait()
        defer { refreshGate.signal() }
        if let current = session.getAccess(), current != tokenBefore { return true }
        guard let refresh = session.getRefresh() else { return false }
        do {
            let payload = try JSONSerialization.data(withJSONObject: ["refreshToken": refresh])
            var request = try makeRequest(
                path: "/api/v1/auth/refresh", method: "POST",
                body: payload, contentType: "application/json", authorized: false
            )
            request.timeoutInterval = 30
            let (data, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                session.clearSession()
                return false
            }
            let auth = try decoder.decode(AuthResponse.self, from: data)
            session.setSession(access: auth.accessToken, refresh: auth.refreshToken, user: auth.user)
            return true
        } catch {
            return false
        }
    }

    private func send(_ build: @escaping () throws -> URLRequest) async throws -> (Data, HTTPURLResponse) {
        var (data, response) = try await urlSession.data(for: build())
        guard var http = response as? HTTPURLResponse else {
            throw ApiError(status: 0, code: "UNAVAILABLE", message: "无法连接服务器")
        }
        if await refreshIfNeeded(status: http.statusCode) {
            (data, response) = try await urlSession.data(for: build())
            guard let retried = response as? HTTPURLResponse else {
                throw ApiError(status: 0, code: "UNAVAILABLE", message: "无法连接服务器")
            }
            http = retried
        }
        return (data, http)
    }

    private func apiError(data: Data, status: Int) -> ApiError {
        let parsed = try? decoder.decode(ErrorBody.self, from: data).error
        let fallback = String(data: data, encoding: .utf8) ?? HTTPURLResponse.localizedString(forStatusCode: status)
        return ApiError(status: status, code: parsed?.code ?? "", message: parsed?.message ?? fallback)
    }

    private func requestDecoded<T: Decodable>(
        _ type: T.Type,
        path: String,
        method: String = "GET",
        query: [URLQueryItem] = [],
        json: [String: Any]? = nil,
        authorized: Bool = true
    ) async throws -> T {
        let body = try json.map { try JSONSerialization.data(withJSONObject: $0) }
        let (data, http) = try await send { [self] in
            try makeRequest(
                path: path, method: method, query: query,
                body: body, contentType: json != nil ? "application/json" : nil,
                authorized: authorized
            )
        }
        guard (200..<300).contains(http.statusCode) else { throw apiError(data: data, status: http.statusCode) }
        return try decoder.decode(T.self, from: data)
    }

    private func requestBytes(path: String) async throws -> Data {
        let (data, http) = try await send { [self] in try makeRequest(path: path) }
        guard (200..<300).contains(http.statusCode) else { throw apiError(data: data, status: http.statusCode) }
        return data
    }

    // MARK: - Auth

    func health() async throws -> HealthResponse {
        var request = try makeRequest(path: "/api/v1/health", authorized: false)
        request.timeoutInterval = 10
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ApiError(status: 0, code: "UNAVAILABLE", message: "无法连接服务器")
        }
        return try decoder.decode(HealthResponse.self, from: data)
    }

    @discardableResult
    func bootstrap(username: String, password: String, displayName: String) async throws -> AuthResponse {
        var payload: [String: Any] = ["username": username, "password": password]
        if !displayName.isEmpty { payload["displayName"] = displayName }
        let auth = try await requestDecoded(
            AuthResponse.self, path: "/api/v1/auth/bootstrap", method: "POST",
            json: payload, authorized: false
        )
        session.setSession(access: auth.accessToken, refresh: auth.refreshToken, user: auth.user)
        return auth
    }

    @discardableResult
    func login(username: String, password: String) async throws -> AuthResponse {
        let auth = try await requestDecoded(
            AuthResponse.self, path: "/api/v1/auth/login", method: "POST",
            json: ["username": username, "password": password], authorized: false
        )
        session.setSession(access: auth.accessToken, refresh: auth.refreshToken, user: auth.user)
        return auth
    }

    func logout() async {
        _ = try? await requestDecoded(
            OkResponse.self, path: "/api/v1/auth/logout", method: "POST", json: [:]
        )
        session.clearSession()
    }

    func me() async throws -> AuthUser {
        try await requestDecoded(MeResponse.self, path: "/api/v1/auth/me").user
    }

    func changePassword(current: String, next: String) async throws -> AuthResponse {
        let auth = try await requestDecoded(
            AuthResponse.self, path: "/api/v1/auth/me/password", method: "PATCH",
            json: ["currentPassword": current, "newPassword": next]
        )
        session.setSession(access: auth.accessToken, refresh: auth.refreshToken, user: auth.user)
        return auth
    }

    // MARK: - Entries

    func listEntries(cursor: String? = nil, limit: Int = 50) async throws -> EntryPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await requestDecoded(EntryPage.self, path: "/api/v1/entries", query: query)
    }

    func getEntry(id: String) async throws -> Entry {
        try await requestDecoded(Entry.self, path: "/api/v1/entries/\(id)")
    }

    func uploadEntry(meta: Entry, jpeg: Data, thumb: Data) async throws -> Entry {
        let boundary = "nx-\(UUID().uuidString)"
        var body = Data()
        func appendField(_ name: String, _ value: Data, filename: String? = nil, mime: String? = nil) {
            body.append(Data("--\(boundary)\r\n".utf8))
            var disposition = "Content-Disposition: form-data; name=\"\(name)\""
            if let filename { disposition += "; filename=\"\(filename)\"" }
            body.append(Data("\(disposition)\r\n".utf8))
            if let mime { body.append(Data("Content-Type: \(mime)\r\n".utf8)) }
            body.append(Data("\r\n".utf8))
            body.append(value)
            body.append(Data("\r\n".utf8))
        }
        let metaData = try JSONCoding.encoder.encode(meta)
        appendField("meta", metaData)
        appendField("image", jpeg, filename: "image.jpg", mime: "image/jpeg")
        appendField("thumb", thumb, filename: "thumb.jpg", mime: "image/jpeg")
        body.append(Data("--\(boundary)--\r\n".utf8))

        let (data, http) = try await send { [self] in
            try makeRequest(
                path: "/api/v1/entries", method: "POST",
                body: body, contentType: "multipart/form-data; boundary=\(boundary)"
            )
        }
        guard (200..<300).contains(http.statusCode) else { throw apiError(data: data, status: http.statusCode) }
        return try decoder.decode(Entry.self, from: data)
    }

    func patchEntry(id: String, patch: [String: Any]) async throws -> Entry {
        try await requestDecoded(Entry.self, path: "/api/v1/entries/\(id)", method: "PATCH", json: patch)
    }

    func deleteEntry(id: String) async throws {
        let (data, http) = try await send { [self] in
            try makeRequest(path: "/api/v1/entries/\(id)", method: "DELETE")
        }
        guard (200..<300).contains(http.statusCode) || http.statusCode == 404 else {
            throw apiError(data: data, status: http.statusCode)
        }
    }

    func mediaBytes(entryId: String, kind: String) async throws -> Data {
        try await requestBytes(path: "/api/v1/entries/\(entryId)/media/\(kind)")
    }

    func depthJson(entryId: String) async throws -> String {
        let data = try await requestBytes(path: "/api/v1/entries/\(entryId)/depth")
        return String(data: data, encoding: .utf8) ?? ""
    }

    // MARK: - Session (canonical)

    func sessionOpen(entryId: String, force: Bool = false) async throws -> SessionOpenResponse {
        try await requestDecoded(
            SessionOpenResponse.self, path: "/api/v1/entries/\(entryId)/session/open",
            method: "POST", json: ["force": force]
        )
    }

    func sessionMessage(entryId: String, text: String) -> AsyncThrowingStream<String, Error> {
        streamSse(path: "/api/v1/entries/\(entryId)/session/message", json: ["text": text])
    }

    func sessionComplete(entryId: String, force: Bool = false) -> AsyncThrowingStream<String, Error> {
        streamSse(path: "/api/v1/entries/\(entryId)/session/complete", json: ["force": force])
    }

    func streamMonthly(yearMonth: String) -> AsyncThrowingStream<String, Error> {
        streamSse(path: "/api/v1/monthly/\(yearMonth)/generate", json: [:])
    }

    func getMonthly(yearMonth: String) async throws -> MonthlyReview? {
        let (data, http) = try await send { [self] in try makeRequest(path: "/api/v1/monthly/\(yearMonth)") }
        if http.statusCode == 404 { return nil }
        guard (200..<300).contains(http.statusCode) else { throw apiError(data: data, status: http.statusCode) }
        return try decoder.decode(MonthlyReview.self, from: data)
    }

    // MARK: - Profile & people

    func profile() async throws -> ProfileData {
        try await requestDecoded(ProfileData.self, path: "/api/v1/me/profile")
    }

    func savePersonality(_ text: String) async throws -> ProfileData {
        try await requestDecoded(ProfileData.self, path: "/api/v1/me/profile", method: "PATCH", json: ["personality": text])
    }

    func editMemory(id: String, text: String) async throws -> ProfileData {
        try await requestDecoded(ProfileData.self, path: "/api/v1/me/memories/\(id)", method: "PATCH", json: ["text": text])
    }

    func deleteMemory(id: String) async throws -> ProfileData {
        try await requestDecoded(ProfileData.self, path: "/api/v1/me/memories/\(id)", method: "DELETE")
    }

    func people() async throws -> [PersonDto] {
        try await requestDecoded(PeoplePage.self, path: "/api/v1/people").items
    }

    @discardableResult
    func createPerson(name: String, relation: String, isUser: Bool = false, samples: [FaceRef] = []) async throws -> PersonDto {
        try await requestDecoded(
            PersonDto.self, path: "/api/v1/people", method: "POST",
            json: ["name": name, "relation": relation, "isUser": isUser, "samples": Self.faceRefsJson(samples)]
        )
    }

    @discardableResult
    func updatePerson(
        id: String,
        name: String? = nil,
        relation: String? = nil,
        isUser: Bool? = nil,
        addSamples: [FaceRef] = []
    ) async throws -> PersonDto {
        var payload: [String: Any] = [:]
        if let name { payload["name"] = name }
        if let relation { payload["relation"] = relation }
        if let isUser { payload["isUser"] = isUser }
        if !addSamples.isEmpty { payload["addSamples"] = Self.faceRefsJson(addSamples) }
        return try await requestDecoded(PersonDto.self, path: "/api/v1/people/\(id)", method: "PATCH", json: payload)
    }

    @discardableResult
    func mergePerson(targetId: String, fromId: String) async throws -> PersonDto {
        try await requestDecoded(
            PersonDto.self, path: "/api/v1/people/\(targetId)/merge", method: "POST", json: ["fromId": fromId]
        )
    }

    func deletePerson(id: String) async throws {
        _ = try await requestDecoded(OkResponse.self, path: "/api/v1/people/\(id)", method: "DELETE") as OkResponse
    }

    func unassignedFaces() async throws -> [FaceCluster] {
        try await requestDecoded(FaceClusterPage.self, path: "/api/v1/faces/unassigned").items
    }

    func faceThumb(entryId: String, faceIndex: Int) async throws -> Data {
        try await requestBytes(path: "/api/v1/entries/\(entryId)/faces/\(faceIndex)/thumb")
    }

    // MARK: - Admin users

    func users() async throws -> [AuthUser] {
        try await requestDecoded(UserPage.self, path: "/api/v1/users").items
    }

    @discardableResult
    func createUser(username: String, password: String, displayName: String, role: String) async throws -> AuthUser {
        try await requestDecoded(
            UserResponse.self, path: "/api/v1/users", method: "POST",
            json: ["username": username, "password": password, "displayName": displayName, "role": role]
        ).user
    }

    @discardableResult
    func updateUser(
        id: String,
        displayName: String? = nil,
        role: String? = nil,
        disabled: Bool? = nil,
        password: String? = nil
    ) async throws -> AuthUser {
        var payload: [String: Any] = [:]
        if let displayName { payload["displayName"] = displayName }
        if let role { payload["role"] = role }
        if let disabled { payload["disabled"] = disabled }
        if let password, !password.isEmpty { payload["password"] = password }
        return try await requestDecoded(UserResponse.self, path: "/api/v1/users/\(id)", method: "PATCH", json: payload).user
    }

    // MARK: - SSE

    /// Streams the accumulated assistant text for each delta frame of an SSE v1 stream.
    /// session/complete may answer with plain JSON `{entry, skipped}` when already done — surfaced as a single emission.
    private func streamSse(path: String, json payload: [String: Any]) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { [self] in
                do {
                    var refreshed = false
                    while true {
                        let body = try JSONSerialization.data(withJSONObject: payload)
                        var request = try makeRequest(
                            path: path, method: "POST", body: body, contentType: "application/json"
                        )
                        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        // LLM 长时间不吐字且无心跳时不能掐断流。
                        request.timeoutInterval = 3600
                        let (bytes, response) = try await urlSession.bytes(for: request)
                        guard let http = response as? HTTPURLResponse else {
                            throw ApiError(status: 0, code: "UNAVAILABLE", message: "无法连接服务器")
                        }
                        if http.statusCode == 401, !refreshed, await refreshIfNeeded(status: 401) {
                            refreshed = true
                            continue
                        }
                        guard (200..<300).contains(http.statusCode) else {
                            var collected = Data()
                            for try await byte in bytes { collected.append(byte) }
                            throw apiError(data: collected, status: http.statusCode)
                        }
                        let contentType = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
                        if contentType.contains("application/json") {
                            var collected = Data()
                            for try await byte in bytes { collected.append(byte) }
                            if let object = try? JSONSerialization.jsonObject(with: collected) as? [String: Any],
                               let entry = object["entry"] as? [String: Any],
                               let diary = entry["diaryText"] as? String, !diary.isEmpty {
                                continuation.yield(diary)
                            }
                            continuation.finish()
                            return
                        }
                        var full = ""
                        var sawDone = false
                        for try await line in bytes.lines {
                            guard line.hasPrefix("data:") else { continue }
                            let event = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                            guard !event.isEmpty,
                                  let object = try? JSONSerialization.jsonObject(with: Data(event.utf8)) as? [String: Any],
                                  let type = object["type"] as? String else { continue }
                            switch type {
                            case "delta":
                                full += object["text"] as? String ?? ""
                                continuation.yield(full)
                            case "done":
                                sawDone = true
                            case "error":
                                throw ApiError(
                                    status: 502,
                                    code: object["code"] as? String ?? "UPSTREAM",
                                    message: object["message"] as? String ?? "stream error"
                                )
                            default:
                                break
                            }
                            if sawDone { break }
                        }
                        guard sawDone else {
                            throw ApiError(status: 502, code: "UPSTREAM", message: "stream ended before completion")
                        }
                        continuation.finish()
                        return
                    }
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func faceRefsJson(_ refs: [FaceRef]) -> [[String: Any]] {
        refs.map { ["entryId": $0.entryId, "faceIndex": $0.faceIndex] }
    }
}

struct OkResponse: Decodable {
    var ok = false

    enum CodingKeys: String, CodingKey { case ok }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.value(.ok, default: false)
    }
}

/// Minimal async counting semaphore (single-flight refresh gate).
actor AsyncSemaphoreState {
    private var value: Int
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(value: Int) { self.value = value }

    func wait() async {
        if value > 0 {
            value -= 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func signal() {
        if let next = waiters.first {
            waiters.removeFirst()
            next.resume()
        } else {
            value += 1
        }
    }
}

final class AsyncSemaphore: @unchecked Sendable {
    private let state: AsyncSemaphoreState
    init(value: Int) { state = AsyncSemaphoreState(value: value) }
    func wait() async { await state.wait() }
    func signal() { Task { await state.signal() } }
}
