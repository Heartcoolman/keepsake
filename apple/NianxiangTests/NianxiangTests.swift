import XCTest
@testable import Nianxiang

final class DiaryParsingTests: XCTestCase {
    func testParsesFrontMatter() {
        let raw = "标题：海边的黄昏\n心情：温暖\n---\n那天的风很轻。\n\n我们走了很久。"
        let parsed = AppViewModel.parseDiary(raw)
        XCTAssertEqual(parsed.title, "海边的黄昏")
        XCTAssertEqual(parsed.mood, "温暖")
        XCTAssertEqual(parsed.body, "那天的风很轻。\n\n我们走了很久。")
    }

    func testHalfWidthColonAndMissingMood() {
        let parsed = AppViewModel.parseDiary("标题: 一次午后\n---\n正文在这里")
        XCTAssertEqual(parsed.title, "一次午后")
        XCTAssertEqual(parsed.mood, "")
        XCTAssertEqual(parsed.body, "正文在这里")
    }

    func testNoFrontMatterFallsBackToRaw() {
        let parsed = AppViewModel.parseDiary("只有一段话，没有分隔线")
        XCTAssertEqual(parsed.title, "未命名记忆")
        XCTAssertEqual(parsed.body, "只有一段话，没有分隔线")
    }
}

final class BaseUrlValidationTests: XCTestCase {
    func testAcceptsHttpsAnywhere() {
        XCTAssertTrue(SessionStore.validBaseUrl("https://nx.example.com"))
    }

    func testAcceptsPrivateIPv4Cleartext() {
        XCTAssertTrue(SessionStore.validBaseUrl("http://192.168.1.10:8787"))
        XCTAssertTrue(SessionStore.validBaseUrl("http://10.0.0.2:8787"))
        XCTAssertTrue(SessionStore.validBaseUrl("http://172.20.0.1:8787"))
        XCTAssertTrue(SessionStore.validBaseUrl("http://localhost:8787"))
        XCTAssertTrue(SessionStore.validBaseUrl("http://nas.local:8787"))
    }

    func testRejectsPublicCleartextAndPrefixTricks() {
        XCTAssertFalse(SessionStore.validBaseUrl("http://example.com"))
        XCTAssertFalse(SessionStore.validBaseUrl("http://10.evil.com"))
        XCTAssertFalse(SessionStore.validBaseUrl("http://172.99.0.1"))
        XCTAssertFalse(SessionStore.validBaseUrl("ftp://192.168.1.1"))
    }
}

final class PhotoDateTests: XCTestCase {
    func testFilenameCompactDate() {
        let time = PhotoImporter.dateFromFilename("IMG_20240102_030405.jpg")
        XCTAssertNotNil(time)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let components = calendar.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: Date(timeIntervalSince1970: Double(time!) / 1000)
        )
        XCTAssertEqual(components.year, 2024)
        XCTAssertEqual(components.month, 1)
        XCTAssertEqual(components.day, 2)
        XCTAssertEqual(components.hour, 3)
        XCTAssertEqual(components.minute, 4)
        XCTAssertEqual(components.second, 5)
    }

    func testFilenameSeparatedDateWithoutTimeDefaultsToNoon() {
        let time = PhotoImporter.dateFromFilename("photo 2023-06-15.png")
        XCTAssertNotNil(time)
        let components = Calendar(identifier: .gregorian).dateComponents(
            [.year, .month, .day, .hour],
            from: Date(timeIntervalSince1970: Double(time!) / 1000)
        )
        XCTAssertEqual(components.year, 2023)
        XCTAssertEqual(components.month, 6)
        XCTAssertEqual(components.day, 15)
        XCTAssertEqual(components.hour, 12)
    }

    func testImplausibleTimesRejected() {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        XCTAssertFalse(PhotoImporter.plausible(0, now: now))
        XCTAssertFalse(PhotoImporter.plausible(now + 48 * 3600 * 1000, now: now))
        XCTAssertTrue(PhotoImporter.plausible(now - 1000, now: now))
    }
}

final class DepthPayloadTests: XCTestCase {
    private func base64(_ bytes: [UInt8]) -> String { Data(bytes).base64EncodedString() }

    func testParsesPlainDepth() {
        let json = """
        {"width":2,"height":2,"depth":"\(base64([0, 64, 128, 255]))"}
        """
        let payload = DepthPayload.parse(json)
        XCTAssertNotNil(payload)
        XCTAssertEqual(payload?.width, 2)
        XCTAssertFalse(payload!.layered)
    }

