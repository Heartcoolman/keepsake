package com.nianxiang.app.ui

import android.Manifest
import android.app.DatePickerDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Mic
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextIndent
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import coil.compose.AsyncImage
import com.nianxiang.app.data.ChatMessage
import com.nianxiang.app.data.Entry
import com.nianxiang.app.data.FaceRef
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

@Composable
fun SessionScreen(
    state: UiState,
    viewModel: AppViewModel,
    particleEntranceStarted: Boolean = false,
    back: () -> Unit,
) {
    val entry = state.sessionEntry
    val leave = {
        viewModel.closeSession()
        back()
    }
    BackHandler(onBack = leave)
    if (entry == null) {
        NxBackdrop {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = NxColors.Paper, strokeWidth = 2.dp)
            }
        }
        return
    }

    var input by rememberSaveable(entry.id) { mutableStateOf("") }
    var textHidden by rememberSaveable(entry.id) { mutableStateOf(false) }
    var editingDiary by rememberSaveable(entry.id) { mutableStateOf(false) }
    var namingFace by rememberSaveable(entry.id) { mutableStateOf<Int?>(null) }
    var orbitHintExpired by rememberSaveable(entry.id) { mutableStateOf(false) }
    val context = LocalContext.current
    val recognizer = remember { SpeechRecognizer.createSpeechRecognizer(context) }
    var listening by remember { mutableStateOf(false) }
    val speechIntent = remember {
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        }
    }
    DisposableEffect(recognizer) {
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onResults(results: Bundle?) {
                results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { input = it }
                listening = false
            }
            override fun onPartialResults(results: Bundle?) {
                results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { input = it }
            }
            override fun onError(error: Int) { listening = false }
            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() { listening = false }
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
        onDispose { recognizer.destroy() }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            listening = true
            recognizer.startListening(speechIntent)
        }
    }
    val toggleSpeech = {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            if (listening) {
                recognizer.stopListening()
                listening = false
            } else {
                listening = true
                recognizer.startListening(speechIntent)
            }
        } else {
            permission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
    val pickDate = {
        val calendar = Calendar.getInstance().apply { timeInMillis = entry.takenAt }
        DatePickerDialog(
            context,
            { _, year, month, day ->
                val selected = Calendar.getInstance().apply {
                    set(year, month, day, 12, 0, 0)
                    set(Calendar.MILLISECOND, 0)
                }
                viewModel.setTakenAt(selected.timeInMillis)
            },
            calendar.get(Calendar.YEAR),
            calendar.get(Calendar.MONTH),
            calendar.get(Calendar.DAY_OF_MONTH),
        ).show()
    }

    Box(Modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = state.photoBytes != null && !particleEntranceStarted,
            enter = fadeIn(),
            exit = fadeOut(tween(350)),
        ) {
            AsyncImage(
                model = state.photoBytes,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize().background(Color.Black),
            )
        }
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    listOf(Color(0x30000000), Color.Transparent, Color(0x66000000)),
                ),
            ),
        )

        val diaryVisible = entry.status == "done" && state.sessionTab == "diary"
        if (diaryVisible) {
            DiaryView(
                entry = entry,
                streamed = state.diaryStream,
                editing = editingDiary,
                setEditing = { editingDiary = it },
                save = viewModel::saveDiary,
                pickDate = pickDate,
            )
        } else {
            ChatView(
                state = state,
                entry = entry,
                textHidden = textHidden,
                input = input,
                changeInput = { input = it },
                listening = listening,
                toggleSpeech = toggleSpeech,
                send = {
                    val text = input.trim()
                    if (text.isNotEmpty()) {
                        input = ""
                        viewModel.sendMessage(text)
                    }
                },
                writeDiary = viewModel::generateDiary,
                nameFace = { namingFace = it },
                viewModel = viewModel,
            )
        }

        NxIconButton(
            Icons.AutoMirrored.Filled.ArrowBack,
            "回到时光轴",
            leave,
            modifier = Modifier.align(Alignment.TopStart).statusBarsPadding().padding(start = 14.dp, top = 10.dp),
        )

        // Tabs and date stack in one column so the date can never slide under the
        // tab pill when the status-bar inset shrinks (e.g. landscape).
        Column(
            modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (entry.status == "done") {
                NxSegmentedControl(
                    options = listOf("diary" to "日记", "chat" to "对话"),
                    selected = state.sessionTab,
                    onSelected = viewModel::setSessionTab,
                )
            }
            if (!diaryVisible) {
                DatePill(entry, pickDate)
            }
        }

        if (!diaryVisible) {
            Surface(
                onClick = { textHidden = !textHidden },
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .statusBarsPadding()
                    .padding(top = 10.dp, end = 14.dp),
                color = Color(0x9918181C),
                shape = RoundedCornerShape(50),
                border = BorderStroke(1.dp, Color(0x12FFFFFF)),
            ) {
                Text(
                    if (textHidden) "字幕模式 · 点按显示文字" else "字幕模式 · 点按隐去文字",
                    color = NxColors.TextFaint,
                    fontSize = 11.sp,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
        }

        if (state.phase == "chatting" && !orbitHintExpired) {
            LaunchedEffect(entry.id) {
                delay(6_000)
                orbitHintExpired = true
            }
        }
        AnimatedVisibility(
            visible = state.phase == "chatting" && !orbitHintExpired,
            enter = fadeIn(),
            exit = fadeOut(animationSpec = tween(800)),
            modifier = Modifier
                .align(Alignment.BottomStart)
                .navigationBarsPadding()
                .padding(start = 22.dp, bottom = 168.dp),
        ) {
            Text(
                "拖动环视 · 双指缩放 · 双击复位",
                color = NxColors.TextFaint,
                fontSize = 11.sp,
                letterSpacing = 1.2.sp,
            )
        }

        if (state.phase == "loading" || state.phase == "analyzing") {
            Text(
                "念念正在端详这张照片…",
                color = NxColors.TextDim,
                fontFamily = NxSerif,
                fontSize = 13.sp,
                modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 112.dp),
            )
        }
        AnimatedVisibility(
            visible = state.phase == "condensing",
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.fillMaxSize(),
        ) {
            Box(Modifier.fillMaxSize().background(Color(0x78000000)), contentAlignment = Alignment.Center) {
                Text(
                    "思 绪 正 在 沉 淀 . . .",
                    color = NxColors.TextDim,
                    fontFamily = NxSerif,
                    fontSize = 15.sp,
                )
            }
        }
    }

    namingFace?.let { index ->
        FaceNamerDialog(
            title = "这是谁？",
            people = state.people,
            dismiss = { namingFace = null },
            chooseExisting = { person ->
                viewModel.assignFaces(
                    person.id,
                    listOf(FaceRef(entry.id, index)),
                    toast = "记住了，这是${person.name} ✦",
                )
                namingFace = null
            },
            createNew = { name, relation ->
                viewModel.createPerson(
                    name = name,
                    relation = relation,
                    samples = listOf(FaceRef(entry.id, index)),
                    toast = "记住了，这是$name ✦",
                )
                namingFace = null
            },
        )
    }
}

