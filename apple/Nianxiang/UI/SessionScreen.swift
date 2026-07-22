import SwiftUI

/// Photo session: particle cloud behind, chat / diary text over it.
/// Ported from Android SessionScreen; orbit/zoom/pulse gestures forward to the engine.
struct SessionScreen: View {
    let engine: ParticleEngine
    let particleEntranceStarted: Bool
    let back: () -> Void

    @Environment(AppViewModel.self) private var model
    @State private var input = ""
    @State private var textHidden = false
    @State private var editingDiary = false
    @State private var namingFace: Int?
    @State private var datePickerOpen = false
    @State private var speech = SpeechInput()
    @State private var orbitState = OrbitDragState()
    @State private var orbitHintExpired = false

    var body: some View {
        guard let entry = model.sessionEntry else {
            return AnyView(
                NxBackdrop { ProgressView().tint(NxColors.paper) }
            )
        }
        let diaryVisible = entry.status == "done" && model.sessionTab == "diary"
        return AnyView(
            ZStack {
                // 粒子入场前先显示照片本体，入场后淡出交给粒子。
                if model.photoBytes != nil && !particleEntranceStarted {
                    BytesImage(data: model.photoBytes, contentMode: .fit)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color.black)
                        .ignoresSafeArea()
                        .transition(.opacity)
                }
                LinearGradient(
                    colors: [Color(argb: 0x30000000), .clear, Color(argb: 0x66000000)],
                    startPoint: .top, endPoint: .bottom
                )
                .ignoresSafeArea()
                .allowsHitTesting(false)

                if diaryVisible {
                    DiaryView(
                        entry: entry,
                        streamed: model.diaryStream,
                        editing: $editingDiary,
                        pickDate: { datePickerOpen = true }
                    )
                } else {
                    ChatView(
                        entry: entry,
                        textHidden: textHidden,
                        input: $input,
                        speech: speech,
                        nameFace: { namingFace = $0 }
                    )
                }

                topChrome(entry: entry, diaryVisible: diaryVisible)

                if model.phase == "chatting" && !orbitHintExpired {
                    VStack {
                        Spacer()
                        HStack {
                            Text(Self.orbitHintText)
                                .font(.system(size: 11))
                                .kerning(1.2)
                                .foregroundStyle(NxColors.textFaint)
                                .padding(.leading, 22)
                                .padding(.bottom, 20)
                            Spacer()
                        }
                    }
                    .allowsHitTesting(false)
                    .transition(.opacity)
                    .task {
                        try? await Task.sleep(nanoseconds: 6_000_000_000)
                        withAnimation(.easeOut(duration: 0.8)) { orbitHintExpired = true }
                    }
                }

                if model.phase == "loading" || model.phase == "analyzing" {
                    VStack {
                        Spacer()
                        Text("念念正在端详这张照片…")
                            .font(.nxSerif(13))
                            .foregroundStyle(NxColors.textDim)
                            .padding(.bottom, 112)
                    }
                    .allowsHitTesting(false)
                }
                if model.phase == "condensing" {
                    ZStack {
                        Color(argb: 0x78000000).ignoresSafeArea()
                        Text("思 绪 正 在 沉 淀 . . .")
                            .font(.nxSerif(15))
                            .foregroundStyle(NxColors.textDim)
                    }
                    .transition(.opacity)
                    .allowsHitTesting(false)
                }
            }
            .animation(.easeInOut(duration: 0.35), value: particleEntranceStarted)
            .animation(.easeInOut(duration: 0.3), value: model.phase)
            .simultaneousGesture(orbitGesture)
            .simultaneousGesture(magnifyGesture)
            .simultaneousGesture(TapGesture(count: 2).onEnded { engine.resetCamera() })
            .simultaneousGesture(
                SpatialTapGesture().onEnded { value in
                    engine.pulseAt(screenX: Float(value.location.x), screenY: Float(value.location.y))
                }
            )
            .onAppear {
                speech.onTranscript = { input = $0 }
            }
            .onDisappear { speech.stop() }
            .overlay { faceNamingDialog(entry: entry) }
            .sheet(isPresented: $datePickerOpen) {
                TakenAtPicker(initial: entry.takenAt) { millis in
                    model.setTakenAt(millis)
                }
            }
        )
    }

    static var orbitHintText: String {
        #if os(macOS)
        return "拖动环视 · 捏合缩放 · 双击复位"
        #else
        return "拖动环视 · 双指缩放 · 双击复位"
        #endif
    }

    // MARK: - Top chrome

    @ViewBuilder
    private func topChrome(entry: Entry, diaryVisible: Bool) -> some View {
        VStack {
            ZStack(alignment: .top) {
                HStack {
                    NxIconButton(systemName: "arrow.left", label: "回到时光轴", action: back)
                    Spacer()
                    if !diaryVisible {
                        SubtitleToggle(textHidden: $textHidden)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 10)

                VStack(spacing: 2) {
                    if entry.status == "done" {
                        NxSegmentedControl(
                            options: [("diary", "日记"), ("chat", "对话")],
                            selected: model.sessionTab
                        ) { model.sessionTab = $0 }
                    }
                    if !diaryVisible {
                        DatePill(entry: entry) { datePickerOpen = true }
                    }
                }
                .padding(.top, 8)
            }
            Spacer()
        }
    }

    // MARK: - Face naming

    @ViewBuilder
    private func faceNamingDialog(entry: Entry) -> some View {
        if let index = namingFace {
            FaceNamerDialog(
                title: "这是谁？",
                samples: [FaceRef(entryId: entry.id, faceIndex: index)],
                dismiss: { namingFace = nil }
            )
        }
    }

    // MARK: - Particle gestures

    private var orbitGesture: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                let previous = orbitState.last ?? value.startLocation
                let deltaX = Float(value.location.x - previous.x)
                let deltaY = Float(value.location.y - previous.y)
                orbitState.last = value.location
                if !orbitState.decided {
                    let dx = abs(value.translation.width)
                    let dy = abs(value.translation.height)
                    guard dx + dy > 10 else { return }
                    orbitState.decided = true
                    orbitState.orbiting = dx > dy
                }
                guard orbitState.orbiting else { return }
                engine.orbitBy(
                    deltaX: deltaX, deltaY: deltaY,
                    screenX: Float(value.location.x), screenY: Float(value.location.y)
                )
            }
            .onEnded { _ in
                orbitState = OrbitDragState()
                engine.clearParticleFocus()
            }
    }

    private var magnifyGesture: some Gesture {
        MagnificationGesture()
            .onChanged { value in
                let factor = value / max(orbitState.lastMagnification, 0.0001)
                orbitState.lastMagnification = value
                engine.zoomBy(scaleFactor: Float(factor))
            }
            .onEnded { _ in orbitState.lastMagnification = 1 }
    }
}

