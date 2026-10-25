import Foundation

/// App-private authority for one explicit widget Run press. A navigation URL
/// alone never creates this record, and a consumed press is never retried.
private struct PendingWidgetWorkflowLaunch: Codable {
    enum Phase: String, Codable { case pending, consumed }
    let version: Int
    let navigationID: UUID
    let slug: String
    let pairingFingerprint: String
    let tappedAt: Date
    var phase: Phase
}

/// A separate app-private Keychain item, never an App Group or credential
/// account. Reuse the synchronous, status-checked update/add implementation;
/// its WhenUnlockedThisDeviceOnly protection matches foreground-only claims.
final class KeychainWidgetWorkflowLaunchDataStore: PendingPushNavigationDataStore {
    private let keychain: KeychainOriginHandoffDataStore

    init(account: String = "pending") {
        keychain = KeychainOriginHandoffDataStore(
            service: "ai.breakthroughcoaching.clem.widget-workflow-launch", account: account)
    }

    func load() -> Data? { keychain.load() }

    @discardableResult
    func save(_ data: Data) -> Bool { keychain.save(data) }

    func clear() { keychain.clear() }
}

final class PendingWidgetWorkflowLaunchRepository {
    static let shared = PendingWidgetWorkflowLaunchRepository(
        storage: KeychainWidgetWorkflowLaunchDataStore())
    private let storage: PendingPushNavigationDataStore
    private let now: () -> Date
    private let pinnedSlugs: () -> [String]
    private let lock = NSLock()

    init(storage: PendingPushNavigationDataStore, now: @escaping () -> Date = Date.init,
         pinnedSlugs: @escaping () -> [String] = { ClemWidgetWorkflowStore.shared.load().map(\.slug) }) {
        self.storage = storage
        self.now = now
        self.pinnedSlugs = pinnedSlugs
    }

    @discardableResult
    func park(slug: String, pairingFingerprint: String, navigationID: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard validTarget(slug: slug, pairingFingerprint: pairingFingerprint),
              load()?.navigationID != navigationID else { return false }
        let pending = PendingWidgetWorkflowLaunch(version: 1, navigationID: navigationID, slug: slug,
            pairingFingerprint: pairingFingerprint, tappedAt: now(), phase: .pending)
        return save(pending)
    }

    /// The trusted foreground bridge calls this before issuing the workflow
    /// request. Persisting consumption first makes a lost response non-replayable.
    @discardableResult
    func consume(id: UUID, slug: String, pairingFingerprint: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard validTarget(slug: slug, pairingFingerprint: pairingFingerprint),
              var pending = load(), pending.phase == .pending,
              pending.navigationID == id, pending.slug == slug,
              pending.pairingFingerprint == pairingFingerprint else { return false }
        let age = now().timeIntervalSince(pending.tappedAt)
        guard age >= 0, age < 5 * 60 else { return false }
        pending.phase = .consumed
        return save(pending)
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        storage.clear()
    }

    private func validTarget(slug: String, pairingFingerprint: String) -> Bool {
        ClemWidgetWorkflow.validSlug(slug) && pinnedSlugs().contains(slug)
            && !pairingFingerprint.isEmpty && pairingFingerprint.utf8.count <= 256
            && pairingFingerprint == pairingFingerprint.trimmingCharacters(in: .whitespacesAndNewlines)
            && !pairingFingerprint.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }

    private func load() -> PendingWidgetWorkflowLaunch? {
        guard let data = storage.load(), data.count <= 4096,
              let pending = try? JSONDecoder().decode(PendingWidgetWorkflowLaunch.self, from: data),
              pending.version == 1 else { return nil }
        return pending
    }

    private func save(_ pending: PendingWidgetWorkflowLaunch) -> Bool {
        guard let data = try? JSONEncoder().encode(pending), data.count <= 4096 else { return false }
        return storage.save(data)
    }
}
