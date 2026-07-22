import SwiftUI
#if os(iOS)
import PhotosUI
#endif

struct AppRoot: View {
    let engine: ParticleEngine
    @Environment(AppViewModel.self) private var model
    @Environment(ShellState.self) private var shell
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif

    @State private var sessionOpen = false
    @State private var entrancePhotoId: String?
    @State private var listenerBox = ParticleListenerBox()

    private var isRegular: Bool {
        #if os(macOS)
        return true
        #else
        return horizontalSizeClass == .regular
        #endif
    }

    var body: some View {
        Group {
            if model.user == nil {
                ZStack {
                    ParticleCanvas(engine: engine).ignoresSafeArea()
                    AuthScreen()
                }
            } else if isRegular {
                SplitShell(engine: engine, sessionOpen: $sessionOpen, entrancePhotoId: $entrancePhotoId)
            } else {
                CompactShell(engine: engine, sessionOpen: $sessionOpen, entrancePhotoId: $entrancePhotoId)
            }
        }
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                ToastView(message: toast)
                    .task(id: toast) {
                        // 与 Web Toast 时长一致（3.2s）。
                        try? await Task.sleep(nanoseconds: 3_200_000_000)
                        model.clearToast()
                    }
            }
        }
        .overlay { OverlayHost() }
        .onChange(of: model.navigateToSession) { _, navigate in
            if navigate {
                shell.overlay = nil
                sessionOpen = true
                model.consumeSessionNavigation()
            }
        }
        .onChange(of: shell.closeSessionRequest) {
            if sessionOpen {
                model.closeSession()
                sessionOpen = false
            }
        }
        .onChange(of: sessionOpen) { _, open in
            // 进程重建后 sessionEntry 已丢失时不能停在会话页加载态。
            if open && model.sessionEntry == nil { sessionOpen = false }
        }
        .onAppear {
            listenerBox.onEntranceStarted = { entrancePhotoId = $0 }
            engine.listener = listenerBox
        }
        .task(id: sceneKey) { submitScene() }
        .background(Color.black.ignoresSafeArea())
    }

    private var sceneKey: String {
        [
            model.sessionEntry?.id ?? "",
            String(sessionOpen),
            String(model.user != nil),
            String(model.photoBytes != nil),
            model.phase,
            model.sessionTab,
            model.sessionEntry?.mood ?? "",
            String(model.sessionMessages.count),
            String(model.depthJson?.count ?? 0),
        ].joined(separator: "|")
    }

    private func submitScene() {
        let mode = particleModeFor(
            sessionOpen: sessionOpen,
            userPresent: model.user != nil,
            hasPhoto: model.photoBytes != nil,
            phase: model.phase,
            sessionTab: model.sessionTab,
            mood: model.sessionEntry?.mood ?? "",
            lines: model.sessionMessages.map(\.content)
        )
        let photoId = sessionOpen ? model.sessionEntry?.id : nil
        engine.submit(ParticleSceneState(
            photoId: photoId,
            jpeg: sessionOpen ? model.photoBytes : nil,
            depthJson: sessionOpen ? model.depthJson : nil,
            mode: mode
        ))
        if entrancePhotoId != photoId && photoId == nil { entrancePhotoId = nil }
    }
}

/// Class-boxed listener so the engine's weak reference survives SwiftUI value semantics.
@MainActor
final class ParticleListenerBox: ParticleEngineListener {
    var onEntranceStarted: (String) -> Void = { _ in }

    func onEntranceStarted(photoId: String) { onEntranceStarted(photoId) }
}

// MARK: - Compact (iPhone) layout

private struct CompactShell: View {
    let engine: ParticleEngine
    @Binding var sessionOpen: Bool
    @Binding var entrancePhotoId: String?
    @Environment(AppViewModel.self) private var model
    @Environment(ShellState.self) private var shell

    var body: some View {
        ZStack {
            ParticleCanvas(engine: engine).ignoresSafeArea()
            if sessionOpen {
                SessionScreen(
                    engine: engine,
                    particleEntranceStarted: entrancePhotoId == model.sessionEntry?.id
                ) {
                    model.closeSession()
                    sessionOpen = false
                }
                // Rebuild on entry switch so composer draft / open sheets don't leak across entries.
                .id(model.sessionEntry?.id)
            } else {
                NxBackdrop {
                    TimelineScreen { entry in
                        shell.overlay = nil
                        sessionOpen = true
                        model.openEntry(entry)
                    }
                }
            }
        }
    }
}

