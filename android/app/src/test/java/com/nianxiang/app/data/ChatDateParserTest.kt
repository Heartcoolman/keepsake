package com.nianxiang.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

/** Mirrors client/src/lib/parseChatDate.ts and Apple ChatDateParserTests. */
class ChatDateParserTest {
    private fun reference(year: Int, month: Int, day: Int): Long =
        Calendar.getInstance().apply {
            clear()
            set(Calendar.YEAR, year)
            set(Calendar.MONTH, month - 1)
            set(Calendar.DAY_OF_MONTH, day)
            set(Calendar.HOUR_OF_DAY, 12)
        }.timeInMillis

    private fun components(millis: Long): List<Int> {
        val c = Calendar.getInstance().apply { timeInMillis = millis }
        return listOf(
            c.get(Calendar.YEAR),
            c.get(Calendar.MONTH) + 1,
            c.get(Calendar.DAY_OF_MONTH),
            c.get(Calendar.HOUR_OF_DAY),
        )
    }

    @Test
    fun absoluteFullDate() {
        val parsed = ChatDateParser.parse("那是2019年7月16日拍的", reference(2026, 7, 20))
        assertEquals(ChatDateParser.Kind.ABSOLUTE, parsed?.kind)
        assertEquals(listOf(2019, 7, 16, 12), components(parsed!!.takenAt))
    }

    @Test
    fun absoluteYearMonthUsesMidMonth() {
        val parsed = ChatDateParser.parse("2021年3月的事", reference(2026, 7, 20))
        assertEquals(ChatDateParser.Kind.ABSOLUTE, parsed?.kind)
        assertEquals(listOf(2021, 3, 15, 12), components(parsed!!.takenAt))
    }

    @Test
    fun absoluteSeason() {
        val parsed = ChatDateParser.parse("2020年夏天去的海边", reference(2026, 7, 20))
        assertEquals(listOf(2020, 7), components(parsed!!.takenAt).take(2))
    }

    @Test
    fun absoluteBareYear() {
        val parsed = ChatDateParser.parse("2018年的旧照片", reference(2026, 7, 20))
        assertEquals(listOf(2018, 7, 15, 12), components(parsed!!.takenAt))
    }

    @Test
    fun isoDate() {
        val parsed = ChatDateParser.parse("拍摄于 2022/5/3", reference(2026, 7, 20))
        assertEquals(ChatDateParser.Kind.ABSOLUTE, parsed?.kind)
        assertEquals(listOf(2022, 5, 3, 12), components(parsed!!.takenAt))
    }

    @Test
    fun relativeLastYearWithMonthDay() {
        val parsed = ChatDateParser.parse("去年8月2日的合影", reference(2026, 7, 20))
        assertEquals(ChatDateParser.Kind.RELATIVE, parsed?.kind)
        assertEquals(listOf(2025, 8, 2, 12), components(parsed!!.takenAt))
    }

    @Test
    fun relativeSpringFestival() {
        val parsed = ChatDateParser.parse("前年春节拍的", reference(2026, 7, 20))
        assertEquals(listOf(2024, 2, 15, 12), components(parsed!!.takenAt))
    }

    @Test
    fun relativeBareLastYearFallsToSameMonth() {
        val parsed = ChatDateParser.parse("去年的事了", reference(2026, 7, 20))
        assertEquals(listOf(2025, 7, 15, 12), components(parsed!!.takenAt))
    }

    @Test
    fun rejectsFutureAndAncientDates() {
        assertNull(ChatDateParser.parse("2027年8月1日", reference(2026, 7, 20)))
        assertNull(ChatDateParser.parse("1989年的照片", reference(2026, 7, 20)))
        assertNull(ChatDateParser.parse("2月30日去的", reference(2026, 7, 20)))
    }

    @Test
    fun noDateReturnsNull() {
        assertNull(ChatDateParser.parse("今天天气真好", reference(2026, 7, 20)))
        assertNull(ChatDateParser.parse("", reference(2026, 7, 20)))
    }

    @Test
    fun shouldApplyRules() {
        assertTrue(ChatDateParser.shouldApply("exif", ChatDateParser.Kind.ABSOLUTE))
        assertTrue(ChatDateParser.shouldApply("manual", ChatDateParser.Kind.ABSOLUTE))
        assertTrue(ChatDateParser.shouldApply("now", ChatDateParser.Kind.RELATIVE))
        assertTrue(ChatDateParser.shouldApply("file", ChatDateParser.Kind.RELATIVE))
        assertTrue(ChatDateParser.shouldApply("chat", ChatDateParser.Kind.RELATIVE))
        assertFalse(ChatDateParser.shouldApply("exif", ChatDateParser.Kind.RELATIVE))
        assertFalse(ChatDateParser.shouldApply("manual", ChatDateParser.Kind.RELATIVE))
    }
}
