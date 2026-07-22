import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import PhotosUI
import Photos

/// Creation date (ms) of the picked asset, so the importer's "file" date tier works for
/// no-EXIF photos (screenshots, forwarded images). 0 when unavailable — falls back to now.
private func assetCreationMillis(_ localIdentifier: String?) -> Int64 {
    guard let localIdentifier else { return 0 }
    let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
    guard let date = assets.firstObject?.creationDate else { return 0 }
    return Int64(date.timeIntervalSince1970 * 1000)
}
#endif

/// Platform photo intake: PhotosPicker on iOS/iPadOS, file importer on macOS.
/// Presentation is driven by ShellState.requestUpload so menu commands / buttons share one entry point.
struct PhotoPickingModifier: ViewModifier {
    @Environment(AppViewModel.self) private var model
    @Environment(ShellState.self) private var shell
    @State private var presented = false
    #if os(iOS)
    @State private var selection: [PhotosPickerItem] = []
    #endif

    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .onChange(of: shell.requestUpload) { presented = true }
            .photosPicker(
                isPresented: $presented,
                selection: $selection,
                maxSelectionCount: 30,
                matching: .images,
                // .shared() so PhotosPickerItem.itemIdentifier is populated (asset localIdentifier).
                photoLibrary: .shared()
            )
            .onChange(of: selection) { _, items in
                guard !items.isEmpty else { return }
                selection = []
                Task {
                    // Reading a picked asset's creation date needs library access; request it
                    // (no-op once granted). Denied → itemIdentifier lookup yields 0, EXIF/now stand.
                    _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
                    var picked: [AppViewModel.PickedPhoto] = []
                    for item in items {
                        guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                        picked.append(.init(
                            data: data,
                            filename: "",
                            fileModifiedAt: assetCreationMillis(item.itemIdentifier)
                        ))
                    }
                    model.importPhotos(picked)
                }
            }
        #else
        content
            .onChange(of: shell.requestUpload) { presented = true }
            .fileImporter(
                isPresented: $presented,
                allowedContentTypes: [.image],
                allowsMultipleSelection: true
            ) { result in
                guard case .success(let urls) = result else { return }
                importFiles(urls)
            }
        #endif
    }

    #if os(macOS)
    private func importFiles(_ urls: [URL]) {
        var picked: [AppViewModel.PickedPhoto] = []
        for url in urls.prefix(30) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
                .map { Int64($0.timeIntervalSince1970 * 1000) } ?? 0
            picked.append(.init(data: data, filename: url.lastPathComponent, fileModifiedAt: modified))
        }
        model.importPhotos(picked)
    }
    #endif
}

/// Drag photos (from Finder / Photos / other apps) onto the timeline to upload.
struct DropToUploadModifier: ViewModifier {
    @Environment(AppViewModel.self) private var model

    func body(content: Content) -> some View {
        #if os(macOS)
        content.dropDestination(for: URL.self) { urls, _ in
            var picked: [AppViewModel.PickedPhoto] = []
            for url in urls.prefix(30) {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .image),
                      let data = try? Data(contentsOf: url) else { continue }
                let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
                    .map { Int64($0.timeIntervalSince1970 * 1000) } ?? 0
                picked.append(.init(data: data, filename: url.lastPathComponent, fileModifiedAt: modified))
            }
            guard !picked.isEmpty else { return false }
            model.importPhotos(picked)
            return true
        }
        #else
        content.dropDestination(for: Data.self) { items, _ in
            let picked = items.prefix(30).map {
                AppViewModel.PickedPhoto(data: $0, filename: "", fileModifiedAt: 0)
            }
            guard !picked.isEmpty else { return false }
            model.importPhotos(Array(picked))
            return true
        }
        #endif
    }
}

extension View {
    func photoPicking() -> some View { modifier(PhotoPickingModifier()) }
    func dropToUpload() -> some View { modifier(DropToUploadModifier()) }
}
