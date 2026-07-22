package com.nianxiang.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

@Serializable
data class QueueManifest(
    val clientUploadId: String,
    val entry: Entry,
    val state: String = UploadQueue.STATE_PENDING,
    val attempts: Int = 0,
    val enqueuedAt: Long = 0L,
    /** Strictly increasing insertion order; enqueuedAt alone can collide at millisecond resolution. */
    val seq: Long = 0L,
)

/**
 * File-based offline upload queue. Pure JVM (no android.* imports) so it can be constructed
 * against a plain temp directory in unit tests. The directory listing of [dir] IS the index:
 * one manifest (.json) plus image (.img) and thumbnail (.thumb) blob per item, keyed by
 * clientUploadId, sorted by enqueuedAt.
 */
class UploadQueue(private val dir: File) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    init {
        dir.mkdirs()
    }

    fun enqueue(entry: Entry, jpeg: ByteArray, thumb: ByteArray): QueueManifest {
        val nextSeq = (list().maxOfOrNull { it.seq } ?: 0L) + 1
        val manifest = QueueManifest(
            clientUploadId = entry.clientUploadId,
            entry = entry,
            enqueuedAt = System.currentTimeMillis(),
            seq = nextSeq,
        )
        imageFile(manifest.clientUploadId).writeBytes(jpeg)
        thumbFile(manifest.clientUploadId).writeBytes(thumb)
        writeManifest(manifest)
        return manifest
    }

    /** Enqueued order. Corrupted manifests are skipped rather than throwing. */
    fun list(): List<QueueManifest> {
        val files = dir.listFiles { f -> f.name.endsWith(MANIFEST_EXT) } ?: return emptyList()
        return files
            .mapNotNull { f -> runCatching { json.decodeFromString<QueueManifest>(f.readText()) }.getOrNull() }
            .sortedBy { it.seq }
    }

    fun loadImage(clientUploadId: String): ByteArray? =
        imageFile(clientUploadId).takeIf { it.exists() }?.readBytes()

    fun loadThumb(clientUploadId: String): ByteArray? =
        thumbFile(clientUploadId).takeIf { it.exists() }?.readBytes()

    fun updateState(clientUploadId: String, state: String) {
        val manifest = readManifest(clientUploadId) ?: return
        writeManifest(manifest.copy(state = state))
    }

    /** Persists attempts + 1 and returns the new count. */
    fun incrementAttempts(clientUploadId: String): Int {
        val manifest = readManifest(clientUploadId) ?: return 0
        val updated = manifest.copy(attempts = manifest.attempts + 1)
        writeManifest(updated)
        return updated.attempts
    }

    fun remove(clientUploadId: String) {
        manifestFile(clientUploadId).delete()
        imageFile(clientUploadId).delete()
        thumbFile(clientUploadId).delete()
    }

    private fun readManifest(clientUploadId: String): QueueManifest? =
        manifestFile(clientUploadId).takeIf { it.exists() }
            ?.let { f -> runCatching { json.decodeFromString<QueueManifest>(f.readText()) }.getOrNull() }

    private fun writeManifest(manifest: QueueManifest) {
        manifestFile(manifest.clientUploadId).writeText(json.encodeToString(manifest))
    }

    private fun manifestFile(id: String) = File(dir, "$id$MANIFEST_EXT")
    private fun imageFile(id: String) = File(dir, "$id.img")
    private fun thumbFile(id: String) = File(dir, "$id.thumb")

    companion object {
        const val STATE_PENDING = "pending"
        const val STATE_NEEDS_DECISION = "needs_decision"
        const val MAX_ATTEMPTS = 5
        private const val MANIFEST_EXT = ".json"
    }
}
