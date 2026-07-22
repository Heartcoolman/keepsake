package com.nianxiang.app.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.timeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.prepareGet
import io.ktor.client.request.preparePost
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

class ApiClient(private val session: SessionStore) {
    private val refreshMutex = Mutex()

    /** Fires when any request comes back 423 E_KEYS_LOCKED: token is fine but the server
     *  keyring is empty (restart). Only a notification — the caller still sees the thrown
     *  ApiException and the unlock overlay takes over the UI; this never retries the request. */
    val keysLocked = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private val client = HttpClient(Android) {
        expectSuccess = false
        install(ContentNegotiation) { json(json) }
        install(HttpTimeout) {
            requestTimeoutMillis = 120_000
            connectTimeoutMillis = 15_000
            socketTimeoutMillis = 120_000
        }
    }

    private suspend fun base(): String = session.getBaseUrl()

    private suspend fun HttpRequestBuilder.auth() {
        session.getAccess()?.let { bearerAuth(it) }
    }

    /** Encode JsonElement as plain text so ContentNegotiation does not need JsonLiteral serializers. */
    private fun jsonBody(el: JsonElement): String = json.encodeToString(JsonElement.serializer(), el)

    private suspend fun refreshIfNeeded(res: HttpResponse): Boolean {
        if (res.status.value != 401) return false
        // Token in effect when this request went out. If it changed while we were
        // waiting for the mutex, a concurrent 401 already refreshed — reuse it
        // instead of burning another refresh + rotation for every parallel request.
        val tokenBeforeLock = session.getAccess()
        return refreshMutex.withLock {
            val current = session.getAccess()
            if (current != null && current != tokenBeforeLock) return@withLock true
            val refresh = session.getRefresh() ?: return@withLock false
            val r = client.post("${base()}/api/v1/auth/refresh") {
                contentType(ContentType.Application.Json)
                setBody(jsonBody(buildJsonObject { put("refreshToken", refresh) }))
            }
            if (!r.status.isSuccess()) {
                session.clearSession()
                return@withLock false
            }
            val body = r.body<AuthResponse>()
            session.setSession(body.accessToken, body.refreshToken, body.user)
            true
        }
    }

    private suspend inline fun <reified T> get(path: String): T {
        var res = client.get("${base()}$path") { auth() }
        if (refreshIfNeeded(res)) res = client.get("${base()}$path") { auth() }
        if (!res.status.isSuccess()) throw apiError(res)
        return res.body()
    }

    private suspend fun postRaw(path: String, body: JsonElement?, skipAuth: Boolean): HttpResponse {
        val first = client.post("${base()}$path") {
            if (!skipAuth) auth()
            contentType(ContentType.Application.Json)
            if (body != null) setBody(jsonBody(body))
        }
        if (!skipAuth && refreshIfNeeded(first)) {
            return client.post("${base()}$path") {
                auth()
                contentType(ContentType.Application.Json)
                if (body != null) setBody(jsonBody(body))
            }
        }
        return first
    }

    private suspend inline fun <reified T> post(
        path: String,
        body: JsonElement? = null,
        skipAuth: Boolean = false,
    ): T {
        val res = postRaw(path, body, skipAuth)
        if (!res.status.isSuccess()) throw apiError(res)
        return res.body()
    }

    private suspend fun apiError(res: HttpResponse): Exception {
        val text = runCatching { res.bodyAsText() }.getOrDefault(res.status.description)
        val parsed = runCatching { json.decodeFromString<ErrorBody>(text) }.getOrNull()
        val code = parsed?.error?.code.orEmpty()
        if (res.status.value == 423 && code == "E_KEYS_LOCKED") keysLocked.tryEmit(Unit)
        return ApiException(
            res.status.value,
            code,
            parsed?.error?.message ?: text,
            parsed?.duplicateOf?.id,
            parsed?.duplicateOf?.takenAt,
        )
    }

    suspend fun health(): HealthResponse =
        client.get("${base()}/api/v1/health").body()

    suspend fun bootstrap(username: String, password: String, displayName: String): AuthResponse {
        val body = post<AuthResponse>(
            "/api/v1/auth/bootstrap",
            buildJsonObject {
                put("username", username)
                put("password", password)
                if (displayName.isNotBlank()) put("displayName", displayName)
            },
            skipAuth = true,
        )
        session.setSession(body.accessToken, body.refreshToken, body.user)
        return body
    }

