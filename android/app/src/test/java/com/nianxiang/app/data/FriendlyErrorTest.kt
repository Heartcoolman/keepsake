package com.nianxiang.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException

class FriendlyErrorTest {
    @Test
    fun `known error code maps to its table message`() {
        val e = ApiException(404, "NOT_FOUND", "not found")
        assertEquals("对象不存在或已被删除", friendlyError(e, "失败"))
    }

    @Test
    fun `per-call override wins over the table`() {
        val e = ApiException(401, "UNAUTHORIZED", "invalid credentials")
        val msg = friendlyError(e, "登录失败", mapOf("UNAUTHORIZED" to "用户名或密码不正确"))
        assertEquals("用户名或密码不正确", msg)
    }

    @Test
    fun `E_KEYS_LOCKED returns null so the unlock overlay can take over`() {
        val e = ApiException(423, "E_KEYS_LOCKED", "unlock required")
        assertNull(friendlyError(e, "失败"))
    }

    @Test
    fun `missing code falls back to the generic server message`() {
        val e = ApiException(500, "", "boom")
        assertEquals("服务器开小差了,请稍后再试", friendlyError(e, "失败"))
    }

    @Test
    fun `server error status with an unmapped code also gets the generic message`() {
        val e = ApiException(503, "SOME_UNKNOWN_CODE", "boom")
        assertEquals("服务器开小差了,请稍后再试", friendlyError(e, "失败"))
    }

    @Test
    fun `network failure maps to the connectivity message`() {
        val e = IOException("timeout")
        assertEquals("连不上服务器,请检查网络", friendlyError(e, "失败"))
    }

    @Test
    fun `unmapped client error code under 500 falls back to the caller's fallback`() {
        val e = ApiException(400, "SOME_UNKNOWN_CODE", "boom")
        assertEquals("失败", friendlyError(e, "失败"))
    }
}
