package com.nianxiang.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.unit.dp
import androidx.test.espresso.Espresso
import com.nianxiang.app.data.Entry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class NianxiangUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun filterSegmentChangesSelection() {
        var selected = "all"
        compose.setContent {
            NianxiangTheme {
                var value by remember { mutableStateOf(selected) }
                NxSegmentedControl(
                    options = listOf("all" to "全部", "done" to "已成念"),
                    selected = value,
                    onSelected = {
                        value = it
                        selected = it
                    },
                )
            }
        }

        compose.onNodeWithText("已成念").performClick()
        compose.runOnIdle { assertEquals("done", selected) }
    }

    @Test
    fun sessionTabChangesSelection() {
        var selected = "diary"
        compose.setContent {
            NianxiangTheme {
                var value by remember { mutableStateOf(selected) }
                NxSegmentedControl(
                    options = listOf("diary" to "日记", "chat" to "对话"),
                    selected = value,
                    onSelected = {
                        value = it
                        selected = it
                    },
                )
            }
        }

        compose.onNodeWithText("对话").performClick()
        compose.runOnIdle { assertEquals("chat", selected) }
    }

    @Test
    fun timelineCarouselSwipesToNextMemory() {
        var currentPage = 1
        compose.setContent {
            NianxiangTheme {
                val entries = remember {
                    listOf(
                        Entry(id = "first", title = "第一段记忆"),
                        Entry(id = "second", title = "第二段记忆"),
                    )
                }
                val pager = rememberPagerState(initialPage = 1, pageCount = { entries.size + 1 })
                LaunchedEffect(pager.currentPage) { currentPage = pager.currentPage }
                Box(Modifier.width(360.dp).height(600.dp)) {
                    MemoryCarousel(
                        entries = entries,
                        thumbnails = emptyMap(),
                        pagerState = pager,
                        cardHeight = 300.dp,
                        cardMaxWidth = 260.dp,
                        add = {},
                        openEntry = {},
                    )
                }
            }
        }

        compose.onNodeWithTag("memory-carousel").performTouchInput { swipeLeft() }
        compose.waitUntil(3_000) { currentPage == 2 }
        compose.runOnIdle { assertEquals(2, currentPage) }
    }

    @Test
    fun timelineDeleteRequiresConfirmation() {
        var deleted = false
        compose.setContent {
            NianxiangTheme {
                var armed by remember { mutableStateOf(false) }
                TimelineFooter(
                    entry = Entry(id = "entry", title = "一段很长但不能挤坏按钮的记忆标题"),
                    page = 1,
                    count = 3,
                    deleteArmed = armed,
                    open = {},
                    delete = {
                        if (armed) deleted = true else armed = true
                    },
                )
            }
        }

        compose.onNodeWithText("✕ 丢弃").performClick()
        compose.onNodeWithText("确认丢弃?").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(true, deleted) }
    }

    @Test
    fun overlayCloseInvokesDismiss() {
        var dismissed = false
        compose.setContent {
            NianxiangTheme {
                OverlayFrame("✦ 测试面板", { dismissed = true }) {
                    Text("面板内容")
                }
            }
        }

        compose.onNodeWithContentDescription("关闭").performClick()
        compose.runOnIdle { assertEquals(true, dismissed) }
    }

    @Test
    fun systemBackDismissesActiveOverlay() {
        compose.setContent {
            NianxiangTheme {
                var open by remember { mutableStateOf(true) }
                NianxiangBackHandler(enabled = open) { open = false }
                Box(Modifier.fillMaxSize()) {
                    Text(if (open) "覆盖层已打开" else "覆盖层已关闭")
                }
            }
        }

        Espresso.pressBack()
        compose.onNodeWithText("覆盖层已关闭").assertIsDisplayed()
    }
}
