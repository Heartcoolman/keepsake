package com.nianxiang.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Merge
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.nianxiang.app.data.AuthUser
import com.nianxiang.app.data.FaceCluster
import com.nianxiang.app.data.FaceRef
import com.nianxiang.app.data.MemoryItem
import com.nianxiang.app.data.PersonDto
import com.nianxiang.app.data.SessionStore
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
internal fun OverlayFrame(
    title: String,
    dismiss: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val panelInteraction = remember { MutableInteractionSource() }
    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0xA008080C))
            .clickable(onClick = dismiss),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            modifier = modifier
                .fillMaxWidth(0.92f)
                .fillMaxHeight(0.9f)
                .statusBarsPadding()
                .navigationBarsPadding()
                .clickable(
                    interactionSource = panelInteraction,
                    indication = null,
                    onClick = {},
                ),
            color = NxColors.PanelSolid,
            shape = RoundedCornerShape(18.dp),
            border = BorderStroke(1.dp, NxColors.Line),
        ) {
            Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 14.dp)) {
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        title,
                        color = NxColors.Text,
                        fontFamily = NxSerif,
                        fontSize = 20.sp,
                        modifier = Modifier.weight(1f),
                    )
                    NxIconButton(Icons.Default.Close, "关闭", dismiss)
                }
                content()
            }
        }
    }
}

@Composable
fun PeopleOverlay(state: UiState, viewModel: AppViewModel, dismiss: () -> Unit) {
    var tab by rememberSaveable { mutableStateOf("people") }
    var creating by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<PersonDto?>(null) }
    var merging by remember { mutableStateOf<PersonDto?>(null) }
    var naming by remember { mutableStateOf<FaceCluster?>(null) }
    var deleting by remember { mutableStateOf<PersonDto?>(null) }
    LaunchedEffect(Unit) { viewModel.loadPeople() }

    OverlayFrame("✧ 念念认识的人", dismiss) {
        NxSegmentedControl(
            options = listOf("people" to "人物", "faces" to "未命名的脸 ${state.unassignedFaces.size}"),
            selected = tab,
            onSelected = { tab = it },
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
        Spacer(Modifier.height(12.dp))
        if (tab == "faces") {
            FaceClusterList(state, viewModel, Modifier.weight(1f)) { naming = it }
        } else {
            if (merging != null) {
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "选择要把 ${merging?.name} 并入的人物",
                        color = NxColors.TextDim,
                        fontSize = 12.sp,
                        modifier = Modifier.weight(1f),
                    )
                    NxPill("取消", { merging = null })
                }
            }
            if (state.people.isEmpty()) {
                EmptyFeature("还没有人物档案", Modifier.weight(1f))
            } else {
                LazyColumn(
                    Modifier.weight(1f),
                    contentPadding = PaddingValues(bottom = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(state.people, key = { it.id }) { person ->
                        PersonRow(
                            person = person,
                            state = state,
                            viewModel = viewModel,
                            mergeTarget = merging != null && merging?.id != person.id,
                            selectTarget = {
                                val source = merging
                                if (source != null && source.id != person.id) {
                                    viewModel.mergePerson(person.id, source.id)
                                    merging = null
                                }
                            },
                            edit = { editing = person },
                            merge = { merging = person },
                            delete = { deleting = person },
                        )
                    }
                }
            }
            NxPill("＋ 添加人物", { creating = true }, modifier = Modifier.align(Alignment.CenterHorizontally))
        }
    }

    if (creating) PersonDialog("添加人物", null, { creating = false }) { name, relation, isUser ->
        viewModel.createPerson(name, relation, isUser)
        creating = false
    }
    editing?.let { person ->
        PersonDialog("编辑人物", person, { editing = null }) { name, relation, isUser ->
            viewModel.updatePerson(person.id, name, relation, isUser)
            editing = null
        }
    }
    naming?.let { cluster ->
        FaceNamerDialog(
            title = "这些照片里是谁？",
            people = state.people,
            dismiss = { naming = null },
            chooseExisting = { person ->
                viewModel.assignFaces(person.id, cluster.faces, toast = "记住了，这是${person.name} ✦")
                naming = null
            },
            createNew = { name, relation ->
                viewModel.createPerson(
                    name = name,
                    relation = relation,
                    samples = cluster.faces.take(10),
                    toast = "记住了，这是$name ✦",
                )
                naming = null
            },
        )
    }
    deleting?.let { person ->
        ConfirmDialog(
            title = "删除 ${person.name}？",
            body = "人物档案会被删除，照片本身仍然保留。",
            confirm = "删除",
            dismiss = { deleting = null },
        ) {
            viewModel.deletePerson(person.id)
            deleting = null
        }
    }
}