private struct OrbitDragState {
    var last: CGPoint?
    var decided = false
    var orbiting = false
    var lastMagnification: CGFloat = 1
}

// MARK: - Subtitle toggle

/// 文字 pill，对齐 Web 的 .subtitle-toggle（字幕模式 · 点按隐去/显示文字）。
private struct SubtitleToggle: View {
    @Binding var textHidden: Bool

    var body: some View {
        Button { textHidden.toggle() } label: {
            Text(textHidden ? "字幕模式 · 点按显示文字" : "字幕模式 · 点按隐去文字")
                .font(.system(size: 11))
                .foregroundStyle(NxColors.textFaint)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Color(argb: 0x9918181C), in: Capsule())
                .overlay(Capsule().stroke(Color(argb: 0x12FFFFFF), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(textHidden ? "显示字幕" : "隐藏字幕")
    }
}

// MARK: - Date pill & picker

private struct DatePill: View {
    let entry: Entry
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text(SidebarDateFormat.text(entry.takenAt))
                .font(.system(size: 11))
                .foregroundStyle(NxColors.textDim)
                .padding(.horizontal, 11)
                .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
    }
}

enum SidebarDateFormat {
    static func text(_ millis: Int64) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy年M月d日"
        formatter.locale = Locale(identifier: "zh_CN")
        return formatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }
}

private struct TakenAtPicker: View {
    let initial: Int64
    let save: (Int64) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var date = Date()

