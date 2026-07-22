import Foundation
import Observation

/// Ported from the Android AppViewModel: single observable state container, session
/// orchestration goes through server session intents (open/message/complete).
@MainActor
@Observable
final class AppViewModel {
    let api: ApiClient
    let session: SessionStore
    let uploadQueue: UploadQueue

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

    // Account / family / recovery
    var locked = false
    var recoveryCode: String?
    var familyInfo: FamilyInfo?
    var myInvites: [MyInvite] = []
    var familyBusyKey: String?

    // Relationship graph
    var graphNodes: [GraphNode] = []
    var graphEdges: [RelationshipDto] = []
    var graphLoading = false

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
    var depthVersion = 0
    var navigateToSession = false
    var duplicatePrompt: DuplicatePrompt?
    var pendingDecisionCount = 0

    @ObservationIgnored private var sessionStreamTask: Task<Void, Never>?
    @ObservationIgnored private var sessionLoadTask: Task<Void, Never>?
    @ObservationIgnored private var thumbnailBytesTotal = 0
    @ObservationIgnored private var duplicateDecision: CheckedContinuation<Bool, Never>?
    @ObservationIgnored private var isDraining = false
    @ObservationIgnored private var isForeground = true
    @ObservationIgnored private let connectivity = ConnectivityObserver()
    @ObservationIgnored private var changeFeedTask: Task<Void, Never>?
    @ObservationIgnored private var changeFeedSeq: Int64 = 0
    @ObservationIgnored private var coalesceTask: Task<Void, Never>?
    @ObservationIgnored private var coalesceDeadline: ContinuousClock.Instant?

    struct DuplicatePrompt: Equatable {
        let entryId: String
        let takenAt: Int64
    }

    init(container: AppContainer = AppContainer.shared) {
        api = container.api
        session = container.session
        uploadQueue = container.uploadQueue
        baseUrl = session.getBaseUrl()
        user = session.getUser()
        refreshPendingDecisionCount()
        connectivity.onRegained = { [weak self] in
            guard let self, self.isForeground else { return }
            self.drainQueue(interactive: false)
            self.restartChangeFeed()
        }
        connectivity.start()
        api.onKeysLocked = { [weak self] in
            Task { @MainActor [weak self] in
                // Only a ready session flips to locked — a mid-login/register lock is surfaced
                // as a normal error by that action instead (mirrors Web's mode === 'ready' gate).
                guard let self, self.user != nil else { return }
                self.locked = true
            }
        }
        Task { await start() }
    }