@Composable
private fun PersonRow(
    person: PersonDto,
    state: UiState,
    viewModel: AppViewModel,
    mergeTarget: Boolean,
    selectTarget: () -> Unit,
    edit: () -> Unit,
    merge: () -> Unit,
    delete: () -> Unit,
) {
    val face = person.enrolledFrom.firstOrNull()
    val faceKey = face?.let { "${it.entryId}:${it.faceIndex}" }
    if (face != null) LaunchedEffect(faceKey) { viewModel.loadFaceThumb(face) }
    Row(
        Modifier
            .fillMaxWidth()
            .background(
                if (mergeTarget) Color(0x1FFFFFFF) else Color(0x0AFFFFFF),
                RoundedCornerShape(8.dp),
            )
            .clickable(enabled = mergeTarget, onClick = selectTarget)
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Surface(
            modifier = Modifier.size(42.dp),
            shape = CircleShape,
            color = if (person.isUser) NxColors.Gold.copy(alpha = 0.18f) else NxColors.ControlRaised,
            border = BorderStroke(1.dp, NxColors.Line),
        ) {
            if (faceKey != null && state.faceThumbs[faceKey] != null) {
                AsyncImage(
                    state.faceThumbs[faceKey],
                    person.name,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop,
                )
            } else {
                Box(contentAlignment = Alignment.Center) {
                    Text(person.name.take(1), color = NxColors.Text, fontFamily = NxSerif, fontSize = 17.sp)
                }
            }
        }
        Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(person.name, color = NxColors.Text, fontFamily = NxSerif, fontSize = 16.sp)
                if (person.isUser) {
                    Text(
                        "使用者",
                        color = NxColors.OnPaper,
                        fontSize = 9.sp,
                        modifier = Modifier.padding(start = 7.dp).background(NxColors.Paper, CircleShape)
                            .padding(horizontal = 7.dp, vertical = 2.dp),
                    )
                }
            }
            Text(
                person.relation.ifBlank { "未设置关系" },
                color = NxColors.TextFaint,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        if (!mergeTarget) {
            SmallAction(Icons.Default.Edit, "编辑", edit)
            if (!person.isUser) {
                SmallAction(Icons.Default.Merge, "并入其他人物", merge)
                SmallAction(Icons.Default.Delete, "删除", delete, NxColors.Error)
            }
        }
    }
}

@Composable
private fun FaceClusterList(
    state: UiState,
    viewModel: AppViewModel,
    modifier: Modifier,
    name: (FaceCluster) -> Unit,
) {
    if (state.unassignedFaces.isEmpty()) {
        EmptyFeature("照片里的脸都认全啦", modifier)
        return
    }
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(state.unassignedFaces) { cluster ->
            Row(
                Modifier.fillMaxWidth().background(Color(0x0AFFFFFF), RoundedCornerShape(8.dp)).padding(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    cluster.faces.take(4).forEach { ref ->
                        val key = "${ref.entryId}:${ref.faceIndex}"
                        LaunchedEffect(key) { viewModel.loadFaceThumb(ref) }
                        Surface(
                            modifier = Modifier.size(44.dp),
                            shape = CircleShape,
                            color = NxColors.Control,
                            border = BorderStroke(1.dp, NxColors.Line),
                        ) {
                            AsyncImage(
                                state.faceThumbs[key],
                                "未命名人脸",
                                modifier = Modifier.fillMaxSize(),
                                contentScale = ContentScale.Crop,
                            )
                        }
                    }
                    if (cluster.faces.size > 4) {
                        Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
                            Text("+${cluster.faces.size - 4}", color = NxColors.TextDim, fontSize = 11.sp)
                        }
                    }
                }
                NxPill("这是谁？", { name(cluster) })
            }
        }
    }
}

