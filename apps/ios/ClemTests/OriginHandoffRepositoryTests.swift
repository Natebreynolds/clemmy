import Foundation
import XCTest
@testable import Clem

final class OriginHandoffRepositoryTests: XCTestCase {
    func testLegacyPayloadSurvivesRecreationWithoutBecomingV2Authority() {
        let clock = TestClock(millisecondsSince1970: 1_000_000)
        let storage = MemoryOriginHandoffDataStore()
        let repository = LegacyOriginHandoffRepository(storage: storage, now: { clock.date })
        XCTAssertTrue(repository.park(
            token: "legacy-token",
            expiresAtMs: 1_100_000,
            pairingFingerprint: "fingerprint"
        ))
        XCTAssertEqual(repository.current(pairingFingerprint: "fingerprint"), "legacy-token")
        let recreated = LegacyOriginHandoffRepository(storage: storage, now: { clock.date })
        XCTAssertEqual(recreated.current(pairingFingerprint: "fingerprint"), "legacy-token")
        XCTAssertNil(repository.current(pairingFingerprint: "other-daemon"))
    }
    func testRealKeychainRoundTripSurvivesRepositoryRecreation() throws {
        let service = "ai.breakthroughcoaching.clem.tests.\(UUID().uuidString)"
        let storage = KeychainOriginHandoffDataStore(service: service, account: "round-trip")
        storage.clear()
        defer { storage.clear() }
        let first = OriginHandoffRepository(storage: storage)
        XCTAssertTrue(first.park(
            token: "keychain-round-trip-token-with-enough-entropy",
            expiresAtMs: Date().addingTimeInterval(600).timeIntervalSince1970 * 1000,
            handoffId: "keychain-handoff",
            generation: 41,
            deviceId: "keychain-device",
            pairingFingerprint: "keychain-fingerprint"
        ))

        let recreated = OriginHandoffRepository(storage: storage)
        let lease = recreated.currentLease(pairingFingerprint: "keychain-fingerprint")
        XCTAssertEqual(lease?.handoffId, "keychain-handoff")
        XCTAssertEqual(lease?.generation, 41)
    }
    private let fingerprint = "pairing-fingerprint"
    private let deviceId = "device-123"

    func testLeaseSurvivesRepositoryRecreationAndReadsAreNonConsuming() {
        let storage = MemoryOriginHandoffDataStore()
        let clock = TestClock(millisecondsSince1970: 1_000)
        let firstRepository = repository(storage: storage, clock: clock)

        XCTAssertTrue(park(
            firstRepository,
            token: "token-a",
            handoffId: "handoff-a",
            generation: 1,
            expiresAtMs: 60_000
        ))

        let recreatedRepository = repository(storage: storage, clock: clock)
        let firstRead = recreatedRepository.currentLease(pairingFingerprint: fingerprint)
        let secondRead = recreatedRepository.currentLease(pairingFingerprint: fingerprint)

        XCTAssertEqual(firstRead, expectedLease(
            token: "token-a",
            handoffId: "handoff-a",
            generation: 1,
            expiresAtMs: 60_000
        ))
        XCTAssertEqual(secondRead, firstRead)
        XCTAssertNotNil(storage.data)
        XCTAssertEqual(storage.clearCount, 0)
    }

    func testExpiredLeaseIsRejectedAndCleared() {
        let storage = MemoryOriginHandoffDataStore()
        let clock = TestClock(millisecondsSince1970: 1_000)
        let repository = repository(storage: storage, clock: clock)

        XCTAssertTrue(park(
            repository,
            token: "token-a",
            handoffId: "handoff-a",
            generation: 1,
            expiresAtMs: 2_000
        ))
        clock.millisecondsSince1970 = 2_000

        XCTAssertNil(repository.currentLease(pairingFingerprint: fingerprint))
        XCTAssertNil(storage.data)
        XCTAssertEqual(storage.clearCount, 1)
    }

    func testFingerprintMismatchRejectsAndClearsLease() {
        let storage = MemoryOriginHandoffDataStore()
        let clock = TestClock(millisecondsSince1970: 1_000)
        let repository = repository(storage: storage, clock: clock)

        XCTAssertTrue(park(
            repository,
            token: "token-a",
            handoffId: "handoff-a",
            generation: 1,
            expiresAtMs: 60_000
        ))

        XCTAssertNil(repository.currentLease(pairingFingerprint: "different-pairing"))
        XCTAssertNil(storage.data)
        XCTAssertEqual(storage.clearCount, 1)
    }

