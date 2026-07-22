package com.nianxiang.app.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.URI
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val Context.dataStore by preferencesDataStore("nianxiang_session")

class SessionStore(private val context: Context) {
    private val json = Json { ignoreUnknownKeys = true }

    private val baseUrlKey = stringPreferencesKey("base_url")
    private val accessKey = stringPreferencesKey("access")
    private val refreshKey = stringPreferencesKey("refresh")
    private val userKey = stringPreferencesKey("user")

    val baseUrl: Flow<String> = context.dataStore.data.map { it[baseUrlKey] ?: DEFAULT_BASE_URL }
    val accessToken: Flow<String?> = context.dataStore.data.map { it[accessKey]?.let(::decryptOrNull) }
    val user: Flow<AuthUser?> = context.dataStore.data.map { prefs ->
        prefs[userKey]?.let { stored ->
            decryptOrNull(stored)?.let { plain -> runCatching { json.decodeFromString<AuthUser>(plain) }.getOrNull() }
        }
    }

    suspend fun getBaseUrl(): String = baseUrl.first()
    suspend fun getAccess(): String? = readToken(accessKey)
    suspend fun getRefresh(): String? = readToken(refreshKey)
    suspend fun getUser(): AuthUser? = user.first()

    /**
     * Reads and decrypts a stored token. When ciphertext exists but can no longer be
     * decrypted (Keystore key invalidated), the session is unrecoverable: purge it so
     * we stop retrying a dead token, and report null (logged out) instead of throwing.
     */
    private suspend fun readToken(key: Preferences.Key<String>): String? {
        val stored = runCatching { context.dataStore.data.first()[key] }.getOrNull() ?: return null
        val decrypted = decryptOrNull(stored)
        if (decrypted == null) runCatching { clearSession() }
        return decrypted
    }

    suspend fun setBaseUrl(url: String) {
        val normalized = url.trim().trimEnd('/')
        require(validBaseUrl(normalized)) { "公网服务器必须使用 HTTPS" }
        context.dataStore.edit { it[baseUrlKey] = normalized }
    }

    suspend fun setSession(access: String, refresh: String, user: AuthUser) {
        context.dataStore.edit {
            it[accessKey] = encrypt(access)
            it[refreshKey] = encrypt(refresh)
            it[userKey] = encrypt(json.encodeToString(user))
        }
    }

    suspend fun clearSession() {
        context.dataStore.edit {
            it.remove(accessKey)
            it.remove(refreshKey)
            it.remove(userKey)
        }
    }

    private fun validBaseUrl(value: String): Boolean {
        val uri = runCatching { URI(value) }.getOrNull() ?: return false
        if (uri.scheme == "https" && !uri.host.isNullOrBlank()) return true
        if (uri.scheme != "http") return false
        val host = uri.host?.lowercase() ?: return false
        if (host == "localhost" || host == "::1" || host.endsWith(".local")) return true
        // Cleartext only for literal private IPv4 — reject prefix tricks like 10.evil.com.
        val parts = host.split('.')
        if (parts.size != 4) return false
        val nums = parts.map { it.toIntOrNull() ?: return false }
        if (nums.any { it !in 0..255 }) return false
        val a = nums[0]
        val b = nums[1]
        if (a == 10) return true
        if (a == 127) return true
        if (a == 192 && b == 168) return true
        if (a == 172 && b in 16..31) return true
        return false
    }

    @Synchronized
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val ciphertext = Base64.encodeToString(cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
        return "enc:$iv:$ciphertext"
    }

    /**
     * The AndroidKeyStore key can be invalidated out from under us (OS upgrade,
     * backup restore, lock-screen/biometric change → AEADBadTagException, etc.).
     * Treat any decrypt failure as an expired session (null) instead of letting
     * the exception propagate out of a startup coroutine and crash-loop the app.
     */
    private fun decryptOrNull(value: String): String? = runCatching { decrypt(value) }.getOrNull()

    private fun decrypt(value: String): String {
        if (!value.startsWith("enc:")) return value
        val parts = value.split(':', limit = 3)
        if (parts.size != 3) error("invalid encrypted session")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(128, Base64.decode(parts[1], Base64.NO_WRAP)),
        )
        return cipher.doFinal(Base64.decode(parts[2], Base64.NO_WRAP)).toString(Charsets.UTF_8)
    }

    companion object {
        /** 模拟器访问宿主机的默认地址，真机需在连接设置中改为局域网服务器。 */
        const val DEFAULT_BASE_URL = "http://10.0.2.2:8787"
        private const val KEY_ALIAS = "nianxiang.session.v1"
    }
}
