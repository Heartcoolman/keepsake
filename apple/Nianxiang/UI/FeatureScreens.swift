import SwiftUI

/// Routes ShellState.overlay to the modal feature panels.
struct OverlayHost: View {
    @Environment(ShellState.self) private var shell

    var body: some View {
        switch shell.overlay {
        case .review:
            ReviewOverlay { shell.overlay = nil }
        case .people:
            PeopleOverlay { shell.overlay = nil }
        case .profile:
            ProfileOverlay { shell.overlay = nil }
        case .account:
            AccountOverlay(
                dismiss: { shell.overlay = nil },
                openProfile: { shell.overlay = .profile },
                openConnection: { shell.overlay = .connection }
            )
        case .connection:
            ConnectionOverlay { shell.overlay = .account }
        case .graph:
            GraphOverlay { shell.overlay = nil }
        case nil:
            EmptyView()
        }
    }
}

/// Fullscreen scrimmed panel, ported from Android OverlayFrame.
struct OverlayFrame<Content: View>: View {
    let title: String
    let dismiss: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        ZStack {
            Color(argb: 0xA008080C)
                .ignoresSafeArea()
                .onTapGesture(perform: dismiss)
            VStack(spacing: 0) {
                HStack {
                    Text(title)
                        .font(.nxSerif(20))
                        .foregroundStyle(NxColors.text)
                    Spacer()
                    NxIconButton(systemName: "xmark", label: "关闭", action: dismiss)
                }
                .padding(.bottom, 12)
                content
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: 560, maxHeight: 720)
            .background(NxColors.panelSolid, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(NxColors.line, lineWidth: 1))
            .padding(20)
            .onTapGesture {}
        }
    }
}

// MARK: - People

struct PeopleOverlay: View {
    let dismiss: () -> Void
    @Environment(AppViewModel.self) private var model
    @State private var tab = "people"
    @State private var creating = false
    @State private var editing: PersonDto?
    @State private var merging: PersonDto?
    @State private var naming: FaceCluster?
    @State private var deleting: PersonDto?

    var body: some View {
        OverlayFrame(title: "✧ 念念认识的人", dismiss: dismiss) {
            NxSegmentedControl(
                options: [("people", "人物"), ("faces", "未命名的脸 \(model.unassignedFaces.count)")],
                selected: tab
            ) { tab = $0 }
            Spacer().frame(height: 12)
            if tab == "faces" {
                FaceClusterList { naming = $0 }
            } else {
                peopleList
            }
        }
        .task { model.loadPeople() }
        .overlay { dialogs }
    }

    @ViewBuilder
    private var peopleList: some View {
        if let merging {
            HStack {
                Text("选择要把 \(merging.name) 并入的人物")
                    .font(.system(size: 12))
                    .foregroundStyle(NxColors.textDim)
                Spacer()
                NxPill(text: "取消", action: { self.merging = nil })
            }
            .padding(.bottom, 8)
        }
        if model.people.isEmpty {
            EmptyFeature(text: "还没有人物档案")
        } else {
            ScrollView {
                VStack(spacing: 6) {
                    ForEach(model.people) { person in
                        PersonRow(
                            person: person,
                            mergeTarget: merging != nil && merging?.id != person.id,
                            selectTarget: {
                                if let source = merging, source.id != person.id {
                                    model.mergePerson(targetId: person.id, fromId: source.id)
                                    merging = nil
                                }
                            },
                            edit: { editing = person },
                            merge: { merging = person },
                            delete: { deleting = person }
                        )
                    }
                }
                .padding(.bottom, 10)
            }
        }
        NxPill(text: "＋ 添加人物", action: { creating = true })
    }