    suspend fun login(username: String, password: String): AuthResponse {
        val body = post<AuthResponse>(
            "/api/v1/auth/login",
            buildJsonObject {
                put("username", username)
                put("password", password)
            },
            skipAuth = true,
        )
        session.setSession(body.accessToken, body.refreshToken, body.user)
        return body
    }

    suspend fun logout() {
        runCatching {
            val res = postRaw("/api/v1/auth/logout", buildJsonObject {}, skipAuth = false)
            res.bodyAsText()
        }
        session.clearSession()
    }

    suspend fun me(): MeResponse = get("/api/v1/auth/me")

    suspend fun register(
        accountType: String,
        username: String,
        password: String,
        displayName: String? = null,
        familyName: String? = null,
        regCode: String? = null,
    ): AuthResponse {
        val body = post<AuthResponse>(
            "/api/v1/auth/register",
            buildJsonObject {
                put("accountType", accountType)
                put("username", username)
                put("password", password)
                if (!displayName.isNullOrBlank()) put("displayName", displayName)
                if (!familyName.isNullOrBlank()) put("familyName", familyName)
                if (!regCode.isNullOrBlank()) put("regCode", regCode)
            },
            skipAuth = true,
        )
        session.setSession(body.accessToken, body.refreshToken, body.user)
        return body
    }

    /** Server restarted and lost its in-memory keys: re-enter the password, same session. */
    suspend fun unlock(password: String): UnlockResponse =
        post("/api/v1/auth/unlock", buildJsonObject { put("password", password) })

    suspend fun recover(username: String, recoveryCode: String, newPassword: String): AuthResponse {
        val body = post<AuthResponse>(
            "/api/v1/auth/recover",
            buildJsonObject {
                put("username", username)
                put("recoveryCode", recoveryCode)
                put("newPassword", newPassword)
            },
            skipAuth = true,
        )
        session.setSession(body.accessToken, body.refreshToken, body.user)
        return body
    }

    suspend fun regenerateRecoveryCode(currentPassword: String): String =
        post<RecoveryCodeResponse>(
            "/api/v1/auth/me/recovery-code",
            buildJsonObject { put("currentPassword", currentPassword) },
        ).recoveryCode

    // ---------- family / invites ----------

    suspend fun fetchFamily(): FamilyInfo = get("/api/v1/family")

    suspend fun createFamily(name: String? = null): FamilyActionResponse =
        post("/api/v1/family", buildJsonObject { if (!name.isNullOrBlank()) put("name", name) })

    suspend fun sendFamilyInvite(username: String): FamilyInvite =
        post("/api/v1/family/invites", buildJsonObject { put("username", username) })

    suspend fun revokeFamilyInvite(id: String) {
        deleteUnit("/api/v1/family/invites/$id")
    }

    suspend fun myInvites(): List<MyInvite> = get<MyInvitePage>("/api/v1/me/invites").items

    suspend fun acceptInvite(id: String): FamilyActionResponse =
        post("/api/v1/me/invites/$id/accept", buildJsonObject {})

    suspend fun declineInvite(id: String) {
        post<OkResponse>("/api/v1/me/invites/$id/decline", buildJsonObject {})
    }

    suspend fun leaveFamily(): FamilyActionResponse =
        post("/api/v1/me/family/leave", buildJsonObject {})

    suspend fun removeFamilyMember(id: String) {
        deleteUnit("/api/v1/family/members/$id")
    }

    // ---------- relationship graph ----------

    suspend fun graph(): GraphResponse = get("/api/v1/graph")

    suspend fun deleteRelationship(id: String) {
        var res = client.delete("${base()}/api/v1/relationships/$id") { auth() }
        if (refreshIfNeeded(res)) res = client.delete("${base()}/api/v1/relationships/$id") { auth() }
        if (!res.status.isSuccess() && res.status.value != 404) throw apiError(res)
    }

    suspend fun listEntries(cursor: String? = null, limit: Int = 50): EntryPage {
        var res = client.get("${base()}/api/v1/entries") {
            auth()
            parameter("limit", limit)
            if (cursor != null) parameter("cursor", cursor)
        }
        if (refreshIfNeeded(res)) {
            res = client.get("${base()}/api/v1/entries") {
                auth()
                parameter("limit", limit)
                if (cursor != null) parameter("cursor", cursor)
            }
        }
        if (!res.status.isSuccess()) throw apiError(res)
        return res.body()
    }

