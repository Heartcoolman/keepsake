import XCTest
@testable import Nianxiang

final class UploadQueueTests: XCTestCase {
    private var directory: URL!
    private var queue: UploadQueue!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("UploadQueueTests-\(UUID().uuidString)", isDirectory: true)
        queue = UploadQueue(directory: directory)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeEntry() -> Entry {
        var entry = Entry(id: ApiClient.newEntryId())
        entry.clientUploadId = UUID().uuidString
        entry.takenAt = 1_700_000_000_000
        entry.dateSource = "exif"
        return entry
    }

    func testEnqueuePersistsManifestAndBlobs() throws {
        let entry = makeEntry()
        let jpeg = Data([0xFF, 0xD8, 0xFF])
        let thumb = Data([0xFF, 0xD8])
        try queue.enqueue(entry: entry, jpeg: jpeg, thumb: thumb)

        let listed = queue.list()
        XCTAssertEqual(listed.count, 1)
        XCTAssertEqual(listed[0].entry.clientUploadId, entry.clientUploadId)
        XCTAssertEqual(listed[0].state, .pending)
        XCTAssertEqual(listed[0].attempts, 0)
        XCTAssertEqual(queue.jpegData(for: entry.clientUploadId), jpeg)
        XCTAssertEqual(queue.thumbData(for: entry.clientUploadId), thumb)
    }

    /// Writes manifests directly with fixed timestamps so ordering is deterministic (bypasses
    /// enqueue()'s wall-clock stamp, which could collide within the same millisecond).
    func testListingOrderIsOldestFirst() throws {
        let stamps: [(id: String, enqueuedAt: Int64)] = [("c", 3000), ("a", 1000), ("b", 2000)]
        for (id, stamp) in stamps {
            var entry = makeEntry()
            entry.clientUploadId = id
            let manifest = QueueManifest(entry: entry, state: .pending, attempts: 0, enqueuedAt: stamp)
            let data = try JSONCoding.encoder.encode(manifest)
            try data.write(to: directory.appendingPathComponent("\(id).json"))
        }
        XCTAssertEqual(queue.list().map(\.entry.clientUploadId), ["a", "b", "c"])
    }

    func testStateTransitionsAndAttempts() throws {
        let entry = makeEntry()
        try queue.enqueue(entry: entry, jpeg: Data([1]), thumb: Data([2]))
        let id = entry.clientUploadId

        queue.markNeedsDecision(id, duplicateOfId: "other-entry", duplicateOfTakenAt: 42)
        var manifest = queue.list().first { $0.entry.clientUploadId == id }
        XCTAssertEqual(manifest?.state, .needsDecision)
        XCTAssertEqual(manifest?.duplicateOfId, "other-entry")
        XCTAssertEqual(manifest?.duplicateOfTakenAt, 42)

        XCTAssertEqual(queue.recordAttempt(id), 1)
        XCTAssertEqual(queue.recordAttempt(id), 2)
        for _ in 0..<3 { queue.recordAttempt(id) }
        manifest = queue.list().first { $0.entry.clientUploadId == id }
        XCTAssertEqual(manifest?.attempts, 5)

        // Caller (AppViewModel.drainOne) gives up and removes the item once its cap is reached.
        queue.remove(id)
        XCTAssertTrue(queue.list().isEmpty)
    }

    func testRemoveDeletesAllFiles() throws {
        let entry = makeEntry()
        try queue.enqueue(entry: entry, jpeg: Data([1]), thumb: Data([2]))
        let id = entry.clientUploadId
        let jsonUrl = directory.appendingPathComponent("\(id).json")
        let imgUrl = directory.appendingPathComponent("\(id).img")
        let thumbUrl = directory.appendingPathComponent("\(id).thumb")
        XCTAssertTrue(FileManager.default.fileExists(atPath: jsonUrl.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: imgUrl.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: thumbUrl.path))

        queue.remove(id)

        XCTAssertFalse(FileManager.default.fileExists(atPath: jsonUrl.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: imgUrl.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: thumbUrl.path))
        XCTAssertTrue(queue.list().isEmpty)
    }

    func testCorruptedManifestIsSkippedNotThrown() throws {
        let entry = makeEntry()
        try queue.enqueue(entry: entry, jpeg: Data([1]), thumb: Data([2]))
        try Data("not valid json".utf8).write(to: directory.appendingPathComponent("garbage.json"))

        let listed = queue.list()
        XCTAssertEqual(listed.count, 1)
        XCTAssertEqual(listed[0].entry.clientUploadId, entry.clientUploadId)
    }
}