    @ViewBuilder
    private var dialogs: some View {
        if creating {
            PersonDialog(title: "添加人物", person: nil, dismiss: { creating = false }) { name, relation, isUser in
                model.createPerson(name: name, relation: relation, isUser: isUser)
                creating = false
            }
        }
        if let person = editing {
            PersonDialog(title: "编辑人物", person: person, dismiss: { editing = nil }) { name, relation, isUser in
                model.updatePerson(id: person.id, name: name, relation: relation, isUser: isUser)
                editing = nil
            }
        }
        if let cluster = naming {
            FaceNamerDialog(
                title: "这些照片里是谁？",
                samples: Array(cluster.faces.prefix(10)),
                dismiss: { naming = nil }
            )
        }
        if let person = deleting {
            ConfirmDialog(
                title: "删除 \(person.name)？",
                body: "人物档案会被删除，照片本身仍然保留。",
                confirm: "删除",
                dismiss: { deleting = nil }
            ) {
                model.deletePerson(id: person.id)
                deleting = nil
            }
        }
    }
}

private struct PersonRow: View {
    let person: PersonDto
    let mergeTarget: Bool
    let selectTarget: () -> Void
    let edit: () -> Void
    let merge: () -> Void
    let delete: () -> Void
    @Environment(AppViewModel.self) private var model

    var body: some View {
        let face = person.enrolledFrom.first
        HStack(spacing: 0) {
            ZStack {
                Circle().fill(person.isUser ? NxColors.gold.opacity(0.18) : NxColors.controlRaised)
                if let face, let data = model.faceThumbs[face.cacheKey] {
                    BytesImage(data: data).clipShape(Circle())
                } else {
                    Text(String(person.name.prefix(1)))
                        .font(.nxSerif(17))
                        .foregroundStyle(NxColors.text)
                }
            }
            .frame(width: 42, height: 42)
            .overlay(Circle().stroke(NxColors.line, lineWidth: 1))
            .task { if let face { model.loadFaceThumb(face) } }

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 7) {
                    Text(person.name).font(.nxSerif(16)).foregroundStyle(NxColors.text)
                    if person.isUser {
                        Text("使用者")
                            .font(.system(size: 9))
                            .foregroundStyle(NxColors.onPaper)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(NxColors.paper, in: Capsule())
                    }
                }
                Text(person.relation.isEmpty ? "未设置关系" : person.relation)
                    .font(.system(size: 11))
                    .foregroundStyle(NxColors.textFaint)
            }
            .padding(.horizontal, 10)
            Spacer()
            if !mergeTarget {
                SmallAction(systemName: "pencil", label: "编辑", action: edit)
                if !person.isUser {
                    SmallAction(systemName: "arrow.triangle.merge", label: "并入其他人物", action: merge)
                    SmallAction(systemName: "trash", label: "删除", action: delete, tint: NxColors.errorColor)
                }
            }
        }
        .padding(10)
        .background(
            mergeTarget ? Color(argb: 0x1FFFFFFF) : Color(argb: 0x0AFFFFFF),
            in: RoundedRectangle(cornerRadius: 8)
        )
        .contentShape(RoundedRectangle(cornerRadius: 8))
        .onTapGesture { if mergeTarget { selectTarget() } }
    }
}

private struct FaceClusterList: View {
    let name: (FaceCluster) -> Void
    @Environment(AppViewModel.self) private var model

