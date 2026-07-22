package com.nianxiang.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.hypot

class GraphLayoutTest {

    @Test
    fun `overlapping nodes separate after one step`() {
        val points = mapOf(
            "a" to GraphPoint(x = 100f, y = 100f),
            "b" to GraphPoint(x = 100f, y = 100f),
        )
        GraphLayout.step(points, listOf("a", "b"), emptyList(), 600f, 400f, 0f)
        val a = points.getValue("a")
        val b = points.getValue("b")
        val distance = hypot((a.x - b.x).toDouble(), (a.y - b.y).toDouble())
        assertTrue(distance > 0.0)
    }

    @Test
    fun `spring pulls edge length toward its rest length`() {
        val points = mapOf(
            "a" to GraphPoint(x = 0f, y = 0f, fixed = true),
            "b" to GraphPoint(x = 300f, y = 0f),
        )
        val edges = listOf(GraphLayout.LayoutEdge("a", "b", hasLabel = true))
        var distance = 300f
        repeat(120) { tick ->
            GraphLayout.step(points, listOf("a", "b"), edges, 800f, 800f, tick.toFloat())
            distance = abs(points.getValue("b").x - points.getValue("a").x)
        }
        val initialGap = abs(300f - GraphLayout.SPRING_REST_AI)
        val finalGap = abs(distance - GraphLayout.SPRING_REST_AI)
        assertTrue("expected $distance to have converged toward ${GraphLayout.SPRING_REST_AI}", finalGap < initialGap / 3f)
    }

    @Test
    fun `damping decays velocity when otherwise unforced`() {
        // Point sits at the canvas center (no center-pull force) with no other nodes/edges,
        // so damping is the only force left acting on its existing velocity.
        val points = mapOf("a" to GraphPoint(x = 300f, y = 300f, vx = 10f, vy = 0f))
        GraphLayout.step(points, listOf("a"), emptyList(), 600f, 600f, 0f)
        assertTrue(abs(points.getValue("a").vx) < 10f)
    }

    @Test
    fun `fixed point does not move`() {
        val points = mapOf(
            "a" to GraphPoint(x = 50f, y = 50f, fixed = true),
            "b" to GraphPoint(x = 500f, y = 500f),
        )
        GraphLayout.step(points, listOf("a", "b"), emptyList(), 600f, 600f, 0f)
        val a = points.getValue("a")
        assertEquals(50f, a.x, 0.0001f)
        assertEquals(50f, a.y, 0.0001f)
        assertEquals(0f, a.vx, 0.0001f)
        assertEquals(0f, a.vy, 0.0001f)
    }
}
