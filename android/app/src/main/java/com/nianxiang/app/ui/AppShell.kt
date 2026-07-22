package com.nianxiang.app.ui

import android.graphics.BitmapFactory
import android.view.ViewConfiguration
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import coil.compose.AsyncImage
import com.nianxiang.app.data.Entry
import com.nianxiang.app.particle.ParticleSceneState
import com.nianxiang.app.particle.ParticleView
import com.nianxiang.app.particle.particleModeFor
import kotlin.math.absoluteValue
import kotlin.math.hypot
import kotlin.math.min

private enum class AppOverlay {
    REVIEW,
    PEOPLE,
    PROFILE,
    ACCOUNT,
    CONNECTION,
}

@Composable
fun AppRoot(state: UiState, viewModel: AppViewModel) {
    var overlay by rememberSaveable { mutableStateOf<AppOverlay?>(null) }
    var sessionOpen by rememberSaveable { mutableStateOf(false) }
    var particleView by remember { mutableStateOf<ParticleView?>(null) }
    var entrancePhotoId by remember { mutableStateOf<String?>(null) }
    val particleMode = particleModeFor(
        sessionOpen = sessionOpen,
        userPresent = state.user != null,
        hasPhoto = state.photoBytes != null,
        phase = state.phase,
        sessionTab = state.sessionTab,
        mood = state.sessionEntry?.mood.orEmpty(),
        lines = state.sessionMessages.map { it.content },
    )
    val photoId = state.sessionEntry?.id.takeIf { sessionOpen }
    val particleScene = ParticleSceneState(
        photoId = photoId,
        jpeg = state.photoBytes.takeIf { sessionOpen },
        depthJson = state.depthJson.takeIf { sessionOpen },
        mode = particleMode,
    )
    val particleListener = remember {
        object : ParticleView.Listener {
            override fun onEntranceStarted(photoId: String) {
                entrancePhotoId = photoId
            }
        }
    }

    LaunchedEffect(photoId) {
        if (entrancePhotoId != photoId) entrancePhotoId = null
    }
    DisposableEffect(Unit) {
        onDispose { particleView?.release() }
    }

    NianxiangBackHandler(enabled = overlay != null) { overlay = null }
    LaunchedEffect(state.navigateToSession) {
        if (state.navigateToSession) {
            overlay = null
            sessionOpen = true
            viewModel.consumeSessionNavigation()
        }
    }
    // 进程被杀后 sessionOpen 会随 saved state 恢复，但 ViewModel 里的 sessionEntry 已丢失，
    // 若不重置会永远停在会话页的加载态。
    LaunchedEffect(sessionOpen, state.sessionEntry == null) {
        if (sessionOpen && state.sessionEntry == null) sessionOpen = false
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .observeParticleGestures(sessionOpen, particleView),
    ) {
        AndroidView(
            factory = { context ->
                ParticleView(context).also {
                    it.listener = particleListener
                    particleView = it
                }
            },
            update = { view ->
                view.listener = particleListener
                view.submit(particleScene)
            },
            modifier = Modifier.fillMaxSize(),
        )

        when {
            state.user == null -> AuthScreen(state, viewModel)
            sessionOpen -> SessionScreen(
                state = state,
                viewModel = viewModel,
                particleEntranceStarted = entrancePhotoId == photoId,
            ) { sessionOpen = false }
            else -> NxBackdrop {
                TimelineScreen(
                    state = state,
                    viewModel = viewModel,
                    openEntry = { entry ->
                        overlay = null
                        sessionOpen = true
                        viewModel.openEntry(entry)
                    },
                    openReview = { overlay = AppOverlay.REVIEW },
                    openPeople = { overlay = AppOverlay.PEOPLE },
                    openAccount = { overlay = AppOverlay.ACCOUNT },
                )
            }
        }

        when (overlay) {
            AppOverlay.REVIEW -> ReviewOverlay(
                state,
                viewModel,
                dismiss = { overlay = null },
            )
            AppOverlay.PEOPLE -> PeopleOverlay(state, viewModel) { overlay = null }
            AppOverlay.PROFILE -> ProfileOverlay(state, viewModel) { overlay = null }
            AppOverlay.ACCOUNT -> AccountOverlay(
                state,
                viewModel,
                dismiss = { overlay = null },
                openProfile = { overlay = AppOverlay.PROFILE },
                openConnection = { overlay = AppOverlay.CONNECTION },
            )
            AppOverlay.CONNECTION -> ConnectionOverlay(state, viewModel) { overlay = AppOverlay.ACCOUNT }
            null -> Unit
        }
    }
}

