import Foundation
import XCTest
@testable import Clem

final class WidgetWorkflowLaunchTests: XCTestCase {
    func testKeychainRoundTripPersistsConsumptionAcrossRepositoryRecreation() throws {
        // Only this unique synthetic account is read or deleted. Never use
        // the production launch account or another native credential store.
        let account = "fixture-\(UUID().uuidString)"
        let storage = KeychainWidgetWorkflowLaunchDataStore(account: account)
        defer { storage.clear() }
        XCTAssertNil(storage.load())
        let id = UUID()
        let first = PendingWidgetWorkflowLaunchRepository(storage: storage, pinnedSlugs: { ["fixture-flow"] })
        XCTAssertTrue(first.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id))
        let pending = try XCTUnwrap(storage.load())
        let restoredStorage = KeychainWidgetWorkflowLaunchDataStore(account: account)
        XCTAssertEqual(restoredStorage.load(), pending)
        let restored = PendingWidgetWorkflowLaunchRepository(storage: restoredStorage, pinnedSlugs: { ["fixture-flow"] })
        XCTAssertTrue(restored.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
        XCTAssertNotEqual(try XCTUnwrap(restoredStorage.load()), pending, "Consumption must update the Keychain item")
        let reopened = PendingWidgetWorkflowLaunchRepository(
            storage: KeychainWidgetWorkflowLaunchDataStore(account: account), pinnedSlugs: { ["fixture-flow"] })
        XCTAssertFalse(reopened.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
        XCTAssertFalse(reopened.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id))
        reopened.clear()
        XCTAssertNil(restoredStorage.load())
    }

    func testExactPinnedLaunchSurvivesColdStartAndConsumesOnce() {
        let storage = WorkflowLaunchMemoryStore()
        let id = UUID()
        let first = repository(storage)
        XCTAssertTrue(first.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id))
        let restored = repository(storage)
        XCTAssertTrue(restored.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
        XCTAssertFalse(restored.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
        XCTAssertFalse(repository(storage).consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
        XCTAssertFalse(repository(storage).park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id),
                       "The consumed navigation ID cannot be rearmed")
    }

    func testWrongClaimDoesNotConsumeTheExactPendingLaunch() {
        let store = repository(WorkflowLaunchMemoryStore())
        let id = UUID()
        XCTAssertTrue(store.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id))
        XCTAssertFalse(store.consume(id: UUID(), slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
        XCTAssertFalse(store.consume(id: id, slug: "other-flow", pairingFingerprint: "fixture-pin"))
        XCTAssertFalse(store.consume(id: id, slug: "fixture-flow", pairingFingerprint: "other-pin"))
        XCTAssertTrue(store.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
    }

    func testOnlyLatestExplicitLaunchCanBeConsumed() {
        let store = repository(WorkflowLaunchMemoryStore())
        let first = UUID(), latest = UUID()
        XCTAssertTrue(store.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: first))
        XCTAssertTrue(store.park(slug: "other-flow", pairingFingerprint: "fixture-pin", navigationID: latest))
        XCTAssertFalse(store.consume(id: first, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
        XCTAssertTrue(store.consume(id: latest, slug: "other-flow", pairingFingerprint: "fixture-pin"))
    }

    func testDuplicateParkCannotExtendFiveMinuteExpiry() {
        let storage = WorkflowLaunchMemoryStore()
        var now = Date(timeIntervalSince1970: 2_000_000)
        let store = repository(storage, now: { now })
        let id = UUID()
        XCTAssertTrue(store.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id))
        now = now.addingTimeInterval(299)
        XCTAssertFalse(store.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id))
        now = now.addingTimeInterval(1)
        XCTAssertFalse(store.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
    }

    func testFutureTimestampAndRemovedPinRefuseLaunch() {
        let storage = WorkflowLaunchMemoryStore()
        var now = Date(timeIntervalSince1970: 2_000_000)
        var pins = ["fixture-flow"]
        let store = PendingWidgetWorkflowLaunchRepository(storage: storage, now: { now }, pinnedSlugs: { pins })
        let id = UUID()
        XCTAssertTrue(store.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id))
        now = now.addingTimeInterval(-1)
        XCTAssertFalse(store.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
        now = now.addingTimeInterval(2)
        pins = []
        XCTAssertFalse(store.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
    }

    func testInvalidOrUnpinnedRequestsCannotReplacePendingLaunch() {
        let store = repository(WorkflowLaunchMemoryStore())
        let id = UUID()
        XCTAssertTrue(store.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id))
        for slug in ["", "../fixture-flow", "fixture-flow/run", "not-pinned"] {
            XCTAssertFalse(store.park(slug: slug, pairingFingerprint: "fixture-pin", navigationID: UUID()), slug)
        }
        for fingerprint in ["", " fixture-pin", "fixture\npin", String(repeating: "f", count: 257)] {
            XCTAssertFalse(store.park(slug: "fixture-flow", pairingFingerprint: fingerprint, navigationID: UUID()))
        }
        XCTAssertTrue(store.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
    }

    func testConsumedMarkerMustBeSavedBeforeGrantingLaunch() {
        let storage = WorkflowLaunchMemoryStore()
        let store = repository(storage)
        let id = UUID()
        storage.acceptsWrites = false
        XCTAssertFalse(store.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id))
        storage.acceptsWrites = true
        XCTAssertTrue(store.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id))
        storage.acceptsWrites = false
        XCTAssertFalse(store.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
        storage.acceptsWrites = true
        XCTAssertTrue(store.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
    }

    func testMalformedStorageAndClearGrantNoLaunch() {
        let storage = WorkflowLaunchMemoryStore()
        let store = repository(storage)
        let id = UUID()
        for data in [Data("bad json".utf8), Data(repeating: 0, count: 4097)] {
            storage.data = data
            XCTAssertFalse(store.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
        }
        XCTAssertTrue(store.park(slug: "fixture-flow", pairingFingerprint: "fixture-pin", navigationID: id))
        store.clear()
        XCTAssertNil(storage.data)
        XCTAssertFalse(store.consume(id: id, slug: "fixture-flow", pairingFingerprint: "fixture-pin"))
    }

    private func repository(_ storage: WorkflowLaunchMemoryStore, now: @escaping () -> Date = Date.init) -> PendingWidgetWorkflowLaunchRepository {
        PendingWidgetWorkflowLaunchRepository(storage: storage, now: now, pinnedSlugs: { ["fixture-flow", "other-flow"] })
    }
}

private final class WorkflowLaunchMemoryStore: PendingPushNavigationDataStore {
    var data: Data?
    var acceptsWrites = true
    func load() -> Data? { data }
    func save(_ data: Data) -> Bool {
        guard acceptsWrites else { return false }
        self.data = data
        return true
    }
    func clear() { data = nil }
}
