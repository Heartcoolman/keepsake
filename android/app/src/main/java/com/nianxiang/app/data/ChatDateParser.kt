package com.nianxiang.app.data

import java.util.Calendar

/**
 * Rule-based extraction of memory dates from chat text (no LLM).
 * Port of client/src/lib/parseChatDate.ts — keep the three clients in sync.
 */
object ChatDateParser {
    enum class Kind { ABSOLUTE, RELATIVE }

    data class Parsed(val takenAt: Long, val kind: Kind)

    private const val DAY_MILLIS = 24L * 60 * 60 * 1000
    private const val MIN_YEAR = 1990

    private val seasonMonth = mapOf(
        "春" to 4, "夏" to 7, "秋" to 10, "冬" to 1,
        "春天" to 4, "夏天" to 7, "秋天" to 10, "冬天" to 1,
    )

    fun parse(text: String, reference: Long = System.currentTimeMillis()): Parsed? {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return null

        parseAbsolute(trimmed)?.takeIf { isPlausible(it.takenAt, reference + DAY_MILLIS) }?.let { return it }
        parseRelative(trimmed, reference)?.takeIf { isPlausible(it.takenAt, reference + DAY_MILLIS) }?.let { return it }
        return null
    }

    /** Absolute always wins; relative only overrides weak sources. */
    fun shouldApply(dateSource: String?, kind: Kind): Boolean {
        if (kind == Kind.ABSOLUTE) return true
        val source = dateSource?.ifBlank { null } ?: "now"
        return source == "now" || source == "file" || source == "chat"
    }

    fun sameDay(a: Long, b: Long): Boolean {
        val calA = Calendar.getInstance().apply { timeInMillis = a }
        val calB = Calendar.getInstance().apply { timeInMillis = b }
        return calA.get(Calendar.YEAR) == calB.get(Calendar.YEAR) &&
            calA.get(Calendar.DAY_OF_YEAR) == calB.get(Calendar.DAY_OF_YEAR)
    }

    private fun parseAbsolute(text: String): Parsed? {
        Regex("""(19\d{2}|20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?""")
            .find(text)?.let { m ->
                localTs(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt())
                    ?.let { return Parsed(it, Kind.ABSOLUTE) }
            }

        Regex("""(19\d{2}|20\d{2})\s*年\s*(\d{1,2})\s*月(?!\s*\d)""")
            .find(text)?.let { m ->
                midMonth(m.groupValues[1].toInt(), m.groupValues[2].toInt())
                    ?.let { return Parsed(it, Kind.ABSOLUTE) }
            }

        Regex("""(19\d{2}|20\d{2})\s*年\s*(春天|夏天|秋天|冬天|春|夏|秋|冬)""")
            .find(text)?.let { m ->
                val month = seasonMonth[m.groupValues[2]] ?: return@let
                midMonth(m.groupValues[1].toInt(), month)?.let { return Parsed(it, Kind.ABSOLUTE) }
            }

        Regex("""(19\d{2}|20\d{2})\s*年(?!\s*\d)""")
            .find(text)?.let { m ->
                midMonth(m.groupValues[1].toInt(), 7)?.let { return Parsed(it, Kind.ABSOLUTE) }
            }

        Regex("""(19\d{2}|20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})""")
            .find(text)?.let { m ->
                localTs(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt())
                    ?.let { return Parsed(it, Kind.ABSOLUTE) }
            }

        Regex("""(19\d{2}|20\d{2})[-/.](\d{1,2})(?![-/.\d])""")
            .find(text)?.let { m ->
                midMonth(m.groupValues[1].toInt(), m.groupValues[2].toInt())
                    ?.let { return Parsed(it, Kind.ABSOLUTE) }
            }

        return null
    }

    private fun relativeYearOffset(text: String): Int? = when {
        "大前年" in text -> 3
        "前年" in text -> 2
        "去年" in text || "上年" in text -> 1
        "今年" in text -> 0
        else -> null
    }

    private fun parseRelative(text: String, reference: Long): Parsed? {
        val yearsAgo = relativeYearOffset(text) ?: return null
        val refCal = Calendar.getInstance().apply { timeInMillis = reference }
        val year = refCal.get(Calendar.YEAR) - yearsAgo

        if ("过年" in text || "春节" in text || "新年" in text) {
            midMonth(year, 2)?.let { return Parsed(it, Kind.RELATIVE) }
        }

        Regex("""(春天|夏天|秋天|冬天|春|夏|秋|冬)""").find(text)?.let { m ->
            val month = seasonMonth[m.groupValues[1]] ?: return@let
            midMonth(year, month)?.let { return Parsed(it, Kind.RELATIVE) }
        }

        Regex("""(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?""").find(text)?.let { m ->
            localTs(year, m.groupValues[1].toInt(), m.groupValues[2].toInt())
                ?.let { return Parsed(it, Kind.RELATIVE) }
        }

        Regex("""(\d{1,2})\s*月(?!\s*\d)""").find(text)?.let { m ->
            midMonth(year, m.groupValues[1].toInt())?.let { return Parsed(it, Kind.RELATIVE) }
        }

        return midMonth(year, refCal.get(Calendar.MONTH) + 1)?.let { Parsed(it, Kind.RELATIVE) }
    }

    /** Build local timestamp from Y/M/D at noon. Rejects impossible dates (e.g. 2月30日). */
    fun localTs(year: Int, month: Int, day: Int): Long? {
        if (month !in 1..12 || day !in 1..31) return null
        val cal = Calendar.getInstance().apply {
            clear()
            set(Calendar.YEAR, year)
            set(Calendar.MONTH, month - 1)
            set(Calendar.DAY_OF_MONTH, day)
            set(Calendar.HOUR_OF_DAY, 12)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        if (cal.get(Calendar.YEAR) != year ||
            cal.get(Calendar.MONTH) != month - 1 ||
            cal.get(Calendar.DAY_OF_MONTH) != day
        ) {
            return null
        }
        val ts = cal.timeInMillis
        return if (isPlausible(ts, System.currentTimeMillis())) ts else null
    }

    private fun midMonth(year: Int, month: Int): Long? = localTs(year, month, 15)

    fun isPlausible(ts: Long, now: Long): Boolean {
        val year = Calendar.getInstance().apply { timeInMillis = ts }.get(Calendar.YEAR)
        if (year < MIN_YEAR) return false
        return ts <= now + DAY_MILLIS
    }
}
