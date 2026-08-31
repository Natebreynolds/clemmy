import Foundation

/// One explicit notification tap that still needs to reach the paired web app.
///
/// This contains only an address into the authenticated Inbox. Notification
/// copy and response data remain on the Mac and are fetched after unlock.
struct PendingPushNavigation: Codable, Equatable {
    static let currentVersion = 1

    let version: Int
    let notificationID: String
    let path: String
    let pairingFingerprint: String
    let tappedAt: Date

    init(
        notificationID: String,
        path: String,
        pairingFingerprint: String,
        tappedAt: Date
    ) {
        version = Self.currentVersion
        self.notificationID = notificationID
        self.path = path
        self.pairingFingerprint = pairingFingerprint
        self.tappedAt = tappedAt
    }
}

/// The APNs provider owns this deliberately tiny route contract. Restricting a
/// push to the Inbox prevents a payload from invoking pairing/adoption routes
/// or steering the pinned view to another host.
enum PendingPushNavigationRoute {
    private static let maximumPathBytes = 2_048
    private static let maximumNotificationIDBytes = 512

    static func parse(_ rawPath: String) -> (path: String, notificationID: String)? {
        guard !rawPath.isEmpty,
              rawPath.utf8.count <= maximumPathBytes,
              let components = URLComponents(string: rawPath),
              components.scheme == nil,
              components.user == nil,
              components.password == nil,
              components.host == nil,
              components.port == nil,
              components.fragment == nil,
              components.percentEncodedPath == "/m/",
              let items = components.queryItems,
              items.count == 2 else {
            return nil
        }

        let tabs = items.filter { $0.name == "tab" }
        let notifications = items.filter { $0.name == "notification" }
        guard tabs.count == 1,
              tabs[0].value == "inbox",
              notifications.count == 1,
              let notificationID = notifications[0].value,
              !notificationID.isEmpty,
              notificationID == notificationID.trimmingCharacters(in: .whitespacesAndNewlines),
              notificationID.utf8.count <= maximumNotificationIDBytes,
              !notificationID.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              items.allSatisfy({ $0.name == "tab" || $0.name == "notification" }) else {
            return nil
        }

        // Persist one canonical representation. Besides making comparisons
        // deterministic, URLQueryItem percent-encodes arbitrary durable IDs.
        var canonical = URLComponents()
        canonical.path = "/m/"
        canonical.queryItems = [
            URLQueryItem(name: "tab", value: "inbox"),
            URLQueryItem(name: "notification", value: notificationID),
        ]
        guard let path = canonical.string else { return nil }
        return (path, notificationID)
    }
}

protocol PendingPushNavigationDataStore: AnyObject {
    func load() -> Data?
    @discardableResult func save(_ data: Data) -> Bool
    func clear()
}

/// UserDefaults is intentional here. The envelope is a non-secret local route,
/// should disappear with an uninstall, and needs one atomic replace rather than
/// credential-style Keychain semantics.
final class UserDefaultsPendingPushNavigationDataStore: PendingPushNavigationDataStore {
    private let defaults: UserDefaults
    private let key: String

    init(
        defaults: UserDefaults = .standard,
        key: String = "clem.apns.pending-navigation.v1"
    ) {
        self.defaults = defaults
        self.key = key
    }

    func load() -> Data? {
        defaults.data(forKey: key)
    }

    @discardableResult
    func save(_ data: Data) -> Bool {
        defaults.set(data, forKey: key)
        return true
    }

    func clear() {
        defaults.removeObject(forKey: key)
    }
}

/// Thread-safe, latest-intent-wins repository. The Inbox itself is the durable
/// aggregate of every notification; replaying a FIFO of old taps would only
/// bounce the user through several screens before reaching their latest choice.
final class PendingPushNavigationRepository {
    static let defaultMaximumAge: TimeInterval = 7 * 24 * 60 * 60

    private let storage: PendingPushNavigationDataStore
    private let now: () -> Date
    private let maximumAge: TimeInterval
    private let lock = NSLock()

    init(
        storage: PendingPushNavigationDataStore,
        maximumAge: TimeInterval = PendingPushNavigationRepository.defaultMaximumAge,
        now: @escaping () -> Date = Date.init
    ) {
        self.storage = storage
        self.maximumAge = maximumAge
        self.now = now
    }

    @discardableResult
    func park(path rawPath: String, pairingFingerprint: String) -> Bool {
        guard !pairingFingerprint.isEmpty,
              let route = PendingPushNavigationRoute.parse(rawPath) else {
            return false
        }
        let pending = PendingPushNavigation(
            notificationID: route.notificationID,
            path: route.path,
            pairingFingerprint: pairingFingerprint,
            tappedAt: now()
        )
        guard let data = try? JSONEncoder().encode(pending) else { return false }

        lock.lock()
        defer { lock.unlock() }
        return storage.save(data)
    }

    func current(pairingFingerprint: String) -> PendingPushNavigation? {
        lock.lock()
        defer { lock.unlock() }
        return currentUnlocked(pairingFingerprint: pairingFingerprint)
    }

    /// Clears only the exact current intent. A late receipt for notification A
    /// can never consume a newer tap for notification B.
    @discardableResult
    func acknowledge(notificationID: String, pairingFingerprint: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let pending = currentUnlocked(pairingFingerprint: pairingFingerprint),
              pending.notificationID == notificationID else {
            return false
        }
        storage.clear()
        return true
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        storage.clear()
    }

    private func currentUnlocked(pairingFingerprint: String) -> PendingPushNavigation? {
        guard let data = storage.load() else { return nil }
        guard let pending = try? JSONDecoder().decode(PendingPushNavigation.self, from: data),
              pending.version == PendingPushNavigation.currentVersion,
              pending.pairingFingerprint == pairingFingerprint,
              let route = PendingPushNavigationRoute.parse(pending.path),
              route.notificationID == pending.notificationID else {
            storage.clear()
            return nil
        }

        let age = now().timeIntervalSince(pending.tappedAt)
        // A large future timestamp is corrupt state, while a few minutes of
        // clock correction should not throw away the user's explicit tap.
        guard age >= -5 * 60, age < maximumAge else {
            storage.clear()
            return nil
        }
        return pending
    }
}

enum PendingPushNavigationStore {
    static let repository = PendingPushNavigationRepository(
        storage: UserDefaultsPendingPushNavigationDataStore()
    )

    @discardableResult
    static func park(path: String, pairingFingerprint: String) -> Bool {
        repository.park(path: path, pairingFingerprint: pairingFingerprint)
    }

    static func current(pairingFingerprint: String) -> PendingPushNavigation? {
        repository.current(pairingFingerprint: pairingFingerprint)
    }

    @discardableResult
    static func acknowledge(notificationID: String, pairingFingerprint: String) -> Bool {
        repository.acknowledge(
            notificationID: notificationID,
            pairingFingerprint: pairingFingerprint
        )
    }

    static func clear() {
        repository.clear()
    }
}