@Composable
fun ProfileOverlay(state: UiState, viewModel: AppViewModel, dismiss: () -> Unit) {
    var personality by remember { mutableStateOf<String?>(null) }
    var editingMemory by remember { mutableStateOf<Pair<String, String>?>(null) }
    var confirmDelete by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { viewModel.loadProfile() }

    OverlayFrame("✦ 念念眼中的你", dismiss) {
        val profile = state.profile
        if (profile == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("正在回想…", color = NxColors.TextFaint, fontFamily = NxSerif)
            }
        } else {
            LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 12.dp)) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("性格印象", color = NxColors.TextDim, fontSize = 12.sp)
                        if (profile.profile.mood.isNotBlank()) {
                            Text(
                                "最近 · ${profile.profile.mood}",
                                color = NxColors.TextDim,
                                fontSize = 10.sp,
                                modifier = Modifier.padding(start = 9.dp).background(NxColors.Control, CircleShape)
                                    .padding(horizontal = 8.dp, vertical = 3.dp),
                            )
                        }
                        Spacer(Modifier.weight(1f))
                        if (personality == null) SmallAction(Icons.Default.Edit, "编辑", onClick = {
                            personality = profile.profile.personality
                        })
                    }
                    if (personality != null) {
                        NxField(
                            personality.orEmpty(),
                            { personality = it },
                            "写下性格印象",
                            Modifier.fillMaxWidth().heightIn(min = 140.dp).padding(top = 10.dp),
                            singleLine = false,
                            maxLength = 500,
                        )
                        Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            NxPill("保存", {
                                viewModel.savePersonality(personality.orEmpty())
                                personality = null
                            })
                            NxPill("取消", { personality = null })
                        }
                    } else {
                        Text(
                            profile.profile.personality.ifBlank { "念念还在慢慢认识你，多聊几次，这里就会有你的样子。" },
                            color = NxColors.Text,
                            fontFamily = NxSerif,
                            fontSize = 14.sp,
                            lineHeight = 25.sp,
                            modifier = Modifier.padding(top = 10.dp, bottom = 24.dp),
                        )
                    }
                    Text("记得的点点滴滴(${profile.memories.size})", color = NxColors.TextDim, fontSize = 12.sp)
                    Spacer(Modifier.height(9.dp))
                }
                if (profile.memories.isEmpty()) {
                    item { Text("还没有记下什么，去和念念聊聊照片吧", color = NxColors.TextFaint, fontSize = 12.sp) }
                } else {
                    items(profile.memories.reversed(), key = { it.id }) { memory ->
                        MemoryRow(
                            memory = memory,
                            editing = editingMemory?.first == memory.id,
                            editText = editingMemory?.second.orEmpty(),
                            change = { editingMemory = memory.id to it },
                            startEdit = {
                                editingMemory = memory.id to memory.text
                                confirmDelete = null
                            },
                            cancelEdit = { editingMemory = null },
                            saveEdit = {
                                val text = editingMemory?.second.orEmpty().trim()
                                if (text.isNotEmpty()) viewModel.editMemory(memory.id, text)
                                editingMemory = null
                            },
                            deleteArmed = confirmDelete == memory.id,
                            delete = {
                                if (confirmDelete == memory.id) {
                                    viewModel.deleteMemory(memory.id)
                                    confirmDelete = null
                                } else confirmDelete = memory.id
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MemoryRow(
    memory: MemoryItem,
    editing: Boolean,
    editText: String,
    change: (String) -> Unit,
    startEdit: () -> Unit,
    cancelEdit: () -> Unit,
    saveEdit: () -> Unit,
    deleteArmed: Boolean,
    delete: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(bottom = 6.dp).background(Color(0x08FFFFFF), RoundedCornerShape(8.dp)).padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (editing) {
            NxField(editText, change, "记忆内容", Modifier.weight(1f), maxLength = 120)
            SmallAction(Icons.Default.Save, "保存", saveEdit)
            SmallAction(Icons.Default.Close, "取消", cancelEdit)
        } else {
            Text(
                categoryLabel(memory.category),
                color = NxColors.OnPaper,
                fontSize = 9.sp,
                modifier = Modifier.background(NxColors.Paper, CircleShape).padding(horizontal = 7.dp, vertical = 3.dp),
            )
            Text(memory.text, color = NxColors.Text, fontSize = 12.5.sp, modifier = Modifier.weight(1f).padding(horizontal = 8.dp))
            Text(formatDate(memory.createdAt), color = NxColors.TextFaint, fontSize = 9.sp)
            SmallAction(Icons.Default.Edit, "修改", startEdit)
            SmallAction(Icons.Default.Delete, "忘掉这条", delete, if (deleteArmed) NxColors.Error else NxColors.TextDim)
        }
    }
}

@Composable
fun ReviewOverlay(
    state: UiState,
    viewModel: AppViewModel,
    dismiss: () -> Unit,
) {
    val months = remember(state.entries) {
        state.entries.mapNotNull { it.yearMonth.takeIf(String::isNotBlank) }.distinct().sorted()
    }
    val fallbackMonth = remember { SimpleDateFormat("yyyy-MM", Locale.US).format(Date()) }
    val selected = state.selectedMonth.ifBlank { months.lastOrNull() ?: fallbackMonth }
    val index = months.indexOf(selected)
    val monthEntries = remember(state.entries, selected) { state.entries.filter { it.yearMonth == selected } }
    val report = state.monthlyStream.ifBlank { state.monthlyReview?.text.orEmpty() }
    val doneCount = monthEntries.count { it.status == "done" }
    // Single owner of the network load: re-runs only when `selected` changes, so each
    // month navigation fetches exactly once. Chevrons just move `selected` (setSelectedMonth).
    LaunchedEffect(selected) {
        if (state.monthlyReview?.yearMonth != selected) viewModel.loadMonthly(selected)
    }

    OverlayFrame("", dismiss) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            NxIconButton(
                Icons.Default.ChevronLeft,
                "上一个月",
                { viewModel.loadMonthly(months[index - 1]) },
                enabled = index > 0,
            )
            Text(
                selected.replace("-", "年") + "月",
                color = NxColors.Text,
                fontSize = 16.sp,
                modifier = Modifier.padding(horizontal = 18.dp),
            )
            NxIconButton(
                Icons.Default.ChevronRight,
                "下一个月",
                { viewModel.loadMonthly(months[index + 1]) },
                enabled = index >= 0 && index < months.lastIndex,
            )
        }
        Column(
            Modifier.fillMaxWidth().weight(1f).padding(top = 18.dp).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(NxColors.Line))
            Text("✦ 这个月的你", color = NxColors.TextDim, fontSize = 13.sp, modifier = Modifier.padding(top = 18.dp))
            when {
                report.isNotBlank() -> {
                    report.split(Regex("\\n+")).filter(String::isNotBlank).forEach { paragraph ->
                        Text(
                            paragraph,
                            color = NxColors.Text,
                            fontFamily = NxSerif,
                            fontSize = 15.sp,
                            lineHeight = 29.sp,
                            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                        )
                    }
                    if (!state.busy) {
                        Row(
                            Modifier.padding(top = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            val generatedAt = state.monthlyReview?.generatedAt ?: 0L
                            if (generatedAt > 0) {
                                Text(
                                    "凝聚于 ${formatChineseDate(generatedAt)}",
                                    color = NxColors.TextFaint,
                                    fontSize = 10.sp,
                                )
                            }
                            NxPill("↻ 重新凝聚", viewModel::generateMonthly, icon = Icons.Default.Refresh)
                        }
                    }
                }
                state.busy -> Text("思绪正在沉淀…", color = NxColors.TextFaint, fontSize = 12.sp, modifier = Modifier.padding(top = 16.dp))
                doneCount > 0 -> NxPill("✦ 凝聚这个月", viewModel::generateMonthly, modifier = Modifier.padding(top = 16.dp))
                else -> Text("这个月还没有写完的日记", color = NxColors.TextFaint, fontSize = 12.sp, modifier = Modifier.padding(top = 16.dp))
            }
        }
    }
}

@Composable
fun AccountOverlay(
    state: UiState,
    viewModel: AppViewModel,
    dismiss: () -> Unit,
    openProfile: () -> Unit,
    openConnection: () -> Unit,
) {
    // 密码不进 saved instance state：该 Bundle 会随进程回收明文落盘。
    var currentPassword by remember { mutableStateOf("") }
    var nextPassword by remember { mutableStateOf("") }
    var displayName by rememberSaveable { mutableStateOf("") }
    var username by rememberSaveable { mutableStateOf("") }
    var initialPassword by remember { mutableStateOf("") }
    var role by rememberSaveable { mutableStateOf("member") }
    var editing by remember { mutableStateOf<AuthUser?>(null) }
    LaunchedEffect(state.user?.role) { if (state.user?.role == "admin") viewModel.loadUsers() }

    OverlayFrame("✦ ${state.user?.displayName.orEmpty()}", dismiss) {
        Text(
            "@${state.user?.username.orEmpty()} · ${if (state.user?.role == "admin") "管理员" else "成员"}",
            color = NxColors.TextDim,
            fontSize = 12.sp,
            modifier = Modifier.align(Alignment.CenterHorizontally).padding(bottom = 6.dp),
        )
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 12.dp)) {
            item {
                NxPill("✦ 看看念念眼中的你", openProfile, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                SectionLabel("修改密码")
                NxField(currentPassword, { currentPassword = it }, "当前密码", Modifier.fillMaxWidth(), password = true, maxLength = 128)
                Spacer(Modifier.height(8.dp))
                NxField(nextPassword, { nextPassword = it }, "新密码（至少 8 位）", Modifier.fillMaxWidth(), password = true, maxLength = 128)
                NxPill(
                    "保存新密码",
                    {
                        viewModel.changePassword(currentPassword, nextPassword)
                        currentPassword = ""
                        nextPassword = ""
                    },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    enabled = currentPassword.isNotBlank() && nextPassword.length >= 8,
                )
                SectionLabel("连接")
                Row(
                    Modifier.fillMaxWidth().background(Color(0x08FFFFFF), RoundedCornerShape(8.dp)).padding(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("服务器地址", color = NxColors.TextDim, fontSize = 10.sp)
                        Text(state.baseUrl, color = NxColors.Text, fontSize = 12.sp, modifier = Modifier.padding(top = 3.dp))
                    }
                    NxPill("连接设置", openConnection)
                }
                if (state.user?.role == "admin") {
                    SectionLabel("家庭成员账号")
                }
            }
            if (state.user?.role == "admin") {
                items(state.adminUsers, key = { it.id }) { user ->
                    Row(
                        Modifier.fillMaxWidth().padding(bottom = 6.dp).background(Color(0x08FFFFFF), RoundedCornerShape(8.dp))
                            .clickable { editing = user }.padding(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(user.displayName, color = NxColors.Text, fontSize = 13.sp)
                            Text(
                                "@${user.username} · ${if (user.role == "admin") "管理员" else "成员"}${if (user.disabled) " · 已禁用" else ""}",
                                color = if (user.disabled) NxColors.Error else NxColors.TextFaint,
                                fontSize = 10.sp,
                            )
                        }
                        SmallAction(Icons.Default.Edit, "编辑", onClick = { editing = user })
                    }
                }
                item {
                    Column(Modifier.fillMaxWidth().padding(top = 5.dp)) {
                        NxField(displayName, { displayName = it }, "称呼", Modifier.fillMaxWidth(), maxLength = 20)
                        Spacer(Modifier.height(7.dp))
                        NxField(username, { username = it }, "用户名", Modifier.fillMaxWidth(), maxLength = 32)
                        Spacer(Modifier.height(7.dp))
                        NxField(initialPassword, { initialPassword = it }, "初始密码", Modifier.fillMaxWidth(), password = true, maxLength = 128)
                        Row(Modifier.padding(top = 7.dp), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                            NxPill("成员", { role = "member" }, selected = role == "member")
                            NxPill("管理员", { role = "admin" }, selected = role == "admin")
                        }
                        NxPill(
                            "创建账号",
                            {
                                viewModel.createUser(username.trim(), initialPassword, displayName.trim(), role)
                                displayName = ""
                                username = ""
                                initialPassword = ""
                                role = "member"
                            },
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                            enabled = displayName.isNotBlank() && username.isNotBlank() && initialPassword.length >= 8,
                            icon = Icons.Default.Add,
                        )
                    }
                }
            }
        }
        NxPill("退出登录", viewModel::logout, modifier = Modifier.fillMaxWidth())
    }

    editing?.let { user ->
        UserDialog(user, { editing = null }) { name, _, password, nextRole, disabled ->
            viewModel.updateUser(user.id, name, nextRole, disabled, password.ifBlank { null })
            editing = null
        }
    }
}