internal fun Modifier.observeParticleGestures(enabled: Boolean, view: ParticleView?): Modifier {
    if (!enabled || view == null) return this
    return pointerInput(view) {
        val touchSlop = viewConfiguration.touchSlop
        var lastTapAt = 0L
        var lastTapPosition = Offset.Unspecified
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Final)
            var eligible = !down.isConsumed
            var moved = 0f
            var usedMultiplePointers = false
            var lastSpan = 0f
            var totalDelta = Offset.Zero
            var orbiting = false
            var finishedAt = down.uptimeMillis
            var event = awaitPointerEvent(pass = PointerEventPass.Final)
            do {
                finishedAt = event.changes.maxOfOrNull { it.uptimeMillis } ?: finishedAt
                if (event.changes.size == 1 && event.changes.any { it.isConsumed }) eligible = false
                val pressed = event.changes.filter { it.pressed }
                when {
                    eligible && pressed.size >= 2 -> {
                        usedMultiplePointers = true
                        val first = pressed[0].position
                        val second = pressed[1].position
                        val span = hypot(first.x - second.x, first.y - second.y)
                        if (lastSpan > 0f && span > 0f) view.zoomBy(span / lastSpan)
                        lastSpan = span
                    }
                    eligible && pressed.size == 1 && !usedMultiplePointers -> {
                        val change = pressed[0]
                        val delta = change.position - change.previousPosition
                        totalDelta += delta
                        moved = totalDelta.getDistance()
                        if (!orbiting && moved >= touchSlop) {
                            if (kotlin.math.abs(totalDelta.x) > kotlin.math.abs(totalDelta.y)) {
                                orbiting = true
                                view.orbitBy(
                                    totalDelta.x,
                                    totalDelta.y,
                                    change.position.x,
                                    change.position.y,
                                )
                            } else {
                                eligible = false
                            }
                        } else if (orbiting && !change.isConsumed && delta != Offset.Zero) {
                            view.orbitBy(delta.x, delta.y, change.position.x, change.position.y)
                        }
                    }
                }
                if (event.changes.none { it.pressed }) break
                event = awaitPointerEvent(pass = PointerEventPass.Final)
            } while (true)

            view.clearParticleFocus()
            if (eligible && !usedMultiplePointers && moved < touchSlop) {
                val closeInTime = lastTapAt > 0L && finishedAt - lastTapAt <= ViewConfiguration.getDoubleTapTimeout()
                val closeInSpace = lastTapAt > 0L &&
                    (down.position - lastTapPosition).getDistance() <= touchSlop * 2f
                if (closeInTime && closeInSpace) {
                    view.resetCamera()
                    lastTapAt = 0L
                    lastTapPosition = Offset.Unspecified
                } else {
                    view.pulseAt(down.position.x, down.position.y)
                    lastTapAt = finishedAt
                    lastTapPosition = down.position
                }
            }
        }
    }
}

@Composable
private fun AuthScreen(state: UiState, viewModel: AppViewModel) {
    var username by rememberSaveable { mutableStateOf("") }
    // 密码不进 saved instance state：该 Bundle 会随进程回收明文落盘。
    var password by remember { mutableStateOf("") }
    var displayName by rememberSaveable { mutableStateOf("") }
    var connectionOpen by rememberSaveable { mutableStateOf(false) }
    val bootstrap = state.bootstrapped == false

    NxBackdrop {
        Box(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(20.dp),
            contentAlignment = Alignment.Center,
        ) {
            NxPanel(Modifier.fillMaxWidth().widthIn(max = 430.dp)) {
                Column(
                    Modifier.padding(horizontal = 24.dp, vertical = 28.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        if (bootstrap) "✦ 首次启用" else "✦ 登录念想",
                        color = NxColors.Text,
                        fontFamily = NxSerif,
                        fontSize = 25.sp,
                    )
                    Text(
                        if (bootstrap) "创建管理员账号，记忆会锁在你的账户下" else "输入用户名与密码",
                        color = NxColors.TextDim,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 7.dp, bottom = 22.dp),
                    )
                    if (bootstrap) {
                        NxField(displayName, { displayName = it }, "怎么称呼你?", Modifier.fillMaxWidth(), maxLength = 20)
                        Spacer(Modifier.height(10.dp))
                    }
                    NxField(username, { username = it }, "用户名 (字母数字_)", Modifier.fillMaxWidth(), maxLength = 32)
                    Spacer(Modifier.height(10.dp))
                    NxField(password, { password = it }, "密码 (至少 8 位)", Modifier.fillMaxWidth(), password = true, maxLength = 128)
                    state.error?.let {
                        Text(it, color = NxColors.Error, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp))
                    }
                    Spacer(Modifier.height(18.dp))
                    NxPrimaryButton(
                        text = when {
                            state.loading -> "…"
                            bootstrap -> "启用 ✦"
                            else -> "进入 ✦"
                        },
                        onClick = {
                            if (bootstrap) viewModel.bootstrap(username.trim(), password, displayName.trim())
                            else viewModel.login(username.trim(), password)
                        },
                        enabled = !state.loading && username.isNotBlank() && password.length >= 8,
                    )
                    NxPill(
                        text = "连接设置",
                        onClick = { connectionOpen = true },
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }
            }
        }
    }
    if (connectionOpen) ConnectionOverlay(state, viewModel) { connectionOpen = false }
}

