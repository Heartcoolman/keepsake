import Foundation
import Observation

/// Ported from the Android AppViewModel: single observable state container, session
/// orchestration goes through server session intents (open/message/complete).
@MainActor
@Observable
final class AppViewModel {
    let api: ApiClient
    let session: SessionStore

    // Connection & auth
    var baseUrl: String
    var bootstrapped: Bool?
    var user: AuthUser?
    var loading = false
    var error: String?

    // Timeline
    var entries: [Entry] = []
    var thumbnails: [String: Data] = [:]
    var query = ""
    var filter = "all"
    var sortAscending = false

    // People / profile / review / admin
    var people: [PersonDto] = []
    var unassignedFaces: [FaceCluster] = []
    var faceThumbs: [String: Data] = [:]
    var profile: ProfileData?
    var monthlyReview: MonthlyReview?
    var monthlyStream = ""
    var selectedMonth = ""
    var adminUsers: [AuthUser] = []

    // Session
    var sessionEntry: Entry?
    var sessionMessages: [ChatMessage] = []
    var diaryStream = ""
    var phase = "idle"
    var sessionTab = "diary"
    var busy = false
    var uploadProgress = ""
    var toast: String?
    var photoBytes: Data?
    var depthJson: String?
    var navigateToSession = false

    @ObservationIgnored private var sessionStreamTask: Task<Void, Never>?
    @ObservationIgnored private var sessionLoadTask: Task<Void, Never>?
    @ObservationIgnored private var thumbnailBytesTotal = 0

    init(container: AppContainer = AppContainer.shared) {
        api = container.api
        session = container.session
        baseUrl = session.getBaseUrl()
        user = session.getUser()
        Task { await start() }
    }

    private func cancelSessionTasks() {
        sessionLoadTask?.cancel()
        sessionLoadTask = nil
        sessionStreamTask?.cancel()
        sessionStreamTask = nil
    }

    private func start() async {
        await refreshHealth()
        guard session.getAccess() != nil else { return }
        do {
            let me = try await api.me()
            user = me
            loadHome()
        } catch let apiError as ApiError where apiError.status == 401 || apiError.status == 403 {
            // 服务器明确拒绝鉴权才登出；连不上时保留本地会话离线进入。
            session.clearSession()
            user = nil
        } catch {
            if user != nil {
                self.error = error.localizedDescription
                loadHome()
            }
        }
    }

    // MARK: - Connection & auth