@Composable
fun ConnectionOverlay(state: UiState, viewModel: AppViewModel, dismiss: () -> Unit) {
    var url by rememberSaveable(state.baseUrl) { mutableStateOf(state.baseUrl) }
    OverlayFrame("连接设置", dismiss, Modifier.fillMaxHeight(0.52f)) {
        Text(
            "服务器地址",
            color = NxColors.TextDim,
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 8.dp, bottom = 8.dp),
        )
        NxField(url, { url = it }, SessionStore.DEFAULT_BASE_URL, Modifier.fillMaxWidth())
        Text(
            "模拟器通常使用 10.0.2.2，真机请填写同一网络中的服务器地址。",
            color = NxColors.TextFaint,
            fontSize = 11.sp,
            lineHeight = 17.sp,
            modifier = Modifier.padding(top = 10.dp),
        )
        state.error?.let { Text(it, color = NxColors.Error, fontSize = 11.sp, modifier = Modifier.padding(top = 8.dp)) }
        Spacer(Modifier.weight(1f))
        NxPrimaryButton(
            "保存并探测连接",
            {
                viewModel.setBaseUrl(url)
                dismiss()
            },
            enabled = url.startsWith("http://") || url.startsWith("https://"),
        )
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        color = NxColors.TextDim,
        fontSize = 11.sp,
        modifier = Modifier.padding(top = 18.dp, bottom = 8.dp),
    )
}

