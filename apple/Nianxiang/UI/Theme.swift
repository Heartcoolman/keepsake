import SwiftUI

extension Color {
    /// 0xAARRGGBB, matching the Android Color literals.
    init(argb: UInt32) {
        self.init(
            .sRGB,
            red: Double((argb >> 16) & 0xff) / 255,
            green: Double((argb >> 8) & 0xff) / 255,
            blue: Double(argb & 0xff) / 255,
            opacity: Double((argb >> 24) & 0xff) / 255
        )
    }
}

enum NxColors {
    static let ink = Color(argb: 0xFF060605)
    static let inkWarm = Color(argb: 0xFF0C0A07)
    static let panel = Color(argb: 0xB316161A)
    static let panelSolid = Color(argb: 0xF216161A)
    static let control = Color(argb: 0xBF1C1C21)
    static let controlRaised = Color(argb: 0xCC303037)
    static let text = Color(argb: 0xEBFFFFFF)
    static let textDim = Color(argb: 0x8CFFFFFF)
    static let textFaint = Color(argb: 0x52FFFFFF)
    static let line = Color(argb: 0x24FFFFFF)
    static let lineStrong = Color(argb: 0x42FFFFFF)
    static let paper = Color(argb: 0xFFF1F0ED)
    static let onPaper = Color(argb: 0xFF171717)
    static let gold = Color(argb: 0xFFE8C48A)
    static let rose = Color(argb: 0xFFD98F98)
    static let blue = Color(argb: 0xFF86A8C8)
    static let green = Color(argb: 0xFF82AE94)
    static let errorColor = Color(argb: 0xFFFF8E8E)
}

extension Font {
    static func nxSerif(_ size: CGFloat) -> Font {
        .custom("Songti SC", size: size).weight(.regular)
    }
}

func categoryLabel(_ category: String) -> String {
    switch category {
    case "preference": return "喜好"
    case "event": return "经历"
    case "person": return "牵挂"
    default: return "点滴"
    }
}