@Composable
private fun DatePill(entry: Entry, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        modifier = modifier,
        color = Color.Transparent,
        shape = RoundedCornerShape(50),
    ) {
        Text(
            SimpleDateFormat("yyyy年M月d日", Locale.CHINA).format(Date(entry.takenAt)),
            color = NxColors.TextDim,
            fontSize = 11.sp,
            modifier = Modifier.padding(horizontal = 11.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun ChatView(
    state: UiState,
    entry: Entry,
    textHidden: Boolean,
    input: String,
    changeInput: (String) -> Unit,
    listening: Boolean,
    toggleSpeech: () -> Unit,
    send: () -> Unit,
    writeDiary: () -> Unit,
    nameFace: (Int) -> Unit,
    viewModel: AppViewModel,
) {
    val conversationState = rememberLazyListState()
    LaunchedEffect(state.sessionMessages.size, state.sessionMessages.lastOrNull()?.content) {
        if (state.sessionMessages.isNotEmpty()) conversationState.scrollToItem(state.sessionMessages.size)
    }

    AnimatedVisibility(visible = !textHidden, enter = fadeIn(), exit = fadeOut()) {
        LazyColumn(
            Modifier.fillMaxSize(),
            state = conversationState,
            contentPadding = PaddingValues(start = 22.dp, end = 22.dp, top = 118.dp, bottom = 166.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item { Spacer(Modifier.fillParentMaxHeight(0.5f)) }
            itemsIndexed(state.sessionMessages) { _, message -> ConversationLine(message) }
        }
    }

    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Bottom,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .imePadding()
                .navigationBarsPadding()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            FaceRow(entry, state, viewModel, nameFace)
            if (state.sessionMessages.any { it.role == "user" }) {
                CondenseButton(
                    text = if (entry.status == "done") "✦ 重新凝聚" else "✦ 凝聚记忆",
                    onClick = writeDiary,
                    modifier = Modifier.padding(bottom = 8.dp),
                    enabled = !state.busy,
                )
            }
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                NxIconButton(
                    Icons.Default.Mic,
                    if (listening) "停止语音" else "语音输入",
                    toggleSpeech,
                    selected = listening,
                    enabled = !state.busy,
                )
                NxField(
                    value = input,
                    onValueChange = changeInput,
                    placeholder = if (listening) "正在听…" else "说点什么…",
                    modifier = Modifier.weight(1f),
                    enabled = !state.busy,
                    maxLength = 4000,
                )
                NxPill("发送", send, enabled = input.isNotBlank() && !state.busy)
            }
        }
    }
}

@Composable
private fun ConversationLine(message: ChatMessage) {
    val mine = message.role == "user"
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
    ) {
        if (mine) {
            Surface(
                modifier = Modifier.fillMaxWidth(0.72f),
                color = Color(0xA8181A20),
                shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, NxColors.Line),
            ) {
                Text(
                    message.content,
                    color = Color(0xD9FFFFFF),
                    fontSize = 14.sp,
                    lineHeight = 24.sp,
                    modifier = Modifier.padding(horizontal = 15.dp, vertical = 9.dp),
                )
            }
        } else {
            Text(
                message.content.ifBlank { "· · ·" },
                color = NxColors.Text,
                fontSize = 14.5.sp,
                lineHeight = 25.sp,
                style = TextStyle(shadow = Shadow(Color.Black, Offset(0f, 2f), 12f)),
                modifier = Modifier.fillMaxWidth(0.72f),
            )
        }
    }
}

