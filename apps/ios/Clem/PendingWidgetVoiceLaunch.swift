import Foundation

/// A URL selects a conversation surface; only an authenticated AppIntent
/// creates permission for that surface to start its microphone once.
private struct PendingWidgetVoiceLaunch: Codable {
    let version: Int
    let navigationID: UUID
    let pairingFingerprint: String
    let tappedAt: Date
    var consumed: Bool
}

private final class KeychainVoiceLaunchDataStore: PendingPushNavigationDataStore {
    private let keychain = KeychainOriginHandoffDataStore(
        service: "ai.breakthroughcoaching.clem.widget-voice-launch", account: "pending")
    func load() -> Data? { keychain.load() }
    func save(_ data: Data) -> Bool { keychain.save(data) }
    func clear() { keychain.clear() }
}

final class PendingWidgetVoiceLaunchRepository {
    static let shared = PendingWidgetVoiceLaunchRepository(storage: KeychainVoiceLaunchDataStore())
    private let storage: PendingPushNavigationDataStore
    private let now: () -> Date
    private let lock = NSLock()
    init(storage: PendingPushNavigationDataStore, now: @escaping () -> Date = Date.init) {
        self.storage = storage; self.now = now
    }
    @discardableResult func park(pairingFingerprint: String, navigationID: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !pairingFingerprint.isEmpty, pairingFingerprint.utf8.count <= 256,
              load()?.navigationID != navigationID else { return false }
        return save(.init(version: 1, navigationID: navigationID,
            pairingFingerprint: pairingFingerprint, tappedAt: now(), consumed: false))
    }
    /// Saving the consumed state must succeed before the page gets authority.
    func consume(id: UUID, pairingFingerprint: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard var value = load(), value.version == 1, !value.consumed,
              value.navigationID == id, value.pairingFingerprint == pairingFingerprint else { return false }
        let age = now().timeIntervalSince(value.tappedAt)
        guard age >= 0, age < 300 else { return false }
        value.consumed = true
        return save(value)
    }
    func clear() { lock.lock(); defer { lock.unlock() }; storage.clear() }
    private func load() -> PendingWidgetVoiceLaunch? {
        guard let data = storage.load(), data.count <= 4096 else { return nil }
        return try? JSONDecoder().decode(PendingWidgetVoiceLaunch.self, from: data)
    }
    private func save(_ value: PendingWidgetVoiceLaunch) -> Bool {
        guard let data = try? JSONEncoder().encode(value), data.count <= 4096 else { return false }
        return storage.save(data)
    }
}
