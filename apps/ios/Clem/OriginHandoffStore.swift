import Foundation
import Security

struct OriginHandoffLease: Codable, Equatable {
    let version: Int
    let token: String
    let expiresAtMs: Double
    let handoffId: String
    let generation: Int
    let deviceId: String
    let pairingFingerprint: String

    func isValid(at date: Date) -> Bool {
        version == 2
            && !token.isEmpty
            && !handoffId.isEmpty
            && generation > 0
            && !deviceId.isEmpty
            && !pairingFingerprint.isEmpty
            && expiresAtMs > date.timeIntervalSince1970 * 1000
    }
}

protocol OriginHandoffDataStore {
    func load() -> Data?
    @discardableResult func save(_ data: Data) -> Bool
    func clear()
}

/// Device-only Keychain storage for the one credential that must survive an
/// origin switch and an ordinary iOS process eviction.
struct KeychainOriginHandoffDataStore: OriginHandoffDataStore {
    private let service: String
    private let account: String

    init(
        service: String = "ai.breakthroughcoaching.clem.origin-handoff",
        account: String = "active"
    ) {
        self.service = service
        self.account = account
    }

    func load() -> Data? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    @discardableResult
    func save(_ data: Data) -> Bool {
        let updates = [kSecValueData as String: data]
        let updated = SecItemUpdate(baseQuery() as CFDictionary, updates as CFDictionary)
        if updated == errSecSuccess { return true }
        guard updated == errSecItemNotFound else { return false }

        var insert = baseQuery()
        insert[kSecValueData as String] = data
        // Adoption only happens while the foreground app is unlocked. Keep
        // the seven-day bearer unavailable to background processes.
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
    }

    func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

/// Lease semantics around the Keychain bytes.
///
/// Reading a lease never consumes it. Only an explicit successful/invalid
/// adoption acknowledgement for the exact token may clear it. That makes a
/// network failure or process death between navigation and adoption retryable,
/// and prevents a late acknowledgement for token A from deleting newer token B.
final class OriginHandoffRepository {
    private let storage: OriginHandoffDataStore
    private let now: () -> Date
    private var cached: OriginHandoffLease?

    init(
        storage: OriginHandoffDataStore,
        now: @escaping () -> Date = Date.init
    ) {
        self.storage = storage
        self.now = now
        if let data = storage.load() {
            cached = try? JSONDecoder().decode(OriginHandoffLease.self, from: data)
        }
    }

    @discardableResult
    func park(
        token: String,
        expiresAtMs: Double,
        handoffId: String,
        generation: Int,
        deviceId: String,
        pairingFingerprint: String
    ) -> Bool {
        let lease = OriginHandoffLease(
            version: 2,
            token: token,
            expiresAtMs: expiresAtMs,
            handoffId: handoffId,
            generation: generation,
            deviceId: deviceId,
            pairingFingerprint: pairingFingerprint
        )
        guard lease.isValid(at: now()),
              let data = try? JSONEncoder().encode(lease) else { return false }
        if let cached, cached.pairingFingerprint == pairingFingerprint {
            if generation < cached.generation { return false }
            if generation == cached.generation {
                // Equal generations are idempotent only for the exact same
                // server-authored handoff. Two different tuples at one
                // generation indicate corruption or a split owner.
                return cached == lease
            }
        }
        guard storage.save(data) else { return false }
        cached = lease
        return true
    }

    func currentLease(pairingFingerprint: String) -> OriginHandoffLease? {
        guard let cached,
              cached.pairingFingerprint == pairingFingerprint,
              cached.isValid(at: now()) else {
            clear()
            return nil
        }
        return cached
    }

    @discardableResult
    func acknowledge(
        handoffId: String,
        generation: Int,
        pairingFingerprint: String
    ) -> Bool {
        guard cached?.handoffId == handoffId,
              cached?.generation == generation,
              cached?.pairingFingerprint == pairingFingerprint else { return false }
        clear()
        return true
    }