@Composable
private fun DiaryView(
    entry: Entry,
    streamed: String,
    editing: Boolean,
    setEditing: (Boolean) -> Unit,
    save: (String, String) -> Unit,
    pickDate: () -> Unit,
) {
    var title by remember(entry.id, editing) { mutableStateOf(entry.title) }
    var body by remember(entry.id, editing) { mutableStateOf(entry.diaryText) }
    // 0x80 scrim: diary text sits directly on the particle photo, so bright photo
    // regions need extra dimming to keep white serif text readable.
    Box(Modifier.fillMaxSize().background(Color(0x80000000))) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 22.dp, end = 22.dp, top = 126.dp, bottom = 110.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item {
                if (editing) {
                    NxField(title, { title = it }, "标题", Modifier.fillMaxWidth(), maxLength = 200)
                } else {
                    Text(
                        entry.title.ifBlank { "这一天" },
                        color = Color(0xF2FFFFFF),
                        fontFamily = NxSerif,
                        fontSize = 26.sp,
                        lineHeight = 40.sp,
                        letterSpacing = 5.sp,
                        textAlign = TextAlign.Center,
                        style = TextStyle(shadow = Shadow(Color.Black, Offset(0f, 2f), 12f)),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                DatePill(entry, pickDate, Modifier.padding(top = 10.dp))
                Spacer(Modifier.height(36.dp))
                if (editing) {
                    NxField(
                        body,
                        { body = it },
                        "正文",
                        Modifier.fillMaxWidth().heightIn(min = 320.dp),
                        singleLine = false,
                        maxLength = 20000,
                    )
                    Row(
                        Modifier.fillMaxWidth().padding(top = 18.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        NxPill("取消", { setEditing(false) })
                        Spacer(Modifier.size(10.dp))
                        NxPill("保存", {
                            save(title.trim(), body.trim())
                            setEditing(false)
                        }, enabled = body.isNotBlank())
                    }
                } else {
                    val diary = entry.diaryText.ifBlank { streamed.ifBlank { "日记还在生成中…" } }
                    diary.split(Regex("\\n+")).filter(String::isNotBlank).forEach { paragraph ->
                        Text(
                            paragraph,
                            color = Color(0xE6FFFFFF),
                            fontFamily = NxSerif,
                            fontSize = 16.sp,
                            lineHeight = 36.sp,
                            style = TextStyle(
                                textIndent = TextIndent(firstLine = 32.sp),
                                shadow = Shadow(Color.Black, Offset(0f, 2f), 12f),
                            ),
                            modifier = Modifier.fillMaxWidth().padding(bottom = 18.dp),
                        )
                    }
                    NxPill("编辑", { setEditing(true) }, modifier = Modifier.padding(top = 18.dp), icon = Icons.Default.Edit)
                }
            }
        }
    }
}

@Composable
private fun FaceRow(
    entry: Entry,
    state: UiState,
    viewModel: AppViewModel,
    name: (Int) -> Unit,
) {
    if (entry.unknownFaces <= 0) return
    val matched = entry.people.map { it.faceIndex }.toSet()
    val total = matched.size + entry.unknownFaces
    val indices = (0 until total).filterNot(matched::contains)
    LazyRow(
        Modifier.fillMaxWidth().padding(bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        item { Text("这是谁？", color = NxColors.TextDim, fontSize = 12.sp) }
        items(indices) { index ->
            val ref = FaceRef(entry.id, index)
            val key = "${ref.entryId}:${ref.faceIndex}"
            LaunchedEffect(key) { viewModel.loadFaceThumb(ref) }
            Surface(
                onClick = { name(index) },
                modifier = Modifier
                    .size(46.dp)
                    .drawBehind {
                        drawCircle(
                            color = Color(0x73FFFFFF),
                            style = Stroke(
                                width = 1.5.dp.toPx(),
                                pathEffect = PathEffect.dashPathEffect(floatArrayOf(5.dp.toPx(), 4.dp.toPx())),
                            ),
                        )
                    },
                shape = CircleShape,
                color = NxColors.Control,
                border = BorderStroke(0.dp, Color.Transparent),
            ) {
                AsyncImage(state.faceThumbs[key], "未识别人脸", modifier = Modifier.fillMaxSize())
            }
        }
    }
}