@Composable
private fun TimelineScreen(
    state: UiState,
    viewModel: AppViewModel,
    openEntry: (Entry) -> Unit,
    openReview: () -> Unit,
    openPeople: () -> Unit,
    openAccount: () -> Unit,
) {
    var confirmDelete by rememberSaveable { mutableStateOf<String?>(null) }
    var centeredInitial by rememberSaveable { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(30)) { uris ->
        viewModel.importPhotos(uris)
    }
    val filtered = remember(state.entries, state.query, state.filter, state.sortAscending) {
        val query = state.query.trim().lowercase()
        val items = state.entries.filter { entry ->
            (state.filter == "all" || entry.status == state.filter) &&
                (query.isEmpty() || listOf(entry.title, entry.diaryText, entry.mood, entry.chat.joinToString { it.content })
                    .joinToString(" ").lowercase().contains(query))
        }
        if (state.sortAscending) items.reversed() else items
    }
    val pagerState = rememberPagerState(pageCount = { filtered.size + 1 })

    LaunchedEffect(filtered.map { it.id }) {
        if (filtered.isNotEmpty() && !centeredInitial) {
            pagerState.scrollToPage(1)
            centeredInitial = true
        } else if (pagerState.currentPage > filtered.size) {
            pagerState.scrollToPage(filtered.size)
        }
    }

    Column(Modifier.fillMaxSize()) {
        TimelineToolbar(
            state,
            viewModel,
            openReview,
            openPeople,
            openAccount,
        )
        state.error?.let { error ->
            Row(
                Modifier.padding(horizontal = 18.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    error,
                    color = NxColors.Error,
                    fontSize = 11.sp,
                    modifier = Modifier.weight(1f, fill = false),
                    maxLines = 2,
                )
                NxPill("重试", { viewModel.loadHome() })
            }
        }
        when {
            state.loading && state.entries.isEmpty() -> LoadingMemories(state.uploadProgress)
            state.entries.isEmpty() -> EmptyTimeline {
                picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }
            filtered.isEmpty() -> EmptyFiltered()
            else -> BoxWithConstraints(Modifier.fillMaxSize()) {
                val cardHeight = LocalConfiguration.current.screenHeightDp.dp * 0.44f
                val cardMaxWidth = maxWidth * 0.72f
                val focused = filtered.getOrNull(pagerState.currentPage - 1)

                MemoryCarousel(
                    entries = filtered,
                    thumbnails = state.thumbnails,
                    pagerState = pagerState,
                    cardHeight = cardHeight,
                    cardMaxWidth = cardMaxWidth,
                    add = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    openEntry = openEntry,
                )

                focused?.let { entry ->
                    Box(Modifier.align(Alignment.BottomCenter)) {
                        TimelineFooter(
                            entry = entry,
                            page = pagerState.currentPage,
                            count = filtered.size,
                            deleteArmed = confirmDelete == entry.id,
                            open = { openEntry(entry) },
                            delete = {
                                if (confirmDelete == entry.id) {
                                    confirmDelete = null
                                    viewModel.deleteEntry(entry.id)
                                } else {
                                    confirmDelete = entry.id
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun MemoryCarousel(
    entries: List<Entry>,
    thumbnails: Map<String, ByteArray>,
    pagerState: PagerState,
    cardHeight: Dp,
    cardMaxWidth: Dp,
    add: () -> Unit,
    openEntry: (Entry) -> Unit,
) {
    HorizontalPager(
        state = pagerState,
        modifier = Modifier.fillMaxWidth().fillMaxHeight().padding(bottom = 104.dp).testTag("memory-carousel"),
        contentPadding = PaddingValues(horizontal = 52.dp),
        pageSpacing = 18.dp,
        beyondViewportPageCount = 1,
        verticalAlignment = Alignment.CenterVertically,
    ) { page ->
        val pageOffset = ((pagerState.currentPage - page) + pagerState.currentPageOffsetFraction)
            .absoluteValue.coerceIn(0f, 1f)
        val cardModifier = Modifier.graphicsLayer {
            scaleX = 1f - pageOffset * 0.1f
            scaleY = 1f - pageOffset * 0.1f
            alpha = 1f - pageOffset * 0.45f
        }
        if (page == 0) {
            AddMemoryCard(cardHeight, cardModifier, add)
        } else {
            val entry = entries[page - 1]
            TimelineCard(
                entry,
                thumbnails[entry.id],
                cardHeight,
                cardMaxWidth,
                cardModifier,
            ) { openEntry(entry) }
        }
    }
}

@Composable
private fun TimelineToolbar(
    state: UiState,
    viewModel: AppViewModel,
    openReview: () -> Unit,
    openPeople: () -> Unit,
    openAccount: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("all" to "全部", "new" to "未开始", "chatting" to "对话中", "done" to "已成念")
                .forEach { (key, label) ->
                    NxPill(label, { viewModel.setFilter(key) }, selected = state.filter == key)
                }
        }
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            NxPill(if (state.sortAscending) "⇅ 最早" else "⇅ 最近", viewModel::toggleSort)
            NxPill("✦ 回顾", openReview)
            NxPill("✧ 人物", openPeople)
            NxPill("◐ ${state.user?.displayName ?: "选择使用者"}", openAccount)
        }
        NxSearchField(state.query, viewModel::setQuery, Modifier.fillMaxWidth())
    }
}

@Composable
private fun TimelineCard(
    entry: Entry,
    thumb: ByteArray?,
    cardHeight: Dp,
    maxWidth: Dp,
    modifier: Modifier,
    open: () -> Unit,
) {
    val aspect = remember(thumb) { imageAspect(thumb) }
    val width = (cardHeight * aspect).coerceAtMost(maxWidth).coerceAtLeast(cardHeight * 0.48f)
    Box(
        modifier
            .height(cardHeight)
            .width(width)
            .clip(RoundedCornerShape(10.dp))
            .background(Color(0xFF111113))
            .clickable(onClick = open),
        contentAlignment = Alignment.Center,
    ) {
        if (thumb == null) {
            CircularProgressIndicator(Modifier.size(22.dp), color = NxColors.TextFaint, strokeWidth = 1.5.dp)
        } else {
            AsyncImage(
                model = thumb,
                contentDescription = "打开${entry.title}",
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
        }
    }
}

@Composable
private fun AddMemoryCard(cardHeight: Dp, modifier: Modifier, add: () -> Unit) {
    Surface(
        onClick = add,
        modifier = modifier
            .height(cardHeight)
            .width(cardHeight * 0.59f)
            .drawBehind {
                drawRoundRect(
                    color = Color(0x2EFFFFFF),
                    cornerRadius = CornerRadius(10.dp.toPx()),
                    style = Stroke(
                        width = 1.5.dp.toPx(),
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 5.dp.toPx())),
                    ),
                )
            },
        color = Color(0x08FFFFFF),
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(0.dp, Color.Transparent),
    ) {
        Column(
            Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("＋", color = NxColors.TextFaint, fontSize = 30.sp, fontWeight = FontWeight.Light)
            Text("添加照片", color = NxColors.TextFaint, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

@Composable
internal fun TimelineFooter(
    entry: Entry,
    page: Int,
    count: Int,
    deleteArmed: Boolean,
    open: () -> Unit,
    delete: () -> Unit,
) {
    Column(
        Modifier.navigationBarsPadding().padding(bottom = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(entry.title, color = NxColors.TextDim, fontSize = 14.sp, maxLines = 1)
        Text("${min(page, count)} / $count", color = NxColors.TextFaint, fontSize = 11.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            NxPill("✧ 翻开这一天", open)
            NxPill(
                if (deleteArmed) "确认丢弃?" else "✕ 丢弃",
                delete,
                modifier = Modifier,
            )
        }
    }
}

@Composable
internal fun NianxiangBackHandler(enabled: Boolean, onBack: () -> Unit) {
    BackHandler(enabled = enabled, onBack = onBack)
}

@Composable
private fun LoadingMemories(progress: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(color = NxColors.Paper, strokeWidth = 2.dp)
            Text(
                progress.ifBlank { "正在取回记忆" },
                color = NxColors.TextDim,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 12.dp),
            )
        }
    }
}

@Composable
private fun EmptyTimeline(add: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("✦", color = NxColors.Gold.copy(alpha = 0.65f), fontSize = 26.sp)
            Text("还没有念想。", color = NxColors.TextDim, fontFamily = NxSerif, fontSize = 17.sp)
            Text(
                "点击下方按钮，记下第一张吧。",
                color = NxColors.TextFaint,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 7.dp),
            )
            NxPill("＋ 添加照片", add, modifier = Modifier.padding(top = 18.dp), icon = Icons.Default.Add)
        }
    }
}

@Composable
private fun EmptyFiltered() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("没有符合条件的记忆", color = NxColors.TextDim, fontFamily = NxSerif, fontSize = 17.sp)
    }
}

private fun imageAspect(bytes: ByteArray?): Float {
    if (bytes == null) return 0.72f
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    if (options.outWidth <= 0 || options.outHeight <= 0) return 0.72f
    return options.outWidth.toFloat() / options.outHeight
}
