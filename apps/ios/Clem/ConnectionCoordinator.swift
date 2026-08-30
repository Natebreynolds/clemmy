import Combine
import Foundation
import Network

/// The transport class iOS is currently using.
///
/// This is deliberately smaller than `NWPath`: the rest of the app only needs
/// to know whether a LAN route is plausible or whether it should go straight
/// to the already-paired relay door.
enum ConnectionPathKind: Equatable, Sendable {
    case wifi
    case cellular
    case other
    case unavailable

    var prefersRelay: Bool { self == .cellular }
    var isReachable: Bool { self != .unavailable }
}

struct ConnectionPathUpdate: Equatable, Sendable {
    let kind: ConnectionPathKind
    let isInitial: Bool
}

enum ConnectionRoutePolicy {
    /// Cellular must never burn RFC1918/Bonjour timeouts before trying the
    /// already-paired relay. Wi-Fi keeps the normal LAN-first ladder.
    static func candidates(for kind: ConnectionPathKind, pairing: Pairing) -> [String] {
        if kind.prefersRelay {
            return pairing.relayOrigin.map { [$0] } ?? []
        }
        var seen = Set<String>()
        return [pairing.lanOrigin, pairing.origin, pairing.relayOrigin]
            .compactMap { $0 }
            .filter { seen.insert($0).inserted }
    }
}

/// Coalesces identical reconnect triggers while fencing a changed path intent.
/// NWPath, foregrounding, and the PWA can all report the same outage within a
/// few milliseconds; one physical relay probe is enough. A real Wi-Fi ↔︎
/// cellular transition supersedes the old callback without trusting it.
struct ReconnectAttemptGate {
    private(set) var generation = 0
    private(set) var activeIntent: ConnectionPathKind?

    mutating func begin(_ intent: ConnectionPathKind) -> Int? {
        if activeIntent == intent { return nil }
        generation += 1
        activeIntent = intent
        return generation
    }

    func isCurrent(_ token: Int) -> Bool {
        token == generation && activeIntent != nil
    }

    @discardableResult
    mutating func finish(_ token: Int) -> Bool {
        guard isCurrent(token) else { return false }
        activeIntent = nil
        return true
    }

    mutating func cancel() {
        generation += 1
        activeIntent = nil
    }
}

protocol ConnectionPathMonitoring: AnyObject {
    var updateHandler: ((ConnectionPathKind) -> Void)? { get set }
    func start()
    func cancel()
}

final class SystemConnectionPathMonitor: ConnectionPathMonitoring {
    var updateHandler: ((ConnectionPathKind) -> Void)?

    private var monitor: NWPathMonitor?
    private let queue = DispatchQueue(label: "ai.breakthroughcoaching.clem.connection-path")

    func start() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            self?.updateHandler?(Self.kind(for: path))
        }
        self.monitor = monitor
        monitor.start(queue: queue)
    }

    func cancel() {
        monitor?.cancel()
        monitor = nil
    }

    private static func kind(for path: NWPath) -> ConnectionPathKind {
        guard path.status == .satisfied else { return .unavailable }
        if path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet) {
            return .wifi
        }
        if path.usesInterfaceType(.cellular) { return .cellular }
        return .other
    }
}

/// Converts iOS path changes into one serialized main-thread signal.
///
/// A loaded WKWebView does not navigate when Wi-Fi disappears, and its cached
/// shell can remain perfectly renderable while every same-origin API request
/// points at a dead RFC1918 address. Waiting for a web request to time out is
/// therefore not a connection strategy. This coordinator makes the OS path
/// transition itself the signal to run Clem's pinned LAN/relay probe ladder.
final class ConnectionCoordinator: ObservableObject {
    private let monitor: ConnectionPathMonitoring
    private var started = false
    private var lastKind: ConnectionPathKind?
    private var handler: ((ConnectionPathUpdate) -> Void)?

    @MainActor private(set) var currentKind: ConnectionPathKind?

    init(monitor: ConnectionPathMonitoring = SystemConnectionPathMonitor()) {
        self.monitor = monitor
    }

    @MainActor
    func start(_ handler: @escaping (ConnectionPathUpdate) -> Void) {
        guard !started else { return }
        started = true
        self.handler = handler
        monitor.updateHandler = { [weak self] kind in
            DispatchQueue.main.async { [weak self] in
                self?.accept(kind)
            }
        }
        monitor.start()
    }

    @MainActor
    func stop() {
        guard started else { return }
        started = false
        handler = nil
        monitor.updateHandler = nil
        monitor.cancel()
        lastKind = nil
        currentKind = nil
    }

    @MainActor
    private func accept(_ kind: ConnectionPathKind) {
        guard started, kind != lastKind else { return }
        let update = ConnectionPathUpdate(kind: kind, isInitial: lastKind == nil)
        lastKind = kind
        currentKind = kind
        handler?(update)
    }
}
