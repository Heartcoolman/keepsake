import Foundation

/// Chinese error-code → message table, copied byte-for-byte from client/src/lib/http.ts
/// (including its half-width commas).
private let friendlyErrorTable: [String: String] = [
    "UNAUTHORIZED": "认证失败或登录已过期",
    "FORBIDDEN": "没有权限执行此操作",
    "NOT_FOUND": "对象不存在或已被删除",
    "VALIDATION": "输入不合法,请检查后重试",
    "CONFLICT": "操作冲突,请刷新后重试",
    "RATE_LIMITED": "尝试次数过多,请稍后再试",
    "PAYLOAD_TOO_LARGE": "提交内容过大",
]

/// Maps a caught error to a Chinese user-facing message. Returns nil when the caller must show
/// nothing — E_KEYS_LOCKED, where the global unlock overlay already takes over. Mirrors
/// client/src/lib/http.ts friendlyError exactly, including evaluation order.
func friendlyError(_ error: Error, fallback: String, overrides: [String: String] = [:]) -> String? {
    if error is URLError { return "连不上服务器,请检查网络" }
    guard let apiError = error as? ApiError else { return fallback }
    if apiError.code == "E_KEYS_LOCKED" { return nil }
    if !apiError.code.isEmpty, let override = overrides[apiError.code] { return override }
    if !apiError.code.isEmpty, let mapped = friendlyErrorTable[apiError.code] { return mapped }
    if apiError.code.isEmpty || apiError.status >= 500 { return "服务器开小差了,请稍后再试" }
    return fallback
}