    var body: some View {
        VStack(spacing: 14) {
            Text("修改日期").font(.nxSerif(18)).foregroundStyle(NxColors.text)
            DatePicker("", selection: $date, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .labelsHidden()
                .tint(NxColors.gold)
            HStack(spacing: 10) {
                NxPill(text: "取消", action: { dismiss() })
                NxPill(text: "保存", action: {
                    var components = Calendar.current.dateComponents([.year, .month, .day], from: date)
                    components.hour = 12
                    components.minute = 0
                    components.second = 0
                    let noon = Calendar.current.date(from: components) ?? date
                    save(Int64(noon.timeIntervalSince1970 * 1000))
                    dismiss()
                }, selected: true)
            }
        }
        .padding(22)
        .presentationDetents([.medium])
        .presentationBackground(NxColors.panelSolid)
        .onAppear { date = Date(timeIntervalSince1970: Double(initial) / 1000) }
    }
}

// MARK: - Chat view

private struct ChatView: View {
    let entry: Entry
    let textHidden: Bool
    @Binding var input: String
    let speech: SpeechInput
    let nameFace: (Int) -> Void

    @Environment(AppViewModel.self) private var model

    var body: some View {
        ZStack {
            if !textHidden {
                conversation
                    .transition(.opacity)
            }
            VStack {
                Spacer()
                composer
            }
        }
        .animation(.easeInOut(duration: 0.25), value: textHidden)
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 16) {
                    Color.clear.frame(height: 260)
                    ForEach(Array(model.sessionMessages.enumerated()), id: \.offset) { _, message in
                        ConversationLine(message: message)
                    }
                    Color.clear.frame(height: 1).id("__bottom__")
                }
                .padding(.horizontal, 22)
                .padding(.top, 118)
                .padding(.bottom, 166)
            }
            .scrollIndicators(.hidden)
            .onChange(of: model.sessionMessages.count) {
                proxy.scrollTo("__bottom__", anchor: .bottom)
            }
            .onChange(of: model.sessionMessages.last?.content) {
                proxy.scrollTo("__bottom__", anchor: .bottom)
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            FaceRow(entry: entry, nameFace: nameFace)
            if model.sessionMessages.contains(where: { $0.role == "user" }) {
                CondenseButton(
                    text: entry.status == "done" ? "✦ 重新凝聚" : "✦ 凝聚记忆",
                    action: model.generateDiary,
                    enabled: !model.busy
                )
            }
            HStack(spacing: 8) {
                if speech.available {
                    NxIconButton(
                        systemName: "mic",
                        label: speech.listening ? "停止语音" : "语音输入",
                        action: speech.toggle,
                        selected: speech.listening,
                        enabled: !model.busy
                    )
                }
                NxField(
                    placeholder: speech.listening ? "正在听…" : "说点什么…",
                    text: $input,
                    enabled: !model.busy,
                    maxLength: 4000
                )
                .onSubmit(send)
                NxPill(
                    text: "发送",
                    action: send,
                    enabled: !input.trimmingCharacters(in: .whitespaces).isEmpty && !model.busy
                )
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !model.busy else { return }
        input = ""
        if speech.listening { speech.stop() }
        model.sendMessage(text)
    }
}

/// 暖金描边 + 光晕的凝聚按钮，对齐 Web 的 .condense-btn。
private struct CondenseButton: View {
    let text: String
    let action: () -> Void
    var enabled = true

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 13.5))
                .foregroundStyle(Color(argb: 0xF2FFEAC8))
                .padding(.horizontal, 24)
                .padding(.vertical, 11)
                .background(Color(argb: 0xCC1E1D1A), in: Capsule())
                .overlay(Capsule().stroke(Color(argb: 0x47FFE0B2), lineWidth: 1))
                .shadow(color: Color(argb: 0x59FFD296), radius: 12)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

private struct ConversationLine: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == "user" {
                Spacer(minLength: 0)
                Text(message.content)
                    .font(.system(size: 14))
                    .lineSpacing(8)
                    .foregroundStyle(Color(argb: 0xD9FFFFFF))
                    .padding(.horizontal, 15)
                    .padding(.vertical, 9)
                    .background(Color(argb: 0xA8181A20), in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(NxColors.line, lineWidth: 1))
                    .frame(maxWidth: 480, alignment: .trailing)
            } else {
                Text(message.content.isEmpty ? "· · ·" : message.content)
                    .font(.system(size: 14.5))
                    .lineSpacing(9)
                    .foregroundStyle(NxColors.text)
                    .shadow(color: .black, radius: 6, y: 2)
                    .frame(maxWidth: 480, alignment: .leading)
                Spacer(minLength: 0)
            }
        }
    }
}

