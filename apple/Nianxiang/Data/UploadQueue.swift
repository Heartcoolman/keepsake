import Foundation

/// Persisted queue item: entry meta (already carries clientUploadId/takenAt/dateSource) plus
/// queue bookkeeping. DUPLICATE_IMAGE detail is kept so a later banner-triggered decision can
/// still show the same confirm dialog without re-hitting the network.
struct QueueManifest: Codable {
    enum State: String, Codable {
        case pending
        case needsDecision = "needs_decision"
    }

    var entry: Entry
    var state: State
    var attempts: Int
    var enqueuedAt: Int64
    var duplicateOfId: String? = nil
    var duplicateOfTakenAt: Int64? = nil
}

/// App-private, on-disk upload queue: enqueue writes a manifest + image + thumb before any
/// network attempt, so a process kill never loses queued photos. Directory listing is the
/// index (sorted by enqueuedAt); pure Foundation so it's testable with any injected directory.
final class UploadQueue: @unchecked Sendable {
    let directory: URL

    init(directory: URL) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("upload_queue", isDirectory: true)
    }

    @discardableResult
    func enqueue(entry: Entry, jpeg: Data, thumb: Data) throws -> QueueManifest {
        let manifest = QueueManifest(
            entry: entry, state: .pending, attempts: 0,
            enqueuedAt: Int64(Date().timeIntervalSince1970 * 1000)
        )
        try jpeg.write(to: imageUrl(entry.clientUploadId), options: .atomic)
        try thumb.write(to: thumbUrl(entry.clientUploadId), options: .atomic)
        try write(manifest)
        return manifest
    }

    /// All manifests sorted oldest-first. Corrupted/unreadable manifest files are skipped, not thrown.
    func list() -> [QueueManifest] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        let manifests: [QueueManifest] = names
            .filter { $0.hasSuffix(".json") }
            .compactMap { name in
                guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)) else { return nil }
                return try? JSONCoding.decoder.decode(QueueManifest.self, from: data)
            }
        return manifests.sorted { $0.enqueuedAt < $1.enqueuedAt }
    }

    func jpegData(for clientUploadId: String) -> Data? { try? Data(contentsOf: imageUrl(clientUploadId)) }
    func thumbData(for clientUploadId: String) -> Data? { try? Data(contentsOf: thumbUrl(clientUploadId)) }

    func markNeedsDecision(_ clientUploadId: String, duplicateOfId: String?, duplicateOfTakenAt: Int64?) {
        mutate(clientUploadId) {
            $0.state = .needsDecision
            $0.duplicateOfId = duplicateOfId
            $0.duplicateOfTakenAt = duplicateOfTakenAt
        }
    }

    @discardableResult
    func recordAttempt(_ clientUploadId: String) -> Int {
        mutate(clientUploadId) { $0.attempts += 1 }?.attempts ?? 0
    }

    func remove(_ clientUploadId: String) {
        for url in [manifestUrl(clientUploadId), imageUrl(clientUploadId), thumbUrl(clientUploadId)] {
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - Private

    @discardableResult
    private func mutate(_ clientUploadId: String, _ change: (inout QueueManifest) -> Void) -> QueueManifest? {
        guard let data = try? Data(contentsOf: manifestUrl(clientUploadId)),
              var manifest = try? JSONCoding.decoder.decode(QueueManifest.self, from: data) else { return nil }
        change(&manifest)
        try? write(manifest)
        return manifest
    }

    private func write(_ manifest: QueueManifest) throws {
        let data = try JSONCoding.encoder.encode(manifest)
        try data.write(to: manifestUrl(manifest.entry.clientUploadId), options: .atomic)
    }

    private func manifestUrl(_ id: String) -> URL { directory.appendingPathComponent("\(id).json") }
    private func imageUrl(_ id: String) -> URL { directory.appendingPathComponent("\(id).img") }
    private func thumbUrl(_ id: String) -> URL { directory.appendingPathComponent("\(id).thumb") }
}
