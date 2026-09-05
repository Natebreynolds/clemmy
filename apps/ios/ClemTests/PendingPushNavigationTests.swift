import Foundation
import XCTest
@testable import Clem

final class PendingPushNavigationRepositoryTests: XCTestCase {
    private let fingerprint = "pairing-fingerprint"

    func testStrictRouteParserAcceptsOnlyOneCanonicalInboxNotificationRoute() throws {
        let parsed = try XCTUnwrap(PendingPushNavigationRoute.parse(
            "/m/?notification=notification%3A42&tab=inbox"
        ))

        XCTAssertEqual(parsed.notificationID, "notification:42")
        XCTAssertEqual(parsed.path, "/m/?tab=inbox&notification=notification:42")

        for rejected in [
            "https://evil.example/m/?tab=inbox&notification=n-1",
            "//evil.example/m/?tab=inbox&notification=n-1",
            "/m?tab=inbox&notification=n-1",
            "/m/../admin?tab=inbox&notification=n-1",
            "/m/?tab=home&notification=n-1",
            "/m/?tab=inbox&notification=",
            "/m/?tab=inbox&notification=n-1&notification=n-2",
            "/m/?tab=inbox&notification=n-1&adopt=credential",
            "/m/?tab=inbox&notification=%0A",
        ] {
            XCTAssertNil(PendingPushNavigationRoute.parse(rejected), rejected)
        }
    }

    func testUserDefaultsEnvelopeSurvivesRepositoryRecreation() throws {
        let suite = "ai.breakthroughcoaching.clem.tests.pending.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        let clock = PendingNavigationTestClock(date: Date(timeIntervalSince1970: 1_000))

        let first = PendingPushNavigationRepository(
            storage: UserDefaultsPendingPushNavigationDataStore(defaults: defaults),
            now: { clock.date }
        )
        XCTAssertTrue(first.park(
            path: "/m/?tab=inbox&notification=n-1",
            pairingFingerprint: fingerprint
        ))

        let recreated = PendingPushNavigationRepository(
            storage: UserDefaultsPendingPushNavigationDataStore(
                defaults: try XCTUnwrap(UserDefaults(suiteName: suite))
            ),
            now: { clock.date }
        )
        XCTAssertEqual(
            recreated.current(pairingFingerprint: fingerprint)?.notificationID,
            "n-1"
        )
    }

    func testLatestTapWinsAndLateAcknowledgementCannotClearIt() {
        let storage = MemoryPendingPushNavigationDataStore()
        let clock = PendingNavigationTestClock(date: Date(timeIntervalSince1970: 1_000))
        let repository = makeRepository(storage: storage, clock: clock)

        XCTAssertTrue(repository.park(
            path: "/m/?tab=inbox&notification=notification-a",
            pairingFingerprint: fingerprint
        ))
        clock.date = clock.date.addingTimeInterval(1)
        XCTAssertTrue(repository.park(
            path: "/m/?tab=inbox&notification=notification-b",
            pairingFingerprint: fingerprint
        ))

        XCTAssertFalse(repository.acknowledge(
            notificationID: "notification-a",
            pairingFingerprint: fingerprint
        ))
        XCTAssertEqual(
            repository.current(pairingFingerprint: fingerprint)?.notificationID,
            "notification-b"
        )
        XCTAssertTrue(repository.acknowledge(
            notificationID: "notification-b",
            pairingFingerprint: fingerprint
        ))
        XCTAssertNil(storage.data)
    }

    func testPairingMismatchAndExpiryFailClosedAndClearState() {
        let storage = MemoryPendingPushNavigationDataStore()
        let clock = PendingNavigationTestClock(date: Date(timeIntervalSince1970: 1_000))
        let repository = makeRepository(storage: storage, clock: clock, maximumAge: 60)

        XCTAssertTrue(repository.park(
            path: "/m/?tab=inbox&notification=n-1",
            pairingFingerprint: fingerprint
        ))
        XCTAssertNil(repository.current(pairingFingerprint: "another-mac"))
        XCTAssertNil(storage.data)

        XCTAssertTrue(repository.park(
            path: "/m/?tab=inbox&notification=n-2",
            pairingFingerprint: fingerprint
        ))
        clock.date = clock.date.addingTimeInterval(60)
        XCTAssertNil(repository.current(pairingFingerprint: fingerprint))
        XCTAssertNil(storage.data)
    }

    func testCorruptPersistedEnvelopeIsCleared() {
        let storage = MemoryPendingPushNavigationDataStore()
        storage.data = Data("not json".utf8)
        let repository = PendingPushNavigationRepository(storage: storage)

        XCTAssertNil(repository.current(pairingFingerprint: fingerprint))
        XCTAssertNil(storage.data)
        XCTAssertEqual(storage.clearCount, 1)
    }

