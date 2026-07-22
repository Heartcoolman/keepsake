import Foundation

/// Force layout simulation for the relationship graph. Pure port of the web
/// GraphOverlay.tsx `useForceLayout` step: same constants, same three passes
/// (pairwise repulsion → edge springs → center pull + wander + damping + integrate).
enum GraphLayout {
    static let repulsion: Double = 2500
    static let springK: Double = 0.04
    static let springRestAI: Double = 90
    static let springRestCooccur: Double = 140
    static let centerK: Double = 0.004
    static let damping: Double = 0.9
    static let wander: Double = 0.035

    struct Point: Equatable {
        var x: Double
        var y: Double
        var vx: Double = 0
        var vy: Double = 0
        var fixed = false
        var phase: Double = 0
    }

    struct Edge {
        let a: String
        let b: String
        /// true when the edge carries a label (AI/manual relation); false = co-occurrence only.
        /// Selects the spring's rest length, mirroring `e.label ? SPRING_REST_AI : SPRING_REST_COOCCUR`.
        let hasLabel: Bool
    }

    /// Initial placement for a freshly-seen node: `0.35 * min(w,h)` radius circle, positioned
    /// by index, with a per-id hashed phase for the idle wander drift.
    static func initialPoint(id: String, index: Int, count: Int, width: Double, height: Double) -> Point {
        let cx = width > 0 ? width / 2 : 300
        let cy = height > 0 ? height / 2 : 200
        let radius = max(min(width, height) * 0.35, 60)
        let angle = (Double(index) / Double(max(count, 1))) * 2 * Double.pi
        var hash: Int32 = 0
        for scalar in id.unicodeScalars {
            hash = hash &* 31 &+ Int32(truncatingIfNeeded: scalar.value)
        }
        let phase = Double(abs(Int(hash)) % 628) / 100
        return Point(x: cx + radius * cos(angle), y: cy + radius * sin(angle), phase: phase)
    }

    /// One simulation tick, in place. `t` drives the sin/cos idle wander (same units as the
    /// web rAF timestamp: milliseconds); `wanderEnabled` gates it off under reduce-motion.
    static func step(
        points: inout [String: Point],
        ids: [String],
        edges: [Edge],
        width: Double,
        height: Double,
        t: Double,
        wanderEnabled: Bool
    ) {
        let cx = width > 0 ? width / 2 : 300
        let cy = height > 0 ? height / 2 : 200

        // Pass 1: pairwise repulsion.
        for i in 0..<ids.count {
            guard var a = points[ids[i]] else { continue }
            for j in (i + 1)..<ids.count {
                guard var b = points[ids[j]] else { continue }
                var dx = a.x - b.x
                var dy = a.y - b.y
                var d2 = dx * dx + dy * dy
                if d2 < 1 {
                    dx = Double.random(in: -0.5...0.5)
                    dy = Double.random(in: -0.5...0.5)
                    d2 = 1
                }
                let d = d2.squareRoot()
                let force = repulsion / d2
                let fx = (dx / d) * force
                let fy = (dy / d) * force
                a.vx += fx
                a.vy += fy
                b.vx -= fx
                b.vy -= fy
                points[ids[j]] = b
            }
            points[ids[i]] = a
        }

        // Pass 2: edge springs.
        for e in edges {
            guard var a = points[e.a], var b = points[e.b] else { continue }
            let rest = e.hasLabel ? springRestAI : springRestCooccur
            let dx = b.x - a.x
            let dy = b.y - a.y
            let raw = (dx * dx + dy * dy).squareRoot()
            let d = raw == 0 ? 0.01 : raw
            let force = (d - rest) * springK
            let fx = (dx / d) * force
            let fy = (dy / d) * force
            a.vx += fx
            a.vy += fy
            b.vx -= fx
            b.vy -= fy
            points[e.a] = a
            points[e.b] = b
        }

        // Pass 3: center pull + wander + damping + integrate. Fixed points just stop.
        for id in ids {
            guard var p = points[id] else { continue }
            if p.fixed {
                p.vx = 0
                p.vy = 0
                points[id] = p
                continue
            }
            p.vx += (cx - p.x) * centerK
            p.vy += (cy - p.y) * centerK
            if wanderEnabled {
                p.vx += sin(t * 0.0012 + p.phase) * wander
                p.vy += cos(t * 0.0009 + p.phase * 1.7) * wander
            }
            p.vx *= damping
            p.vy *= damping
            p.x += p.vx
            p.y += p.vy
            points[id] = p
        }
    }
}
