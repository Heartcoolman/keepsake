package com.nianxiang.app.ui

import android.app.Application
import android.net.Uri
import android.util.LruCache
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nianxiang.app.NianxiangApp
import com.nianxiang.app.data.ApiClient
import com.nianxiang.app.data.ApiException
import com.nianxiang.app.data.AuthResponse
import com.nianxiang.app.data.AuthUser
import com.nianxiang.app.data.ChangeEvent
import com.nianxiang.app.data.ChatDateParser
import com.nianxiang.app.data.ChatMessage
import com.nianxiang.app.data.Entry
import com.nianxiang.app.data.FaceCluster
import com.nianxiang.app.data.FaceRef
import com.nianxiang.app.data.FamilyInfo
import com.nianxiang.app.data.GraphNode
import com.nianxiang.app.data.MonthlyReview
import com.nianxiang.app.data.MyInvite
import com.nianxiang.app.data.PersonDto
import com.nianxiang.app.data.ProfileData
import com.nianxiang.app.data.RelationshipDto
import com.nianxiang.app.data.SessionStore
import com.nianxiang.app.data.UploadQueue
import com.nianxiang.app.data.friendlyError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonPrimitive
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

data class UiState(
    val baseUrl: String = SessionStore.DEFAULT_BASE_URL,
    val bootstrapped: Boolean? = null,
    val user: AuthUser? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val entries: List<Entry> = emptyList(),
    val thumbnails: Map<String, ByteArray> = emptyMap(),
    val query: String = "",
    val filter: String = "all",
    val sortAscending: Boolean = false,
    val people: List<PersonDto> = emptyList(),
    val unassignedFaces: List<FaceCluster> = emptyList(),
    val faceThumbs: Map<String, ByteArray> = emptyMap(),
    val profile: ProfileData? = null,
    val monthlyReview: MonthlyReview? = null,
    val monthlyStream: String = "",
    val selectedMonth: String = "",
    val locked: Boolean = false,
    val recoveryCode: String? = null,
    val familyInfo: FamilyInfo? = null,
    val myInvites: List<MyInvite> = emptyList(),
    val familyBusyKey: String? = null,
    val graphNodes: List<GraphNode> = emptyList(),
    val graphEdges: List<RelationshipDto> = emptyList(),
    val graphLoading: Boolean = false,
    val sessionEntry: Entry? = null,
    val sessionMessages: List<ChatMessage> = emptyList(),
    val diaryStream: String = "",
    val phase: String = "idle",
    val sessionTab: String = "diary",
    val busy: Boolean = false,
    val uploadProgress: String = "",
    val toast: String? = null,
    /** Bumped on every toast so identical back-to-back messages restart the dismiss timer. */
    val toastSeq: Long = 0L,
    val photoBytes: ByteArray? = null,
    val depthJson: String? = null,
    val navigateToSession: Boolean = false,
    val duplicatePrompt: Boolean = false,
    val pendingDecisionCount: Int = 0,
    val pendingDecisionPrompt: Boolean = false,
)

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as NianxiangApp).container
    private val api get() = container.api
    private val session get() = container.session

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** In-flight chat/diary SSE collection, cancelled when the session is closed. */
    private var sessionStreamJob: Job? = null

    /** openEntry / sessionOpen 的加载协程，切换或关闭会话时取消，避免旧会话数据写回。 */
    private var sessionLoadJob: Job? = null

    /** 月报加载/生成协程，切换月份时取消，避免旧月份响应写回当前月份。 */
    private var monthlyJob: Job? = null

    /** Pending duplicate-image decision from importPhotos, resolved by the UI's confirm dialog. */
    private var duplicateDecision: CompletableDeferred<Boolean>? = null

    /** Pending decision while walking needs_decision items from resolvePendingDecisions(). */
    private var pendingWalkDecision: CompletableDeferred<Boolean>? = null

    /** Serializes all upload-queue drains/decision-walks so the queue directory is never touched concurrently. */
    private val drainMutex = Mutex()

    /** Collects connectivity changes only while foreground; started/stopped by onAppForeground/onAppBackground. */
    private var connectivityJob: Job? = null

    /** True between onAppForeground() and onAppBackground(); gates the change feed alongside login state. */
    private var isForeground = false

    /** Change-feed subscription; runs only while logged in and foreground. */
    private var changeFeedJob: Job? = null

    /** Last seq seen from the change feed, resumed across reconnects; reset on logout. */
    private var lastChangeSeq: Long = 0L

    /** One tick per "change" frame; coalesced into a single loadHome() by the collector started in init. */
    private val changeSignal = MutableSharedFlow<Unit>(extraBufferCapacity = 64)

    private fun cancelSessionJobs() {
        sessionLoadJob?.cancel()
        sessionLoadJob = null
        sessionStreamJob?.cancel()
        sessionStreamJob = null
    }

    /**
     * Bounded, byte-sized cache backing [UiState.thumbnails] so a large library can't
     * pin every decoded thumbnail in memory forever. Evicted entries are simply
     * re-fetched the next time the timeline loads.
     */
    private val thumbnailCache = object : LruCache<String, ByteArray>(THUMBNAIL_CACHE_BYTES) {
        override fun sizeOf(key: String, value: ByteArray): Int = value.size
    }

    init {
        startChangeCoalescer()
        // Server restarted and lost its in-memory keys: only ready sessions flip to locked
        // (mirrors Web's onKeysLocked — a login/register/recover in flight isn't "ready" yet).
        viewModelScope.launch {
            api.keysLocked.collect {
                if (_state.value.user != null) _state.update { it.copy(locked = true) }
            }
        }
        viewModelScope.launch {
            // DataStore/Keystore 读取失败一律视为未登录，绝不让异常从启动协程冒泡导致崩溃循环。
            val url = runCatching { session.getBaseUrl() }.getOrDefault(SessionStore.DEFAULT_BASE_URL)
            val storedUser = runCatching { session.getUser() }.getOrNull()
            _state.update { it.copy(baseUrl = url, user = storedUser) }
            refreshHealth()
            val access = runCatching { session.getAccess() }.getOrNull()
            if (access != null) {
                runCatching { api.me() }
                    .onSuccess { me ->
                        _state.update { it.copy(user = me.user, locked = me.locked) }
                        // Locked: skip data calls (they'd just 423) until unlock() succeeds.
                        if (!me.locked) {
                            loadHome()
                            drainQueue(interactive = false)
                            startChangeFeed()
                        }
                    }
                    .onFailure { e ->
                        // 只有服务器明确拒绝鉴权（401/403，且 ApiClient 内部已重试过刷新）
                        // 才真正登出；服务器不可达/超时等临时错误保留本地会话离线进入，
                        // 否则出门在外连不上家里 NAS 就会被强制重新输密码。
                        if (e is ApiException && (e.status == 401 || e.status == 403)) {
                            runCatching { session.clearSession() }
                            _state.update { s -> s.copy(user = null) }
                        } else if (storedUser != null) {
                            _state.update { s -> s.copy(error = e.message) }
                            loadHome()
                            drainQueue(interactive = false)
                            startChangeFeed()
                        }
                    }
            }
        }
    }

    /** Drain + change-feed triggers: app returns to foreground, and connectivity regained while foreground. */
    fun onAppForeground() {
        isForeground = true
        viewModelScope.launch { drainQueue(interactive = false) }
        startChangeFeed()
        if (connectivityJob == null) {
            connectivityJob = viewModelScope.launch {
                container.connectivity.isOnline.collect { online ->
                    if (online) {
                        drainQueue(interactive = false)
                        // Share the reconnect trigger: don't wait out the change feed's own backoff.
                        restartChangeFeed()
                    }
                }
            }
        }
    }

    fun onAppBackground() {
        isForeground = false
        connectivityJob?.cancel()
        connectivityJob = null
        stopChangeFeed()
    }

    /** Starts the change-feed subscription if not already running and both gates (login, foreground) hold. */
    private fun startChangeFeed() {
        if (!isForeground || _state.value.user == null || changeFeedJob != null) return
        changeFeedJob = viewModelScope.launch {
            var backoffMs = CHANGE_FEED_BACKOFF_MIN_MS
            while (true) {
                val error = runCatching {
                    var connected = false
                    api.changeFeed(lastChangeSeq).collect { event ->
                        if (!connected) {
                            connected = true
                            backoffMs = CHANGE_FEED_BACKOFF_MIN_MS // reset as soon as a connection succeeds
                        }
                        if (event.seq > 0) lastChangeSeq = event.seq
                        when (event.type) {
                            "change" -> changeSignal.tryEmit(Unit)
                            "resync" -> loadHome(clearError = false)
                        }
                    }
                }.exceptionOrNull()
                if (error is CancellationException) throw error
                if (error != null) {
                    delay(backoffMs)
                    backoffMs = (backoffMs * 2).coerceAtMost(CHANGE_FEED_BACKOFF_MAX_MS)
                }
                // else: server closed the stream cleanly (~20min) -> loop immediately, no backoff
            }
        }
    }

    private fun stopChangeFeed() {
        changeFeedJob?.cancel()
        changeFeedJob = null
    }

    private fun restartChangeFeed() {
        stopChangeFeed()
        startChangeFeed()
    }

    /** Coalesces "change" frames into a single loadHome(): flush after 1s quiet or 3s max wait since the first. */
    private fun startChangeCoalescer() {
        viewModelScope.launch {
            while (true) {
                changeSignal.first()
                val batchStart = System.currentTimeMillis()
                while (true) {
                    val remaining = CHANGE_MAX_WAIT_MS - (System.currentTimeMillis() - batchStart)
                    if (remaining <= 0) break
                    val gotMore = withTimeoutOrNull(minOf(CHANGE_DEBOUNCE_MS, remaining)) { changeSignal.first() }
                    if (gotMore == null) break
                }
                loadHome(clearError = false)
            }
        }
    }

    fun setBaseUrl(url: String) {
        viewModelScope.launch {
            runCatching { session.setBaseUrl(url) }
                .onSuccess {
                    _state.update { it.copy(baseUrl = url.trim().trimEnd('/'), error = null) }
                    refreshHealth()
                }
                .onFailure { e -> _state.update { it.copy(error = e.message) } }
        }
    }

    fun refreshHealth() {
        viewModelScope.launch {
            runCatching { api.health() }
                .onSuccess { h -> _state.update { it.copy(bootstrapped = h.bootstrapped, error = null) } }
                .onFailure { e -> _state.update { it.copy(error = e.message, bootstrapped = null) } }
        }
    }

    fun login(username: String, password: String) = authAction(
        fallback = "登录失败",
        overrides = mapOf("UNAUTHORIZED" to "用户名或密码不正确"),
    ) { api.login(username, password) }

    fun bootstrap(username: String, password: String, displayName: String) = authAction(
        fallback = "初始化失败",
        overrides = mapOf(
            "CONFLICT" to "用户名已被占用",
            "VALIDATION" to "用户名需 3-32 位字母/数字/下划线,密码至少 8 位",
        ),
    ) { api.bootstrap(username, password, displayName) }

    fun register(
        accountType: String,
        username: String,
        password: String,
        displayName: String,
        familyName: String,
        regCode: String,
    ) = authAction(
        fallback = "注册失败",
        overrides = mapOf(
            "CONFLICT" to "用户名已被占用",
            "VALIDATION" to "用户名需 3-32 位字母/数字/下划线,密码至少 8 位",
        ),
    ) {
        api.register(
            accountType = accountType,
            username = username,
            password = password,
            displayName = displayName.ifBlank { null },
            familyName = if (accountType == "family") familyName.ifBlank { null } else null,
            regCode = regCode.ifBlank { null },
        )
    }

    fun recover(username: String, recoveryCode: String, newPassword: String) = authAction(
        fallback = "找回失败",
        overrides = mapOf(
            "UNAUTHORIZED" to "恢复码不正确",
            "NOT_FOUND" to "用户名不存在",
        ),
    ) { api.recover(username, recoveryCode, newPassword) }

    /** Server restarted and lost its in-memory keys: same session, no logout. */
    fun unlock(password: String) {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { api.unlock(password) }
                .onSuccess { res ->
                    _state.update { it.copy(loading = false, locked = false, recoveryCode = res.recoveryCode) }
                    loadHome()
                    drainQueue(interactive = false)
                    startChangeFeed()
                }
                .onFailure { e ->
                    val msg = friendlyError(e, "解锁失败", mapOf("UNAUTHORIZED" to "密码不正确")) ?: "解锁失败"
                    _state.update { it.copy(loading = false, error = msg) }
                }
        }
    }

    private fun authAction(fallback: String, overrides: Map<String, String> = emptyMap(), block: suspend () -> AuthResponse) {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { block() }
                .onSuccess { res ->
                    _state.update {
                        it.copy(user = res.user, recoveryCode = res.recoveryCode, loading = false, locked = false)
                    }
                    loadHome()
                    startChangeFeed()
                }
                .onFailure { e ->
                    _state.update { it.copy(loading = false, error = friendlyError(e, fallback, overrides) ?: fallback) }
                }
        }
    }

    fun logout() {
        cancelSessionJobs()
        stopChangeFeed()
        lastChangeSeq = 0L
        viewModelScope.launch {
            api.logout()
            thumbnailCache.evictAll()
            _state.update { UiState(baseUrl = it.baseUrl, bootstrapped = true) }
        }
    }

    fun loadHome(clearError: Boolean = true) {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = if (clearError) null else it.error) }
            runCatching {
                val entries = mutableListOf<Entry>()
                var cursor: String? = null
                val seenCursors = HashSet<String>()
                do {
                    val page = api.listEntries(cursor = cursor, limit = 100)
                    entries += page.items
                    // 防止服务端返回重复 cursor 造成死循环。
                    cursor = page.nextCursor?.takeIf(seenCursors::add)
                } while (cursor != null)
                val people = api.people()
                entries to people
            }.onSuccess { (entries, people) ->
                _state.update {
                    it.copy(entries = entries, people = people, loading = false)
                }
                loadThumbnails(entries)
            }.onFailure { e ->
                _state.update { it.copy(loading = false, error = e.message) }
            }
        }
    }

    private fun loadThumbnails(entries: List<Entry>) {
        viewModelScope.launch {
            // Surface anything already cached first (e.g. the UiState map was reset but
            // the byte cache survived), then fetch only what's genuinely missing.
            thumbnailCache.snapshot().takeIf { it.isNotEmpty() }?.let { cached ->
                _state.update { it.copy(thumbnails = cached) }
            }
            val pending = entries.filter { thumbnailCache.get(it.id) == null }
            if (pending.isEmpty()) return@launch
            // Bounded concurrency (fetch several at once, not one-by-one) + a single
            // state emission per batch instead of one per photo, so a large library
            // neither opens a socket per memory nor rebuilds/recomposes the map N times.
            val gate = Semaphore(THUMBNAIL_CONCURRENCY)
            pending.chunked(THUMBNAIL_BATCH).forEach { batch ->
                val loaded = coroutineScope {
                    batch.map { entry ->
                        async {
                            entry.id to gate.withPermit {
                                runCatching { api.mediaBytes(entry.id, "thumb") }.getOrNull()
                            }
                        }
                    }.awaitAll()
                }.mapNotNull { (id, bytes) -> bytes?.let { id to it } }
                if (loaded.isEmpty()) return@forEach
                loaded.forEach { (id, bytes) -> thumbnailCache.put(id, bytes) }
                _state.update { state -> state.copy(thumbnails = thumbnailCache.snapshot()) }
            }
        }
    }

    fun setQuery(value: String) = _state.update { it.copy(query = value) }
    fun setFilter(value: String) = _state.update { it.copy(filter = value) }
    fun toggleSort() = _state.update { it.copy(sortAscending = !it.sortAscending) }

    fun deleteEntry(id: String) {
        viewModelScope.launch {
            runCatching { api.deleteEntry(id) }
                .onSuccess {
                    thumbnailCache.remove(id)
                    _state.update { state ->
                        state.copy(
                            entries = state.entries.filterNot { it.id == id },
                            thumbnails = state.thumbnails - id,
                        ).showToast("已删除")
                    }
                }
                .onFailure { e -> _state.update { it.copy(error = e.message).showToast("删除失败") } }
        }
    }

    fun openEntry(entry: Entry) {
        cancelSessionJobs()
        sessionLoadJob = viewModelScope.launch {
            _state.update {
                it.copy(
                    loading = true,
                    error = null,
                    sessionEntry = entry,
                    sessionMessages = emptyList(),
                    photoBytes = null,
                    depthJson = null,
                    phase = "loading",
                    busy = false,
                )
            }
            runCatching {
                val full = api.getEntry(entry.id)
                val photo = api.mediaBytes(entry.id, "image")
                full to photo
            }.onSuccess { (full, photo) ->
                _state.update {
                    if (it.sessionEntry?.id != entry.id) return@update it
                    it.copy(
                        sessionEntry = full,
                        sessionMessages = full.chat,
                        photoBytes = photo,
                        loading = false,
                        phase = if (full.status == "done") "done" else if (full.chat.isNotEmpty()) "chatting" else "ready",
                        sessionTab = if (full.status == "done") "diary" else "chat",
                    )
                }
                loadDepth(full.id)
                if (full.status != "done" && full.chat.none { it.role == "user" }) {
                    sessionOpenEntry(full.id)
                }
            }.onFailure { e ->
                if (e is CancellationException) throw e
                _state.update {
                    if (it.sessionEntry?.id != entry.id) return@update it
                    it.copy(loading = false, error = e.message).showToast("打开失败")
                }
            }
        }
    }

    private fun loadDepth(entryId: String) {
        viewModelScope.launch {
            val depth = runCatching { api.depthJson(entryId) }.getOrNull() ?: return@launch
            _state.update { state ->
                if (state.sessionEntry?.id == entryId) state.copy(depthJson = depth) else state
            }
        }
    }

    private fun sessionOpenEntry(id: String) {
        sessionLoadJob = viewModelScope.launch {
            _state.update { it.copy(phase = "analyzing", loading = true) }
            runCatching { api.sessionOpen(id) }
                .onSuccess { res ->
                    val opened = res.entry
                    _state.update {
                        if (it.sessionEntry?.id != id) return@update it
                        it.copy(
                            sessionMessages = opened.chat,
                            phase = if (opened.status == "done") "done" else "chatting",
                            loading = false,
                            sessionEntry = opened,
                            entries = it.entries.map { entry ->
                                if (entry.id == id) opened else entry
                            },
                        )
                    }
                }
                .onFailure { e ->
                    if (e is CancellationException) throw e
                    _state.update {
                        if (it.sessionEntry?.id != id) return@update it
                        it.copy(loading = false, error = e.message, phase = "chatting")
                    }
                }
        }
    }

    fun sendMessage(text: String) {
        val entry = _state.value.sessionEntry ?: return
        if (_state.value.busy) return
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        sessionStreamJob = viewModelScope.launch {
            val withUser = _state.value.sessionMessages + ChatMessage("user", trimmed)
            _state.update {
                it.copy(
                    sessionMessages = withUser + ChatMessage("assistant", ""),
                    phase = "chatting",
                    busy = true,
                )
            }
            runCatching {
                var last = ""
                api.sessionMessage(entry.id, trimmed).collect { full ->
                    last = full
                    _state.update { s ->
                        if (s.sessionEntry?.id != entry.id) return@update s
                        val msgs = s.sessionMessages.toMutableList()
                        if (msgs.isNotEmpty()) msgs[msgs.lastIndex] = ChatMessage("assistant", full)
                        s.copy(sessionMessages = msgs)
                    }
                }
                last
            }.onSuccess {
                val authoritative = runCatching { api.getEntry(entry.id) }.getOrNull()
                _state.update { s ->
                    if (s.sessionEntry?.id != entry.id) return@update s
                    if (authoritative != null) {
                        s.copy(
                            sessionMessages = authoritative.chat,
                            sessionEntry = authoritative,
                            busy = false,
                        )
                    } else {
                        s.copy(busy = false)
                    }
                }
                applyChatDate(authoritative ?: entry, trimmed)
            }.onFailure { e ->
                if (e is CancellationException) throw e
                val authoritative = runCatching { api.getEntry(entry.id) }.getOrNull()
                _state.update { s ->
                    if (s.sessionEntry?.id != entry.id) return@update s
                    s.copy(
                        sessionMessages = authoritative?.chat ?: withUser,
                        sessionEntry = authoritative ?: s.sessionEntry,
                        busy = false,
                        error = e.message,
                    ).showToast("发送失败")
                }
            }
        }
    }

    /** 软性日期修正：用户在聊天里提到日期时自动改写 takenAt（对齐 Web parseChatDate）。 */
    private fun applyChatDate(entry: Entry, text: String) {
        val reference = when {
            entry.uploadedAt > 0 -> entry.uploadedAt
            entry.takenAt > 0 -> entry.takenAt
            else -> System.currentTimeMillis()
        }
        val parsed = ChatDateParser.parse(text, reference) ?: return
        if (!ChatDateParser.shouldApply(entry.dateSource, parsed.kind)) return
        if (ChatDateParser.sameDay(entry.takenAt, parsed.takenAt)) return
        viewModelScope.launch {
            runCatching {
                api.patchEntry(
                    entry.id,
                    mapOf(
                        "takenAt" to JsonPrimitive(parsed.takenAt),
                        "createdAt" to JsonPrimitive(parsed.takenAt),
                        "dateSource" to JsonPrimitive("chat"),
                    ),
                )
            }.onSuccess { updated ->
                _state.update {
                    it.copy(
                        sessionEntry = if (it.sessionEntry?.id == updated.id) updated else it.sessionEntry,
                    ).showToast("已记到 ${formatChineseDate(parsed.takenAt)}，不对可点日期改")
                }
                loadHome(clearError = false)
            }
        }
    }

    fun generateDiary() {
        val entry = _state.value.sessionEntry ?: return
        val messages = _state.value.sessionMessages
        if (messages.none { it.role == "user" }) return
        if (_state.value.busy) return
        val force = _state.value.phase == "done" || entry.status == "done"
        sessionStreamJob = viewModelScope.launch {
            _state.update { it.copy(phase = "condensing", diaryStream = "", busy = true) }
            runCatching {
                var last = ""
                api.sessionComplete(entry.id, force = force).collect { full ->
                    last = full
                    _state.update {
                        if (it.sessionEntry?.id != entry.id) return@update it
                        it.copy(
                            diaryStream = full,
                            phase = if (full.contains("---")) "revealing" else "condensing",
                        )
                    }
                }
                last
            }.onSuccess { full ->
                val authoritative = runCatching { api.getEntry(entry.id) }.getOrNull()
                if (authoritative != null && authoritative.status == "done") {
                    _state.update {
                        if (it.sessionEntry?.id != entry.id) return@update it
                        it.copy(
                            phase = "done",
                            sessionEntry = authoritative,
                            entries = it.entries.map { e -> if (e.id == entry.id) authoritative else e },
                            diaryStream = full,
                            sessionTab = "diary",
                            busy = false,
                        )
                    }
                } else {
                    val parsed = parseDiary(full)
                    _state.update {
                        if (it.sessionEntry?.id != entry.id) return@update it
                        val updatedEntry = it.sessionEntry.copy(
                            title = parsed.first,
                            mood = parsed.second,
                            diaryText = parsed.third,
                            status = "done",
                        )
                        it.copy(
                            phase = "done",
                            sessionEntry = updatedEntry,
                            entries = it.entries.map { e -> if (e.id == entry.id) updatedEntry else e },
                            diaryStream = full,
                            sessionTab = "diary",
                            busy = false,
                        )
                    }
                }
            }.onFailure { e ->
                if (e is CancellationException) throw e
                val authoritative = runCatching { api.getEntry(entry.id) }.getOrNull()
                if (authoritative != null && authoritative.status == "done" && authoritative.diaryText.isNotBlank()) {
                    _state.update {
                        if (it.sessionEntry?.id != entry.id) return@update it
                        it.copy(
                            phase = "done",
                            sessionEntry = authoritative,
                            sessionTab = "diary",
                            busy = false,
                            error = e.message,
                        ).showToast("日记没写成,已保留上一版")
                    }
                } else {
                    _state.update {
                        if (it.sessionEntry?.id != entry.id) return@update it
                        it.copy(
                            error = e.message,
                            phase = if (force) "done" else "chatting",
                            busy = false,
                        ).showToast("日记没写成")
                    }
                }
            }
        }
    }

    /** Every picked photo is persisted to the offline queue BEFORE any network attempt, then drained. */
    fun importPhotos(uris: List<Uri>) {
        if (uris.isEmpty()) return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null, uploadProgress = "0/${uris.size}") }
            var prepFailures = 0
            var firstPrepFailure: String? = null
            uris.forEachIndexed { index, uri ->
                runCatching {
                    val photo = container.photoImporter.prepare(uri)
                    val now = System.currentTimeMillis()
                    val entry = Entry(
                        id = ApiClient.newEntryId(),
                        createdAt = photo.takenAt,
                        takenAt = photo.takenAt,
                        uploadedAt = now,
                        dateSource = photo.dateSource,
                        yearMonth = SimpleDateFormat("yyyy-MM", Locale.US).format(Date(photo.takenAt)),
                        status = "new",
                        title = "未命名记忆",
                        userId = _state.value.user?.id.orEmpty(),
                        ownerId = _state.value.user?.id.orEmpty(),
                        clientUploadId = UUID.randomUUID().toString(),
                    )
                    container.uploadQueue.enqueue(entry, photo.jpeg, photo.thumb)
                }.onFailure { error ->
                    prepFailures++
                    if (firstPrepFailure == null) firstPrepFailure = error.message ?: error::class.simpleName ?: "未知错误"
                }
                _state.update { it.copy(uploadProgress = "${index + 1}/${uris.size}") }
            }
            _state.update { it.copy(uploadProgress = "") }
            drainQueue(interactive = true, extraFailures = prepFailures, extraFirstFailure = firstPrepFailure)
            _state.update { it.copy(loading = false) }
        }
    }

    /**
     * Drains all queued items sequentially: uploads (reusing the stored clientUploadId so
     * server-side retries dedup), removes on success, and applies HTTP-error/duplicate/network
     * semantics per item. Guarded by [drainMutex] so only one drain runs at a time.
     */
    private suspend fun drainQueue(interactive: Boolean, extraFailures: Int = 0, extraFirstFailure: String? = null) {
        drainMutex.withLock {
            val result = runDrainLocked(interactive)
            val failCount = result.failCount + extraFailures
            val firstFailure = result.firstFailure ?: extraFirstFailure
            refreshPendingDecisionCount()
            val processed = result.successCount + result.skipCount + failCount
            if (processed > 0) {
                _state.update { it.showToast(drainSummary(result.successCount, result.skipCount, failCount, firstFailure)) }
            }
            if (result.successCount > 0) {
                loadHome(clearError = false)
                if (interactive) {
                    result.lastUploaded?.let { created ->
                        _state.update { it.copy(sessionEntry = created, navigateToSession = true) }
                        openEntry(created)
                    }
                }
            }
        }
    }

    private data class DrainResult(
        val successCount: Int = 0,
        val skipCount: Int = 0,
        val failCount: Int = 0,
        val firstFailure: String? = null,
        val lastUploaded: Entry? = null,
    )

    private suspend fun runDrainLocked(interactive: Boolean): DrainResult {
        val queue = container.uploadQueue
        val pending = queue.list().filter { it.state == UploadQueue.STATE_PENDING }
        if (pending.isEmpty()) return DrainResult()
        var successCount = 0
        var skipCount = 0
        var failCount = 0
        var firstFailure: String? = null
        var lastUploaded: Entry? = null
        for ((index, manifest) in pending.withIndex()) {
            _state.update { it.copy(uploadProgress = "${index + 1}/${pending.size}") }
            val jpeg = queue.loadImage(manifest.clientUploadId)
            val thumb = queue.loadThumb(manifest.clientUploadId)
            if (jpeg == null || thumb == null) {
                queue.remove(manifest.clientUploadId)
                failCount++
                if (firstFailure == null) firstFailure = "文件已丢失"
                continue
            }
            try {
                val uploaded = api.uploadEntry(manifest.entry, jpeg, thumb)
                queue.remove(manifest.clientUploadId)
                successCount++
                lastUploaded = uploaded
            } catch (e: ApiException) {
                when {
                    // Server keyring is empty (restart): the unlock overlay will take over via
                    // the api.keysLocked hook — leave this item pending, don't count it as a
                    // failure or toast about it.
                    e.code == "E_KEYS_LOCKED" -> break
                    e.code == "DUPLICATE_IMAGE" && interactive -> {
                        if (confirmDuplicateUpload()) {
                            try {
                                val uploaded = api.uploadEntry(manifest.entry, jpeg, thumb, override = true)
                                queue.remove(manifest.clientUploadId)
                                successCount++
                                lastUploaded = uploaded
                            } catch (e2: ApiException) {
                                queue.remove(manifest.clientUploadId)
                                failCount++
                                if (firstFailure == null) firstFailure = e2.message
                            } catch (e2: IOException) {
                                break // network dropped mid-decision; stays queued for a later drain
                            }
                        } else {
                            queue.remove(manifest.clientUploadId)
                            skipCount++
                        }
                    }
                    e.code == "DUPLICATE_IMAGE" -> queue.updateState(manifest.clientUploadId, UploadQueue.STATE_NEEDS_DECISION)
                    else -> {
                        val attempts = queue.incrementAttempts(manifest.clientUploadId)
                        failCount++
                        if (firstFailure == null) firstFailure = e.message
                        if (attempts >= UploadQueue.MAX_ATTEMPTS) queue.remove(manifest.clientUploadId)
                    }
                }
            } catch (e: IOException) {
                break // network-layer failure: stop draining, remaining items stay pending for later
            }
        }
        _state.update { it.copy(uploadProgress = "") }
        return DrainResult(successCount, skipCount, failCount, firstFailure, lastUploaded)
    }

    private fun drainSummary(success: Int, skip: Int, fail: Int, firstFailure: String?): String {
        if (fail == 0 && skip == 0) return "已上传 $success 张"
        return buildString {
            append("$success 张成功")
            if (skip > 0) append("，$skip 张重复已跳过")
            if (fail > 0) append("，$fail 张失败：${firstFailure ?: "请重试"}")
        }
    }

    private fun refreshPendingDecisionCount() {
        val count = container.uploadQueue.list().count { it.state == UploadQueue.STATE_NEEDS_DECISION }
        _state.update { it.copy(pendingDecisionCount = count) }
    }

    /** Walks queued needs_decision items (from automatic drains) through the same confirm dialog. */
    fun resolvePendingDecisions() {
        viewModelScope.launch {
            drainMutex.withLock {
                val queue = container.uploadQueue
                val items = queue.list().filter { it.state == UploadQueue.STATE_NEEDS_DECISION }
                if (items.isEmpty()) return@withLock
                var successCount = 0
                var skipCount = 0
                var failCount = 0
                var firstFailure: String? = null
                var lastUploaded: Entry? = null
                for (manifest in items) {
                    val decision = CompletableDeferred<Boolean>()
                    pendingWalkDecision = decision
                    _state.update { it.copy(pendingDecisionPrompt = true) }
                    val createAnyway = decision.await()
                    pendingWalkDecision = null
                    _state.update { it.copy(pendingDecisionPrompt = false) }
                    if (!createAnyway) {
                        queue.remove(manifest.clientUploadId)
                        skipCount++
                        continue
                    }
                    val jpeg = queue.loadImage(manifest.clientUploadId)
                    val thumb = queue.loadThumb(manifest.clientUploadId)
                    if (jpeg == null || thumb == null) {
                        queue.remove(manifest.clientUploadId)
                        failCount++
                        continue
                    }
                    try {
                        val uploaded = api.uploadEntry(manifest.entry, jpeg, thumb, override = true)
                        queue.remove(manifest.clientUploadId)
                        successCount++
                        lastUploaded = uploaded
                    } catch (e: ApiException) {
                        queue.remove(manifest.clientUploadId)
                        failCount++
                        if (firstFailure == null) firstFailure = e.message
                    } catch (e: IOException) {
                        break // network dropped mid-decision; item stays needs_decision for another tap
                    }
                }
                refreshPendingDecisionCount()
                val processed = successCount + skipCount + failCount
                if (processed > 0) _state.update { it.showToast(drainSummary(successCount, skipCount, failCount, firstFailure)) }
                if (successCount > 0) {
                    loadHome(clearError = false)
                    lastUploaded?.let { created ->
                        _state.update { it.copy(sessionEntry = created, navigateToSession = true) }
                        openEntry(created)
                    }
                }
            }
        }
    }

    /** Called by the UI's confirm dialog while walking needs_decision items. */
    fun resolvePendingDecisionChoice(createAnyway: Boolean) {
        pendingWalkDecision?.complete(createAnyway)
    }

    private suspend fun confirmDuplicateUpload(): Boolean {
        val decision = CompletableDeferred<Boolean>()
        duplicateDecision = decision
        _state.update { it.copy(duplicatePrompt = true) }
        return try {
            decision.await()
        } finally {
            duplicateDecision = null
            _state.update { it.copy(duplicatePrompt = false) }
        }
    }

    /** Called by the UI's confirm dialog: true = create anyway, false = skip this photo. */
    fun resolveDuplicatePrompt(createAnyway: Boolean) {
        duplicateDecision?.complete(createAnyway)
    }

    fun consumeSessionNavigation() {
        _state.update { it.copy(navigateToSession = false) }
    }

    fun loadProfile() {
        viewModelScope.launch {
            runCatching { api.profile() }
                .onSuccess { p -> _state.update { it.copy(profile = p) } }
                .onFailure { e -> _state.update { it.copy(error = e.message) } }
        }
    }

    fun savePersonality(text: String) = profileAction { api.savePersonality(text) }
    fun editMemory(id: String, text: String) = profileAction { api.editMemory(id, text) }
    fun deleteMemory(id: String) = profileAction { api.deleteMemory(id) }

    private fun profileAction(action: suspend () -> ProfileData) {
        viewModelScope.launch {
            runCatching { action() }
                .onSuccess { profile -> _state.update { it.copy(profile = profile).showToast("已保存") } }
                .onFailure { e -> _state.update { it.copy(error = e.message).showToast("保存失败") } }
        }
    }

    fun loadPeople() {
        viewModelScope.launch {
            runCatching { api.people() to api.unassignedFaces() }
                .onSuccess { (people, faces) -> _state.update { it.copy(people = people, unassignedFaces = faces) } }
                .onFailure { e -> _state.update { it.copy(error = e.message) } }
        }
    }

    fun createPerson(
        name: String,
        relation: String,
        isUser: Boolean = false,
        samples: List<FaceRef> = emptyList(),
        toast: String? = null,
    ) = peopleAction(refreshEntryIds = samples.map { it.entryId }, successToast = toast) {
        api.createPerson(name, relation, isUser, samples)
    }

    // 改名/改关系不影响条目内容，无需刷新条目。
    fun updatePerson(id: String, name: String, relation: String, isUser: Boolean? = null) = peopleAction {
        api.updatePerson(id, name, relation, isUser)
    }

    fun assignFaces(id: String, samples: List<FaceRef>, toast: String? = null) =
        peopleAction(refreshEntryIds = samples.map { it.entryId }, successToast = toast) {
            api.updatePerson(id, addSamples = samples)
        }

    // 合并/删除人物会改写未知数量条目中的人物引用，客户端无法定位受影响条目，保留全量刷新。
    fun mergePerson(targetId: String, fromId: String) =
        peopleAction(fullRefresh = true) { api.mergePerson(targetId, fromId) }

    fun deletePerson(id: String) = peopleAction(fullRefresh = true) { api.deletePerson(id) }

    private fun peopleAction(
        refreshEntryIds: List<String> = emptyList(),
        fullRefresh: Boolean = false,
        successToast: String? = null,
        action: suspend () -> Unit,
    ) {
        viewModelScope.launch {
            runCatching { action() }
                .onSuccess {
                    loadPeople()
                    if (fullRefresh) loadHome() else refreshEntries(refreshEntryIds)
                    _state.update { it.showToast(successToast ?: "人物已更新") }
                }
                .onFailure { e -> _state.update { it.copy(error = e.message).showToast("人物更新失败") } }
        }
    }

    /** 只重新拉取受影响的条目并更新本地列表，替代全量 loadHome。 */
    private suspend fun refreshEntries(ids: List<String>) {
        for (id in ids.distinct()) {
            val updated = runCatching { api.getEntry(id) }.getOrNull() ?: continue
            _state.update { state ->
                state.copy(
                    entries = state.entries.map { if (it.id == id) updated else it },
                    sessionEntry = if (state.sessionEntry?.id == id) updated else state.sessionEntry,
                )
            }
        }
    }

    fun loadFaceThumb(ref: FaceRef) {
        val key = "${ref.entryId}:${ref.faceIndex}"
        if (_state.value.faceThumbs.containsKey(key)) return
        viewModelScope.launch {
            runCatching { api.faceThumb(ref.entryId, ref.faceIndex) }.onSuccess { bytes ->
                _state.update { it.copy(faceThumbs = it.faceThumbs.putCapped(key, bytes)) }
            }
        }
    }

    /** 仅切换选中月份，不触发网络——网络加载统一由 ReviewOverlay 的 LaunchedEffect 驱动。 */
    fun setSelectedMonth(yearMonth: String) {
        _state.update { it.copy(selectedMonth = yearMonth) }
    }

    fun loadMonthly(yearMonth: String) {
        monthlyJob?.cancel()
        monthlyJob = viewModelScope.launch {
            _state.update { it.copy(selectedMonth = yearMonth, monthlyReview = null, monthlyStream = "") }
            runCatching { api.getMonthly(yearMonth) }
                .onSuccess { review ->
                    _state.update { if (it.selectedMonth != yearMonth) it else it.copy(monthlyReview = review) }
                }
                .onFailure { e ->
                    if (e is CancellationException) throw e
                    _state.update { if (it.selectedMonth != yearMonth) it else it.copy(error = e.message) }
                }
        }
    }

    fun generateMonthly() {
        val month = _state.value.selectedMonth.ifBlank {
            SimpleDateFormat("yyyy-MM", Locale.US).format(Date())
        }
        if (_state.value.busy) return
        monthlyJob?.cancel()
        monthlyJob = viewModelScope.launch {
            _state.update { it.copy(busy = true, monthlyStream = "") }
            runCatching {
                var last = ""
                api.streamMonthly(month).collect { text ->
                    last = text
                    _state.update { if (it.selectedMonth != month) it else it.copy(monthlyStream = text) }
                }
                last
            }.onSuccess { text ->
                _state.update {
                    if (it.selectedMonth != month) return@update it
                    it.copy(
                        busy = false,
                        monthlyReview = MonthlyReview(month, text, System.currentTimeMillis()),
                    )
                }
            }.onFailure { e ->
                if (e is CancellationException) throw e
                _state.update {
                    if (it.selectedMonth != month) it.copy(busy = false)
                    else it.copy(busy = false, error = e.message).showToast("月报生成失败")
                }
            }
        }
    }

    fun changePassword(current: String, next: String) {
        viewModelScope.launch {
            runCatching { api.changePassword(current, next) }
                .onSuccess { response -> _state.update { it.copy(user = response.user).showToast("密码已修改") } }
                .onFailure { e -> _state.update { it.showToast(friendlyError(e, "密码修改失败") ?: "密码修改失败") } }
        }
    }

    fun regenerateRecoveryCode(currentPassword: String) {
        viewModelScope.launch {
            runCatching { api.regenerateRecoveryCode(currentPassword) }
                .onSuccess { code -> _state.update { it.copy(recoveryCode = code) } }
                .onFailure { e -> _state.update { it.showToast(friendlyError(e, "获取恢复码失败") ?: "获取恢复码失败") } }
        }
    }

    fun ackRecoveryCode() = _state.update { it.copy(recoveryCode = null) }

    /** Family membership panel data: current family (if any) + pending invites addressed to me. */
    fun loadFamilyPanel() {
        viewModelScope.launch {
            val user = _state.value.user ?: return@launch
            val info = if (user.familyId != null) runCatching { api.fetchFamily() }.getOrNull() else null
            val invites = if (user.accountType == "personal") {
                runCatching { api.myInvites() }.getOrNull().orEmpty()
            } else {
                emptyList()
            }
            _state.update { it.copy(familyInfo = info, myInvites = invites) }
        }
    }

    /** Mirrors Web's FamilyPanel act(): single busy gate, apply the inline user (when the
     *  response carries one), refresh the panel, toast. */
    private fun runFamilyAction(key: String, okToast: String, block: suspend () -> AuthUser?) {
        if (_state.value.familyBusyKey != null) return
        viewModelScope.launch {
            _state.update { it.copy(familyBusyKey = key) }
            runCatching { block() }
                .onSuccess { user ->
                    _state.update { s -> (if (user != null) s.copy(user = user) else s).showToast(okToast) }
                    loadFamilyPanel()
                    loadPeople()
                }
                .onFailure { e -> _state.update { it.showToast(friendlyError(e, "操作失败") ?: "操作失败") } }
            _state.update { it.copy(familyBusyKey = null) }
        }
    }

    fun createFamily(name: String?) = runFamilyAction("create", "家庭已创建") { api.createFamily(name).user }
    fun sendFamilyInvite(username: String) = runFamilyAction("invite", "邀请已发送") { api.sendFamilyInvite(username); null }
    fun revokeFamilyInvite(id: String) = runFamilyAction("revoke:$id", "已撤回") { api.revokeFamilyInvite(id); null }
    fun acceptInvite(id: String) = runFamilyAction("accept:$id", "已加入家庭") { api.acceptInvite(id).user }
    fun declineInvite(id: String) = runFamilyAction("decline:$id", "已拒绝") { api.declineInvite(id); null }
    fun leaveFamily() = runFamilyAction("leave", "已退出家庭") { api.leaveFamily().user }
    fun removeFamilyMember(id: String) = runFamilyAction("remove:$id", "已移出家庭") { api.removeFamilyMember(id); null }

    fun loadGraph() {
        viewModelScope.launch {
            _state.update { it.copy(graphLoading = true) }
            runCatching { api.graph() }
                .onSuccess { res -> _state.update { it.copy(graphNodes = res.nodes, graphEdges = res.edges, graphLoading = false) } }
                .onFailure { e -> _state.update { it.copy(graphLoading = false, error = e.message) } }
        }
    }

    fun deleteGraphEdge(id: String) {
        viewModelScope.launch {
            runCatching { api.deleteRelationship(id) }
                .onSuccess { _state.update { it.copy(graphEdges = it.graphEdges.filterNot { e -> e.id == id }) } }
                .onFailure { _state.update { it.showToast("没删掉,稍后再试") } }
        }
    }

    fun saveDiary(title: String, body: String) {
        val entry = _state.value.sessionEntry ?: return
        viewModelScope.launch {
            runCatching {
                api.patchEntry(entry.id, mapOf(
                    "title" to JsonPrimitive(title.trim().ifBlank { "未命名记忆" }),
                    "diaryText" to JsonPrimitive(body.trim()),
                ))
            }.onSuccess { updated ->
                _state.update {
                    it.copy(
                        sessionEntry = if (it.sessionEntry?.id == updated.id) updated else it.sessionEntry,
                        entries = it.entries.map { e -> if (e.id == updated.id) updated else e },
                    ).showToast("日记已保存")
                }
            }.onFailure { e -> _state.update { it.copy(error = e.message).showToast("保存失败") } }
        }
    }

    fun setTakenAt(timestamp: Long) {
        val entry = _state.value.sessionEntry ?: return
        viewModelScope.launch {
            runCatching { api.patchEntry(entry.id, mapOf(
                "takenAt" to JsonPrimitive(timestamp),
                "dateSource" to JsonPrimitive("manual"),
            )) }.onSuccess { updated ->
                _state.update {
                    it.copy(
                        sessionEntry = if (it.sessionEntry?.id == updated.id) updated else it.sessionEntry,
                    ).showToast("日期已修改")
                }
                // 修改拍摄日期会影响时间轴排序与月份分组，排序由服务端决定，保留全量刷新。
                loadHome()
            }.onFailure { e -> _state.update { it.copy(error = e.message) } }
        }
    }

    fun setSessionTab(tab: String) = _state.update { it.copy(sessionTab = tab) }

    fun clearToast() = _state.update { it.copy(toast = null) }

    /** Set toast + bump seq so the UI restarts its timer even for a repeat message. */
    private fun UiState.showToast(message: String): UiState =
        copy(toast = message, toastSeq = toastSeq + 1)

    fun closeSession() {
        cancelSessionJobs()
        _state.update {
            it.copy(
                sessionEntry = null,
                photoBytes = null,
                depthJson = null,
                phase = "idle",
                diaryStream = "",
                busy = false,
                navigateToSession = false,
            )
        }
    }

    private fun parseDiary(raw: String): Triple<String, String, String> {
        val idx = raw.indexOf("---")
        val header = if (idx >= 0) raw.substring(0, idx) else raw
        val body = if (idx >= 0) raw.substring(idx + 3).trimStart('-', ' ', '\n') else ""
        val title = Regex("标题[::]\\s*(.+)").find(header)?.groupValues?.getOrNull(1)?.trim().orEmpty()
        val mood = Regex("心情[::]\\s*(.+)").find(header)?.groupValues?.getOrNull(1)?.trim().orEmpty()
        return Triple(title.ifBlank { "未命名记忆" }, mood, body.ifBlank { raw }.trim())
    }

    private companion object {
        const val THUMBNAIL_CONCURRENCY = 6
        const val THUMBNAIL_BATCH = 12
        const val THUMBNAIL_CACHE_BYTES = 32 * 1024 * 1024
        const val CHANGE_DEBOUNCE_MS = 1_000L
        const val CHANGE_MAX_WAIT_MS = 3_000L
        const val CHANGE_FEED_BACKOFF_MIN_MS = 1_000L
        const val CHANGE_FEED_BACKOFF_MAX_MS = 30_000L

        fun formatChineseDate(timestamp: Long): String =
            SimpleDateFormat("yyyy年M月d日", Locale.CHINA).format(Date(timestamp))
    }
}

/** 按插入顺序淘汰的容量上限 Map（近似 LRU），防止人脸缩略图无限增长。 */
private fun Map<String, ByteArray>.putCapped(
    key: String,
    value: ByteArray,
    limit: Int = 300,
): Map<String, ByteArray> {
    if (containsKey(key) || size < limit) return this + (key to value)
    val trimmed = LinkedHashMap(this)
    val iterator = trimmed.keys.iterator()
    while (trimmed.size >= limit && iterator.hasNext()) {
        iterator.next()
        iterator.remove()
    }
    trimmed[key] = value
    return trimmed
}
