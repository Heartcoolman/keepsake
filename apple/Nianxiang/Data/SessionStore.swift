import Foundation
import Security

/// Keychain-backed session storage: base URL, JWT pair and cached user.
/// Mirrors the Android SessionStore contract (validated base URL, tokens wiped together).
final class SessionStore: @unchecked Sendable {
    static let defaultBaseURL = "http://127.0.0.1:8787"

    private let lock = NSLock()
    private let service = "com.nianxiang.app.session"
    private let json = JSONCoding.encoder
    /// In-memory backing for tests — keeps integration runs out of the real Keychain.
    private var memory: [String: String]?

    init(inMemory: Bool = false) {
        memory = inMemory ? [:] : nil
    }

    private enum Key: String {
        case baseURL = "base_url"
        case access = "access"
        case refresh = "refresh"
        case user = "user"
    }

    func getBaseUrl() -> String {
        read(.baseURL) ?? Self.defaultBaseURL
    }

    func getAccess() -> String? { read(.access) }
    func getRefresh() -> String? { read(.refresh) }

    func getUser() -> AuthUser? {
        guard let raw = read(.user), let data = raw.data(using: .utf8) else { return nil }
        return try? JSONCoding.decoder.decode(AuthUser.self, from: data)
    }

    func setBaseUrl(_ url: String) throws {
        let normalized = url.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingSuffix(while: { $0 == "/" })
        guard Self.validBaseUrl(String(normalized)) else {
            throw ApiError(status: 0, code: "VALIDATION", message: "公网服务器必须使用 HTTPS")
        }
        write(.baseURL, String(normalized))
    }

    func setSession(access: String, refresh: String, user: AuthUser) {
        write(.access, access)
        write(.refresh, refresh)
        if let data = try? json.encode(user), let text = String(data: data, encoding: .utf8) {
            write(.user, text)
        }
    }

    func clearSession() {
        delete(.access)
        delete(.refresh)
        delete(.user)
    }

    /// Cleartext HTTP is only allowed toward loopback/mDNS/literal private IPv4 — same policy as Android.
    static func validBaseUrl(_ value: String) -> Bool {
        guard let url = URL(string: value), let host = url.host?.lowercased() else { return false }
        if url.scheme == "https" { return !host.isEmpty }
        guard url.scheme == "http" else { return false }
        if host == "localhost" || host == "::1" || host == "127.0.0.1" || host.hasSuffix(".local") { return true }
        let parts = host.split(separator: ".")
        guard parts.count == 4 else { return false }
        let nums = parts.compactMap { Int($0) }
        guard nums.count == 4, nums.allSatisfy({ (0...255).contains($0) }) else { return false }
        let (a, b) = (nums[0], nums[1])
        if a == 10 || a == 127 { return true }
        if a == 192 && b == 168 { return true }
        if a == 172 && (16...31).contains(b) { return true }
        return false
    }

    // MARK: - Keychain primitives

    private func query(_ key: Key) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
        ]
    }

    private func read(_ key: Key) -> String? {
        lock.lock()
        defer { lock.unlock() }
        if memory != nil { return memory?[key.rawValue] }
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func write(_ key: Key, _ value: String) {
        lock.lock()
        defer { lock.unlock() }
        if memory != nil {
            memory?[key.rawValue] = value
            return
        }
        let data = Data(value.utf8)
        let update = [kSecValueData as String: data]
        let status = SecItemUpdate(query(key) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var q = query(key)
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(q as CFDictionary, nil)
        }
    }

    private func delete(_ key: Key) {
        lock.lock()
        defer { lock.unlock() }
        if memory != nil {
            memory?.removeValue(forKey: key.rawValue)
            return
        }
        SecItemDelete(query(key) as CFDictionary)
    }
}

enum JSONCoding {
    static let encoder = JSONEncoder()
    static let decoder = JSONDecoder()
}

private extension String {
    func trimmingSuffix(while predicate: (Character) -> Bool) -> Substring {
        var view = self[...]
        while let last = view.last, predicate(last) { view = view.dropLast() }
        return view
    }
}