    private func makeRepository(
        storage: MemoryPendingPushNavigationDataStore,
        clock: PendingNavigationTestClock,
        maximumAge: TimeInterval = PendingPushNavigationRepository.defaultMaximumAge
    ) -> PendingPushNavigationRepository {
        PendingPushNavigationRepository(
            storage: storage,
            maximumAge: maximumAge,
            now: { clock.date }
        )
    }
}

@MainActor
final class PendingPushNavigationModelTests: XCTestCase {
    private let origin = "https://192.168.1.11:43117"
    private let fingerprint = "certificate-fingerprint"

    func testColdPageLoadWaitsForAuthorizationThenReplaysPersistedTap() throws {
        let storage = MemoryPendingPushNavigationDataStore()
        let repository = PendingPushNavigationRepository(storage: storage)
        XCTAssertTrue(repository.park(
            path: "/m/?tab=inbox&notification=cold-notification",
            pairingFingerprint: fingerprint
        ))
        let model = makeModel(repository: repository)
        defer { model.webView.stopLoading() }

        model.setPendingPushNavigationAllowed(false)
        model.webView(model.webView, didFinish: nil)
        XCTAssertNil(model.lastRequestedURL, "a page finishing behind the lock must not drain the tap")

        model.setConnectionRouteReady(true)
        XCTAssertNil(model.lastRequestedURL, "a selected route must still wait for biometric authorization")
        model.setPendingPushNavigationAllowed(true)
        let target = try XCTUnwrap(model.lastRequestedURL)
        XCTAssertEqual(target.host, "192.168.1.11")
        XCTAssertEqual(URLComponents(url: target, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "notification" })?.value, "cold-notification")
        XCTAssertNotNil(repository.current(pairingFingerprint: fingerprint),
                        "native navigation is not the commit point; the web receipt is")
    }

    func testNewTapSupersedesInFlightTapAndOnlyExactReceiptClears() throws {
        let storage = MemoryPendingPushNavigationDataStore()
        let repository = PendingPushNavigationRepository(storage: storage)
        XCTAssertTrue(repository.park(
            path: "/m/?tab=inbox&notification=notification-a",
            pairingFingerprint: fingerprint
        ))
        let model = makeModel(repository: repository)
        defer { model.webView.stopLoading() }
        model.setConnectionRouteReady(true)
        model.setPendingPushNavigationAllowed(true)
        model.webView(model.webView, didFinish: nil)

        XCTAssertTrue(repository.park(
            path: "/m/?tab=inbox&notification=notification-b",
            pairingFingerprint: fingerprint
        ))
        model.resumePendingPushNavigation()
        let target = try XCTUnwrap(model.lastRequestedURL)
        XCTAssertEqual(URLComponents(url: target, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "notification" })?.value, "notification-b")

        XCTAssertFalse(model.acknowledgePendingPushNavigation(notificationID: "notification-a"))
        XCTAssertEqual(repository.current(pairingFingerprint: fingerprint)?.notificationID, "notification-b")
        XCTAssertTrue(model.acknowledgePendingPushNavigation(notificationID: "notification-b"))
        XCTAssertNil(repository.current(pairingFingerprint: fingerprint))
    }

    func testOrdinaryReconnectLoadDoesNotEraseTapAndNextSuccessRetriesIt() throws {
        let storage = MemoryPendingPushNavigationDataStore()
        let repository = PendingPushNavigationRepository(storage: storage)
        XCTAssertTrue(repository.park(
            path: "/m/?tab=inbox&notification=retry-me",
            pairingFingerprint: fingerprint
        ))
        let model = makeModel(repository: repository)
        defer { model.webView.stopLoading() }
        model.setConnectionRouteReady(true)
        model.setPendingPushNavigationAllowed(true)
        model.webView(model.webView, didFinish: nil)

        let home = try XCTUnwrap(URL(string: "\(origin)/m/"))
        model.load(home)
        XCTAssertEqual(model.lastRequestedURL, home)
        XCTAssertNotNil(repository.current(pairingFingerprint: fingerprint))

        model.setConnectionRouteReady(true)
        XCTAssertEqual(URLComponents(url: try XCTUnwrap(model.lastRequestedURL), resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "notification" })?.value, "retry-me")
    }

    func testReceiptCannotClearTapWhileLockedOrWithoutAnInFlightDelivery() {
        let storage = MemoryPendingPushNavigationDataStore()
        let repository = PendingPushNavigationRepository(storage: storage)
        XCTAssertTrue(repository.park(
            path: "/m/?tab=inbox&notification=locked-notification",
            pairingFingerprint: fingerprint
        ))
        let model = makeModel(repository: repository)
        defer { model.webView.stopLoading() }

        model.setConnectionRouteReady(true)
        model.webView(model.webView, didFinish: nil)
        XCTAssertFalse(model.acknowledgePendingPushNavigation(notificationID: "locked-notification"))

        model.setPendingPushNavigationAllowed(true)
        model.setPendingPushNavigationAllowed(false)
        XCTAssertFalse(model.acknowledgePendingPushNavigation(notificationID: "locked-notification"))
        XCTAssertNotNil(repository.current(pairingFingerprint: fingerprint))
    }

    private func makeModel(repository: PendingPushNavigationRepository) -> WebViewModel {
        WebViewModel(
            pairing: Pairing(
                origin: origin,
                fingerprint: fingerprint,
                relayOrigin: "https://relay.example.test:53028",
                lanOrigin: origin
            ),
            pendingPushNavigations: repository
        )
    }
}

