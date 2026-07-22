package com.nianxiang.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class UploadQueueTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var dir: File
    private lateinit var queue: UploadQueue

    @Before
    fun setUp() {
        dir = tempFolder.newFolder("upload_queue")
        queue = UploadQueue(dir)
    }

    private fun entry(id: String, clientUploadId: String) = Entry(
        id = id,
        takenAt = 1000L,
        dateSource = "exif",
        clientUploadId = clientUploadId,
    )

    @Test
    fun `enqueue persists manifest and both blobs`() {
        val jpeg = byteArrayOf(1, 2, 3)
        val thumb = byteArrayOf(4, 5)
        queue.enqueue(entry("e1", "c1"), jpeg, thumb)

        assertTrue(File(dir, "c1.json").exists())
        assertTrue(File(dir, "c1.img").exists())
        assertTrue(File(dir, "c1.thumb").exists())
        assertEquals(UploadQueue.STATE_PENDING, queue.list().single().state)
        assertEquals(0, queue.list().single().attempts)
    }

    @Test
    fun `list returns enqueued order`() {
        queue.enqueue(entry("e1", "c1"), byteArrayOf(1), byteArrayOf(1))
        queue.enqueue(entry("e2", "c2"), byteArrayOf(2), byteArrayOf(2))
        queue.enqueue(entry("e3", "c3"), byteArrayOf(3), byteArrayOf(3))

        val ids = queue.list().map { it.clientUploadId }
        assertEquals(listOf("c1", "c2", "c3"), ids)
    }

    @Test
    fun `state transitions from pending to needs_decision`() {
        queue.enqueue(entry("e1", "c1"), byteArrayOf(1), byteArrayOf(1))
        queue.updateState("c1", UploadQueue.STATE_NEEDS_DECISION)

        assertEquals(UploadQueue.STATE_NEEDS_DECISION, queue.list().single().state)
    }

    @Test
    fun `attempts increment persists across reads`() {
        queue.enqueue(entry("e1", "c1"), byteArrayOf(1), byteArrayOf(1))

        assertEquals(1, queue.incrementAttempts("c1"))
        assertEquals(2, queue.incrementAttempts("c1"))
        assertEquals(2, queue.list().single().attempts)
    }

    @Test
    fun `failed item is removed once attempts reach the cap`() {
        queue.enqueue(entry("e1", "c1"), byteArrayOf(1), byteArrayOf(1))

        var attempts = 0
        repeat(UploadQueue.MAX_ATTEMPTS) { attempts = queue.incrementAttempts("c1") }
        assertEquals(UploadQueue.MAX_ATTEMPTS, attempts)

        if (attempts >= UploadQueue.MAX_ATTEMPTS) queue.remove("c1")

        assertTrue(queue.list().isEmpty())
        assertFalse(File(dir, "c1.json").exists())
    }

    @Test
    fun `remove deletes manifest and both blobs`() {
        queue.enqueue(entry("e1", "c1"), byteArrayOf(1), byteArrayOf(1))
        queue.remove("c1")

        assertTrue(queue.list().isEmpty())
        assertFalse(File(dir, "c1.json").exists())
        assertFalse(File(dir, "c1.img").exists())
        assertFalse(File(dir, "c1.thumb").exists())
        assertNull(queue.loadImage("c1"))
        assertNull(queue.loadThumb("c1"))
    }

    @Test
    fun `corrupted manifest is skipped without crashing`() {
        queue.enqueue(entry("e1", "c1"), byteArrayOf(1), byteArrayOf(1))
        File(dir, "broken.json").writeText("{ not valid json")

        val items = queue.list()

        assertEquals(1, items.size)
        assertEquals("c1", items.single().clientUploadId)
    }
}
