package com.nianxiang.app.particle

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import kotlin.random.Random

class ParticleModelsTest {
    @Test
    fun depthPayloadParsesLayersAndFallsBackWhenLayerLengthsAreInvalid() {
        val depth = byteArrayOf(0, 64, 127, -1)
        val mask = byteArrayOf(0, -1, 0, 0)
        val background = ByteArray(12) { it.toByte() }
        val backgroundDepth = byteArrayOf(10, 20, 30, 40)
        val json = JSONObject()
            .put("width", 2)
            .put("height", 2)
            .put("layered", true)
            .put("depth", encode(depth))
            .put("mask", encode(mask))
            .put("bg", encode(background))
            .put("bgDepth", encode(backgroundDepth))
            .toString()

        val parsed = DepthPayload.parse(json)
        assertNotNull(parsed)
        assertTrue(parsed!!.layered)
        assertEquals(4, parsed.depth.size)

        val invalid = JSONObject(json).put("bg", encode(ByteArray(3))).toString()
        val fallback = DepthPayload.parse(invalid)
        assertNotNull(fallback)
        assertFalse(fallback!!.layered)
        assertNull(DepthPayload.parse("{bad"))
    }

    @Test
    fun depthMapUsesRobustRangeAndMarksBoundaries() {
        val data = fixtureData(4)
        val payload = DepthPayload(2, 2, byteArrayOf(0, 20, -56, -1))
        val result = ParticleDepth.apply(data, payload, Random(7))

        assertEquals(0.08f, result.depthScale, 0.0001f)
        assertTrue(data.target.filterIndexed { index, _ -> index % 4 == 3 }.any { it != 0f })
        assertTrue(data.visual.filterIndexed { index, _ -> index % 6 == 5 }.all { it in 0f..1f })
    }

    @Test
    fun layeredDepthReassignsOccludedBackgroundAndComputesFocusPlane() {
        val data = fixtureData(14)
        val mask = byteArrayOf(-1, 0, 0, 0)
        val background = ByteArray(12) { index -> if (index % 3 == 0) -1 else 0 }
        val payload = DepthPayload(
            width = 2,
            height = 2,
            depth = byteArrayOf(-16, 10, 20, 30),
            mask = mask,
            background = background,
            backgroundDepth = byteArrayOf(40, 50, 60, 70),
        )
        val result = ParticleDepth.apply(data, payload, Random(11))

        assertTrue(result.layered)
        assertEquals(0.34f, result.depthScale, 0.0001f)
        assertTrue(data.visual[0] > 0.9f)
        assertTrue(data.indices.toSet().size == data.count)
    }

    @Test
    fun layeredDepthUsesOneSeventhOfBudgetAndSortsFarToNear() {
        val data = fixtureData(70)
        val payload = DepthPayload(
            width = 2,
            height = 2,
            depth = byteArrayOf(-1, -32, -64, -96),
            mask = byteArrayOf(-1, -1, -1, -1),
            background = byteArrayOf(
                -1, 0, 0,
                -1, 0, 0,
                -1, 0, 0,
                -1, 0, 0,
            ),
            backgroundDepth = byteArrayOf(8, 16, 24, 32),
        )

        ParticleDepth.apply(data, payload, Random(19))

        assertEquals(10, (0 until data.count).count { data.visual[it * 6] > 0.9f })
        val sortedDepths = data.indices.map { data.target[it * 4 + 3] }
        assertTrue(sortedDepths.zipWithNext().all { (far, near) -> far <= near })
    }

    @Test
    fun moodMappingMatchesWebRules() {
        assertEquals(ParticleAmbience.RAIN, ambienceForMood("安静的思念"))
        assertEquals(ParticleAmbience.SNOW, ambienceForMood("冬日安宁"))
        assertEquals(ParticleAmbience.DUST, ambienceForMood("温暖喜悦"))
    }

    @Test
    fun sceneStateMappingCoversTimelineLoadingCondensingDiaryAndChat() {
        val messages = (1..10).map { "第 $it 句" }
        assertEquals(
            ParticleMode.Timeline,
            particleModeFor(false, true, false, "idle", "chat", "", messages),
        )
        assertEquals(
            ParticleMode.Loading,
            particleModeFor(true, true, false, "loading", "chat", "", messages),
        )
        assertEquals(
            ParticleMode.Condensing(messages.takeLast(8)),
            particleModeFor(true, true, true, "condensing", "chat", "", messages),
        )
        assertEquals(
            ParticleMode.Diary("冬日安宁"),
            particleModeFor(true, true, true, "revealing", "diary", "冬日安宁", messages),
        )
        assertEquals(
            ParticleMode.Chat,
            particleModeFor(true, true, true, "done", "chat", "冬日安宁", messages),
        )
    }

    private fun fixtureData(count: Int): ParticleData {
        val target = FloatArray(count * 4)
        val visual = FloatArray(count * 6)
        val uv = FloatArray(count * 2)
        for (i in 0 until count) {
            val u = (i % 2 + 0.5f) / 2f
            val v = (i / 2 % 2 + 0.5f) / 2f
            target[i * 4] = u - 0.5f
            target[i * 4 + 1] = 0.5f - v
            visual[i * 6] = 0.2f
            visual[i * 6 + 1] = 0.3f
            visual[i * 6 + 2] = 0.4f
            visual[i * 6 + 3] = i.toFloat() / count
            uv[i * 2] = u
            uv[i * 2 + 1] = v
        }
        return ParticleData(
            count = count,
            aspect = 1f,
            gridHeight = 2,
            state = FloatArray(count * 8),
            target = target,
            scatter = FloatArray(count * 4),
            visual = visual,
            uv = uv,
            indices = IntArray(count) { it },
        )
    }

    private fun encode(value: ByteArray): String = Base64.getEncoder().encodeToString(value)
}