    suspend fun getEntry(id: String): Entry = get("/api/v1/entries/$id")

    suspend fun uploadEntry(meta: Entry, jpeg: ByteArray, thumb: ByteArray, override: Boolean = false): Entry {
        suspend fun once() = client.post("${base()}/api/v1/entries") {
            auth()
            setBody(
                MultiPartFormDataContent(
                    formData {
                        append("meta", json.encodeToString(meta))
                        if (override) append("override", "1")
                        append(
                            "image",
                            jpeg,
                            Headers.build {
                                append(HttpHeaders.ContentType, "image/jpeg")
                                append(HttpHeaders.ContentDisposition, "filename=\"image.jpg\"")
                            },
                        )
                        append(
                            "thumb",
                            thumb,
                            Headers.build {
                                append(HttpHeaders.ContentType, "image/jpeg")
                                append(HttpHeaders.ContentDisposition, "filename=\"thumb.jpg\"")
                            },
                        )
                    },
                ),
            )
        }
        var res = once()
        if (refreshIfNeeded(res)) res = once()
        if (!res.status.isSuccess()) throw apiError(res)
        return res.body()
    }

    suspend fun patchEntry(id: String, patch: Map<String, kotlinx.serialization.json.JsonElement>): Entry {
        return postPatch(id, patch)
    }

    private suspend fun postPatch(id: String, patch: Map<String, kotlinx.serialization.json.JsonElement>): Entry {
        val payload = jsonBody(JsonObject(patch))
        val first = client.patch("${base()}/api/v1/entries/$id") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(payload)
        }
        val res = if (refreshIfNeeded(first)) {
            client.patch("${base()}/api/v1/entries/$id") {
                auth()
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
        } else first
        if (!res.status.isSuccess()) throw apiError(res)
        return res.body()
    }

    suspend fun deleteEntry(id: String) {
        var res = client.delete("${base()}/api/v1/entries/$id") { auth() }
        if (refreshIfNeeded(res)) res = client.delete("${base()}/api/v1/entries/$id") { auth() }
        if (!res.status.isSuccess() && res.status.value != 404) throw apiError(res)
    }

    suspend fun mediaBytes(entryId: String, kind: String): ByteArray {
        var res = client.get("${base()}/api/v1/entries/$entryId/media/$kind") { auth() }
        if (refreshIfNeeded(res)) res = client.get("${base()}/api/v1/entries/$entryId/media/$kind") { auth() }
        if (!res.status.isSuccess()) throw apiError(res)
        return res.body()
    }

    suspend fun depthJson(entryId: String): String {
        var res = client.get("${base()}/api/v1/entries/$entryId/depth") { auth() }
        if (refreshIfNeeded(res)) res = client.get("${base()}/api/v1/entries/$entryId/depth") { auth() }
        if (!res.status.isSuccess()) throw apiError(res)
        return res.bodyAsText()
    }

    suspend fun sessionOpen(entryId: String, force: Boolean = false): SessionOpenResponse =
        post(
            "/api/v1/entries/$entryId/session/open",
            buildJsonObject { put("force", force) },
        )

    fun sessionMessage(entryId: String, text: String): Flow<String> =
        streamSse(
            "/api/v1/entries/$entryId/session/message",
            buildJsonObject { put("text", text) },
        )

    fun sessionComplete(entryId: String, force: Boolean = false): Flow<String> =
        streamSse(
            "/api/v1/entries/$entryId/session/complete",
            buildJsonObject { put("force", force) },
        )

    fun streamChat(entryId: String, messages: List<ChatMessage>): Flow<String> =
        streamSse("/api/v1/entries/$entryId/chat", buildJsonObject {
            put("messages", messagesToJson(messages))
        })

    fun streamDiary(entryId: String, messages: List<ChatMessage>, dateStr: String, mood: String): Flow<String> =
        streamSse("/api/v1/entries/$entryId/diary", buildJsonObject {
            put("messages", messagesToJson(messages))
            put("dateStr", dateStr)
            put("mood", mood)
        })

    fun streamMonthly(yearMonth: String): Flow<String> =
        streamSse("/api/v1/monthly/$yearMonth/generate", buildJsonObject {})

