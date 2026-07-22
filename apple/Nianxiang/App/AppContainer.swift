import Foundation

final class AppContainer: @unchecked Sendable {
    static let shared = AppContainer()

    let session: SessionStore
    let api: ApiClient
    let uploadQueue: UploadQueue

    init() {
        session = SessionStore()
        api = ApiClient(session: session)
        uploadQueue = UploadQueue(directory: UploadQueue.defaultDirectory())
    }
}