    func setBaseUrl(_ url: String) {
        do {
            try session.setBaseUrl(url)
            baseUrl = session.getBaseUrl()
            error = nil
            Task { await refreshHealth() }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func refreshHealth() async {
        do {
            let health = try await api.health()
            bootstrapped = health.bootstrapped
            error = nil
        } catch {
            self.error = error.localizedDescription
            bootstrapped = nil
        }
    }

    func login(username: String, password: String) {
        authAction { try await self.api.login(username: username, password: password).user }
    }

    func bootstrap(username: String, password: String, displayName: String) {
        authAction { try await self.api.bootstrap(username: username, password: password, displayName: displayName).user }
    }

    private func authAction(_ block: @escaping () async throws -> AuthUser) {
        Task {
            loading = true
            error = nil
            do {
                user = try await block()
                loading = false
                loadHome()
            } catch {
                loading = false
                self.error = error.localizedDescription
            }
        }
    }

    func logout() {
        cancelSessionTasks()
        Task {
            await api.logout()
            let keptBaseUrl = baseUrl
            resetState()
            baseUrl = keptBaseUrl
            bootstrapped = true
        }
    }

    private func resetState() {
        user = nil
        entries = []
        thumbnails = [:]
        thumbnailBytesTotal = 0
        query = ""
        filter = "all"
        sortAscending = false
        people = []
        unassignedFaces = []
        faceThumbs = [:]
        profile = nil
        monthlyReview = nil
        monthlyStream = ""
        selectedMonth = ""
        adminUsers = []
        closeSession()
        error = nil
        loading = false
    }

    // MARK: - Timeline

    func loadHome(clearError: Bool = true) {
        Task {
            loading = true
            if clearError { error = nil }
            do {
                var all: [Entry] = []
                var cursor: String?
                var seen = Set<String>()
                repeat {
                    let page = try await api.listEntries(cursor: cursor, limit: 100)
                    all += page.items
                    // 防止服务端返回重复 cursor 造成死循环。
                    cursor = page.nextCursor.flatMap { seen.insert($0).inserted ? $0 : nil }
                } while cursor != nil
                let loadedPeople = try await api.people()
                entries = all
                people = loadedPeople
                loading = false
                loadThumbnails(for: all)
            } catch {
                loading = false
                self.error = error.localizedDescription
            }
        }
    }

    private func loadThumbnails(for entries: [Entry]) {
        let pending = entries.filter { thumbnails[$0.id] == nil }
        guard !pending.isEmpty else { return }
        Task {
            // 分批 + 限并发拉取缩略图；每批一次性更新 state。
            for batch in pending.chunked(into: 12) {
                let loaded: [(String, Data)] = await withTaskGroup(of: (String, Data?).self) { group in
                    var iterator = batch.makeIterator()
                    var active = 0
                    var results: [(String, Data)] = []
                    func addNext() {
                        guard let entry = iterator.next() else { return }
                        active += 1
                        group.addTask { [api] in
                            (entry.id, try? await api.mediaBytes(entryId: entry.id, kind: "thumb"))
                        }
                    }
                    for _ in 0..<6 { addNext() }
                    while active > 0 {
                        guard let (id, data) = await group.next() else { break }
                        active -= 1
                        if let data { results.append((id, data)) }
                        addNext()
                    }
                    return results
                }
                guard !loaded.isEmpty else { continue }
                for (id, data) in loaded {
                    thumbnails[id] = data
                    thumbnailBytesTotal += data.count
                }
                evictThumbnailsIfNeeded()
            }
        }
    }

    /// Keeps decoded thumbnails under ~32MB; evicted ones are re-fetched on next load.
    private func evictThumbnailsIfNeeded() {
        let limit = 32 * 1024 * 1024
        guard thumbnailBytesTotal > limit else { return }
        for (key, value) in thumbnails {
            guard thumbnailBytesTotal > limit else { break }
            if key == sessionEntry?.id { continue }
            thumbnails.removeValue(forKey: key)
            thumbnailBytesTotal -= value.count
        }
    }

    var filteredEntries: [Entry] {
        let trimmed = query.trimmingCharacters(in: .whitespaces).lowercased()
        let items = entries.filter { entry in
            (filter == "all" || entry.status == filter) &&
                (trimmed.isEmpty || [
                    entry.title, entry.diaryText, entry.mood,
                    entry.chat.map(\.content).joined(separator: " "),
                ].joined(separator: " ").lowercased().contains(trimmed))
        }
        return sortAscending ? items.reversed() : items
    }

    func toggleSort() { sortAscending.toggle() }

    func deleteEntry(id: String) {
        Task {
            do {
                try await api.deleteEntry(id: id)
                if let removed = thumbnails.removeValue(forKey: id) {
                    thumbnailBytesTotal -= removed.count
                }
                entries.removeAll { $0.id == id }
                toast = "已删除"
            } catch {
                self.error = error.localizedDescription
                toast = "删除失败"
            }
        }
    }

    // MARK: - Session

    func openEntry(_ entry: Entry) {
        cancelSessionTasks()
        sessionLoadTask = Task {
            loading = true
            error = nil
            sessionEntry = entry
            sessionMessages = []
            photoBytes = nil
            depthJson = nil
            phase = "loading"
            busy = false
            do {
                let full = try await api.getEntry(id: entry.id)
                let photo = try await api.mediaBytes(entryId: entry.id, kind: "image")
                guard !Task.isCancelled, sessionEntry?.id == entry.id else { return }
                sessionEntry = full
                sessionMessages = full.chat
                photoBytes = photo
                loading = false
                phase = full.status == "done" ? "done" : (full.chat.isEmpty ? "ready" : "chatting")
                sessionTab = full.status == "done" ? "diary" : "chat"
                loadDepth(entryId: full.id)
                if full.status != "done" && !full.chat.contains(where: { $0.role == "user" }) {
                    sessionOpenEntry(id: full.id)
                }
            } catch {
                guard !Task.isCancelled, sessionEntry?.id == entry.id else { return }
                loading = false
                self.error = error.localizedDescription
                toast = "打开失败"
            }
        }
    }

    private func loadDepth(entryId: String) {
        Task {
            guard let depth = try? await api.depthJson(entryId: entryId), !depth.isEmpty else { return }
            if sessionEntry?.id == entryId { depthJson = depth }
        }
    }

    private func sessionOpenEntry(id: String) {
        sessionLoadTask = Task {
            phase = "analyzing"
            loading = true
            do {
                let response = try await api.sessionOpen(entryId: id)
                guard !Task.isCancelled, sessionEntry?.id == id else { return }
                let opened = response.entry
                sessionMessages = opened.chat
                phase = opened.status == "done" ? "done" : "chatting"
                loading = false
                sessionEntry = opened
                replaceEntry(opened)
            } catch {
                guard !Task.isCancelled, sessionEntry?.id == id else { return }
                loading = false
                self.error = error.localizedDescription
                phase = "chatting"
            }
        }
    }

    func sendMessage(_ text: String) {
        guard let entry = sessionEntry, !busy else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        applyChatDate(entry: entry, text: trimmed)
        sessionStreamTask = Task {
            let withUser = sessionMessages + [ChatMessage(role: "user", content: trimmed)]
            sessionMessages = withUser + [ChatMessage(role: "assistant", content: "")]
            phase = "chatting"
            busy = true
            do {
                for try await full in api.sessionMessage(entryId: entry.id, text: trimmed) {
                    guard sessionEntry?.id == entry.id else { break }
                    if !sessionMessages.isEmpty {
                        sessionMessages[sessionMessages.count - 1] = ChatMessage(role: "assistant", content: full)
                    }
                }
                let authoritative = try? await api.getEntry(id: entry.id)
                guard sessionEntry?.id == entry.id else { return }
                if let authoritative {
                    sessionMessages = authoritative.chat
                    sessionEntry = authoritative
                }
                busy = false
            } catch {
                if Task.isCancelled { return }
                let authoritative = try? await api.getEntry(id: entry.id)
                guard sessionEntry?.id == entry.id else { return }
                sessionMessages = authoritative?.chat ?? withUser
                if let authoritative { sessionEntry = authoritative }
                busy = false
                self.error = error.localizedDescription
                toast = "发送失败"
            }
        }
    }

    /// 软性日期修正：用户在聊天里提到日期时自动改写 takenAt（对齐 Web parseChatDate）。
    private func applyChatDate(entry: Entry, text: String) {
        let reference = entry.uploadedAt > 0
            ? entry.uploadedAt
            : (entry.takenAt > 0 ? entry.takenAt : ChatDateParser.nowMillis())
        guard let parsed = ChatDateParser.parse(text, reference: reference),
              ChatDateParser.shouldApply(dateSource: entry.dateSource, kind: parsed.kind),
              !ChatDateParser.sameDay(entry.takenAt, parsed.takenAt)
        else { return }
        Task {
            do {
                let updated = try await api.patchEntry(id: entry.id, patch: [
                    "takenAt": parsed.takenAt,
                    "createdAt": parsed.takenAt,
                    "dateSource": "chat",
                ])
                if sessionEntry?.id == updated.id { sessionEntry = updated }
                replaceEntry(updated)
                toast = "已记到 \(Self.formatDate(parsed.takenAt))，不对可点日期改"
                // 拍摄日期影响时间轴排序，交给服务端重新排序。
                loadHome(clearError: false)
            } catch {
                // 软修正失败不打断聊天。
            }
        }
    }

    nonisolated static func formatDate(_ millis: Int64) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy年M月d日"
        formatter.locale = Locale(identifier: "zh_CN")
        return formatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }

    func generateDiary() {
        guard let entry = sessionEntry,
              sessionMessages.contains(where: { $0.role == "user" }),
              !busy else { return }
        let force = phase == "done" || entry.status == "done"
        sessionStreamTask = Task {
            phase = "condensing"
            diaryStream = ""
            busy = true
            do {
                var last = ""
                for try await full in api.sessionComplete(entryId: entry.id, force: force) {
                    last = full
                    guard sessionEntry?.id == entry.id else { break }
                    diaryStream = full
                    phase = full.contains("---") ? "revealing" : "condensing"
                }
                let authoritative = try? await api.getEntry(id: entry.id)
                guard sessionEntry?.id == entry.id else { return }
                if let authoritative, authoritative.status == "done" {
                    phase = "done"
                    sessionEntry = authoritative
                    replaceEntry(authoritative)
                    diaryStream = last
                    sessionTab = "diary"
                    busy = false
                } else {
                    let parsed = Self.parseDiary(last)
                    var updated = sessionEntry ?? entry
                    updated.title = parsed.title
                    updated.mood = parsed.mood
                    updated.diaryText = parsed.body
                    updated.status = "done"
                    phase = "done"
                    sessionEntry = updated
                    replaceEntry(updated)
                    diaryStream = last
                    sessionTab = "diary"
                    busy = false
                }
            } catch {
                if Task.isCancelled { return }
                let authoritative = try? await api.getEntry(id: entry.id)
                guard sessionEntry?.id == entry.id else { return }
                if let authoritative, authoritative.status == "done", !authoritative.diaryText.isEmpty {
                    phase = "done"
                    sessionEntry = authoritative
                    sessionTab = "diary"
                    busy = false
                    self.error = error.localizedDescription
                    toast = "日记没写成，已保留上一版"
                } else {
                    self.error = error.localizedDescription
                    phase = force ? "done" : "chatting"
                    busy = false
                    toast = "日记没写成"
                }
            }
        }
    }

    private func replaceEntry(_ entry: Entry) {
        entries = entries.map { $0.id == entry.id ? entry : $0 }
    }

    nonisolated static func parseDiary(_ raw: String) -> (title: String, mood: String, body: String) {
        let idx = raw.range(of: "---")
        let header = idx.map { String(raw[..<$0.lowerBound]) } ?? raw
        var body = ""
        if let idx {
            body = String(raw[idx.upperBound...])
            while let first = body.first, first == "-" || first == " " || first == "\n" {
                body.removeFirst()
            }
        }
        func capture(_ pattern: String) -> String {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: header, range: NSRange(header.startIndex..., in: header)),
                  match.numberOfRanges > 1,
                  let range = Range(match.range(at: 1), in: header) else { return "" }
            return String(header[range]).trimmingCharacters(in: .whitespaces)
        }
        let title = capture("标题[:：]\\s*(.+)")
        let mood = capture("心情[:：]\\s*(.+)")
        let finalBody = body.isEmpty ? raw : body
        return (
            title.isEmpty ? "未命名记忆" : title,
            mood,
            finalBody.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    // MARK: - Upload

    struct PickedPhoto {
        let data: Data
        let filename: String
        let fileModifiedAt: Int64
    }

    func importPhotos(_ photos: [PickedPhoto]) {
        guard !photos.isEmpty else { return }
        Task {
            loading = true
            error = nil
            uploadProgress = "0/\(photos.count)"
            var last: Entry?
            var failures = 0
            var firstFailure: String?
            for (index, photo) in photos.enumerated() {
                do {
                    let prepared = try await Task.detached(priority: .utility) {
                        try PhotoImporter.prepare(
                            data: photo.data,
                            filename: photo.filename,
                            fileModifiedAt: photo.fileModifiedAt
                        )
                    }.value
                    var entry = Entry(id: ApiClient.newEntryId())
                    entry.createdAt = prepared.takenAt
                    entry.takenAt = prepared.takenAt
                    entry.uploadedAt = Int64(Date().timeIntervalSince1970 * 1000)
                    entry.dateSource = prepared.dateSource
                    entry.yearMonth = Self.yearMonth(from: prepared.takenAt)
                    entry.status = "new"
                    entry.title = "未命名记忆"
                    entry.userId = user?.id ?? ""
                    entry.ownerId = user?.id ?? ""
                    last = try await api.uploadEntry(meta: entry, jpeg: prepared.jpeg, thumb: prepared.thumb)
                } catch {
                    failures += 1
                    if firstFailure == nil { firstFailure = error.localizedDescription }
                }
                uploadProgress = "\(index + 1)/\(photos.count)"
            }
            loading = false
            uploadProgress = ""
            error = firstFailure
            toast = failures == 0
                ? "已上传 \(photos.count) 张"
                : "\(photos.count - failures) 张成功，\(failures) 张失败：\(firstFailure ?? "请重试")"
            loadHome(clearError: false)
            if let created = last {
                sessionEntry = created
                navigateToSession = true
                openEntry(created)
            }
        }
    }

    nonisolated static func yearMonth(from millis: Int64) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }

    func consumeSessionNavigation() { navigateToSession = false }

    // MARK: - Profile

    func loadProfile() {
        Task {
            do { profile = try await api.profile() } catch { self.error = error.localizedDescription }
        }
    }

    func savePersonality(_ text: String) { profileAction { try await self.api.savePersonality(text) } }
    func editMemory(id: String, text: String) { profileAction { try await self.api.editMemory(id: id, text: text) } }
    func deleteMemory(id: String) { profileAction { try await self.api.deleteMemory(id: id) } }

    private func profileAction(_ action: @escaping () async throws -> ProfileData) {
        Task {
            do {
                profile = try await action()
                toast = "已保存"
            } catch {
                self.error = error.localizedDescription
                toast = "保存失败"
            }
        }
    }

    // MARK: - People

    func loadPeople() {
        Task {
            do {
                people = try await api.people()
                unassignedFaces = try await api.unassignedFaces()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func createPerson(name: String, relation: String, isUser: Bool = false, samples: [FaceRef] = [], toast: String? = nil) {
        peopleAction(refreshEntryIds: samples.map(\.entryId), successToast: toast) {
            try await self.api.createPerson(name: name, relation: relation, isUser: isUser, samples: samples)
        }
    }

    // 改名/改关系不影响条目内容，无需刷新条目。
    func updatePerson(id: String, name: String, relation: String, isUser: Bool? = nil) {
        peopleAction { try await self.api.updatePerson(id: id, name: name, relation: relation, isUser: isUser) }
    }

    func assignFaces(id: String, samples: [FaceRef], toast: String? = nil) {
        peopleAction(refreshEntryIds: samples.map(\.entryId), successToast: toast) {
            try await self.api.updatePerson(id: id, addSamples: samples)
        }
    }

    // 合并/删除会改写未知数量条目中的人物引用，保留全量刷新。
    func mergePerson(targetId: String, fromId: String) {
        peopleAction(fullRefresh: true) { try await self.api.mergePerson(targetId: targetId, fromId: fromId) }
    }

    func deletePerson(id: String) {
        peopleAction(fullRefresh: true) { try await self.api.deletePerson(id: id) }
    }

    private func peopleAction(
        refreshEntryIds: [String] = [],
        fullRefresh: Bool = false,
        successToast: String? = nil,
        _ action: @escaping () async throws -> Void
    ) {
        Task {
            do {
                try await action()
                loadPeople()
                if fullRefresh { loadHome() } else { await refreshEntries(ids: refreshEntryIds) }
                toast = successToast ?? "人物已更新"
            } catch {
                self.error = error.localizedDescription
                toast = "人物更新失败"
            }
        }
    }

    private func refreshEntries(ids: [String]) async {
        for id in Set(ids) {
            guard let updated = try? await api.getEntry(id: id) else { continue }
            replaceEntry(updated)
            if sessionEntry?.id == id { sessionEntry = updated }
        }
    }

    func loadFaceThumb(_ ref: FaceRef) {
        let key = ref.cacheKey
        guard faceThumbs[key] == nil else { return }
        Task {
            guard let bytes = try? await api.faceThumb(entryId: ref.entryId, faceIndex: ref.faceIndex) else { return }
            if faceThumbs.count >= 300, let firstKey = faceThumbs.keys.first {
                faceThumbs.removeValue(forKey: firstKey)
            }
            faceThumbs[key] = bytes
        }
    }

    // MARK: - Monthly review

    func loadMonthly(_ yearMonth: String) {
        Task {
            selectedMonth = yearMonth
            monthlyReview = nil
            monthlyStream = ""
            do { monthlyReview = try await api.getMonthly(yearMonth: yearMonth) } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func generateMonthly() {
        let month = selectedMonth.isEmpty ? Self.yearMonth(from: Int64(Date().timeIntervalSince1970 * 1000)) : selectedMonth
        guard !busy else { return }
        Task {
            busy = true
            monthlyStream = ""
            do {
                var last = ""
                for try await text in api.streamMonthly(yearMonth: month) {
                    last = text
                    monthlyStream = text
                }
                busy = false
                monthlyReview = MonthlyReview(yearMonth: month, text: last, generatedAt: Int64(Date().timeIntervalSince1970 * 1000))
            } catch {
                busy = false
                self.error = error.localizedDescription
                toast = "月报生成失败"
            }
        }
    }

    // MARK: - Admin

    func loadUsers() {
        guard user?.role == "admin" else { return }
        Task {
            do { adminUsers = try await api.users() } catch { self.error = error.localizedDescription }
        }
    }

    func createUser(username: String, password: String, displayName: String, role: String) {
        Task {
            do {
                try await api.createUser(username: username, password: password, displayName: displayName, role: role)
                loadUsers()
                toast = "成员已创建"
            } catch {
                self.error = error.localizedDescription
                toast = "创建失败"
            }
        }
    }

    func updateUser(id: String, name: String, role: String, disabled: Bool, password: String? = nil) {
        Task {
            do {
                try await api.updateUser(id: id, displayName: name, role: role, disabled: disabled, password: password)
                loadUsers()
                toast = "账号已更新"
            } catch {
                self.error = error.localizedDescription
                toast = "更新失败"
            }
        }
    }

    func changePassword(current: String, next: String) {
        Task {
            do {
                let response = try await api.changePassword(current: current, next: next)
                user = response.user
                toast = "密码已修改"
            } catch {
                self.error = error.localizedDescription
                toast = "密码修改失败"
            }
        }
    }

    // MARK: - Diary edits

    func saveDiary(title: String, body: String) {
        guard let entry = sessionEntry else { return }
        Task {
            do {
                let trimmedTitle = title.trimmingCharacters(in: .whitespaces)
                let updated = try await api.patchEntry(id: entry.id, patch: [
                    "title": trimmedTitle.isEmpty ? "未命名记忆" : trimmedTitle,
                    "diaryText": body.trimmingCharacters(in: .whitespacesAndNewlines),
                ])
                if sessionEntry?.id == updated.id { sessionEntry = updated }
                replaceEntry(updated)
                toast = "日记已保存"
            } catch {
                self.error = error.localizedDescription
                toast = "保存失败"
            }
        }
    }

    func setTakenAt(_ timestamp: Int64) {
        guard let entry = sessionEntry else { return }
        Task {
            do {
                let updated = try await api.patchEntry(id: entry.id, patch: [
                    "takenAt": timestamp,
                    "dateSource": "manual",
                ])
                if sessionEntry?.id == updated.id { sessionEntry = updated }
                toast = "日期已修改"
                // 拍摄日期影响时间轴排序与月份分组，排序由服务端决定，保留全量刷新。
                loadHome()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func clearToast() { toast = nil }

    func closeSession() {
        cancelSessionTasks()
        sessionEntry = nil
        photoBytes = nil
        depthJson = nil
        phase = "idle"
        diaryStream = ""
        busy = false
        navigateToSession = false
    }
}

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}