    func clear() {
        cached = nil
        storage.clear()
    }
}

private struct LegacyOriginHandoffLease: Codable {
    let token: String
    let expiresAtMs: Double
    let pairingFingerprint: String

    func isValid(at date: Date) -> Bool {
        !token.isEmpty
            && !pairingFingerprint.isEmpty
            && expiresAtMs > date.timeIntervalSince1970 * 1000
    }
}

/// Rolling-upgrade bridge for an older cached PWA that can only send
/// `{token, expiresAt}`. It is kept in a separate device-only Keychain slot:
/// durable enough to survive process eviction during rollback, but never
/// restamped into v2 id/generation authority.
final class LegacyOriginHandoffRepository {
    private let storage: OriginHandoffDataStore
    private let now: () -> Date
    private var cached: LegacyOriginHandoffLease?

    init(
        storage: OriginHandoffDataStore = KeychainOriginHandoffDataStore(
            service: "ai.breakthroughcoaching.clem.origin-handoff-legacy",
            account: "active"
        ),
        now: @escaping () -> Date = Date.init
    ) {
        self.storage = storage
        self.now = now
        if let data = storage.load() {
            cached = try? JSONDecoder().decode(LegacyOriginHandoffLease.self, from: data)
        }
    }

    @discardableResult
    func park(token: String, expiresAtMs: Double, pairingFingerprint: String) -> Bool {
        let lease = LegacyOriginHandoffLease(
            token: token,
            expiresAtMs: expiresAtMs,
            pairingFingerprint: pairingFingerprint
        )
        guard lease.isValid(at: now()),
              let data = try? JSONEncoder().encode(lease),
              storage.save(data) else { return false }
        cached = lease
        return true
    }

    func current(pairingFingerprint: String) -> String? {
        guard let cached,
              cached.pairingFingerprint == pairingFingerprint,
              cached.isValid(at: now()) else {
            clear()
            return nil
        }
        return cached.token
    }

    func clear() {
        cached = nil
        storage.clear()
    }
}

enum OriginHandoffStore {
    private static let repository = OriginHandoffRepository(storage: KeychainOriginHandoffDataStore())
    private static let legacyRepository = LegacyOriginHandoffRepository()

    @discardableResult
    static func park(
        token: String,
        expiresAtMs: Double,
        handoffId: String,
        generation: Int,
        deviceId: String,
        pairingFingerprint: String
    ) -> Bool {
        let stored = repository.park(
            token: token,
            expiresAtMs: expiresAtMs,
            handoffId: handoffId,
            generation: generation,
            deviceId: deviceId,
            pairingFingerprint: pairingFingerprint
        )
        if stored { legacyRepository.clear() }
        return stored
    }

    static func currentLease(pairingFingerprint: String) -> OriginHandoffLease? {
        repository.currentLease(pairingFingerprint: pairingFingerprint)
    }

    @discardableResult
    static func parkLegacy(
        token: String,
        expiresAtMs: Double,
        pairingFingerprint: String
    ) -> Bool {
        let stored = legacyRepository.park(
            token: token,
            expiresAtMs: expiresAtMs,
            pairingFingerprint: pairingFingerprint
        )
        if stored {
            // Receiving an authenticated legacy mint proves the daemon rolled
            // back. Its generation counter may restart at 1 on roll-forward,
            // so the stale v2 fence must not reject every new valid lease.
            repository.clear()
        }
        return stored
    }

    static func currentLegacyToken(pairingFingerprint: String) -> String? {
        legacyRepository.current(pairingFingerprint: pairingFingerprint)
    }

    static func acknowledge(
        handoffId: String,
        generation: Int,
        pairingFingerprint: String
    ) {
        _ = repository.acknowledge(
            handoffId: handoffId,
            generation: generation,
            pairingFingerprint: pairingFingerprint
        )
    }

    static func clear() {
        repository.clear()
        legacyRepository.clear()
    }
}