    /**
     * GET-shaped SSE (unlike [streamSse], which is POST-shaped): one streaming connection to
     * the change feed starting at [since]. Emits every frame (cursor/change/resync/ping) as
     * they arrive; completes normally on a clean server-side close, throws on network failure.
     * Reconnect policy (backoff, resuming from the last seen seq) is the caller's job.
     */
    fun changeFeed(since: Long): Flow<ChangeEvent> = flow {
        var refreshed = false
        while (true) {
            var retry = false
            client.prepareGet("${base()}/api/v1/entries/changes") {
                auth()
                parameter("since", since)
                header(HttpHeaders.Accept, "text/event-stream")
                timeout {
                    requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                    socketTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                }
            }.execute { response ->
                if (response.status.value == 401 && !refreshed && refreshIfNeeded(response)) {
                    retry = true
                    return@execute
                }
                if (!response.status.isSuccess()) throw apiError(response)
                val channel = response.bodyAsChannel()
                while (!channel.isClosedForRead) {
                    val line = channel.readUTF8Line() ?: break
                    if (!line.startsWith("data:")) continue
                    val data = line.removePrefix("data:").trim()
                    if (data.isEmpty()) continue
                    val event = runCatching { json.decodeFromString<ChangeEvent>(data) }.getOrNull() ?: continue
                    emit(event)
                }
            }
            if (retry) {
                refreshed = true
                continue
            }
            break
        }
    }.flowOn(Dispatchers.IO)

    suspend fun getMonthly(yearMonth: String): MonthlyReview? {
        val res = client.get("${base()}/api/v1/monthly/$yearMonth") { auth() }
        if (res.status.value == 404) return null
        if (!res.status.isSuccess()) {
            if (refreshIfNeeded(res)) {
                val r2 = client.get("${base()}/api/v1/monthly/$yearMonth") { auth() }
                if (r2.status.value == 404) return null
                if (!r2.status.isSuccess()) throw apiError(r2)
                return r2.body()
            }
            throw apiError(res)
        }
        return res.body()
    }

    suspend fun profile(): ProfileData = get("/api/v1/me/profile")

    suspend fun savePersonality(text: String): ProfileData {
        val payload = jsonBody(buildJsonObject { put("personality", text) })
        val first = client.patch("${base()}/api/v1/me/profile") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(payload)
        }
        val res = if (refreshIfNeeded(first)) {
            client.patch("${base()}/api/v1/me/profile") {
                auth()
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
        } else first
        if (!res.status.isSuccess()) throw apiError(res)
        return res.body()
    }

    suspend fun people(): List<PersonDto> = get<PeoplePage>("/api/v1/people").items

    suspend fun createPerson(
        name: String,
        relation: String,
        isUser: Boolean = false,
        samples: List<FaceRef> = emptyList(),
    ): PersonDto =
        post("/api/v1/people", buildJsonObject {
            put("name", name)
            put("relation", relation)
            put("isUser", isUser)
            put("samples", faceRefsJson(samples))
        })

    suspend fun updatePerson(
        id: String,
        name: String? = null,
        relation: String? = null,
        isUser: Boolean? = null,
        addSamples: List<FaceRef> = emptyList(),
    ): PersonDto = patchJson("/api/v1/people/$id", buildJsonObject {
        if (name != null) put("name", name)
        if (relation != null) put("relation", relation)
        if (isUser != null) put("isUser", isUser)
        if (addSamples.isNotEmpty()) put("addSamples", faceRefsJson(addSamples))
    })

    suspend fun mergePerson(targetId: String, fromId: String): PersonDto =
        post("/api/v1/people/$targetId/merge", buildJsonObject { put("fromId", fromId) })

    suspend fun deletePerson(id: String) {
        deleteUnit("/api/v1/people/$id")
    }

    suspend fun unassignedFaces(): List<FaceCluster> =
        get<FaceClusterPage>("/api/v1/faces/unassigned").items

    suspend fun faceThumb(entryId: String, faceIndex: Int): ByteArray =
        getBytes("/api/v1/entries/$entryId/faces/$faceIndex/thumb")

    suspend fun editMemory(id: String, text: String): ProfileData =
        patchJson("/api/v1/me/memories/$id", buildJsonObject { put("text", text) })

    suspend fun deleteMemory(id: String): ProfileData = deleteJson("/api/v1/me/memories/$id")

    suspend fun users(): List<AuthUser> = get<UserPage>("/api/v1/users").items