    var body: some View {
        if model.unassignedFaces.isEmpty {
            EmptyFeature(text: "照片里的脸都认全啦")
        } else {
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(Array(model.unassignedFaces.enumerated()), id: \.offset) { _, cluster in
                        HStack {
                            HStack(spacing: 5) {
                                ForEach(cluster.faces.prefix(4), id: \.self) { ref in
                                    BytesImage(data: model.faceThumbs[ref.cacheKey])
                                        .frame(width: 44, height: 44)
                                        .clipShape(Circle())
                                        .overlay(Circle().stroke(NxColors.line, lineWidth: 1))
                                        .task { model.loadFaceThumb(ref) }
                                }
                                if cluster.faces.count > 4 {
                                    Text("+\(cluster.faces.count - 4)")
                                        .font(.system(size: 11))
                                        .foregroundStyle(NxColors.textDim)
                                        .frame(width: 44, height: 44)
                                }
                            }
                            Spacer()
                            NxPill(text: "这是谁？", action: { name(cluster) })
                        }
                        .padding(10)
                        .background(Color(argb: 0x0AFFFFFF), in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
        }
    }
}

// MARK: - Profile

struct ProfileOverlay: View {
    let dismiss: () -> Void
    @Environment(AppViewModel.self) private var model
    @State private var personality: String?
    @State private var editingMemoryId: String?
    @State private var editingMemoryText = ""
    @State private var confirmDelete: String?

    var body: some View {
        OverlayFrame(title: "✦ 念念眼中的你", dismiss: dismiss) {
            if let profile = model.profile {
                profileBody(profile)
            } else {
                Text("正在回想…")
                    .font(.nxSerif(15))
                    .foregroundStyle(NxColors.textFaint)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { model.loadProfile() }
    }

    @ViewBuilder
    private func profileBody(_ profile: ProfileData) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("性格印象").font(.system(size: 12)).foregroundStyle(NxColors.textDim)
                    if !profile.profile.mood.isEmpty {
                        Text("最近 · \(profile.profile.mood)")
                            .font(.system(size: 10))
                            .foregroundStyle(NxColors.textDim)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(NxColors.control, in: Capsule())
                    }
                    Spacer()
                    if personality == nil {
                        SmallAction(systemName: "pencil", label: "编辑") {
                            personality = profile.profile.personality
                        }
                    }
                }
                if personality != nil {
                    NxField(
                        placeholder: "写下性格印象",
                        text: Binding(get: { personality ?? "" }, set: { personality = $0 }),
                        singleLine: false,
                        maxLength: 500
                    )
                    .frame(minHeight: 140, alignment: .top)
                    .padding(.top, 10)
                    HStack(spacing: 8) {
                        NxPill(text: "保存", action: {
                            model.savePersonality(personality ?? "")
                            personality = nil
                        })
                        NxPill(text: "取消", action: { personality = nil })
                    }
                    .padding(.top, 10)
                } else {
                    Text(profile.profile.personality.isEmpty
                        ? "念念还在慢慢认识你，多聊几次，这里就会有你的样子。"
                        : profile.profile.personality)
                        .font(.nxSerif(14))
                        .lineSpacing(8)
                        .foregroundStyle(NxColors.text)
                        .padding(.top, 10)
                        .padding(.bottom, 24)
                }
                Text("记得的点点滴滴(\(profile.memories.count))")
                    .font(.system(size: 12))
                    .foregroundStyle(NxColors.textDim)
                    .padding(.bottom, 9)
                if profile.memories.isEmpty {
                    Text("还没有记下什么，去和念念聊聊照片吧")
                        .font(.system(size: 12))
                        .foregroundStyle(NxColors.textFaint)
                } else {
                    ForEach(profile.memories.reversed()) { memory in
                        MemoryRow(
                            memory: memory,
                            editing: editingMemoryId == memory.id,
                            editText: $editingMemoryText,
                            startEdit: {
                                editingMemoryId = memory.id
                                editingMemoryText = memory.text
                                confirmDelete = nil
                            },
                            cancelEdit: { editingMemoryId = nil },
                            saveEdit: {
                                let text = editingMemoryText.trimmingCharacters(in: .whitespacesAndNewlines)
                                if !text.isEmpty { model.editMemory(id: memory.id, text: text) }
                                editingMemoryId = nil
                            },
                            deleteArmed: confirmDelete == memory.id,
                            delete: {
                                if confirmDelete == memory.id {
                                    model.deleteMemory(id: memory.id)
                                    confirmDelete = nil
                                } else {
                                    confirmDelete = memory.id
                                }
                            }
                        )
                    }
                }
            }
            .padding(.bottom, 12)
        }
    }
}

