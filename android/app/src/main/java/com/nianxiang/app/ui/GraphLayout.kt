package com.nianxiang.app.ui

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** Mutable simulation point for one graph node. Pure JVM, no Android imports, so it's
 *  unit-testable without Robolectric. */
data class GraphPoint(
    var x: Float,
    var y: Float,
    var vx: Float = 0f,
    var vy: Float = 0f,
    var fixed: Boolean = false,
    val phase: Float = 0f,
)

/** Force-directed layout for the relationship graph. Constants and the per-tick step are a
 *  line-for-line port of the web client's useForceLayout (GraphOverlay.tsx) — Android has no
 *  system reduced-motion toggle, so unlike the web version the idle wander drift always runs. */
object GraphLayout {
    const val REPULSION = 2500f
    const val SPRING_K = 0.04f
    const val SPRING_REST_AI = 90f
    const val SPRING_REST_COOCCUR = 140f
    const val CENTER_K = 0.004f
    const val DAMPING = 0.9f
    const val WANDER = 0.035f

    /** One edge for layout purposes: ids of the two endpoints + whether it carries an AI
     *  label (vs. a bare co-occurrence link), which sets the spring's rest length. */
    data class LayoutEdge(val a: String, val b: String, val hasLabel: Boolean)

    /** Initial placement for a freshly-appeared node: even spacing around a circle, phase
     *  seeded from a hash of its id (so the same node always starts at the same wander phase). */
    fun initialPosition(index: Int, total: Int, id: String, width: Float, height: Float): GraphPoint {
        val cx = if (width > 0f) width / 2f else 300f
        val cy = if (height > 0f) height / 2f else 200f
        val radius = maxOf(minOf(width, height) * 0.35f, 60f)
        var hash = 0
        for (c in id) hash = (hash * 31 + c.code)
        val angle = (index.toFloat() / maxOf(total, 1)) * (2 * Math.PI).toFloat()
        return GraphPoint(
            x = cx + radius * cos(angle),
            y = cy + radius * sin(angle),
            phase = (abs(hash) % 628) / 100f,
        )
    }

    /**
     * One simulation tick, mutating [points] in place: pairwise repulsion, edge springs
     * (rest length by [LayoutEdge.hasLabel]), center pull + idle wander drift, damping,
     * then integrate. Fixed points (being dragged) don't move.
     */
    fun step(points: Map<String, GraphPoint>, ids: List<String>, edges: List<LayoutEdge>, width: Float, height: Float, t: Float) {
        val cx = if (width > 0f) width / 2f else 300f
        val cy = if (height > 0f) height / 2f else 200f

        for (i in ids.indices) {
            val a = points[ids[i]] ?: continue
            for (j in i + 1 until ids.size) {
                val b = points[ids[j]] ?: continue
                var dx = a.x - b.x
                var dy = a.y - b.y
                var d2 = dx * dx + dy * dy
                if (d2 < 1f) {
                    dx = (Math.random() - 0.5).toFloat()
                    dy = (Math.random() - 0.5).toFloat()
                    d2 = 1f
                }
                val d = sqrt(d2)
                val force = REPULSION / d2
                val fx = (dx / d) * force
                val fy = (dy / d) * force
                a.vx += fx
                a.vy += fy
                b.vx -= fx
                b.vy -= fy
            }
        }

        for (e in edges) {
            val a = points[e.a] ?: continue
            val b = points[e.b] ?: continue
            val rest = if (e.hasLabel) SPRING_REST_AI else SPRING_REST_COOCCUR
            val dx = b.x - a.x
            val dy = b.y - a.y
            val d = sqrt(dx * dx + dy * dy).let { if (it == 0f) 0.01f else it }
            val force = (d - rest) * SPRING_K
            val fx = (dx / d) * force
            val fy = (dy / d) * force
            a.vx += fx
            a.vy += fy
            b.vx -= fx
            b.vy -= fy
        }

        for (id in ids) {
            val p = points[id] ?: continue
            if (p.fixed) {
                p.vx = 0f
                p.vy = 0f
                continue
            }
            p.vx += (cx - p.x) * CENTER_K
            p.vy += (cy - p.y) * CENTER_K
            p.vx += sin(t * 0.0012f + p.phase) * WANDER
            p.vy += cos(t * 0.0009f + p.phase * 1.7f) * WANDER
            p.vx *= DAMPING
            p.vy *= DAMPING
            p.x += p.vx
            p.y += p.vy
        }
    }
}
