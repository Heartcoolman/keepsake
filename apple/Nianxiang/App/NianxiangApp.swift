import SwiftUI

@main
struct NianxiangApp: App {
    @State private var model = AppViewModel()
    @State private var engine = ParticleEngine()
    @State private var shell = ShellState()

    var body: some Scene {
        WindowGroup {
            AppRoot(engine: engine)
                .environment(model)
                .environment(shell)
                .preferredColorScheme(.dark)
                #if os(macOS)
                .frame(minWidth: 900, minHeight: 620)
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 1200, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("上传照片…") { shell.requestUpload += 1 }
                    .keyboardShortcut("n", modifiers: .command)
                    .disabled(model.user == nil)
            }
            CommandMenu("念想") {
                Button("搜索") { shell.focusSearch += 1 }
                    .keyboardShortcut("f", modifiers: .command)
                    .disabled(model.user == nil)
                Divider()
                Button("回顾与月报") { shell.overlay = .review }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(model.user == nil)
                Button("人物") { shell.overlay = .people }
                    .keyboardShortcut("p", modifiers: [.command, .shift])
                    .disabled(model.user == nil)
                Button("关系图谱") { shell.overlay = .graph }
                    .keyboardShortcut("g", modifiers: [.command, .shift])
                    .disabled(model.user == nil)
                Button("账号") { shell.overlay = .account }
                    .keyboardShortcut(",", modifiers: [.command, .shift])
                    .disabled(model.user == nil)
                Divider()
                Button("回到时光轴") { shell.closeSessionRequest += 1 }
                    .keyboardShortcut(.escape, modifiers: [])
                    .disabled(model.user == nil)
            }
        }
        #endif
    }
}

enum AppOverlay {
    case review, people, profile, account, connection, graph
}

/// Cross-view shell signals (menu commands, overlay routing).
@MainActor
@Observable
final class ShellState {
    var overlay: AppOverlay?
    var requestUpload = 0
    var focusSearch = 0
    var closeSessionRequest = 0
}