    /// Foreground transitions drain the queue and (re)start the change feed; backgrounding stops
    /// the feed (see also connectivity.onRegained above, which also kicks a feed reconnect).
    func handleScenePhaseChange(active: Bool) {
        isForeground = active
        if active {
            drainQueue(interactive: false)
            // Entries/people require unlocked keys; the change feed doesn't, so it can still start.
            if user != nil, !locked { loadHome(clearError: false) } // cheap catch-up refresh after backgrounding
            startChangeFeed()
        } else {
            stopChangeFeed()
        }
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
        drainQueue(interactive: false)
        do {
            let me = try await api.me()
            user = me.user
            if me.locked {
                // Valid session, server keyring empty (restart): unlock instead of re-login.
                // Don't touch entries/change-feed yet — unlock(password:) starts them.
                locked = true
            } else {
                loadHome()
                startChangeFeed()
            }
        } catch let apiError as ApiError where apiError.status == 401 || apiError.status == 403 {
            // 服务器明确拒绝鉴权才登出；连不上时保留本地会话离线进入。
            session.clearSession()
            user = nil
        } catch {
            if user != nil {
                self.error = error.localizedDescription
                loadHome()
                startChangeFeed()
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
        authAction(fallback: "登录失败", overrides: ["UNAUTHORIZED": "用户名或密码不正确"]) {
            try await self.api.login(username: username, password: password)
        }
    }

    func bootstrap(username: String, password: String, displayName: String) {
        authAction(fallback: "初始化失败", overrides: [
            "CONFLICT": "用户名已被占用",
            "VALIDATION": "用户名需 3-32 位字母/数字/下划线,密码至少 8 位",
        ]) {
            try await self.api.bootstrap(username: username, password: password, displayName: displayName)
        }
    }

    func register(
        accountType: String, username: String, password: String,
        displayName: String, familyName: String, regCode: String
    ) {
        authAction(fallback: "注册失败", overrides: [
            "CONFLICT": "用户名已被占用",
            "VALIDATION": "用户名需 3-32 位字母/数字/下划线,密码至少 8 位",
        ]) {
            try await self.api.register(
                accountType: accountType, username: username, password: password,
                displayName: displayName.isEmpty ? nil : displayName,
                familyName: familyName.isEmpty ? nil : familyName,
                regCode: regCode.isEmpty ? nil : regCode
            )
        }
    }

    func recover(username: String, recoveryCode: String, newPassword: String) {
        authAction(fallback: "找回失败", overrides: [
            "UNAUTHORIZED": "恢复码不正确",
            "NOT_FOUND": "用户名不存在",
        ]) {
            try await self.api.recover(username: username, recoveryCode: recoveryCode, newPassword: newPassword)
        }
    }

    /// Shared by login/bootstrap/register/recover: install the session, surface the one-shot
    /// recovery code, go ready. Mirrors Web useUserStore's enterSession().
    private func authAction(fallback: String, overrides: [String: String] = [:], _ block: @escaping () async throws -> AuthResponse) {
        Task {
            loading = true
            error = nil
            do {
                let response = try await block()
                user = response.user
                recoveryCode = response.recoveryCode
                loading = false
                loadHome()
                startChangeFeed()
            } catch {
                loading = false
                // A locked keyring mid-login is not an expected state; never leave error empty here.
                self.error = friendlyError(error, fallback: fallback, overrides: overrides) ?? fallback
            }
        }
    }

    /// Server restarted, keyring empty: re-enter the password. Same session — never a logout.
    func unlock(password: String) {
        Task {
            loading = true
            error = nil
            do {
                let response = try await api.unlock(password: password)
                locked = false
                recoveryCode = response.recoveryCode
                loading = false
                loadHome(clearError: false)
                drainQueue(interactive: false)
                startChangeFeed()
            } catch {
                loading = false
                self.error = friendlyError(error, fallback: "解锁失败", overrides: ["UNAUTHORIZED": "密码不正确"]) ?? "解锁失败"
            }
        }
    }

    func logout() {
        cancelSessionTasks()
        stopChangeFeed()
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
        pendingDecisionCount = 0
        changeFeedSeq = 0
        locked = false
        recoveryCode = nil
        familyInfo = nil
        myInvites = []
        familyBusyKey = nil
        graphNodes = []
        graphEdges = []
        graphLoading = false
        closeSession()
        error = nil
        loading = false
    }

    // MARK: - Change feed

    private enum ChangeFeedTiming {
        static let debounce: Duration = .seconds(1)
        static let maxCoalesce: Duration = .seconds(3)
        static let initialBackoff: Duration = .seconds(1)
        static let maxBackoff: Duration = .seconds(30)
    }

    /// Subscribes to GET /entries/changes while logged in and foreground; reconnects with
    /// exponential backoff on error, immediately on a clean server-side close. Single-flight.
    private func startChangeFeed() {
        guard isForeground, user != nil, changeFeedTask == nil else { return }
        changeFeedTask = Task {
            var backoff = ChangeFeedTiming.initialBackoff
            while !Task.isCancelled {
                do {
                    for try await frame in api.entryChanges(since: changeFeedSeq) {
                        guard !Task.isCancelled else { return }
                        backoff = ChangeFeedTiming.initialBackoff // a received frame confirms the connection is live
                        handleChangeFrame(frame)
                    }
                    // Stream ended without error (server's periodic clean close): reconnect immediately.
                } catch {
                    if Task.isCancelled { return }
                    try? await Task.sleep(for: backoff)
                    backoff = min(backoff * 2, ChangeFeedTiming.maxBackoff)
                }
            }
        }
    }

    private func stopChangeFeed() {
        changeFeedTask?.cancel()
        changeFeedTask = nil
        coalesceTask?.cancel()
        coalesceTask = nil
        coalesceDeadline = nil
    }

    private func restartChangeFeed() {
        stopChangeFeed()
        startChangeFeed()
    }

    private func handleChangeFrame(_ frame: ChangeFrame) {
        switch frame.type {
        case "cursor":
            changeFeedSeq = frame.seq
        case "change":
            changeFeedSeq = frame.seq
            scheduleChangeRefresh()
        case "resync":
            changeFeedSeq = frame.seq
            coalesceTask?.cancel()
            coalesceTask = nil
            coalesceDeadline = nil
            loadHome(clearError: false)
        default:
            break // ping / unknown: no-op
        }
    }

    /// Coalesces a burst of "change" frames into one refresh: each frame resets a short debounce
    /// window, bounded by an absolute max wait since the first frame of the burst.
    private func scheduleChangeRefresh() {
        let clock = ContinuousClock()
        let now = clock.now
        let deadline = coalesceDeadline ?? now.advanced(by: ChangeFeedTiming.maxCoalesce)
        coalesceDeadline = deadline
        let fireAt = min(now.advanced(by: ChangeFeedTiming.debounce), deadline)
        coalesceTask?.cancel()
        coalesceTask = Task {
            try? await clock.sleep(until: fireAt)
            guard !Task.isCancelled else { return }
            coalesceDeadline = nil
            loadHome(clearError: false)
        }
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
            if sessionEntry?.id == entryId {
                depthJson = depth
                depthVersion += 1
            }
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

    /// Prepares and enqueues every photo to the on-disk queue BEFORE any network attempt (so a
    /// process kill never loses them), then drains interactively.
    func importPhotos(_ photos: [PickedPhoto]) {
        guard !photos.isEmpty else { return }
        Task {
            loading = true
            error = nil
            for photo in photos {
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
                    entry.clientUploadId = UUID().uuidString
                    try uploadQueue.enqueue(entry: entry, jpeg: prepared.jpeg, thumb: prepared.thumb)
                } catch {
                    self.error = error.localizedDescription
                }
            }
            loading = false
            drainQueue(interactive: true)
        }
    }

    private enum DrainOutcome {
        case success(Entry)
        case skippedDuplicate
        case needsDecisionQueued
        case retryLater
        case networkPending
        case gaveUp(String)
    }

    /// Single-flight: drains queued `pending` items with each item's persisted clientUploadId
    /// (retries reuse it verbatim — the server dedups replays, which is what makes retry safe).
    /// Interactive drains pop the duplicate dialog immediately; automatic drains (launch /
    /// foreground / reconnect) mark DUPLICATE_IMAGE items needs_decision instead so they never
    /// interrupt the user unprompted, and stop at the first plain network failure.
    private func drainQueue(interactive: Bool) {
        guard !isDraining else { return }
        let items = uploadQueue.list().filter { $0.state == .pending }
        guard !items.isEmpty else { return }
        isDraining = true
        Task {
            defer { isDraining = false; refreshPendingDecisionCount() }
            loading = true
            error = nil
            uploadProgress = "0/\(items.count)"
            var successCount = 0, skipped = 0, stillQueued = 0, failures = 0, processed = 0
            var firstFailure: String?
            var lastCreated: Entry?
            itemsLoop: for item in items {
                let outcome = await drainOne(item, interactive: interactive)
                processed += 1
                uploadProgress = "\(processed)/\(items.count)"
                switch outcome {
                case .success(let created):
                    successCount += 1
                    lastCreated = created
                case .skippedDuplicate:
                    skipped += 1
                case .needsDecisionQueued:
                    break
                case .retryLater:
                    stillQueued += 1
                case .gaveUp(let message):
                    failures += 1
                    if firstFailure == nil { firstFailure = message }
                case .networkPending:
                    stillQueued += 1
                    break itemsLoop
                }
            }
            stillQueued += items.count - processed
            loading = false
            uploadProgress = ""
            guard successCount + skipped + failures + stillQueued > 0 else { return }
            error = firstFailure
            toast = Self.importSummary(
                total: items.count, failures: failures, skipped: skipped,
                firstFailure: firstFailure, stillQueued: stillQueued
            )
            if interactive {
                loadHome(clearError: false)
                if successCount > 0, let created = lastCreated {
                    sessionEntry = created
                    navigateToSession = true
                    openEntry(created)
                }
            } else if successCount > 0 || failures > 0 {
                loadHome(clearError: false)
            }
        }
    }

    private func drainOne(_ item: QueueManifest, interactive: Bool) async -> DrainOutcome {
        let id = item.entry.clientUploadId
        guard let jpeg = uploadQueue.jpegData(for: id), let thumb = uploadQueue.thumbData(for: id) else {
            uploadQueue.remove(id)
            return .gaveUp("照片数据丢失")
        }
        var override = false
        while true {
            do {
                let created = try await api.uploadEntry(meta: item.entry, jpeg: jpeg, thumb: thumb, override: override)
                uploadQueue.remove(id)
                return .success(created)
            } catch let apiErr as ApiError where apiErr.code == "DUPLICATE_IMAGE" && !override {
                if interactive {
                    let confirmed = await resolveDuplicate(
                        entryId: apiErr.duplicateOfId ?? "", takenAt: apiErr.duplicateOfTakenAt ?? 0
                    )
                    if confirmed { override = true; continue }
                    uploadQueue.remove(id)
                    return .skippedDuplicate
                }
                uploadQueue.markNeedsDecision(id, duplicateOfId: apiErr.duplicateOfId, duplicateOfTakenAt: apiErr.duplicateOfTakenAt)
                return .needsDecisionQueued
            } catch let apiErr as ApiError where apiErr.code == "E_KEYS_LOCKED" {
                // Locked mid-drain (server restart): stay queued silently, no failed attempt, no toast.
                return .networkPending
            } catch let apiErr as ApiError where apiErr.status == 0 {
                return .networkPending // no HTTP response at all — treated like a connectivity drop
            } catch is URLError {
                return .networkPending
            } catch {
                let attempts = uploadQueue.recordAttempt(id)
                if attempts >= 5 {
                    uploadQueue.remove(id)
                    return .gaveUp(error.localizedDescription)
                }
                return .retryLater
            }
        }
    }

    /// Pauses the drain for a DUPLICATE_IMAGE response; resumed by confirm/skipDuplicateUpload.
    private func resolveDuplicate(entryId: String, takenAt: Int64) async -> Bool {
        duplicatePrompt = DuplicatePrompt(entryId: entryId, takenAt: takenAt)
        let confirmed = await withCheckedContinuation { continuation in
            duplicateDecision = continuation
        }
        duplicatePrompt = nil
        return confirmed
    }

    func confirmDuplicateUpload() {
        duplicateDecision?.resume(returning: true)
        duplicateDecision = nil
    }

    func skipDuplicateUpload() {
        duplicateDecision?.resume(returning: false)
        duplicateDecision = nil
    }

    /// Walks queued needs_decision items (tapped from the timeline banner) through the same dialog.
    func resolvePendingDecisions() {
        guard !isDraining else { return }
        let items = uploadQueue.list().filter { $0.state == .needsDecision }
        guard !items.isEmpty else { return }
        isDraining = true
        Task {
            defer { isDraining = false; refreshPendingDecisionCount() }
            var successCount = 0
            var skipped = 0
            var lastCreated: Entry?
            for item in items {
                let id = item.entry.clientUploadId
                guard let jpeg = uploadQueue.jpegData(for: id), let thumb = uploadQueue.thumbData(for: id) else {
                    uploadQueue.remove(id)
                    continue
                }
                let confirmed = await resolveDuplicate(
                    entryId: item.duplicateOfId ?? "", takenAt: item.duplicateOfTakenAt ?? 0
                )
                if confirmed {
                    do {
                        let created = try await api.uploadEntry(meta: item.entry, jpeg: jpeg, thumb: thumb, override: true)
                        uploadQueue.remove(id)
                        lastCreated = created
                        successCount += 1
                    } catch {
                        // Network hiccup on the override retry: leave needs_decision, banner stays for another tap.
                        self.error = error.localizedDescription
                    }
                } else {
                    uploadQueue.remove(id)
                    skipped += 1
                }
            }
            guard successCount + skipped > 0 else { return }
            toast = Self.importSummary(total: successCount + skipped, failures: 0, skipped: skipped, firstFailure: nil)
            loadHome(clearError: false)
            if let created = lastCreated {
                sessionEntry = created
                navigateToSession = true
                openEntry(created)
            }
        }
    }

    private func refreshPendingDecisionCount() {
        pendingDecisionCount = uploadQueue.list().filter { $0.state == .needsDecision }.count
    }

    nonisolated static func importSummary(
        total: Int, failures: Int, skipped: Int, firstFailure: String?, stillQueued: Int = 0
    ) -> String {
        guard failures != 0 || skipped != 0 || stillQueued != 0 else { return "已上传 \(total) 张" }
        var parts = ["\(total - failures - skipped - stillQueued) 张成功"]
        if skipped > 0 { parts.append("\(skipped) 张已跳过（重复）") }
        if stillQueued > 0 { parts.append("\(stillQueued) 张待稍后重试") }
        if failures > 0 { parts.append("\(failures) 张失败：\(firstFailure ?? "请重试")") }
        return parts.joined(separator: "，")
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

    func changePassword(current: String, next: String) {
        Task {
            do {
                let response = try await api.changePassword(current: current, next: next)
                user = response.user
                toast = "密码已修改"
            } catch {
                self.error = friendlyError(error, fallback: "密码修改失败") ?? "密码修改失败"
                toast = "密码修改失败"
            }
        }
    }

    func regenerateRecoveryCode(currentPassword: String) {
        Task {
            do {
                recoveryCode = try await api.regenerateRecoveryCode(currentPassword: currentPassword)
            } catch {
                toast = friendlyError(error, fallback: "获取恢复码失败") ?? "获取恢复码失败"
            }
        }
    }

    func ackRecoveryCode() { recoveryCode = nil }

    // MARK: - Family

    /// Best-effort, mirrors Web FamilyPanel's refresh(): family info only while a member,
    /// pending invites only for personal accounts (regardless of membership).
    func loadFamily() {
        guard let user else { return }
        Task {
            familyInfo = user.familyId != nil ? try? await api.fetchFamily() : nil
            if user.accountType == "personal" {
                myInvites = (try? await api.myInvites()) ?? []
            }
        }
    }

    func createFamily(name: String) {
        familyAction(key: "create", okToast: "家庭已创建") {
            let response = try await self.api.createFamily(name: name.isEmpty ? nil : name)
            if let updated = response.user { self.user = updated }
        }
    }

    func sendFamilyInvite(username: String) {
        familyAction(key: "invite", okToast: "邀请已发送") {
            _ = try await self.api.sendFamilyInvite(username: username)
        }
    }

    func revokeFamilyInvite(id: String) {
        familyAction(key: "revoke:\(id)", okToast: "已撤回") {
            try await self.api.revokeFamilyInvite(id: id)
        }
    }

    func acceptInvite(id: String) {
        familyAction(key: "accept:\(id)", okToast: "已加入家庭") {
            let response = try await self.api.acceptInvite(id: id)
            if let updated = response.user { self.user = updated }
        }
    }

    func declineInvite(id: String) {
        familyAction(key: "decline:\(id)", okToast: "已拒绝") {
            try await self.api.declineInvite(id: id)
        }
    }

    func leaveFamily() {
        familyAction(key: "leave", okToast: "已退出家庭") {
            let response = try await self.api.leaveFamily()
            if let updated = response.user { self.user = updated }
        }
    }

    func removeFamilyMember(id: String) {
        familyAction(key: "remove:\(id)", okToast: "已移出家庭") {
            try await self.api.removeFamilyMember(id: id)
        }
    }

    /// Mirrors Web AccountManager's act(): single-flight by key, re-fetches family + people on
    /// success (family membership changes the shared person registry), toasts on failure.
    private func familyAction(key: String, okToast: String? = nil, _ action: @escaping () async throws -> Void) {
        guard familyBusyKey == nil else { return }
        familyBusyKey = key
        Task {
            defer { familyBusyKey = nil }
            do {
                try await action()
                if let okToast { toast = okToast }
                loadFamily()
                loadPeople()
            } catch {
                toast = friendlyError(error, fallback: "操作失败") ?? "操作失败"
            }
        }
    }

    // MARK: - Relationship graph

    func loadGraph() {
        Task {
            graphLoading = true
            if let response = try? await api.graph() {
                graphNodes = response.nodes
                graphEdges = response.edges
            }
            graphLoading = false
        }
    }

    func deleteGraphEdge(_ id: String) {
        Task {
            do {
                try await api.deleteRelationship(id: id)
                graphEdges.removeAll { $0.id == id }
            } catch {
                toast = "没删掉,稍后再试"
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
