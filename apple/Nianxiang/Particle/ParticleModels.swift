/// PUBLIC STUB — the depth→particle placement algorithm (ParticleDepth), sampling
/// budget logic and particle data layout live in the private core module. The scene
/// state types below are pure data shared with the UI layer and stay real.
import Foundation

enum ParticleAmbience {
    case none, dust, rain, snow
}

enum ParticleMode: Equatable {
    case timeline
    case loading
    case chat
    case condensing(lines: [String])
    case diary(mood: String)
    case hidden
}

struct ParticleSceneState {
    var photoId: String?
    var jpeg: Data?
    var depthJson: String?
    var mode: ParticleMode = .timeline
}

struct ParticlePerformanceSample {
    let framesPerSecond: Float
    let slowFrameRatio: Float
    let sampledFrames: Int
}

struct DepthPayload {
    let width: Int
    let height: Int
    let depth: [UInt8]
    let mask: [UInt8]?
    let background: [UInt8]?
    let backgroundDepth: [UInt8]?

    var layered: Bool { mask != nil && background != nil && backgroundDepth != nil }

    static func parse(_ json: String?) -> DepthPayload? {
        guard let json, !json.isEmpty,
              let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let width = object["width"] as? Int,
              let height = object["height"] as? Int,
              (1...4096).contains(width), (1...4096).contains(height) else { return nil }
        let pixels = width * height
        guard let depth = decode(object["depth"] as? String, expected: pixels) else { return nil }
        guard object["layered"] as? Bool == true else {
            return DepthPayload(width: width, height: height, depth: depth, mask: nil, background: nil, backgroundDepth: nil)
        }
        let mask = decode(object["mask"] as? String, expected: pixels)
        let background = decode(object["bg"] as? String, expected: pixels * 3)
        let backgroundDepth = decode(object["bgDepth"] as? String, expected: pixels)
        guard let mask, let background, let backgroundDepth else {
            return DepthPayload(width: width, height: height, depth: depth, mask: nil, background: nil, backgroundDepth: nil)
        }
        return DepthPayload(width: width, height: height, depth: depth, mask: mask, background: background, backgroundDepth: backgroundDepth)
    }

    private static func decode(_ value: String?, expected: Int) -> [UInt8]? {
        guard let value, !value.isEmpty, let decoded = Data(base64Encoded: value), decoded.count == expected else { return nil }
        return [UInt8](decoded)
    }
}

func ambienceForMood(_ mood: String) -> ParticleAmbience {
    if mood.range(of: "[雨思念忧伤愁怀]", options: .regularExpression) != nil { return .rain }
    if mood.range(of: "[静雪冬凉安]", options: .regularExpression) != nil { return .snow }
    return .dust
}

func particleModeFor(
    sessionOpen: Bool,
    userPresent: Bool,
    hasPhoto: Bool,
    phase: String,
    sessionTab: String,
    mood: String,
    lines: [String]
) -> ParticleMode {
    if !userPresent || !sessionOpen { return .timeline }
    if !hasPhoto { return .loading }
    if phase == "condensing" { return .condensing(lines: Array(lines.suffix(8))) }
    if (phase == "revealing" || phase == "done") && sessionTab == "diary" { return .diary(mood: mood) }
    return .chat
}

/// Deterministic xorshift RNG so tests can pin seeds; production paths use a random seed.
struct SeededRandom {
    private var state: UInt64

    init(seed: Int) {
        state = UInt64(bitPattern: Int64(seed)) &+ 0x9E3779B97F4A7C15
        if state == 0 { state = 0x1234_5678 }
    }

    init() {
        state = UInt64.random(in: 1...UInt64.max)
    }

    mutating func nextFloat() -> Float {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return Float(state >> 40) / Float(1 << 24)
    }

    mutating func nextInt(_ upperBound: Int) -> Int {
        Int(nextFloat() * Float(upperBound)).clamped(to: 0...(upperBound - 1))
    }
}

extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}