@Composable
private fun PersonDialog(
    title: String,
    person: PersonDto?,
    dismiss: () -> Unit,
    save: (String, String, Boolean) -> Unit,
) {
    var name by remember(person?.id) { mutableStateOf(person?.name.orEmpty()) }
    var relation by remember(person?.id) { mutableStateOf(person?.relation.orEmpty()) }
    var isUser by remember(person?.id) { mutableStateOf(person?.isUser ?: false) }
    AlertDialog(
        onDismissRequest = dismiss,
        containerColor = NxColors.PanelSolid,
        shape = RoundedCornerShape(14.dp),
        title = { Text(title, fontFamily = NxSerif) },
        text = {
            Column {
                NxField(name, { name = it }, "名字", Modifier.fillMaxWidth(), maxLength = 12)
                Spacer(Modifier.height(8.dp))
                NxField(relation, { relation = it }, "关系(可留空)", Modifier.fillMaxWidth(), maxLength = 12)
                Row(
                    Modifier.fillMaxWidth().padding(top = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("使用者", color = NxColors.TextDim, fontSize = 13.sp)
                        Text("会用这个应用的家人", color = NxColors.TextFaint, fontSize = 10.sp)
                    }
                    Switch(
                        checked = isUser,
                        onCheckedChange = { isUser = it },
                        colors = SwitchDefaults.colors(checkedThumbColor = NxColors.OnPaper, checkedTrackColor = NxColors.Paper),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { save(name.trim(), relation.trim(), isUser) }, enabled = name.isNotBlank()) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = dismiss) { Text("取消") } },
    )
}

/** 「这是谁？」：把人脸样本归给已有人物，或直接输入新名字建档（对齐 Web FaceNamer）。 */
@Composable
internal fun FaceNamerDialog(
    title: String,
    people: List<PersonDto>,
    dismiss: () -> Unit,
    chooseExisting: (PersonDto) -> Unit,
    createNew: (name: String, relation: String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var relation by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = dismiss,
        containerColor = NxColors.PanelSolid,
        shape = RoundedCornerShape(14.dp),
        title = { Text(title, fontFamily = NxSerif) },
        text = {
            Column {
                if (people.isEmpty()) {
                    Text("还没有人物档案，可以直接新建", color = NxColors.TextDim, fontSize = 12.sp)
                } else {
                    LazyColumn(Modifier.heightIn(max = 220.dp)) {
                        items(people, key = { it.id }) { person ->
                            TextButton(
                                onClick = { chooseExisting(person) },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text("${person.name}  ${person.relation}", color = NxColors.Text)
                            }
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                NxField(name, { name = it }, "新名字", Modifier.fillMaxWidth(), maxLength = 12)
                Spacer(Modifier.height(8.dp))
                NxField(relation, { relation = it }, "关系(可留空)", Modifier.fillMaxWidth(), maxLength = 12)
            }
        },
        confirmButton = {
            TextButton(
                onClick = { createNew(name.trim(), relation.trim()) },
                enabled = name.isNotBlank(),
            ) { Text("记住") }
        },
        dismissButton = { TextButton(onClick = dismiss) { Text("关闭") } },
    )
}

@Composable
private fun UserDialog(
    user: AuthUser?,
    dismiss: () -> Unit,
    save: (String, String, String, String, Boolean) -> Unit,
) {
    var name by remember(user?.id) { mutableStateOf(user?.displayName.orEmpty()) }
    var username by remember(user?.id) { mutableStateOf(user?.username.orEmpty()) }
    var password by remember(user?.id) { mutableStateOf("") }
    var role by remember(user?.id) { mutableStateOf(user?.role ?: "member") }
    var disabled by remember(user?.id) { mutableStateOf(user?.disabled ?: false) }
    AlertDialog(
        onDismissRequest = dismiss,
        containerColor = NxColors.PanelSolid,
        shape = RoundedCornerShape(14.dp),
        title = { Text(if (user == null) "创建成员" else "编辑账号", fontFamily = NxSerif) },
        text = {
            Column {
                NxField(name, { name = it }, "称呼", Modifier.fillMaxWidth(), maxLength = 20)
                Spacer(Modifier.height(8.dp))
                NxField(username, { username = it }, "用户名", Modifier.fillMaxWidth(), enabled = user == null, maxLength = 32)
                Spacer(Modifier.height(8.dp))
                NxField(
                    password,
                    { password = it },
                    if (user == null) "初始密码" else "重置密码（可留空）",
                    Modifier.fillMaxWidth(),
                    password = true,
                    maxLength = 128,
                )
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    NxPill("成员", { role = "member" }, selected = role == "member")
                    NxPill("管理员", { role = "admin" }, selected = role == "admin")
                }
                if (user != null) {
                    Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("禁用登录", color = NxColors.TextDim, modifier = Modifier.weight(1f))
                        Switch(
                            checked = disabled,
                            onCheckedChange = { disabled = it },
                            colors = SwitchDefaults.colors(checkedThumbColor = NxColors.OnPaper, checkedTrackColor = NxColors.Paper),
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { save(name.trim(), username.trim(), password, role, disabled) },
                enabled = name.isNotBlank() && username.isNotBlank() && (user != null || password.length >= 8) &&
                    (password.isBlank() || password.length >= 8),
            ) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = dismiss) { Text("取消") } },
    )
}

@Composable
private fun SmallAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    onClick: () -> Unit,
    tint: Color = NxColors.TextDim,
) {
    Surface(onClick = onClick, modifier = Modifier.size(34.dp), shape = CircleShape, color = Color.Transparent) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, description, tint = tint, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
private fun EmptyFeature(text: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("✦", color = NxColors.TextFaint, fontSize = 22.sp)
            Text(text, color = NxColors.TextDim, fontFamily = NxSerif, fontSize = 15.sp)
        }
    }
}

@Composable
private fun ConfirmDialog(
    title: String,
    body: String,
    confirm: String,
    dismiss: () -> Unit,
    action: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = dismiss,
        containerColor = NxColors.PanelSolid,
        shape = RoundedCornerShape(14.dp),
        title = { Text(title, fontFamily = NxSerif) },
        text = { Text(body, color = NxColors.TextDim) },
        confirmButton = { TextButton(onClick = action) { Text(confirm, color = NxColors.Error) } },
        dismissButton = { TextButton(onClick = dismiss) { Text("取消") } },
    )
}

private fun formatDate(timestamp: Long): String =
    SimpleDateFormat("yyyy.MM.dd", Locale.CHINA).format(Date(timestamp))

private fun formatChineseDate(timestamp: Long): String =
    SimpleDateFormat("yyyy年M月d日", Locale.CHINA).format(Date(timestamp))

private fun categoryLabel(category: String): String = when (category) {
    "preference" -> "喜好"
    "event" -> "经历"
    "person" -> "牵挂"
    else -> "点滴"
}