    func testLayeredFallsBackWhenPartsMissing() {
        let json = """
        {"width":2,"height":2,"depth":"\(base64([0, 64, 128, 255]))","layered":true,"mask":"\(base64([0, 1, 0, 1]))"}
        """
        let payload = DepthPayload.parse(json)
        XCTAssertNotNil(payload)
        XCTAssertFalse(payload!.layered)
    }

    func testLayeredParsesFully() {
        let pixels: [UInt8] = [0, 64, 128, 255]
        let bg = [UInt8](repeating: 10, count: 12)
        let json = """
        {"width":2,"height":2,"depth":"\(base64(pixels))","layered":true,"mask":"\(base64([0, 1, 0, 1]))","bg":"\(base64(bg))","bgDepth":"\(base64(pixels))"}
        """
        let payload = DepthPayload.parse(json)
        XCTAssertTrue(payload!.layered)
    }

    func testRejectsWrongSizeAndBounds() {
        XCTAssertNil(DepthPayload.parse("{\"width\":2,\"height\":2,\"depth\":\"\(base64([0, 1]))\"}"))
        XCTAssertNil(DepthPayload.parse("{\"width\":9999,\"height\":9999,\"depth\":\"AA==\"}"))
        XCTAssertNil(DepthPayload.parse(nil))
        XCTAssertNil(DepthPayload.parse("not json"))
    }
}

final class ParticleModeTests: XCTestCase {
    func testModeSelection() {
        XCTAssertEqual(
            particleModeFor(sessionOpen: false, userPresent: true, hasPhoto: true, phase: "chatting", sessionTab: "chat", mood: "", lines: []),
            .timeline
        )
        XCTAssertEqual(
            particleModeFor(sessionOpen: true, userPresent: true, hasPhoto: false, phase: "loading", sessionTab: "chat", mood: "", lines: []),
            .loading
        )
        XCTAssertEqual(
            particleModeFor(sessionOpen: true, userPresent: true, hasPhoto: true, phase: "condensing", sessionTab: "chat", mood: "", lines: ["a", "b"]),
            .condensing(lines: ["a", "b"])
        )
        XCTAssertEqual(
            particleModeFor(sessionOpen: true, userPresent: true, hasPhoto: true, phase: "done", sessionTab: "diary", mood: "温暖", lines: []),
            .diary(mood: "温暖")
        )
        XCTAssertEqual(
            particleModeFor(sessionOpen: true, userPresent: true, hasPhoto: true, phase: "done", sessionTab: "chat", mood: "温暖", lines: []),
            .chat
        )
    }

    func testAmbienceForMood() {
        XCTAssertEqual(ambienceForMood("思念"), .rain)
        XCTAssertEqual(ambienceForMood("平静"), .snow)
        XCTAssertEqual(ambienceForMood("开心"), .dust)
    }

    func testCondensingKeepsLastEightLines() {
        let lines = (1...12).map(String.init)
        let mode = particleModeFor(
            sessionOpen: true, userPresent: true, hasPhoto: true,
            phase: "condensing", sessionTab: "chat", mood: "", lines: lines
        )
        XCTAssertEqual(mode, .condensing(lines: (5...12).map(String.init)))
    }
}

final class ModelDecodingTests: XCTestCase {
    func testEntryDecodesWithMissingFields() throws {
        let json = #"{"id":"e1","chat":[{"role":"assistant","content":"你好"}]}"#
        let entry = try JSONDecoder().decode(Entry.self, from: Data(json.utf8))
        XCTAssertEqual(entry.id, "e1")
        XCTAssertEqual(entry.status, "new")
        XCTAssertEqual(entry.chat.count, 1)
        XCTAssertEqual(entry.people.count, 0)
    }

    func testHealthDecodes() throws {
        let json = #"{"ok":true,"bootstrapped":true,"mock":false,"apiVersion":1,"authRequired":true}"#
        let health = try JSONDecoder().decode(HealthResponse.self, from: Data(json.utf8))
        XCTAssertTrue(health.ok)
        XCTAssertTrue(health.bootstrapped)
    }

    func testSessionOpenDecodesWithoutAnalysis() throws {
        let json = #"{"entry":{"id":"e1"}}"#
        let response = try JSONDecoder().decode(SessionOpenResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.entry.id, "e1")
        XCTAssertEqual(response.analysis.status, "")
    }
}

