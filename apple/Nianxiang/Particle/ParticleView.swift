/// PUBLIC STUB — the real ParticleEngine is a Metal compute-shader particle system
/// (spring/curl physics, bokeh, sand-burst, text dissolve) and lives in the private
/// core module. This stub keeps the exact public API and shows the submitted photo
/// in a plain platform image view, so the app remains fully usable without the
/// particle effects. Gesture/camera methods are no-ops (there is no 3D camera).
import Foundation
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
protocol ParticleEngineListener: AnyObject {
    func onPhotoPrepared(photoId: String)
    func onEntranceStarted(photoId: String)
    func onRenderError(message: String)
    func onPerformanceSample(_ sample: ParticlePerformanceSample)
}

extension ParticleEngineListener {
    func onPhotoPrepared(photoId: String) {}
    func onEntranceStarted(photoId: String) {}
    func onRenderError(message: String) {}
    func onPerformanceSample(_ sample: ParticlePerformanceSample) {}
}

@MainActor
final class ParticleEngine {
    weak var listener: (any ParticleEngineListener)?

    #if os(macOS)
    let view = NSImageView()
    #else
    let view = UIImageView()
    #endif

    private let worker = DispatchQueue(label: "particle-stub-decode", qos: .utility)
    private var shownPhotoId: String?
    private var decodingPhotoId: String?

    init() {
        #if os(macOS)
        view.imageScaling = .scaleProportionallyUpOrDown
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.black.cgColor
        #else
        view.contentMode = .scaleAspectFill
        view.clipsToBounds = true
        view.backgroundColor = .black
        view.isUserInteractionEnabled = false
        #endif
    }

    func submit(_ scene: ParticleSceneState) {
        guard let photoId = scene.photoId else {
            shownPhotoId = nil
            decodingPhotoId = nil
            view.image = nil
            return
        }
        guard photoId != shownPhotoId, photoId != decodingPhotoId, let jpeg = scene.jpeg else { return }
        decodingPhotoId = photoId
        worker.async { [weak self] in
            #if os(macOS)
            let image = NSImage(data: jpeg)
            #else
            let image = UIImage(data: jpeg)
            #endif
            Task { @MainActor [weak self] in
                guard let self, self.decodingPhotoId == photoId else { return }
                self.decodingPhotoId = nil
                guard let image else {
                    self.listener?.onRenderError(message: "photo decode failed")
                    return
                }
                self.view.image = image
                self.shownPhotoId = photoId
                self.listener?.onPhotoPrepared(photoId: photoId)
                self.listener?.onEntranceStarted(photoId: photoId)
            }
        }
    }

    func setTestConfiguration(particleBudget: Int, seed: Int?, animationTimeSeconds: Float? = nil) {}

    func orbitBy(deltaX: Float, deltaY: Float, screenX: Float, screenY: Float) {}
    func zoomBy(scaleFactor: Float) {}
    func pulseAt(screenX: Float, screenY: Float) {}
    func resetCamera() {}
    func clearParticleFocus() {}

    func release() {
        shownPhotoId = nil
        decodingPhotoId = nil
        view.image = nil
    }
}

// MARK: - SwiftUI wrapper

#if os(macOS)
struct ParticleCanvas: NSViewRepresentable {
    let engine: ParticleEngine

    func makeNSView(context: Context) -> NSImageView { engine.view }
    func updateNSView(_ nsView: NSImageView, context: Context) {}
}
#else
struct ParticleCanvas: UIViewRepresentable {
    let engine: ParticleEngine

    func makeUIView(context: Context) -> UIImageView { engine.view }
    func updateUIView(_ uiView: UIImageView, context: Context) {}
}
#endif
