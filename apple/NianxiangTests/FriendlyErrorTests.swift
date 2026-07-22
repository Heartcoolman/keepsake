import XCTest
@testable import Nianxiang

final class FriendlyErrorTests: XCTestCase {
    func testTableHit() {
        let error = ApiError(status: 401, code: "UNAUTHORIZED", message: "invalid credentials")
        XCTAssertEqual(friendlyError(error, fallback: "失败"), "认证失败或登录已过期")
    }

    func testOverrideWins() {
        let error = ApiError(status: 401, code: "UNAUTHORIZED", message: "invalid credentials")
        XCTAssertEqual(
            friendlyError(error, fallback: "失败", overrides: ["UNAUTHORIZED": "用户名或密码不正确"]),
            "用户名或密码不正确"
        )
    }

    func testKeysLockedReturnsNil() {
        let error = ApiError(status: 423, code: "E_KEYS_LOCKED", message: "unlock required")
        XCTAssertNil(friendlyError(error, fallback: "失败"))
    }

    func testNoCodeOrServerErrorIsGeneric() {
        let noCode = ApiError(status: 400, code: "", message: "bad")
        XCTAssertEqual(friendlyError(noCode, fallback: "失败"), "服务器开小差了,请稍后再试")
        let serverError = ApiError(status: 502, code: "UPSTREAM", message: "bad gateway")
        XCTAssertEqual(friendlyError(serverError, fallback: "失败"), "服务器开小差了,请稍后再试")
    }

    func testURLErrorMapsToNetworkMessage() {
        let error = URLError(.notConnectedToInternet)
        XCTAssertEqual(friendlyError(error, fallback: "失败"), "连不上服务器,请检查网络")
    }

    func testUnmappedCodeBelow500FallsBackToCallerMessage() {
        let error = ApiError(status: 422, code: "SOMETHING_ELSE", message: "detail")
        XCTAssertEqual(friendlyError(error, fallback: "失败"), "失败")
    }
}