    suspend fun changePassword(currentPassword: String, newPassword: String): AuthResponse {
        val body = patchJson<AuthResponse>("/api/v1/auth/me/password", buildJsonObject {
            put("currentPassword", currentPassword)
            put("newPassword", newPassword)
        })
        session.setSession(body.accessToken, body.refreshToken, body.user)
        return body
    }

    private suspend inline fun <reified T> patchJson(path: String, body: JsonObject): T {
        val payload = jsonBody(body)
        var res = client.patch("${base()}$path") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(payload)
        }
        if (refreshIfNeeded(res)) {
            res = client.patch("${base()}$path") {
                auth()
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
        }
        if (!res.status.isSuccess()) throw apiError(res)
        return res.body()
    }

    private suspend inline fun <reified T> deleteJson(path: String): T {
        var res = client.delete("${base()}$path") { auth() }
        if (refreshIfNeeded(res)) res = client.delete("${base()}$path") { auth() }
        if (!res.status.isSuccess()) throw apiError(res)
        return res.body()
    }

    private suspend fun deleteUnit(path: String) {
        deleteJson<OkResponse>(path)
    }

    private suspend fun getBytes(path: String): ByteArray {
        suspend fun once() = client.get("${base()}$path") { auth() }
        var res = once()
        if (refreshIfNeeded(res)) res = once()
        if (!res.status.isSuccess()) throw apiError(res)
        return res.body()
    }

    private fun streamSse(path: String, body: JsonObject): Flow<String> = flow {
        val payload = jsonBody(body)
        var refreshed = false
        while (true) {
            var retry = false
            var sawDone = false
            var full = ""
            client.preparePost("${base()}$path") {
                auth()
                contentType(ContentType.Application.Json)
                setBody(payload)
                header(HttpHeaders.Accept, "text/event-stream")
                timeout {
                    // LLM 长时间不吐字且无心跳时，默认 120s 的 socket 超时会掐断流。
                    requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                    socketTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                }
            }.execute { response ->
                if (response.status.value == 401 && !refreshed && refreshIfNeeded(response)) {
                    retry = true
                    return@execute
                }
                if (!response.status.isSuccess()) throw apiError(response)
                val contentType = response.contentType()?.toString().orEmpty()
                // session/complete may return JSON {entry,skipped:true} for idempotent redo.
                if (contentType.contains("application/json", ignoreCase = true)) {
                    val text = response.bodyAsText()
                    val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
                    val diary = obj?.get("entry")?.jsonObject
                        ?.get("diaryText")?.jsonPrimitive?.content
                        .orEmpty()
                    if (diary.isNotEmpty()) {
                        full = diary
                        emit(full)
                    }
                    sawDone = true
                    return@execute
                }
                val channel = response.bodyAsChannel()
                while (!channel.isClosedForRead) {
                    val line = channel.readUTF8Line() ?: break
                    if (!line.startsWith("data:")) continue
                    val event = line.removePrefix("data:").trim()
                    if (event.isEmpty()) continue
                    val obj = runCatching { json.parseToJsonElement(event).jsonObject }.getOrNull() ?: continue
                    when (obj["type"]?.jsonPrimitive?.content) {
                        "delta" -> {
                            full += obj["text"]?.jsonPrimitive?.content ?: ""
                            emit(full)
                        }
                        "done" -> {
                            sawDone = true
                            return@execute
                        }
                        "error" -> throw ApiException(
                            502,
                            obj["code"]?.jsonPrimitive?.content ?: "UPSTREAM",
                            obj["message"]?.jsonPrimitive?.content ?: "stream error",
                        )
                    }
                }
            }
            if (retry) {
                refreshed = true
                continue
            }
            if (!sawDone) throw ApiException(502, "UPSTREAM", "stream ended before completion")
            break
        }
    }.flowOn(Dispatchers.IO)

    private fun faceRefsJson(refs: List<FaceRef>): JsonArray = buildJsonArray {
        refs.forEach { ref ->
            add(buildJsonObject {
                put("entryId", ref.entryId)
                put("faceIndex", ref.faceIndex)
            })
        }
    }

    private fun messagesToJson(messages: List<ChatMessage>): JsonArray = buildJsonArray {
        messages.forEach { m ->
            add(
                buildJsonObject {
                    put("role", m.role)
                    put("content", m.content)
                },
            )
        }
    }

    companion object {
        fun newEntryId(): String = UUID.randomUUID().toString()
    }
}