// MARK: - Regular (iPad / Mac) split layout

private struct SplitShell: View {
    let engine: ParticleEngine
    @Binding var sessionOpen: Bool
    @Binding var entrancePhotoId: String?
    @Environment(AppViewModel.self) private var model
    @Environment(ShellState.self) private var shell

    var body: some View {
        NavigationSplitView {
            TimelineSidebar { entry in
                shell.overlay = nil
                sessionOpen = true
                model.openEntry(entry)
            }
            .navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 460)
        } detail: {
            ZStack {
                ParticleCanvas(engine: engine).ignoresSafeArea()
                if sessionOpen, model.sessionEntry != nil {
                    SessionScreen(
                        engine: engine,
                        particleEntranceStarted: entrancePhotoId == model.sessionEntry?.id
                    ) {
                        model.closeSession()
                        sessionOpen = false
                    }
                    // Rebuild on entry switch so composer draft / open sheets don't leak across entries.
                    .id(model.sessionEntry?.id)
                } else {
                    EmptyFeature(text: "从左侧挑一张照片，翻开这一天")
                        .background(Color.black.opacity(0.25))
                }
            }
            #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
            #endif
        }
        .navigationSplitViewStyle(.balanced)
    }
}

// MARK: - Timeline sidebar (regular)

private struct TimelineSidebar: View {
    let openEntry: (Entry) -> Void
    @Environment(AppViewModel.self) private var model
    @Environment(ShellState.self) private var shell
    @State private var confirmDelete: String?

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 8) {
            TimelineToolbar()
            if let error = model.error {
                TimelineErrorRow(error: error)
            }
            if model.loading && model.entries.isEmpty {
                LoadingMemories(progress: model.uploadProgress)
            } else if model.entries.isEmpty {
                EmptyTimeline()
            } else if model.filteredEntries.isEmpty {
                EmptyFeature(text: "没有符合条件的记忆")
            } else {
                List(model.filteredEntries) { entry in
                    SidebarRow(
                        entry: entry,
                        thumb: model.thumbnails[entry.id],
                        deleteArmed: confirmDelete == entry.id
                    ) {
                        openEntry(entry)
                    } delete: {
                        if confirmDelete == entry.id {
                            confirmDelete = nil
                            model.deleteEntry(id: entry.id)
                        } else {
                            confirmDelete = entry.id
                        }
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .padding(.top, 8)
        .background(NxColors.ink)
        .photoPicking()
        .dropToUpload()
    }
}

private struct SidebarRow: View {
    let entry: Entry
    let thumb: Data?
    let deleteArmed: Bool
    let open: () -> Void
    let delete: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                BytesImage(data: thumb)
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.title.isEmpty ? "未命名记忆" : entry.title)
                        .font(.system(size: 14))
                        .foregroundStyle(NxColors.text)
                        .lineLimit(1)
                    Text(Self.dateText(entry.takenAt))
                        .font(.system(size: 11))
                        .foregroundStyle(NxColors.textFaint)
                    Text(statusLabel)
                        .font(.system(size: 10))
                        .foregroundStyle(NxColors.textDim)
                }
                Spacer()
                SmallAction(
                    systemName: "xmark",
                    label: deleteArmed ? "确认丢弃" : "丢弃",
                    action: delete,
                    tint: deleteArmed ? NxColors.errorColor : NxColors.textFaint
                )
            }
            .padding(8)
            .background(Color(argb: 0x0AFFFFFF), in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    private var statusLabel: String {
        switch entry.status {
        case "done": return "已成念 · \(entry.mood)"
        case "chatting": return "对话中"
        default: return "未开始"
        }
    }

    static func dateText(_ millis: Int64) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy年M月d日"
        formatter.locale = Locale(identifier: "zh_CN")
        return formatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }
}

// MARK: - Timeline (compact carousel)

struct TimelineScreen: View {
    let openEntry: (Entry) -> Void
    @Environment(AppViewModel.self) private var model
    @State private var confirmDelete: String?
    @State private var focusedId: String?

