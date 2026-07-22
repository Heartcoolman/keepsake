import Foundation
import Observation
import Speech
import AVFoundation

/// Live speech-to-text via SFSpeechRecognizer + AVAudioEngine, mirroring the
/// Android SpeechRecognizer flow (partials update the input while listening).
@MainActor
@Observable
final class SpeechInput {
    var listening = false
    var onTranscript: (String) -> Void = { _ in }

    @ObservationIgnored private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?

    var available: Bool { recognizer?.isAvailable ?? false }

    func toggle() {
        if listening { stop() } else { Task { await start() } }
    }

    private func start() async {
        guard let recognizer, recognizer.isAvailable else { return }
        let speechGranted = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        guard speechGranted else { return }
        let micGranted = await requestMicrophone()
        guard micGranted else { return }

        stop()
        do {
            #if os(iOS)
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
            #endif
            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else { return }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            engine.prepare()
            try engine.start()
            self.engine = engine
            self.request = request
            listening = true
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    if let result {
                        self.onTranscript(result.bestTranscription.formattedString)
                        if result.isFinal { self.stop() }
                    }
                    if error != nil { self.stop() }
                }
            }
        } catch {
            stop()
        }
    }

    private func requestMicrophone() async -> Bool {
        #if os(iOS)
        return await AVAudioApplication.requestRecordPermission()
        #else
        return await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .audio) { continuation.resume(returning: $0) }
        }
        #endif
    }

    func stop() {
        listening = false
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        engine = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}
