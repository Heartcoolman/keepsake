import Foundation

final class AppContainer: @unchecked Sendable {
    static let shared = AppContainer()

    let session: SessionStore
    let api: ApiClient

    init() {
        session = SessionStore()
        api = ApiClient(session: session)
    }
}