    var body: some View {
        VStack(spacing: 0) {
            TimelineToolbar()
            if let error = model.error {
                TimelineErrorRow(error: error)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 4)
            }
            if model.loading && model.entries.isEmpty {
                LoadingMemories(progress: model.uploadProgress)
            } else if model.entries.isEmpty {
                EmptyTimeline()
            } else if model.filteredEntries.isEmpty {
                EmptyFeature(text: "没有符合条件的记忆")
            } else {
                carousel
            }
        }
        .photoPicking()
        .dropToUpload()
    }

    private var carousel: some View {
        GeometryReader { proxy in
            let cardHeight = proxy.size.height * 0.52
            let cardMaxWidth = proxy.size.width * 0.72
            let filtered = model.filteredEntries
            let focused = filtered.first { $0.id == focusedId } ?? filtered.first

            VStack(spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 18) {
                        AddMemoryCard(cardHeight: cardHeight)
                            .id("__add__")
                        ForEach(filtered) { entry in
                            TimelineCard(
                                entry: entry,
                                thumb: model.thumbnails[entry.id],
                                cardHeight: cardHeight,
                                maxWidth: cardMaxWidth
                            ) { openEntry(entry) }
                            .id(entry.id)
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 52)
                }
                .scrollPosition(id: $focusedId)
                .scrollTargetBehavior(.viewAligned)
                .frame(maxHeight: .infinity)
                .onAppear { if focusedId == nil { focusedId = filtered.first?.id } }

                if let entry = focused {
                    TimelineFooter(
                        entry: entry,
                        index: (filtered.firstIndex { $0.id == entry.id } ?? 0) + 1,
                        count: filtered.count,
                        deleteArmed: confirmDelete == entry.id
                    ) {
                        openEntry(entry)
                    } delete: {
                        if confirmDelete == entry.id {
                            confirmDelete = nil
                            model.deleteEntry(id: entry.id)
                        } else {
                            confirmDelete = entry.id
                        }
                    }
                }
            }
        }
    }
}

struct TimelineToolbar: View {
    @Environment(AppViewModel.self) private var model
    @Environment(ShellState.self) private var shell
    @FocusState private var searchFocused: Bool

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach([("all", "全部"), ("new", "未开始"), ("chatting", "对话中"), ("done", "已成念")], id: \.0) { key, label in
                        NxPill(text: label, action: { model.filter = key }, selected: model.filter == key)
                    }
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    NxPill(text: model.sortAscending ? "⇅ 最早" : "⇅ 最近", action: model.toggleSort)
                    NxPill(text: "✦ 回顾", action: { shell.overlay = .review })
                    NxPill(text: "✧ 人物", action: { shell.overlay = .people })
                    NxPill(text: "◐ \(model.user?.displayName ?? "选择使用者")", action: { shell.overlay = .account })
                }
            }
            NxField(placeholder: "搜索记忆 · 对话 · 日记", text: $model.query, leadingIcon: "magnifyingglass")
                .focused($searchFocused)
                .onChange(of: shell.focusSearch) { searchFocused = true }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

private struct TimelineCard: View {
    let entry: Entry
    let thumb: Data?
    let cardHeight: CGFloat
    let maxWidth: CGFloat
    let open: () -> Void

    var body: some View {
        let aspect = PlatformImage.aspect(thumb)
        let width = min(cardHeight * aspect, maxWidth).clamped(to: (cardHeight * 0.48)...max(maxWidth, cardHeight * 0.48))
        Button(action: open) {
            ZStack {
                Color(argb: 0xFF111113)
                if thumb == nil {
                    ProgressView().tint(NxColors.textFaint)
                } else {
                    BytesImage(data: thumb)
                }
            }
            .frame(width: width, height: cardHeight)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .scrollTransition { content, phase in
            content
                .scaleEffect(phase.isIdentity ? 1 : 0.9)
                .opacity(phase.isIdentity ? 1 : 0.55)
        }
        .accessibilityLabel("打开\(entry.title)")
    }
}

private struct AddMemoryCard: View {
    let cardHeight: CGFloat
    @Environment(ShellState.self) private var shell

    var body: some View {
        Button { shell.requestUpload += 1 } label: {
            VStack(spacing: 8) {
                Text("＋").font(.system(size: 30, weight: .light)).foregroundStyle(NxColors.textFaint)
                Text("添加照片").font(.system(size: 13)).foregroundStyle(NxColors.textFaint)
            }
            .frame(width: cardHeight * 0.59, height: cardHeight)
            .background(Color(argb: 0x08FFFFFF), in: RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Color(argb: 0x2EFFFFFF), style: StrokeStyle(lineWidth: 1.5, dash: [6, 5]))
            )
        }
        .buttonStyle(.plain)
        .scrollTransition { content, phase in
            content
                .scaleEffect(phase.isIdentity ? 1 : 0.9)
                .opacity(phase.isIdentity ? 1 : 0.55)
        }
    }
}