    func testStaleGenerationCannotReplaceNewerLease() {
        let storage = MemoryOriginHandoffDataStore()
        let clock = TestClock(millisecondsSince1970: 1_000)
        let repository = repository(storage: storage, clock: clock)

        XCTAssertTrue(park(
            repository,
            token: "token-b",
            handoffId: "handoff-b",
            generation: 2,
            expiresAtMs: 60_000
        ))
        XCTAssertFalse(park(
            repository,
            token: "token-a",
            handoffId: "handoff-a",
            generation: 1,
            expiresAtMs: 60_000
        ))

        XCTAssertEqual(
            repository.currentLease(pairingFingerprint: fingerprint),
            expectedLease(
                token: "token-b",
                handoffId: "handoff-b",
                generation: 2,
                expiresAtMs: 60_000
            )
        )
        XCTAssertEqual(storage.saveCount, 1)
    }

    func testAcknowledgementRequiresExactHandoffGenerationAndFingerprint() {
        let storage = MemoryOriginHandoffDataStore()
        let clock = TestClock(millisecondsSince1970: 1_000)
        let repository = repository(storage: storage, clock: clock)

        XCTAssertTrue(park(
            repository,
            token: "token-a",
            handoffId: "handoff-a",
            generation: 7,
            expiresAtMs: 60_000
        ))

        XCTAssertFalse(repository.acknowledge(
            handoffId: "wrong-handoff",
            generation: 7,
            pairingFingerprint: fingerprint
        ))
        XCTAssertFalse(repository.acknowledge(
            handoffId: "handoff-a",
            generation: 8,
            pairingFingerprint: fingerprint
        ))
        XCTAssertFalse(repository.acknowledge(
            handoffId: "handoff-a",
            generation: 7,
            pairingFingerprint: "different-pairing"
        ))
        XCTAssertNotNil(repository.currentLease(pairingFingerprint: fingerprint))

        XCTAssertTrue(repository.acknowledge(
            handoffId: "handoff-a",
            generation: 7,
            pairingFingerprint: fingerprint
        ))
        XCTAssertNil(storage.data)
        XCTAssertNil(repository.currentLease(pairingFingerprint: fingerprint))
    }

    func testLateAcknowledgementForADoesNotDeleteNewerB() {
        let storage = MemoryOriginHandoffDataStore()
        let clock = TestClock(millisecondsSince1970: 1_000)
        let repository = repository(storage: storage, clock: clock)

        XCTAssertTrue(park(
            repository,
            token: "token-a",
            handoffId: "handoff-a",
            generation: 1,
            expiresAtMs: 60_000
        ))
        XCTAssertTrue(park(
            repository,
            token: "token-b",
            handoffId: "handoff-b",
            generation: 2,
            expiresAtMs: 60_000
        ))

        XCTAssertFalse(repository.acknowledge(
            handoffId: "handoff-a",
            generation: 1,
            pairingFingerprint: fingerprint
        ))
        XCTAssertEqual(
            repository.currentLease(pairingFingerprint: fingerprint),
            expectedLease(
                token: "token-b",
                handoffId: "handoff-b",
                generation: 2,
                expiresAtMs: 60_000
            )
        )

        XCTAssertTrue(repository.acknowledge(
            handoffId: "handoff-b",
            generation: 2,
            pairingFingerprint: fingerprint
        ))
        XCTAssertNil(storage.data)
    }

    private func repository(
        storage: MemoryOriginHandoffDataStore,
        clock: TestClock
    ) -> OriginHandoffRepository {
        OriginHandoffRepository(storage: storage, now: { clock.date })
    }

    @discardableResult
    private func park(
        _ repository: OriginHandoffRepository,
        token: String,
        handoffId: String,
        generation: Int,
        expiresAtMs: Double
    ) -> Bool {
        repository.park(
            token: token,
            expiresAtMs: expiresAtMs,
            handoffId: handoffId,
            generation: generation,
            deviceId: deviceId,
            pairingFingerprint: fingerprint
        )
    }

    private func expectedLease(
        token: String,
        handoffId: String,
        generation: Int,
        expiresAtMs: Double
    ) -> OriginHandoffLease {
        OriginHandoffLease(
            version: 2,
            token: token,
            expiresAtMs: expiresAtMs,
            handoffId: handoffId,
            generation: generation,
            deviceId: deviceId,
            pairingFingerprint: fingerprint
        )
    }
}

private final class MemoryOriginHandoffDataStore: OriginHandoffDataStore {
    var data: Data?
    private(set) var saveCount = 0
    private(set) var clearCount = 0

    func load() -> Data? {
        data
    }

    @discardableResult
    func save(_ data: Data) -> Bool {
        saveCount += 1
        self.data = data
        return true
    }

    func clear() {
        clearCount += 1
        data = nil
    }
}

private final class TestClock {
    var millisecondsSince1970: Double

    init(millisecondsSince1970: Double) {
        self.millisecondsSince1970 = millisecondsSince1970
    }

    var date: Date {
        Date(timeIntervalSince1970: millisecondsSince1970 / 1_000)
    }
}