private struct FaceRow: View {
    let entry: Entry
    let nameFace: (Int) -> Void
    @Environment(AppViewModel.self) private var model

    var body: some View {
        if entry.unknownFaces > 0 {
            let matched = Set(entry.people.map(\.faceIndex))
            let total = matched.count + entry.unknownFaces
            let indices = (0..<total).filter { !matched.contains($0) }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 7) {
                    Text("这是谁？").font(.system(size: 12)).foregroundStyle(NxColors.textDim)
                    ForEach(indices, id: \.self) { index in
                        let ref = FaceRef(entryId: entry.id, faceIndex: index)
                        Button { nameFace(index) } label: {
                            BytesImage(data: model.faceThumbs[ref.cacheKey])
                                .frame(width: 46, height: 46)
                                .clipShape(Circle())
                                .overlay(
                                    Circle().stroke(
                                        Color(argb: 0x73FFFFFF),
                                        style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])
                                    )
                                )
                        }
                        .buttonStyle(.plain)
                        .task { model.loadFaceThumb(ref) }
                    }
                }
            }
            .padding(.bottom, 4)
        }
    }
}

// MARK: - Diary view

private struct DiaryView: View {
    let entry: Entry
    let streamed: String
    @Binding var editing: Bool
    let pickDate: () -> Void

    @Environment(AppViewModel.self) private var model
    @State private var title = ""
    @State private var bodyText = ""

    var body: some View {
        // 0x80 遮罩：日记直接叠在粒子照片上，亮部需要压暗保证白色宋体可读。
        ZStack {
            Color(argb: 0x80000000).ignoresSafeArea().allowsHitTesting(false)
            ScrollView {
                VStack(spacing: 0) {
                    if editing {
                        NxField(placeholder: "标题", text: $title, maxLength: 200)
                    } else {
                        Text(entry.title.isEmpty ? "这一天" : entry.title)
                            .font(.nxSerif(26))
                            .kerning(5)
                            .lineSpacing(10)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(Color(argb: 0xF2FFFFFF))
                            .shadow(color: .black, radius: 6, y: 2)
                            .frame(maxWidth: .infinity)
                    }
                    DatePill(entry: entry, onTap: pickDate)
                        .padding(.top, 10)
                    Spacer().frame(height: 36)
                    if editing {
                        NxField(placeholder: "正文", text: $bodyText, singleLine: false, maxLength: 20000)
                            .frame(minHeight: 320, alignment: .top)
                        HStack(spacing: 10) {
                            NxPill(text: "取消", action: { editing = false })
                            NxPill(text: "保存", action: {
                                model.saveDiary(title: title, body: bodyText)
                                editing = false
                            }, enabled: !bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        .padding(.top, 18)
                    } else {
                        let diary = entry.diaryText.isEmpty
                            ? (streamed.isEmpty ? "日记还在生成中…" : streamed)
                            : entry.diaryText
                        let paragraphs = diary
                            .components(separatedBy: CharacterSet.newlines)
                            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                        ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                            Text(paragraph)
                                .font(.nxSerif(16))
                                .lineSpacing(16)
                                .foregroundStyle(Color(argb: 0xE6FFFFFF))
                                .shadow(color: .black, radius: 6, y: 2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.bottom, 18)
                        }
                        NxPill(text: "编辑", action: {
                            title = entry.title
                            bodyText = entry.diaryText
                            editing = true
                        }, icon: "pencil")
                        .padding(.top, 18)
                    }
                }
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 22)
                .padding(.top, 126)
                .padding(.bottom, 110)
            }
            .scrollIndicators(.hidden)
        }
    }
}

// MARK: - Dialog scrim

struct DialogScrim<Content: View>: View {
    let dismiss: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        ZStack {
            Color(argb: 0xA008080C)
                .ignoresSafeArea()
                .onTapGesture(perform: dismiss)
            content
                .background(NxColors.panelSolid, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(NxColors.line, lineWidth: 1))
                .frame(maxWidth: 420)
                .padding(24)
        }
    }
}
