import Foundation
import XCTest
import WebKit
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

    func testArtifactPreviewsAreLimitedToPairedChildFrames() throws {
        let page = try XCTUnwrap(URL(string: "https://192.168.1.11:43117/m/?tab=chat"))
        let origin = try XCTUnwrap(URL(string: "https://192.168.1.11:43117"))
        let blob = "blob:https://192.168.1.11:43117/8533143e-ef28-4997-b96f-759e9f6e3260"
        for raw in ["about:srcdoc", blob] {
            let url = try XCTUnwrap(URL(string: raw))
            XCTAssertTrue(PinnedWebNavigationPolicy.allowsArtifactPreview(for: url, pairing: pairing, mainDocumentURL: page, sourceOrigin: origin, targetIsMainFrame: false))
            XCTAssertFalse(PinnedWebNavigationPolicy.allowsArtifactPreview(for: url, pairing: pairing, mainDocumentURL: page, sourceOrigin: origin, targetIsMainFrame: true))
            XCTAssertFalse(PinnedWebNavigationPolicy.allowsArtifactPreview(for: url, pairing: pairing, mainDocumentURL: page, sourceOrigin: origin, targetIsMainFrame: nil))
            XCTAssertFalse(PinnedWebNavigationPolicy.allowsArtifactPreview(for: url, pairing: pairing, mainDocumentURL: page, sourceOrigin: URL(string: "https://evil.example"), targetIsMainFrame: false))
            XCTAssertFalse(PinnedWebNavigationPolicy.allowsArtifactPreview(for: url, pairing: pairing, mainDocumentURL: URL(string: "https://192.168.1.11:43117/admin"), sourceOrigin: origin, targetIsMainFrame: false))
            XCTAssertFalse(PinnedWebNavigationPolicy.allowsArtifactPreview(for: url, pairing: pairing, mainDocumentURL: page, sourceOrigin: nil, targetIsMainFrame: false))
            // The general policy remains closed to top navigation and popups.
            XCTAssertEqual(disposition(raw, userInitiated: true), .cancel)
        }
        for raw in ["about:blank", "about:srcdoc#other", "blob:null/8533143e-ef28-4997-b96f-759e9f6e3260", "blob:https://evil.example/8533143e-ef28-4997-b96f-759e9f6e3260", "blob:https://relay.example.test:53028/8533143e-ef28-4997-b96f-759e9f6e3260", "blob:https://192.168.1.11:43117/not-a-blob", "blob:https://user:password@192.168.1.11:43117/8533143e-ef28-4997-b96f-759e9f6e3260", "data:text/html,hello"] {
            XCTAssertFalse(PinnedWebNavigationPolicy.allowsArtifactPreview(for: try XCTUnwrap(URL(string: raw)), pairing: pairing, mainDocumentURL: page, sourceOrigin: origin, targetIsMainFrame: false), raw)
        }
        var unpinned = pairing
        unpinned.fingerprint = nil
        XCTAssertFalse(PinnedWebNavigationPolicy.allowsArtifactPreview(for: try XCTUnwrap(URL(string: blob)), pairing: unpinned, mainDocumentURL: page, sourceOrigin: origin, targetIsMainFrame: false))
    }

    func testArtifactDownloadRequiresTheMainPageAndAnExplicitDownloadAttribute() throws {
        let page = try XCTUnwrap(URL(string: "https://192.168.1.11:43117/m/"))
        let blob = try XCTUnwrap(URL(string: "blob:https://192.168.1.11:43117/8533143e-ef28-4997-b96f-759e9f6e3260"))
        XCTAssertTrue(PinnedWebNavigationPolicy.allowsArtifactDownload(for: blob, pairing: pairing, mainDocumentURL: page, sourceOrigin: page, sourceIsMainFrame: true, hasDownloadAttribute: true))
        XCTAssertFalse(PinnedWebNavigationPolicy.allowsArtifactDownload(for: blob, pairing: pairing, mainDocumentURL: page, sourceOrigin: page, sourceIsMainFrame: false, hasDownloadAttribute: true))
        XCTAssertFalse(PinnedWebNavigationPolicy.allowsArtifactDownload(for: blob, pairing: pairing, mainDocumentURL: page, sourceOrigin: page, sourceIsMainFrame: true, hasDownloadAttribute: false))
        XCTAssertFalse(PinnedWebNavigationPolicy.allowsArtifactDownload(for: page, pairing: pairing, mainDocumentURL: page, sourceOrigin: page, sourceIsMainFrame: true, hasDownloadAttribute: true))
    }

    func testArtifactDownloadFilenamesCannotEscapeTheirTemporaryDirectory() {
        XCTAssertEqual(ArtifactDownloadPolicy.filename("../Draft.pdf"), "Draft.pdf")
        XCTAssertEqual(ArtifactDownloadPolicy.filename("..\\Draft.pdf"), "Draft.pdf")
        XCTAssertEqual(ArtifactDownloadPolicy.filename("a\u{0000}\n:b.html"), "ab.html")
        XCTAssertEqual(ArtifactDownloadPolicy.filename(".."), "File")
        XCTAssertEqual(ArtifactDownloadPolicy.filename(String(repeating: "x", count: 241)), "File")
        XCTAssertEqual(ArtifactDownloadPolicy.filename("Email draft.html"), "Email draft.html")
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

@MainActor
final class PinnedArtifactWebKitTests: XCTestCase {
    func testWebKitUsesThePairedSourceForSandboxedAndBlobFrames() async throws {
        let pairing = Pairing(origin: "https://artifact-fixture.example.test", fingerprint: "fixture-pin")
        let model = WebViewModel(pairing: pairing, pendingPushNavigations: PendingPushNavigationRepository(storage: MemoryPendingPushNavigationDataStore()))
        let probe = ArtifactNavigationProbe(model: model)
        model.webView.navigationDelegate = probe
        defer { model.webView.stopLoading() }
        model.webView.loadHTMLString("""
        <!doctype html><html><body><script>
        window.fixtureReady = false;
        const frame = document.createElement('iframe');
        frame.sandbox = '';
        frame.srcdoc = '<p>Completed HTML draft</p>';
        document.body.appendChild(frame);
        const blobFrame = document.createElement('iframe');
        const stream = 'BT /F1 12 Tf 72 720 Td (Completed PDF fixture) Tj ET';
        const objects = [
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
          '<< /Length '+stream.length+' >>\\nstream\\n'+stream+'\\nendstream',
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
        ];
        let pdf = '%PDF-1.4\\n';
        const offsets = [0];
        objects.forEach((object,index) => { offsets.push(pdf.length); pdf += (index+1)+' 0 obj\\n'+object+'\\nendobj\\n'; });
        const xref = pdf.length;
        pdf += 'xref\\n0 6\\n0000000000 65535 f \\n'+offsets.slice(1).map(offset => String(offset).padStart(10,'0')+' 00000 n \\n').join('');
        pdf += 'trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n'+xref+'\\n%%EOF';
        blobFrame.src = URL.createObjectURL(new Blob([pdf], {type:'application/pdf'}));
        blobFrame.onload = () => { window.fixtureReady = true; };
        document.body.appendChild(blobFrame);
        </script></body></html>
        """, baseURL: try XCTUnwrap(pairing.homeURL))
        var ready = false
        for _ in 0..<100 {
            if (try? await model.webView.evaluateJavaScript("window.fixtureReady === true")) as? Bool == true {
                ready = true
                break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(ready, "Local blob frame should load without contacting any host")
        XCTAssertTrue(probe.decisions.contains { $0.0.hasPrefix("blob:https://artifact-fixture.example.test/") && $0.1 == .allow }, "Actual WKFrameInfo must pass the scoped artifact policy")
        XCTAssertFalse(probe.decisions.contains { $0.0 == "about:srcdoc" && $0.1 != .allow })
        XCTAssertEqual(model.webView.url, pairing.homeURL, "Preview must retain the mobile top-level document")
    }
}

@MainActor
private final class ArtifactNavigationProbe: NSObject, WKNavigationDelegate {
    let model: WebViewModel
    var decisions: [(String, WKNavigationActionPolicy)] = []

    init(model: WebViewModel) { self.model = model }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        model.webView(webView, decidePolicyFor: action) { policy in
            self.decisions.append((action.request.url?.absoluteString ?? "", policy))
            decisionHandler(policy)
        }
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