private struct MemoryRow: View {
    let memory: MemoryItem
    let editing: Bool
    @Binding var editText: String
    let startEdit: () -> Void
    let cancelEdit: () -> Void
    let saveEdit: () -> Void
    let deleteArmed: Bool
    let delete: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if editing {
                NxField(placeholder: "记忆内容", text: $editText, maxLength: 120)
                SmallAction(systemName: "square.and.arrow.down", label: "保存", action: saveEdit)
                SmallAction(systemName: "xmark", label: "取消", action: cancelEdit)
            } else {
                Text(categoryLabel(memory.category))
                    .font(.system(size: 9))
                    .foregroundStyle(NxColors.onPaper)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(NxColors.paper, in: Capsule())
                Text(memory.text)
                    .font(.system(size: 12.5))
                    .foregroundStyle(NxColors.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(Self.dateText(memory.createdAt))
                    .font(.system(size: 9))
                    .foregroundStyle(NxColors.textFaint)
                SmallAction(systemName: "pencil", label: "修改", action: startEdit)
                SmallAction(
                    systemName: "trash",
                    label: "忘掉这条",
                    action: delete,
                    tint: deleteArmed ? NxColors.errorColor : NxColors.textDim
                )
            }
        }
        .padding(8)
        .background(Color(argb: 0x08FFFFFF), in: RoundedRectangle(cornerRadius: 8))
        .padding(.bottom, 6)
    }

    static func dateText(_ millis: Int64) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy.MM.dd"
        return formatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }
}

// MARK: - Review (monthly report)

struct ReviewOverlay: View {
    let dismiss: () -> Void
    @Environment(AppViewModel.self) private var model

    var body: some View {
        let months = Array(Set(model.entries.map(\.yearMonth).filter { !$0.isEmpty })).sorted()
        let fallback = AppViewModel.yearMonth(from: Int64(Date().timeIntervalSince1970 * 1000))
        let selected = model.selectedMonth.isEmpty ? (months.last ?? fallback) : model.selectedMonth
        let index = months.firstIndex(of: selected) ?? -1
        let monthEntries = model.entries.filter { $0.yearMonth == selected }
        let report = model.monthlyStream.isEmpty ? (model.monthlyReview?.text ?? "") : model.monthlyStream
        let doneCount = monthEntries.filter { $0.status == "done" }.count

        OverlayFrame(title: "", dismiss: dismiss) {
            VStack(spacing: 0) {
                HStack {
                    NxIconButton(systemName: "chevron.left", label: "上一个月", action: {
                        if index > 0 { model.loadMonthly(months[index - 1]) }
                    }, enabled: index > 0)
                    Text(selected.replacingOccurrences(of: "-", with: "年") + "月")
                        .font(.system(size: 16))
                        .foregroundStyle(NxColors.text)
                        .padding(.horizontal, 18)
                    NxIconButton(systemName: "chevron.right", label: "下一个月", action: {
                        if index >= 0 && index < months.count - 1 { model.loadMonthly(months[index + 1]) }
                    }, enabled: index >= 0 && index < months.count - 1)
                }
                ScrollView {
                    VStack(spacing: 0) {
                        Rectangle().fill(NxColors.line).frame(height: 1)
                        Text("✦ 这个月的你")
                            .font(.system(size: 13))
                            .foregroundStyle(NxColors.textDim)
                            .padding(.top, 18)
                        if !report.isEmpty {
                            let paragraphs = report
                                .components(separatedBy: CharacterSet.newlines)
                                .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                            ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                                Text(paragraph)
                                    .font(.nxSerif(15))
                                    .lineSpacing(11)
                                    .foregroundStyle(NxColors.text)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.top, 12)
                            }
                            if !model.busy {
                                HStack(spacing: 12) {
                                    if let generatedAt = model.monthlyReview?.generatedAt, generatedAt > 0 {
                                        Text("凝聚于 \(AppViewModel.formatDate(generatedAt))")
                                            .font(.system(size: 10))
                                            .foregroundStyle(NxColors.textFaint)
                                    }
                                    NxPill(text: "↻ 重新凝聚", action: model.generateMonthly)
                                }
                                .padding(.top, 12)
                            }
                        } else if model.busy {
                            Text("思绪正在沉淀…")
                                .font(.system(size: 12))
                                .foregroundStyle(NxColors.textFaint)
                                .padding(.top, 16)
                        } else if doneCount > 0 {
                            NxPill(text: "✦ 凝聚这个月", action: model.generateMonthly)
                                .padding(.top, 16)
                        } else {
                            Text("这个月还没有写完的日记")
                                .font(.system(size: 12))
                                .foregroundStyle(NxColors.textFaint)
                                .padding(.top, 16)
                        }
                    }
                }
                .padding(.top, 18)
            }
        }
        .task(id: selected) {
            if model.selectedMonth != selected || model.monthlyReview?.yearMonth != selected {
                model.loadMonthly(selected)
            }
        }
    }
}

