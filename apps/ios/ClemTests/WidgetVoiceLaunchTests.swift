import Foundation
import XCTest
@testable import Clem

final class WidgetVoiceLaunchTests: XCTestCase {
    func testOnlyExactFreshNativeLaunchCanBeConsumedOnce() {
        let storage = VoiceLaunchMemoryStorage()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let receipt = PendingWidgetVoiceLaunchRepository(storage: storage, now: { now })
        let id = UUID()
        XCTAssertFalse(receipt.consume(id: id, pairingFingerprint: "fixture-pin"), "a plain route grants no audio")
        XCTAssertTrue(receipt.park(pairingFingerprint: "fixture-pin", navigationID: id))
        XCTAssertFalse(receipt.consume(id: UUID(), pairingFingerprint: "fixture-pin"))
        XCTAssertFalse(receipt.consume(id: id, pairingFingerprint: "other-pin"))
        XCTAssertTrue(receipt.consume(id: id, pairingFingerprint: "fixture-pin"))
        let restored = PendingWidgetVoiceLaunchRepository(storage: storage, now: { now })
        XCTAssertFalse(restored.consume(id: id, pairingFingerprint: "fixture-pin"))
        XCTAssertFalse(restored.park(pairingFingerprint: "fixture-pin", navigationID: id))
    }
    func testFailedPersistenceAndExpiredLaunchNeverGrantAudio() {
        let storage = VoiceLaunchMemoryStorage()
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        let receipt = PendingWidgetVoiceLaunchRepository(storage: storage, now: { now })
        let id = UUID()
        XCTAssertTrue(receipt.park(pairingFingerprint: "fixture-pin", navigationID: id))
        storage.failSave = true
        XCTAssertFalse(receipt.consume(id: id, pairingFingerprint: "fixture-pin"))
        storage.failSave = false
        now = now.addingTimeInterval(300)
        XCTAssertFalse(receipt.consume(id: id, pairingFingerprint: "fixture-pin"))
    }
}

private final class VoiceLaunchMemoryStorage: PendingPushNavigationDataStore {
    var data: Data?
    var failSave = false
    func load() -> Data? { data }
    func save(_ data: Data) -> Bool { if failSave { return false }; self.data = data; return true }
    func clear() { data = nil }
}
