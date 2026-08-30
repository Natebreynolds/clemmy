import XCTest
@testable import Clem

@MainActor
final class ConnectionCoordinatorTests: XCTestCase {
    func testCellularUsesOnlyRelayWhileWiFiKeepsLanFirstOrder() {
        let pairing = Pairing(
            origin: "https://relay.example.test:53028",
            fingerprint: "certificate-fingerprint",
            relayOrigin: "https://relay.example.test:53028",
            lanOrigin: "https://192.168.1.11:43117"
        )

        XCTAssertEqual(
            ConnectionRoutePolicy.candidates(for: .cellular, pairing: pairing),
            ["https://relay.example.test:53028"]
        )
        XCTAssertEqual(
            ConnectionRoutePolicy.candidates(for: .wifi, pairing: pairing),
            [
                "https://192.168.1.11:43117",
                "https://relay.example.test:53028",
            ]
        )
    }

    func testColdCellularSameRelayOriginStillPerformsFirstNavigation() {
        OriginHandoffStore.clear()
        PairingStore.clear()
        defer {
            OriginHandoffStore.clear()
            PairingStore.clear()
        }
        let relay = "https://relay.example.test:53028"
        let model = WebViewModel(pairing: Pairing(
            origin: relay,
            fingerprint: "certificate-fingerprint",
            relayOrigin: relay,
            lanOrigin: "https://192.168.1.11:43117"
        ))

        XCTAssertFalse(model.hasLoadedOnce)
        model.adoptOrigin(relay, isLan: false)

        XCTAssertEqual(model.lastRequestedURL?.absoluteString, "\(relay)/m/")
        XCTAssertFalse(model.lastRequestedURL?.host?.hasPrefix("192.168.") ?? true)
    }

    func testRollbackLegacyLeaseOutranksUnusableV2UntilANewV2IsStored() {
        OriginHandoffStore.clear()
        PairingStore.clear()
        defer {
            OriginHandoffStore.clear()
            PairingStore.clear()
        }
        let fingerprint = "rollback-certificate-fingerprint"
        let relay = "https://relay.example.test:53028"
        XCTAssertTrue(OriginHandoffStore.park(
            token: "stale-v2-keychain-token",
            expiresAtMs: Date().addingTimeInterval(600).timeIntervalSince1970 * 1000,
            handoffId: "stale-v2-handoff",
            generation: 8,
            deviceId: "rollback-device",
            pairingFingerprint: fingerprint
        ))
        XCTAssertTrue(OriginHandoffStore.parkLegacy(
            token: "rollback-legacy-token",
            expiresAtMs: Date().addingTimeInterval(600).timeIntervalSince1970 * 1000,
            pairingFingerprint: fingerprint
        ))

        let model = WebViewModel(pairing: Pairing(
            origin: relay,
            fingerprint: fingerprint,
            relayOrigin: relay,
            lanOrigin: "https://192.168.1.11:43117"
        ))
        model.loadHome()
        let rollbackQuery = URLComponents(
            url: try! XCTUnwrap(model.lastRequestedURL),
            resolvingAgainstBaseURL: false
        )?.queryItems ?? []
        XCTAssertEqual(rollbackQuery.first(where: { $0.name == "adopt" })?.value, "rollback-legacy-token")
        XCTAssertNil(rollbackQuery.first(where: { $0.name == "handoffId" }))

        XCTAssertTrue(OriginHandoffStore.park(
            token: "fresh-v2-keychain-token",
            expiresAtMs: Date().addingTimeInterval(600).timeIntervalSince1970 * 1000,
            handoffId: "fresh-v2-handoff",
            generation: 1,
            deviceId: "rollback-device",
            pairingFingerprint: fingerprint
        ))
        model.loadHome()
        let upgradedQuery = URLComponents(
            url: try! XCTUnwrap(model.lastRequestedURL),
            resolvingAgainstBaseURL: false
        )?.queryItems ?? []
        XCTAssertEqual(upgradedQuery.first(where: { $0.name == "adopt" })?.value, "fresh-v2-keychain-token")
        XCTAssertEqual(upgradedQuery.first(where: { $0.name == "handoffId" })?.value, "fresh-v2-handoff")
    }