// MARK: - Account

struct AccountOverlay: View {
    let dismiss: () -> Void
    let openProfile: () -> Void
    let openConnection: () -> Void
    @Environment(AppViewModel.self) private var model

    @State private var currentPassword = ""
    @State private var nextPassword = ""

    var body: some View {
        OverlayFrame(title: "✦ \(model.user?.displayName ?? "")", dismiss: dismiss) {
            Text("@\(model.user?.username ?? "") · \(model.user?.accountType == "family" ? "家庭账户" : "个人账户")")
                .font(.system(size: 12))
                .foregroundStyle(NxColors.textDim)
                .padding(.bottom, 6)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    NxPill(text: "✦ 看看念念眼中的你", action: openProfile)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                    SectionLabel(text: "修改密码")
                    NxField(placeholder: "当前密码", text: $currentPassword, password: true, maxLength: 128)
                        .padding(.bottom, 8)
                    NxField(placeholder: "新密码（至少 8 位）", text: $nextPassword, password: true, maxLength: 128)
                    NxPill(text: "保存新密码", action: {
                        model.changePassword(current: currentPassword, next: nextPassword)
                        currentPassword = ""
                        nextPassword = ""
                    }, enabled: !currentPassword.isEmpty && nextPassword.count >= 8)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
                    FamilyPanel()
                    RecoveryCodeViewer()
                    SectionLabel(text: "连接")
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("服务器地址").font(.system(size: 10)).foregroundStyle(NxColors.textDim)
                            Text(model.baseUrl).font(.system(size: 12)).foregroundStyle(NxColors.text)
                        }
                        Spacer()
                        NxPill(text: "连接设置", action: openConnection)
                    }
                    .padding(10)
                    .background(Color(argb: 0x08FFFFFF), in: RoundedRectangle(cornerRadius: 8))
                }
                .padding(.bottom, 12)
            }
            NxPill(text: "退出登录", action: model.logout)
                .frame(maxWidth: .infinity)
        }
    }
}

/// Family membership panel, mirrors Web AccountManager.tsx's FamilyPanel: owner
/// invites/removes; personal accounts see pending invites and can leave.
struct FamilyPanel: View {
    @Environment(AppViewModel.self) private var model
    @State private var inviteName = ""
    @State private var newFamilyName = ""
    @State private var confirmRemove: AuthUser?
    @State private var confirmLeave = false

    private var isOwner: Bool { model.user?.accountType == "family" && model.user?.familyId != nil }
    private var inFamily: Bool { model.user?.familyId != nil }

