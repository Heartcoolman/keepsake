import Foundation
import Network

/// Thin NWPathMonitor wrapper: fires `onRegained` when the path flips offline → online.
/// No background scheduling — this only matters while the process is alive and observing.
@MainActor
final class ConnectivityObserver {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.nianxiang.connectivity")
    private(set) var isOnline = true
    var onRegained: (() -> Void)?

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor [weak self] in
                guard let self else { return }
                let wasOnline = self.isOnline
                self.isOnline = online
                if online && !wasOnline { self.onRegained?() }
            }
        }
        monitor.start(queue: queue)
    }

    func stop() { monitor.cancel() }
}
