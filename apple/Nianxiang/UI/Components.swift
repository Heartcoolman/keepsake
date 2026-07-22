import SwiftUI

// Shared chrome, ported from NianxiangComponents.kt.

struct NxBackdrop<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ZStack {
            RadialGradient(
                colors: [
                    NxColors.inkWarm.opacity(0.92),
                    NxColors.ink.opacity(0.9),
                    Color.black.opacity(0.94),
                ],
                center: .center,
                startRadius: 0,
                endRadius: 750
            )
            .ignoresSafeArea()
            content
        }
    }
}

struct NxField: View {
    let placeholder: String
    @Binding var text: String
    var singleLine = true
    var password = false
    var leadingIcon: String?
    var enabled = true
    var maxLength: Int?

    var body: some View {
        HStack(alignment: singleLine ? .center : .top, spacing: 10) {
            if let leadingIcon {
                Image(systemName: leadingIcon)
                    .font(.system(size: 14))
                    .foregroundStyle(NxColors.textFaint)
            }
            Group {
                if password {
                    SecureField("", text: $text, prompt: Text(placeholder).foregroundStyle(NxColors.textFaint))
                } else if singleLine {
                    TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(NxColors.textFaint))
                } else {
                    TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(NxColors.textFaint), axis: .vertical)
                        .lineLimit(5...30)
                }
            }
            .textFieldStyle(.plain)
            .font(.system(size: 13))
            .foregroundStyle(NxColors.text)
            .disabled(!enabled)
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            #endif
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(minHeight: 42, alignment: singleLine ? .center : .top)
        .background(NxColors.control, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(NxColors.line, lineWidth: 1))
        .onChange(of: text) { _, value in
            if let maxLength, value.count > maxLength {
                text = String(value.prefix(maxLength))
            }
        }
    }
}

struct NxPill: View {
    let text: String
    let action: () -> Void
    var selected = false
    var enabled = true
    var icon: String?

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if let icon { Image(systemName: icon).font(.system(size: 12)) }
                Text(text).font(.system(size: 12.5))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .frame(minHeight: 36)
            .foregroundStyle(selected ? NxColors.onPaper : NxColors.textDim)
            .background(selected ? NxColors.paper : NxColors.control, in: Capsule())
            .overlay(Capsule().stroke(selected ? NxColors.paper : NxColors.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

struct NxIconButton: View {
    let systemName: String
    let label: String
    let action: () -> Void
    var selected = false
    var enabled = true

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 14))
                .frame(width: 38, height: 38)
                .foregroundStyle(selected ? NxColors.onPaper : NxColors.textDim)
                .background(selected ? NxColors.paper : NxColors.control, in: Circle())
                .overlay(Circle().stroke(selected ? NxColors.paper : NxColors.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        .accessibilityLabel(label)
    }
}

struct NxPanel<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .background(NxColors.panel, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(NxColors.line, lineWidth: 1))
    }
}

struct NxSegmentedControl: View {
    let options: [(String, String)]
    let selected: String
    let onSelected: (String) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.0) { key, label in
                Button { onSelected(key) } label: {
                    Text(label)
                        .font(.system(size: 13))
                        .padding(.horizontal, 20)
                        .padding(.vertical, 7)
                        .foregroundStyle(selected == key ? NxColors.onPaper : NxColors.textFaint)
                        .background(selected == key ? NxColors.paper : .clear, in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(NxColors.control, in: Capsule())
        .overlay(Capsule().stroke(NxColors.line, lineWidth: 1))
    }
}

struct NxPrimaryButton: View {
    let text: String
    let action: () -> Void
    var enabled = true

    var body: some View {
        NxPill(text: text, action: action, selected: true, enabled: enabled)
            .frame(maxWidth: .infinity)
    }
}

struct SmallAction: View {
    let systemName: String
    let label: String
    let action: () -> Void
    var tint: Color = NxColors.textDim

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13))
                .foregroundStyle(tint)
                .frame(width: 34, height: 34)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// JPEG data → Image, decoded off the raw bytes each render (SwiftUI caches by view identity).
struct BytesImage: View {
    let data: Data?
    var contentMode: ContentMode = .fill

    var body: some View {
        if let data, let image = PlatformImage.decode(data) {
            image
                .resizable()
                .aspectRatio(contentMode: contentMode)
        } else {
            Color(argb: 0xFF111113)
        }
    }
}

enum PlatformImage {
    static func decode(_ data: Data) -> Image? {
        #if os(macOS)
        guard let image = NSImage(data: data) else { return nil }
        return Image(nsImage: image)
        #else
        guard let image = UIImage(data: data) else { return nil }
        return Image(uiImage: image)
        #endif
    }

    static func aspect(_ data: Data?) -> CGFloat {
        guard let data else { return 0.72 }
        #if os(macOS)
        guard let image = NSImage(data: data), image.size.height > 0 else { return 0.72 }
        return image.size.width / image.size.height
        #else
        guard let image = UIImage(data: data), image.size.height > 0 else { return 0.72 }
        return image.size.width / image.size.height
        #endif
    }
}

struct ToastView: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.system(size: 13))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color(argb: 0xE61E1E23), in: Capsule())
            .padding(24)
    }
}

struct EmptyFeature: View {
    let text: String

    var body: some View {
        VStack(spacing: 8) {
            Text("✦").font(.system(size: 22)).foregroundStyle(NxColors.textFaint)
            Text(text).font(.nxSerif(15)).foregroundStyle(NxColors.textDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
