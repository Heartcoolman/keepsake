import Foundation

/// Rule-based extraction of memory dates from chat text (no LLM).
/// Port of client/src/lib/parseChatDate.ts — keep the two in sync.
enum ChatDateParser {
    enum Kind: Equatable { case absolute, relative }

    struct Parsed: Equatable {
        let takenAt: Int64
        let kind: Kind
    }

    private static let dayMillis: Int64 = 24 * 60 * 60 * 1000
    private static let minYear = 1990

    private static let seasonMonth: [String: Int] = [
        "春": 4, "夏": 7, "秋": 10, "冬": 1,
        "春天": 4, "夏天": 7, "秋天": 10, "冬天": 1,
    ]

    static func parse(_ text: String, reference: Int64 = nowMillis()) -> Parsed? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // absolute first (more specific)
        if let abs = parseAbsolute(trimmed), isPlausible(abs.takenAt, now: reference + dayMillis) {
            return abs
        }
        if let rel = parseRelative(trimmed, reference: reference), isPlausible(rel.takenAt, now: reference + dayMillis) {
            return rel
        }
        return nil
    }

    /// Absolute always wins; relative only overrides weak sources.
    static func shouldApply(dateSource: String, kind: Kind) -> Bool {
        if kind == .absolute { return true }
        let source = dateSource.isEmpty ? "now" : dateSource
        return source == "now" || source == "file" || source == "chat"
    }

    static func nowMillis() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    // MARK: - Absolute dates

    private static func parseAbsolute(_ text: String) -> Parsed? {
        // 2019年7月16日 / 2019年07月16号
        if let m = firstMatch(#"(19\d{2}|20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?"#, text),
           let ts = localTs(int(m[1]), int(m[2]), int(m[3])) {
            return Parsed(takenAt: ts, kind: .absolute)
        }

        // 2019年7月 / 2019年07月
        if let m = firstMatch(#"(19\d{2}|20\d{2})\s*年\s*(\d{1,2})\s*月(?!\s*\d)"#, text),
           let ts = midMonth(int(m[1]), int(m[2])) {
            return Parsed(takenAt: ts, kind: .absolute)
        }

        // 2019年夏天 / 2019年春
        if let m = firstMatch(#"(19\d{2}|20\d{2})\s*年\s*(春天|夏天|秋天|冬天|春|夏|秋|冬)"#, text),
           let month = seasonMonth[m[2]],
           let ts = midMonth(int(m[1]), month) {
            // 冬 → 当年 1 月中
            return Parsed(takenAt: ts, kind: .absolute)
        }

        // 2019年（单独）
        if let m = firstMatch(#"(19\d{2}|20\d{2})\s*年(?!\s*\d)"#, text),
           let ts = midMonth(int(m[1]), 7) {
            return Parsed(takenAt: ts, kind: .absolute)
        }

        // 2019-07-16 / 2019/7/16
        if let m = firstMatch(#"(19\d{2}|20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})"#, text),
           let ts = localTs(int(m[1]), int(m[2]), int(m[3])) {
            return Parsed(takenAt: ts, kind: .absolute)
        }

        // 2019-07
        if let m = firstMatch(#"(19\d{2}|20\d{2})[-/.](\d{1,2})(?![-/.\d])"#, text),
           let ts = midMonth(int(m[1]), int(m[2])) {
            return Parsed(takenAt: ts, kind: .absolute)
        }

        return nil
    }

    // MARK: - Relative dates

    private static func relativeYearOffset(_ text: String) -> Int? {
        if text.contains("大前年") { return 3 }
        if text.contains("前年") { return 2 }
        if text.contains("去年") || text.contains("上年") { return 1 }
        if text.contains("今年") { return 0 }
        return nil
    }

    private static func parseRelative(_ text: String, reference: Int64) -> Parsed? {
        guard let yearsAgo = relativeYearOffset(text) else { return nil }

        let calendar = Calendar.current
        let refDate = Date(timeIntervalSince1970: Double(reference) / 1000)
        let year = calendar.component(.year, from: refDate) - yearsAgo

        // 去年过年 / 前年春节 → 2 月中
        if text.contains("过年") || text.contains("春节") || text.contains("新年") {
            if let ts = midMonth(year, 2) { return Parsed(takenAt: ts, kind: .relative) }
        }

        // 去年夏天 …
        if let m = firstMatch(#"(春天|夏天|秋天|冬天|春|夏|秋|冬)"#, text),
           let month = seasonMonth[m[1]],
           let ts = midMonth(year, month) {
            return Parsed(takenAt: ts, kind: .relative)
        }

        // 去年7月16日
        if let m = firstMatch(#"(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?"#, text),
           let ts = localTs(year, int(m[1]), int(m[2])) {
            return Parsed(takenAt: ts, kind: .relative)
        }

        // 去年7月
        if let m = firstMatch(#"(\d{1,2})\s*月(?!\s*\d)"#, text),
           let ts = midMonth(year, int(m[1])) {
            return Parsed(takenAt: ts, kind: .relative)
        }

        // bare 去年 / 前年 → 同年同月中日（相对 ref）
        let refMonth = calendar.component(.month, from: refDate)
        if let ts = midMonth(year, refMonth) { return Parsed(takenAt: ts, kind: .relative) }
        return nil
    }

    // MARK: - Date helpers

    /// Build local timestamp from Y/M/D at noon. Rejects impossible dates (e.g. 2月30日).
    static func localTs(_ year: Int, _ month: Int, _ day: Int) -> Int64? {
        guard (1...12).contains(month), (1...31).contains(day) else { return nil }
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = 12
        let calendar = Calendar.current
        guard let date = calendar.date(from: components) else { return nil }
        let check = calendar.dateComponents([.year, .month, .day], from: date)
        guard check.year == year, check.month == month, check.day == day else { return nil }
        let ts = Int64(date.timeIntervalSince1970 * 1000)
        return isPlausible(ts, now: nowMillis()) ? ts : nil
    }

    private static func midMonth(_ year: Int, _ month: Int) -> Int64? {
        localTs(year, month, 15)
    }

    static func isPlausible(_ ts: Int64, now: Int64) -> Bool {
        let year = Calendar.current.component(.year, from: Date(timeIntervalSince1970: Double(ts) / 1000))
        if year < minYear { return false }
        // allow a small clock skew into the future
        return ts <= now + dayMillis
    }

    static func sameDay(_ a: Int64, _ b: Int64) -> Bool {
        Calendar.current.isDate(
            Date(timeIntervalSince1970: Double(a) / 1000),
            inSameDayAs: Date(timeIntervalSince1970: Double(b) / 1000)
        )
    }

    // MARK: - Regex helper

    /// Capture groups of the first match; index 0 is the whole match. Missing groups are "".
    private static func firstMatch(_ pattern: String, _ text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
        else { return nil }
        return (0..<match.numberOfRanges).map { index in
            guard let range = Range(match.range(at: index), in: text) else { return "" }
            return String(text[range])
        }
    }

    private static func int(_ raw: String) -> Int { Int(raw) ?? 0 }
}
