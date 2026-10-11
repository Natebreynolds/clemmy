import Foundation

/// Widget links select a screen. They never carry text, credentials, or an
/// instruction to start capture. The foreground page still requires a tap.
enum WidgetNavigationRoute {
    static func path(for url: URL) -> String? {
        guard url.absoluteString.utf8.count <= 512,
              let route = URLComponents(url: url, resolvingAgainstBaseURL: false),
              route.scheme == "clem", route.user == nil, route.password == nil,
              route.port == nil, route.fragment == nil, route.percentEncodedPath.isEmpty else { return nil }
        var target = URLComponents()
        target.path = "/m/"
        switch route.host {
        case "voice", "dictate":
            guard route.query == nil else { return nil }
            target.queryItems = [URLQueryItem(name: "tab", value: "chats"), URLQueryItem(name: "compose", value: route.host)]
        case "space":
            if route.query == nil {
                target.queryItems = [URLQueryItem(name: "tab", value: "spaces")]
                break
            }
            guard let query = route.queryItems, query.count == 1, query[0].name == "id",
                  let slug = query[0].value, ClemWidgetSpace.validSlug(slug) else { return nil }
            target.queryItems = [URLQueryItem(name: "tab", value: "spaces"), URLQueryItem(name: "workspace", value: slug)]
        default: return nil
        }
        return target.string
    }
}

struct PendingWidgetNavigation: Codable, Equatable {
    let id: UUID
    let url: URL
    let pairingFingerprint: String
    let tappedAt: Date

    var path: String? {
        guard let path = WidgetNavigationRoute.path(for: url), var target = URLComponents(string: path) else { return nil }
        target.queryItems = (target.queryItems ?? []) + [URLQueryItem(name: "widgetNavigation", value: id.uuidString)]
        return target.string
    }
}

final class PendingWidgetNavigationRepository {
    static let shared = PendingWidgetNavigationRepository(storage: UserDefaultsPendingPushNavigationDataStore(key: "clem.widget.pending-navigation.v1"))
    private let storage: PendingPushNavigationDataStore
    private let now: () -> Date
    private let lock = NSLock()

    init(storage: PendingPushNavigationDataStore, now: @escaping () -> Date = Date.init) {
        self.storage = storage
        self.now = now
    }

    @discardableResult
    func park(url: URL, pairingFingerprint: String) -> Bool {
        guard !pairingFingerprint.isEmpty, WidgetNavigationRoute.path(for: url) != nil else { return false }
        let pending = PendingWidgetNavigation(id: UUID(), url: url, pairingFingerprint: pairingFingerprint, tappedAt: now())
        guard let data = try? JSONEncoder().encode(pending) else { return false }
        lock.lock(); defer { lock.unlock() }
        return storage.save(data)
    }

    func current(pairingFingerprint: String) -> PendingWidgetNavigation? {
        lock.lock(); defer { lock.unlock() }
        return currentUnlocked(pairingFingerprint: pairingFingerprint)
    }

    @discardableResult
    func acknowledge(id: UUID, pairingFingerprint: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard currentUnlocked(pairingFingerprint: pairingFingerprint)?.id == id else { return false }
        storage.clear()
        return true
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        storage.clear()
    }

    private func currentUnlocked(pairingFingerprint: String) -> PendingWidgetNavigation? {
        guard let data = storage.load() else { return nil }
        guard data.count <= 2_048,
              let pending = try? JSONDecoder().decode(PendingWidgetNavigation.self, from: data),
              pending.pairingFingerprint == pairingFingerprint, pending.path != nil,
              now().timeIntervalSince(pending.tappedAt) >= -300,
              now().timeIntervalSince(pending.tappedAt) < 24 * 60 * 60 else {
            storage.clear()
            return nil
        }
        return pending
    }
}