/// Mirrors client/src/lib/parseChatDate.ts behaviour.
final class ChatDateParserTests: XCTestCase {
    private func components(_ millis: Int64) -> DateComponents {
        Calendar.current.dateComponents(
            [.year, .month, .day, .hour],
            from: Date(timeIntervalSince1970: Double(millis) / 1000)
        )
    }

    private func reference(_ year: Int, _ month: Int, _ day: Int) -> Int64 {
        ChatDateParser.localTs(year, month, day)!
    }

    func testAbsoluteFullDate() {
        let parsed = ChatDateParser.parse("那是2019年7月16日拍的", reference: reference(2026, 7, 20))
        XCTAssertEqual(parsed?.kind, .absolute)
        let c = components(parsed!.takenAt)
        XCTAssertEqual([c.year, c.month, c.day, c.hour], [2019, 7, 16, 12])
    }

    func testAbsoluteYearMonthUsesMidMonth() {
        let parsed = ChatDateParser.parse("2021年3月的事", reference: reference(2026, 7, 20))
        XCTAssertEqual(parsed?.kind, .absolute)
        let c = components(parsed!.takenAt)
        XCTAssertEqual([c.year, c.month, c.day], [2021, 3, 15])
    }

    func testAbsoluteSeason() {
        let parsed = ChatDateParser.parse("2020年夏天去的海边", reference: reference(2026, 7, 20))
        let c = components(parsed!.takenAt)
        XCTAssertEqual([c.year, c.month], [2020, 7])
    }

    func testAbsoluteBareYear() {
        let parsed = ChatDateParser.parse("2018年的旧照片", reference: reference(2026, 7, 20))
        let c = components(parsed!.takenAt)
        XCTAssertEqual([c.year, c.month, c.day], [2018, 7, 15])
    }

    func testIsoDate() {
        let parsed = ChatDateParser.parse("拍摄于 2022/5/3", reference: reference(2026, 7, 20))
        XCTAssertEqual(parsed?.kind, .absolute)
        let c = components(parsed!.takenAt)
        XCTAssertEqual([c.year, c.month, c.day], [2022, 5, 3])
    }

    func testRelativeLastYearWithMonthDay() {
        let parsed = ChatDateParser.parse("去年8月2日的合影", reference: reference(2026, 7, 20))
        XCTAssertEqual(parsed?.kind, .relative)
        let c = components(parsed!.takenAt)
        XCTAssertEqual([c.year, c.month, c.day], [2025, 8, 2])
    }

    func testRelativeSpringFestival() {
        let parsed = ChatDateParser.parse("前年春节拍的", reference: reference(2026, 7, 20))
        let c = components(parsed!.takenAt)
        XCTAssertEqual([c.year, c.month, c.day], [2024, 2, 15])
    }

    func testRelativeBareLastYearFallsToSameMonth() {
        let parsed = ChatDateParser.parse("去年的事了", reference: reference(2026, 7, 20))
        let c = components(parsed!.takenAt)
        XCTAssertEqual([c.year, c.month, c.day], [2025, 7, 15])
    }

    func testRejectsFutureAndAncientDates() {
        XCTAssertNil(ChatDateParser.parse("2027年8月1日", reference: reference(2026, 7, 20)))
        XCTAssertNil(ChatDateParser.parse("1989年的照片", reference: reference(2026, 7, 20)))
        XCTAssertNil(ChatDateParser.parse("2月30日去的", reference: reference(2026, 7, 20)))
    }

    func testNoDateReturnsNil() {
        XCTAssertNil(ChatDateParser.parse("今天天气真好", reference: reference(2026, 7, 20)))
        XCTAssertNil(ChatDateParser.parse("", reference: reference(2026, 7, 20)))
    }

    func testShouldApplyRules() {
        XCTAssertTrue(ChatDateParser.shouldApply(dateSource: "exif", kind: .absolute))
        XCTAssertTrue(ChatDateParser.shouldApply(dateSource: "manual", kind: .absolute))
        XCTAssertTrue(ChatDateParser.shouldApply(dateSource: "now", kind: .relative))
        XCTAssertTrue(ChatDateParser.shouldApply(dateSource: "file", kind: .relative))
        XCTAssertTrue(ChatDateParser.shouldApply(dateSource: "chat", kind: .relative))
        XCTAssertFalse(ChatDateParser.shouldApply(dateSource: "exif", kind: .relative))
        XCTAssertFalse(ChatDateParser.shouldApply(dateSource: "manual", kind: .relative))
    }
}