    var body: some View {
        SectionLabel(text: inFamily ? "家庭 · \(model.familyInfo?.family?.name ?? "")" : "家庭")
        VStack(alignment: .leading, spacing: 8) {
            if inFamily { membersList }
            if isOwner {
                ownerInvites
                inviteForm
            }
            if model.user?.accountType == "family" && !inFamily {
                createFamilyForm
            }
            if model.user?.accountType == "personal" && !inFamily {
                personalInvites
            }
            if model.user?.accountType == "personal" && inFamily {
                NxPill(
                    text: model.familyBusyKey == "leave" ? "退出家庭…" : "退出家庭",
                    action: { confirmLeave = true },
                    enabled: model.familyBusyKey == nil
                )
            }
        }
        .task(id: model.user?.familyId) { model.loadFamily() }
        .overlay {
            if let member = confirmRemove {
                ConfirmDialog(
                    title: "把 \(member.displayName) 移出家庭？",
                    body: "其个人数据保留，共享密钥将轮换。",
                    confirm: "移出",
                    dismiss: { confirmRemove = nil }
                ) {
                    model.removeFamilyMember(id: member.id)
                    confirmRemove = nil
                }
            }
            if confirmLeave {
                ConfirmDialog(
                    title: "退出家庭？",
                    body: "你的照片与日记保留为个人数据，家庭共享的人物库将不再可见。",
                    confirm: "退出",
                    dismiss: { confirmLeave = false }
                ) {
                    model.leaveFamily()
                    confirmLeave = false
                }
            }
        }
    }