    func testReconnectGateCoalescesSameIntentAndFencesChangedIntent() {
        var gate = ReconnectAttemptGate()
        let cellular = gate.begin(.cellular)
        XCTAssertNotNil(cellular)
        XCTAssertNil(gate.begin(.cellular), "foreground/path/fetch signals share one relay probe")
        XCTAssertTrue(gate.isCurrent(cellular!))

        let wifi = gate.begin(.wifi)
        XCTAssertNotNil(wifi, "a real path change supersedes the old intent")
        XCTAssertFalse(gate.isCurrent(cellular!))
        XCTAssertTrue(gate.isCurrent(wifi!))
        XCTAssertTrue(gate.finish(wifi!))
        XCTAssertNil(gate.activeIntent)
    }

    func testPublishesInitialPathAndOnlyRealTransitions() async {
        let monitor = FakeConnectionPathMonitor()
        let coordinator = ConnectionCoordinator(monitor: monitor)
        var updates: [ConnectionPathUpdate] = []
        let received = expectation(description: "initial path and two transitions")
        received.expectedFulfillmentCount = 3

        coordinator.start { update in
            updates.append(update)
            received.fulfill()
        }

        monitor.emit(.wifi)
        monitor.emit(.wifi)
        monitor.emit(.cellular)
        monitor.emit(.cellular)
        monitor.emit(.unavailable)

        await fulfillment(of: [received], timeout: 1)

        XCTAssertEqual(
            updates,
            [
                ConnectionPathUpdate(kind: .wifi, isInitial: true),
                ConnectionPathUpdate(kind: .cellular, isInitial: false),
                ConnectionPathUpdate(kind: .unavailable, isInitial: false),
            ]
        )
        XCTAssertEqual(coordinator.currentKind, .unavailable)
        XCTAssertEqual(monitor.startCount, 1)
    }

    func testStartIsIdempotentUntilStopped() async {
        let monitor = FakeConnectionPathMonitor()
        let coordinator = ConnectionCoordinator(monitor: monitor)
        var firstHandlerUpdates: [ConnectionPathUpdate] = []
        var secondHandlerUpdates: [ConnectionPathUpdate] = []
        let received = expectation(description: "only the installed handler receives the update")

        coordinator.start { update in
            firstHandlerUpdates.append(update)
            received.fulfill()
        }
        coordinator.start { update in
            secondHandlerUpdates.append(update)
        }
        monitor.emit(.wifi)

        await fulfillment(of: [received], timeout: 1)

        XCTAssertEqual(firstHandlerUpdates, [ConnectionPathUpdate(kind: .wifi, isInitial: true)])
        XCTAssertTrue(secondHandlerUpdates.isEmpty)
        XCTAssertEqual(monitor.startCount, 1)
    }

    func testStopThenRestartResetsInitialStateAndIgnoresStoppedUpdates() async {
        let monitor = FakeConnectionPathMonitor()
        let coordinator = ConnectionCoordinator(monitor: monitor)
        var firstRun: [ConnectionPathUpdate] = []
        let firstReceived = expectation(description: "first run")

        coordinator.start { update in
            firstRun.append(update)
            firstReceived.fulfill()
        }
        monitor.emit(.wifi)
        await fulfillment(of: [firstReceived], timeout: 1)

        coordinator.stop()
        monitor.emit(.cellular)
        await Task.yield()

        var secondRun: [ConnectionPathUpdate] = []
        let secondReceived = expectation(description: "second run")
        coordinator.start { update in
            secondRun.append(update)
            secondReceived.fulfill()
        }
        monitor.emit(.wifi)
        await fulfillment(of: [secondReceived], timeout: 1)

        XCTAssertEqual(firstRun, [ConnectionPathUpdate(kind: .wifi, isInitial: true)])
        XCTAssertEqual(secondRun, [ConnectionPathUpdate(kind: .wifi, isInitial: true)])
        XCTAssertEqual(coordinator.currentKind, .wifi)
        XCTAssertEqual(monitor.startCount, 2)
        XCTAssertEqual(monitor.cancelCount, 1)
    }
}

private final class FakeConnectionPathMonitor: ConnectionPathMonitoring {
    var updateHandler: ((ConnectionPathKind) -> Void)?
    private(set) var startCount = 0
    private(set) var cancelCount = 0

    func start() {
        startCount += 1
    }

    func cancel() {
        cancelCount += 1
    }

    func emit(_ kind: ConnectionPathKind) {
        updateHandler?(kind)
    }
}
