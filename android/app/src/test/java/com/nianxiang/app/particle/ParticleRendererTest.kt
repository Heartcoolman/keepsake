package com.nianxiang.app.particle

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class ParticleRendererTest {
    @Test
    fun halveIndicesKeepsEveryOtherIndexForEvenSize() {
        val indices = intArrayOf(10, 20, 30, 40, 50, 60)
        assertArrayEquals(intArrayOf(10, 30, 50), halveIndices(indices))
    }

    @Test
    fun halveIndicesFloorsForOddSize() {
        val indices = intArrayOf(1, 2, 3, 4, 5)
        assertArrayEquals(intArrayOf(1, 3), halveIndices(indices))
    }

    @Test
    fun halveIndicesReturnsEmptyForEmptyInput() {
        assertEquals(0, halveIndices(IntArray(0)).size)
    }

    @Test
    fun halveIndicesPreservesOriginalOrderOfKeptEntries() {
        val original = IntArray(200) { it * 7 }
        val halved = halveIndices(original)
        assertEquals(100, halved.size)
        for (i in halved.indices) {
            assertEquals(original[i * 2], halved[i])
        }
    }
}