    @ViewBuilder
    private var membersList: some View {
        if let info = model.familyInfo {
            ForEach(info.members) { member in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(member.displayName).font(.system(size: 13)).foregroundStyle(NxColors.text)
                        Text("@\(member.username)\(member.id == info.family?.ownerId ? " · 家庭账户" : "")")
                            .font(.system(size: 10))
                            .foregroundStyle(NxColors.textFaint)
                    }
                    Spacer()
                    if isOwner && member.id != model.user?.id {
                        NxPill(
                            text: model.familyBusyKey == "remove:\(member.id)" ? "移出…" : "移出",
                            action: { confirmRemove = member },
                            enabled: model.familyBusyKey == nil
                        )
                    }
                }
                .padding(10)
                .background(Color(argb: 0x08FFFFFF), in: RoundedRectangle(cornerRadius: 8))
            }
        } else {
            Text("加载中…").font(.system(size: 12)).foregroundStyle(NxColors.textFaint)
        }
    }

    @ViewBuilder
    private var ownerInvites: some View {
        if let info = model.familyInfo, !info.invites.isEmpty {
            ForEach(info.invites) { invite in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(invite.inviteeName).font(.system(size: 13)).foregroundStyle(NxColors.text)
                        Text("邀请待接受").font(.system(size: 10)).foregroundStyle(NxColors.textFaint)
                    }
                    Spacer()
                    NxPill(
                        text: model.familyBusyKey == "revoke:\(invite.id)" ? "撤回…" : "撤回",
                        action: { model.revokeFamilyInvite(id: invite.id) },
                        enabled: model.familyBusyKey == nil
                    )
                }
                .padding(10)
                .background(Color(argb: 0x08FFFFFF), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private var inviteForm: some View {
        VStack(alignment: .leading, spacing: 7) {
            NxField(placeholder: "邀请个人账户 (用户名)", text: $inviteName)
            NxPill(
                text: model.familyBusyKey == "invite" ? "发出邀请…" : "发出邀请",
                action: {
                    model.sendFamilyInvite(username: inviteName.trimmingCharacters(in: .whitespaces))
                    inviteName = ""
                },
                enabled: !inviteName.trimmingCharacters(in: .whitespaces).isEmpty && model.familyBusyKey == nil
            )
            .frame(maxWidth: .infinity)
            Text("对方需先注册个人账户并登录过一次,接受邀请后即可共享人物库。")
                .font(.system(size: 11))
                .foregroundStyle(NxColors.textFaint)
        }
        .padding(.top, 4)
    }

    private var createFamilyForm: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("你的家庭已解散。可以创建一个新家庭,重新邀请成员。")
                .font(.system(size: 11))
                .foregroundStyle(NxColors.textFaint)
            NxField(placeholder: "家庭名称 (可选)", text: $newFamilyName, maxLength: 20)
            NxPill(
                text: model.familyBusyKey == "create" ? "创建家庭 ✦…" : "创建家庭 ✦",
                action: {
                    model.createFamily(name: newFamilyName.trimmingCharacters(in: .whitespaces))
                    newFamilyName = ""
                },
                selected: true, enabled: model.familyBusyKey == nil
            )
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private var personalInvites: some View {
        if model.myInvites.isEmpty {
            Text("独立使用中。收到家庭邀请会显示在这里。")
                .font(.system(size: 12))
                .foregroundStyle(NxColors.textFaint)
        } else {
            ForEach(model.myInvites) { invite in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(invite.familyName).font(.system(size: 13)).foregroundStyle(NxColors.text)
                        Text("\(invite.inviterName) 邀请你加入").font(.system(size: 10)).foregroundStyle(NxColors.textFaint)
                    }
                    Spacer()
                    NxPill(
                        text: model.familyBusyKey == "accept:\(invite.id)" ? "接受…" : "接受",
                        action: { model.acceptInvite(id: invite.id) },
                        enabled: model.familyBusyKey == nil
                    )
                    NxPill(
                        text: model.familyBusyKey == "decline:\(invite.id)" ? "拒绝…" : "拒绝",
                        action: { model.declineInvite(id: invite.id) },
                        enabled: model.familyBusyKey == nil
                    )
                }
                .padding(10)
                .background(Color(argb: 0x08FFFFFF), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

/// Rotate + reveal a fresh recovery code (needs the password; the old code dies).
struct RecoveryCodeViewer: View {
    @Environment(AppViewModel.self) private var model
    @State private var currentPassword = ""

    var body: some View {
        SectionLabel(text: "恢复码")
        VStack(alignment: .leading, spacing: 7) {
            Text("生成新的恢复码并展示一次(旧码同时失效)。丢了密码和恢复码,数据无人能解。")
                .font(.system(size: 11))
                .foregroundStyle(NxColors.textFaint)
            NxField(placeholder: "当前密码", text: $currentPassword, password: true, maxLength: 128)
            NxPill(
                text: "生成并查看恢复码",
                action: {
                    model.regenerateRecoveryCode(currentPassword: currentPassword)
                    currentPassword = ""
                },
                enabled: !currentPassword.isEmpty
            )
            .frame(maxWidth: .infinity)
        }
    }
}

private struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(NxColors.textDim)
            .padding(.top, 18)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Connection

struct ConnectionOverlay: View {
    let dismiss: () -> Void
    @Environment(AppViewModel.self) private var model
    @State private var url = ""

    var body: some View {
        OverlayFrame(title: "连接设置", dismiss: dismiss) {
            VStack(alignment: .leading, spacing: 0) {
                Text("服务器地址")
                    .font(.system(size: 12))
                    .foregroundStyle(NxColors.textDim)
                    .padding(.top, 8)
                    .padding(.bottom, 8)
                NxField(placeholder: SessionStore.defaultBaseURL, text: $url)
                Text("填写局域网服务器地址（如 http://192.168.x.x:8787），或 HTTPS 域名。")
                    .font(.system(size: 11))
                    .lineSpacing(5)
                    .foregroundStyle(NxColors.textFaint)
                    .padding(.top, 10)
                if let error = model.error {
                    Text(error)
                        .font(.system(size: 11))
                        .foregroundStyle(NxColors.errorColor)
                        .padding(.top, 8)
                }
                Spacer()
                NxPrimaryButton(text: "保存并探测连接", action: {
                    model.setBaseUrl(url)
                    dismiss()
                }, enabled: url.hasPrefix("http://") || url.hasPrefix("https://"))
            }
            .frame(maxHeight: 320)
        }
        .onAppear { url = model.baseUrl }
    }
}

// MARK: - Shared dialogs

/// 「这是谁？」：把人脸样本归给已有人物，或直接输入新名字建档（对齐 Web FaceNamer）。
struct FaceNamerDialog: View {
    let title: String
    let samples: [FaceRef]
    let dismiss: () -> Void
    @Environment(AppViewModel.self) private var model
    @State private var name = ""
    @State private var relation = ""

    var body: some View {
        DialogScrim(dismiss: dismiss) {
            VStack(alignment: .leading, spacing: 10) {
                Text(title).font(.nxSerif(18)).foregroundStyle(NxColors.text)
                if !model.people.isEmpty {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(model.people) { person in
                                Button {
                                    model.assignFaces(id: person.id, samples: samples, toast: "记住了，这是\(person.name) ✦")
                                    dismiss()
                                } label: {
                                    Text("\(person.name)  \(person.relation)")
                                        .foregroundStyle(NxColors.text)
                                        .padding(.vertical, 8)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .frame(maxHeight: 200)
                    Rectangle().fill(NxColors.line).frame(height: 1)
                }
                NxField(placeholder: "新名字", text: $name, maxLength: 12)
                NxField(placeholder: "关系(可留空)", text: $relation, maxLength: 12)
                HStack(spacing: 10) {
                    NxPill(text: "关闭", action: dismiss)
                    NxPill(text: "记住", action: {
                        let trimmed = name.trimmingCharacters(in: .whitespaces)
                        model.createPerson(
                            name: trimmed,
                            relation: relation.trimmingCharacters(in: .whitespaces),
                            samples: samples,
                            toast: "记住了，这是\(trimmed) ✦"
                        )
                        dismiss()
                    }, selected: true, enabled: !name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(.top, 4)
            }
            .padding(18)
        }
    }
}

private struct PersonDialog: View {
    let title: String
    let person: PersonDto?
    let dismiss: () -> Void
    let save: (String, String, Bool) -> Void
    @State private var name = ""
    @State private var relation = ""
    @State private var isUser = false

    var body: some View {
        DialogScrim(dismiss: dismiss) {
            VStack(spacing: 8) {
                Text(title).font(.nxSerif(18)).foregroundStyle(NxColors.text)
                NxField(placeholder: "名字", text: $name, maxLength: 12)
                NxField(placeholder: "关系(可留空)", text: $relation, maxLength: 12)
                Toggle(isOn: $isUser) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("使用者").font(.system(size: 13)).foregroundStyle(NxColors.textDim)
                        Text("会用这个应用的家人").font(.system(size: 10)).foregroundStyle(NxColors.textFaint)
                    }
                }
                .tint(NxColors.paper)
                HStack(spacing: 10) {
                    NxPill(text: "取消", action: dismiss)
                    NxPill(text: "保存", action: {
                        save(name.trimmingCharacters(in: .whitespaces), relation.trimmingCharacters(in: .whitespaces), isUser)
                    }, selected: true, enabled: !name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(.top, 6)
            }
            .padding(18)
        }
        .onAppear {
            name = person?.name ?? ""
            relation = person?.relation ?? ""
            isUser = person?.isUser ?? false
        }
    }
}

struct ConfirmDialog: View {
    let title: String
    let body_: String
    let confirm: String
    let dismissLabel: String
    let dismiss: () -> Void
    let action: () -> Void

    init(
        title: String, body: String, confirm: String, dismissLabel: String = "取消",
        dismiss: @escaping () -> Void, action: @escaping () -> Void
    ) {
        self.title = title
        self.body_ = body
        self.confirm = confirm
        self.dismissLabel = dismissLabel
        self.dismiss = dismiss
        self.action = action
    }

    var body: some View {
        DialogScrim(dismiss: dismiss) {
            VStack(spacing: 12) {
                Text(title).font(.nxSerif(18)).foregroundStyle(NxColors.text)
                Text(body_).font(.system(size: 13)).foregroundStyle(NxColors.textDim)
                HStack(spacing: 10) {
                    NxPill(text: dismissLabel, action: dismiss)
                    NxPill(text: confirm, action: action)
                }
            }
            .padding(18)
        }
    }
}
