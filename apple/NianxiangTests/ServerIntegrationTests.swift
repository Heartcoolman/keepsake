import XCTest
import CoreGraphics
import UniformTypeIdentifiers
import ImageIO
@testable import Nianxiang

/// End-to-end run of the real ApiClient against a live MOCK_AI server.
/// Opt-in: set NIANXIANG_E2E_BASE (e.g. http://127.0.0.1:18787) and start the server with
///   MOCK_AI=1 PORT=18787 node --watch=false server/src/index.ts
/// Covers: health → bootstrap/login → upload (multipart) → session open ×2 (idempotent)
/// → message (SSE) → complete (SSE) → GET status=done → PATCH whitelist → delete.
final class ServerIntegrationTests: XCTestCase {
    private var api: ApiClient!
    private var store: SessionStore!

    override func setUpWithError() throws {
        guard let base = ProcessInfo.processInfo.environment["NIANXIANG_E2E_BASE"], !base.isEmpty else {
            throw XCTSkip("NIANXIANG_E2E_BASE not set; skipping server integration test")
        }
        store = SessionStore(inMemory: true)
        try store.setBaseUrl(base)
        api = ApiClient(session: store)
    }

    func testFullSessionLifecycle() async throws {
        // 1. Health + auth (bootstrap on a fresh server, else login with e2e credentials).
        let health = try await api.health()
        XCTAssertEqual(health.apiVersion, 1)
        let username = "e2e_apple"
        let password = "password123"
        if health.bootstrapped {
            _ = try await api.login(username: username, password: password)
        } else {
            _ = try await api.bootstrap(username: username, password: password, displayName: "E2E")
        }
        let me = try await api.me()
        XCTAssertEqual(me.user.username, username)

        // 2. Upload a generated photo through the real multipart path.
        let jpeg = try Self.makeJpeg(side: 256)
        let thumb = try Self.makeJpeg(side: 64)
        var meta = Entry(id: ApiClient.newEntryId())
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        meta.createdAt = now
        meta.takenAt = now
        meta.uploadedAt = now
        meta.dateSource = "now"
        meta.yearMonth = AppViewModel.yearMonth(from: now)
        meta.status = "new"
        meta.title = "e2e 照片"
        meta.userId = me.user.id
        meta.ownerId = me.user.id
        let created = try await api.uploadEntry(meta: meta, jpeg: jpeg, thumb: thumb)
        XCTAssertEqual(created.id, meta.id)

        // 3. Media round-trips with Bearer auth.
        let fetchedThumb = try await api.mediaBytes(entryId: created.id, kind: "thumb")
        XCTAssertFalse(fetchedThumb.isEmpty)

        // 4. Session open is idempotent: second open must not mint a new opener.
        let first = try await api.sessionOpen(entryId: created.id)
        let opener = first.entry.chat.first { $0.role == "assistant" }?.content ?? ""
        XCTAssertFalse(opener.isEmpty)
        let second = try await api.sessionOpen(entryId: created.id)
        XCTAssertEqual(second.analysis.status, "skipped")
        XCTAssertEqual(second.entry.chat.first { $0.role == "assistant" }?.content, opener)

        // 5. Message streams via SSE and the server persists both sides of the chat.
        var streamed = ""
        for try await full in api.sessionMessage(entryId: created.id, text: "这张照片是在公园拍的") {
            streamed = full
        }
        XCTAssertFalse(streamed.isEmpty)
        let afterMessage = try await api.getEntry(id: created.id)
        XCTAssertTrue(afterMessage.chat.contains { $0.role == "user" && $0.content == "这张照片是在公园拍的" })
        XCTAssertTrue((afterMessage.chat.last?.content ?? "").count > 0)

        // 6. Complete writes the diary server-side and flips status to done.
        var diary = ""
        for try await full in api.sessionComplete(entryId: created.id) {
            diary = full
        }
        XCTAssertFalse(diary.isEmpty)
        let done = try await api.getEntry(id: created.id)
        XCTAssertEqual(done.status, "done")
        XCTAssertFalse(done.diaryText.isEmpty)

        // 7. PATCH whitelist: diary edits pass, forging chat/status is rejected.
        let patched = try await api.patchEntry(id: created.id, patch: ["title": "改过的标题"])
        XCTAssertEqual(patched.title, "改过的标题")
        do {
            _ = try await api.patchEntry(id: created.id, patch: ["status": "new"])
            XCTFail("PATCH status should be rejected")
        } catch let error as ApiError {
            XCTAssertEqual(error.code, "VALIDATION")
        }

        // 8. Cleanup.
        try await api.deleteEntry(id: created.id)
        let page = try await api.listEntries()
        XCTAssertFalse(page.items.contains { $0.id == created.id })
    }

    private static func makeJpeg(side: Int) throws -> Data {
        let context = CGContext(
            data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.setFillColor(CGColor(red: 0.4, green: 0.5, blue: 0.7, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: side, height: side))
        context.setFillColor(CGColor(red: 0.9, green: 0.7, blue: 0.3, alpha: 1))
        context.fillEllipse(in: CGRect(x: side / 4, y: side / 4, width: side / 2, height: side / 2))
        let image = context.makeImage()!
        let output = NSMutableData()
        let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image, nil)
        CGImageDestinationFinalize(destination)
        return output as Data
    }
}
