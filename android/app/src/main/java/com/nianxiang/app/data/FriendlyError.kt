package com.nianxiang.app.data

import java.io.IOException

private val ERROR_MESSAGES = mapOf(
    "UNAUTHORIZED" to "认证失败或登录已过期",
    "FORBIDDEN" to "没有权限执行此操作",
    "NOT_FOUND" to "对象不存在或已被删除",
    "VALIDATION" to "输入不合法,请检查后重试",
    "CONFLICT" to "操作冲突,请刷新后重试",
    "RATE_LIMITED" to "尝试次数过多,请稍后再试",
    "PAYLOAD_TOO_LARGE" to "提交内容过大",
)

/** Map a caught error to a Chinese user-facing message (mirrors Web's http.ts friendlyError).
 *  Returns null when the caller must show nothing — E_KEYS_LOCKED, where the global unlock
 *  overlay already takes over. */
fun friendlyError(e: Throwable, fallback: String, overrides: Map<String, String> = emptyMap()): String? {
    if (e is IOException) return "连不上服务器,请检查网络"
    if (e is ApiException) {
        if (e.code == "E_KEYS_LOCKED") return null
        overrides[e.code]?.let { return it }
        ERROR_MESSAGES[e.code]?.let { return it }
        if (e.code.isEmpty() || e.status >= 500) return "服务器开小差了,请稍后再试"
    }
    return fallback
}
