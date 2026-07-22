/** PUBLIC STUB — the depth→particle placement algorithm (ParticleDepth), sampling
 *  budget logic and particle data layout live in the private core module. The scene
 *  state types below are pure data shared with the UI layer and stay real. */
package com.nianxiang.app.particle

import org.json.JSONObject
import java.util.Base64

enum class ParticleAmbience { NONE, DUST, RAIN, SNOW }

sealed interface ParticleMode {
    data object Timeline : ParticleMode
    data object Loading : ParticleMode
    data object Chat : ParticleMode
    data class Condensing(val lines: List<String>) : ParticleMode
    data class Diary(val mood: String) : ParticleMode
    data object Hidden : ParticleMode
}

data class ParticleSceneState(
    val photoId: String? = null,
    val jpeg: ByteArray? = null,
    val depthJson: String? = null,
    val mode: ParticleMode = ParticleMode.Timeline,
)

data class ParticlePerformanceSample(
    val framesPerSecond: Float,
    val slowFrameRatio: Float,
    val sampledFrames: Int,
)

data class DepthPayload(
    val width: Int,
    val height: Int,
    val depth: ByteArray,
    val mask: ByteArray? = null,
    val background: ByteArray? = null,
    val backgroundDepth: ByteArray? = null,
) {
    val layered: Boolean
        get() = mask != null && background != null && backgroundDepth != null

    companion object {
        fun parse(json: String?): DepthPayload? {
            if (json.isNullOrBlank()) return null
            return runCatching {
                val value = JSONObject(json)
                val width = value.getInt("width")
                val height = value.getInt("height")
                require(width in 1..4096 && height in 1..4096)
                val pixels = Math.multiplyExact(width, height)
                val depth = decode(value.getString("depth"), pixels) ?: return@runCatching null
                if (!value.optBoolean("layered", false)) {
                    return@runCatching DepthPayload(width, height, depth)
                }
                val mask = decode(value.optString("mask"), pixels)
                val background = decode(value.optString("bg"), Math.multiplyExact(pixels, 3))
                val backgroundDepth = decode(value.optString("bgDepth"), pixels)
                if (mask == null || background == null || backgroundDepth == null) {
                    DepthPayload(width, height, depth)
                } else {
                    DepthPayload(width, height, depth, mask, background, backgroundDepth)
                }
            }.getOrNull()
        }

        private fun decode(value: String, expected: Int): ByteArray? {
            if (value.isBlank()) return null
            val decoded = runCatching { Base64.getDecoder().decode(value) }.getOrNull() ?: return null
            return decoded.takeIf { it.size == expected }
        }
    }
}

internal fun ambienceForMood(mood: String): ParticleAmbience = when {
    Regex("[雨思念忧伤愁怀]").containsMatchIn(mood) -> ParticleAmbience.RAIN
    Regex("[静雪冬凉安]").containsMatchIn(mood) -> ParticleAmbience.SNOW
    else -> ParticleAmbience.DUST
}

internal fun particleModeFor(
    sessionOpen: Boolean,
    userPresent: Boolean,
    hasPhoto: Boolean,
    phase: String,
    sessionTab: String,
    mood: String,
    lines: List<String>,
): ParticleMode = when {
    !userPresent || !sessionOpen -> ParticleMode.Timeline
    !hasPhoto -> ParticleMode.Loading
    phase == "condensing" -> ParticleMode.Condensing(lines.takeLast(8))
    (phase == "revealing" || phase == "done") && sessionTab == "diary" -> ParticleMode.Diary(mood)
    else -> ParticleMode.Chat
}