final class PairingParserTests: XCTestCase {
    func testParserRequiresANonemptyCertificateFingerprint() throws {
        for raw in [
            "https://192.168.1.11:43117/m/?pair=one-time-token",
            "https://192.168.1.11:43117/m/?pair=one-time-token&fp=",
            "https://192.168.1.11:43117/m/?pair=one-time-token&fp=%20%0A",
        ] {
            XCTAssertThrowsError(try PairingParser.parse(raw), raw) { error in
                guard case PairingParseError.missingFingerprint = error else {
                    return XCTFail("Expected missingFingerprint, got \(error)")
                }
            }
        }

        let parsed = try PairingParser.parse(
            "https://192.168.1.11:43117/m/?pair=one-time-token&fp=certificate-fingerprint"
        )
        XCTAssertEqual(parsed.pairing.fingerprint, "certificate-fingerprint")
    }
}

final class PinnedWebNavigationPolicyTests: XCTestCase {
    private let pairing = Pairing(
        origin: "https://192.168.1.11:43117",
        fingerprint: "certificate-fingerprint",
        relayOrigin: "https://relay.example.test:53028",
        lanOrigin: "https://192.168.1.11:43117"
    )

    func testOnlyPairedMobileOriginsStayInsidePinnedWebView() throws {
        XCTAssertEqual(disposition("https://192.168.1.11:43117/m/"), .allowInWebView)
        XCTAssertEqual(disposition("https://relay.example.test:53028/m/?tab=inbox"), .allowInWebView)
        XCTAssertEqual(disposition("https://192.168.1.11:43117/admin"), .cancel)
        XCTAssertEqual(disposition("https://192.168.1.11:43117/m/../admin"), .cancel)
        XCTAssertEqual(disposition("https://192.168.1.11:43117/m/%2e%2e/admin"), .cancel)
        XCTAssertEqual(disposition("https://192.168.1.11:43117/m/%2Fadmin"), .cancel)
        XCTAssertEqual(disposition("https://user:PLACEHOLDER@192.168.1.11:43117/m/"), .cancel)
        XCTAssertEqual(disposition("http://192.168.1.11:43117/m/"), .cancel)
        XCTAssertEqual(disposition("javascript:alert(1)", userInitiated: true), .cancel)
    }

    func testExternalLinksRequireAnExplicitUserTap() throws {
        XCTAssertEqual(disposition("https://example.com/help", userInitiated: true), .openExternally)
        XCTAssertEqual(disposition("mailto:help@example.com", userInitiated: true), .openExternally)
        XCTAssertEqual(disposition("https://example.com/redirect", userInitiated: false), .cancel)
        XCTAssertEqual(disposition("unknown-scheme://example", userInitiated: true), .cancel)
    }

    func testBridgeOriginAllowsCurrentLanAndRelayButNoOtherPage() {
        XCTAssertTrue(PinnedWebNavigationPolicy.isPairedOrigin(
            scheme: "https", host: "192.168.1.11", port: 43_117, pairing: pairing
        ))
        XCTAssertTrue(PinnedWebNavigationPolicy.isPairedOrigin(
            scheme: "https", host: "relay.example.test", port: 53_028, pairing: pairing
        ))
        XCTAssertFalse(PinnedWebNavigationPolicy.isPairedOrigin(
            scheme: "https", host: "evil.example", port: 443, pairing: pairing
        ))
        XCTAssertFalse(PinnedWebNavigationPolicy.isPairedOrigin(
            scheme: "http", host: "192.168.1.11", port: 43_117, pairing: pairing
        ))
    }

    private func disposition(
        _ rawURL: String,
        userInitiated: Bool = false,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> PinnedWebNavigationDisposition {
        guard let url = URL(string: rawURL) else {
            XCTFail("Invalid test URL: \(rawURL)", file: file, line: line)
            return .cancel
        }
        return PinnedWebNavigationPolicy.disposition(
            for: url,
            pairing: pairing,
            userInitiated: userInitiated
        )
    }
}

private final class MemoryPendingPushNavigationDataStore: PendingPushNavigationDataStore {
    var data: Data?
    private(set) var saveCount = 0
    private(set) var clearCount = 0

    func load() -> Data? { data }

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

private final class PendingNavigationTestClock {
    var date: Date

    init(date: Date) {
        self.date = date
    }
}