private struct TimelineFooter: View {
    let entry: Entry
    let index: Int
    let count: Int
    let deleteArmed: Bool
    let open: () -> Void
    let delete: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            Text(entry.title).font(.system(size: 14)).foregroundStyle(NxColors.textDim).lineLimit(1)
            Text("\(min(index, count)) / \(count)").font(.system(size: 11)).foregroundStyle(NxColors.textFaint)
            HStack(spacing: 10) {
                NxPill(text: "✧ 翻开这一天", action: open)
                NxPill(text: deleteArmed ? "确认丢弃?" : "✕ 丢弃", action: delete)
            }
        }
        .padding(.bottom, 18)
    }
}

private struct TimelineErrorRow: View {
    let error: String
    @Environment(AppViewModel.self) private var model

    var body: some View {
        HStack(spacing: 10) {
            Text(error)
                .font(.system(size: 11))
                .foregroundStyle(NxColors.errorColor)
                .lineLimit(2)
            NxPill(text: "重试", action: { model.loadHome() })
        }
    }
}

private struct LoadingMemories: View {
    let progress: String

    var body: some View {
        VStack(spacing: 12) {
            ProgressView().tint(NxColors.paper)
            Text(progress.isEmpty ? "正在取回记忆" : progress)
                .font(.system(size: 12))
                .foregroundStyle(NxColors.textDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct EmptyTimeline: View {
    @Environment(ShellState.self) private var shell

    var body: some View {
        VStack(spacing: 7) {
            Text("✦").font(.system(size: 26)).foregroundStyle(NxColors.gold.opacity(0.65))
            Text("还没有念想。").font(.nxSerif(17)).foregroundStyle(NxColors.textDim)
            Text("点击下方按钮，记下第一张吧。").font(.system(size: 12)).foregroundStyle(NxColors.textFaint)
            NxPill(text: "＋ 添加照片", action: { shell.requestUpload += 1 })
                .padding(.top, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Auth

struct AuthScreen: View {
    @Environment(AppViewModel.self) private var model
    @State private var username = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var connectionOpen = false

    var body: some View {
        let bootstrap = model.bootstrapped == false
        NxBackdrop {
            NxPanel {
                VStack(spacing: 0) {
                    Text(bootstrap ? "✦ 首次启用" : "✦ 登录念想")
                        .font(.nxSerif(25))
                        .foregroundStyle(NxColors.text)
                    Text(bootstrap ? "创建管理员账号，记忆会锁在你的账户下" : "输入用户名与密码")
                        .font(.system(size: 12))
                        .foregroundStyle(NxColors.textDim)
                        .multilineTextAlignment(.center)
                        .padding(.top, 7)
                        .padding(.bottom, 22)
                    if bootstrap {
                        NxField(placeholder: "怎么称呼你?", text: $displayName, maxLength: 20)
                            .padding(.bottom, 10)
                    }
                    NxField(placeholder: "用户名 (字母数字_)", text: $username, maxLength: 32)
                        .padding(.bottom, 10)
                    NxField(placeholder: "密码 (至少 8 位)", text: $password, password: true, maxLength: 128)
                    if let error = model.error {
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundStyle(NxColors.errorColor)
                            .padding(.top, 10)
                    }
                    NxPrimaryButton(
                        text: model.loading ? "…" : (bootstrap ? "启用 ✦" : "进入 ✦"),
                        action: {
                            let name = username.trimmingCharacters(in: .whitespaces)
                            if bootstrap {
                                model.bootstrap(username: name, password: password, displayName: displayName.trimmingCharacters(in: .whitespaces))
                            } else {
                                model.login(username: name, password: password)
                            }
                        },
                        enabled: !model.loading && !username.trimmingCharacters(in: .whitespaces).isEmpty && password.count >= 8
                    )
                    .padding(.top, 18)
                    NxPill(text: "连接设置", action: { connectionOpen = true })
                        .padding(.top, 12)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 28)
            }
            .frame(maxWidth: 430)
            .padding(20)
        }
        .overlay {
            if connectionOpen {
                ConnectionOverlay { connectionOpen = false }
            }
        }
        .onSubmit {
            let name = username.trimmingCharacters(in: .whitespaces)
            guard !model.loading, !name.isEmpty, password.count >= 8 else { return }
            if bootstrap {
                model.bootstrap(username: name, password: password, displayName: displayName.trimmingCharacters(in: .whitespaces))
            } else {
                model.login(username: name, password: password)
            }
        }
    }
}
