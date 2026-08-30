import XCTest
@testable import Clem

/// Off-Wi-Fi access, pinned at the two places it actually broke.
///
/// Owner report 2026-08-27: "the off Wi-Fi still doesn't work." The live store
/// agreed — 131 handoff mints, ZERO origin adoptions, and every mobile session
/// created from a 192.168.x address. A new deviceId appeared on six separate
/// days: the re-pair treadmill.
///
/// The existing cold-cellular test passed throughout, because it builds the
/// case with `origin == relayOrigin` and so `adoptOrigin` takes its
/// `guard origin != pairing.origin` early return. It never performs a switch
/// and never touches the network. These tests perform a REAL switch.
@MainActor
final class OffNetworkOriginTests: XCTestCase {
    private let lan = "https://192.168.1.11:43117"
    private let relay = "https://relay.example.test:53028"

    private func model() -> WebViewModel {
        WebViewModel(pairing: Pairing(
            origin: lan,
            fingerprint: "certificate-fingerprint",
            relayOrigin: relay,
            lanOrigin: lan
        ))
    }

    override func setUp() {
        super.setUp()
        OriginHandoffStore.clear()
        PairingStore.clear()
    }

    override func tearDown() {
        OriginHandoffStore.clear()
        PairingStore.clear()
        super.tearDown()
    }

    func testNativeHealthProbeCannotVetoTheRelayDoor() {
        XCTAssertTrue(
            RelayDiscovery.nativeHealthProbeCanRun(on: lan),
            "LAN RFC1918 is NSAllowsLocalNetworking — URLSession may probe it"
        )
        XCTAssertFalse(
            RelayDiscovery.nativeHealthProbeCanRun(on: relay),
            "a public relay hostname with the Mac's self-signed cert must not be ATS-vetoed on URLSession"
        )
        XCTAssertFalse(
            RelayDiscovery.nativeHealthProbeCanRun(on: "https://abc123.r.breakthroughcoaching.ai"),
            "the hosted relay base domain is public; WKWebView is the proof"
        )
    }

    func testPublicRelayProbeReportsReachableWithoutURLSession() async {
        // Must not use wait(for:) on the main actor: skip-probe hops to main,
        // and a blocked run loop would deadlock the very hop it is proving.
        let ok = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            RelayDiscovery.probe(
                origin: "https://abc123.r.breakthroughcoaching.ai",
                fingerprint: "certificate-fingerprint",
                timeout: 0.1
            ) { reachable in
                cont.resume(returning: reachable)
            }
        }
        XCTAssertTrue(ok, "WKWebView is the proof; a native probe must not veto the door")
    }

    /// The case the old test avoided: LAN origin stored, relay adopted.
    func testGenuineLanToRelaySwitchNavigatesToTheRelay() {
        let model = model()
        model.adoptOrigin(relay, isLan: false)

        XCTAssertEqual(model.lastRequestedURL?.absoluteString, "\(relay)/m/",
                       "a real origin switch must navigate to the relay door")
        XCTAssertFalse(model.lastRequestedURL?.host?.hasPrefix("192.168.") ?? true,
                       "it must not still be pointing at the LAN address")
    }

    /// The treadmill: one failed relay navigation used to overwrite a working
    /// LAN origin permanently, so the next cold start woke on a dead door and
    /// the only way out was to re-pair.
    func testAFailedRemoteNavigationRestoresTheLastWorkingOrigin() {
        let originalPairing = Pairing(
            origin: lan,
            fingerprint: "certificate-fingerprint",
            relayOrigin: relay,
            lanOrigin: lan
        )
        PairingStore.save(originalPairing)
        XCTAssertEqual(PairingStore.load(), originalPairing,
                       "test precondition: the working LAN pairing must actually exist in durable storage")

        let model = WebViewModel(pairing: originalPairing)
        model.adoptOrigin(relay, isLan: false)

        model.webView(
            model.webView,
            didFailProvisionalNavigation: nil,
            withError: NSError(domain: NSURLErrorDomain,
                               code: NSURLErrorSecureConnectionFailed)
        )

        XCTAssertEqual(model.pairing.origin, lan,
                       "a relay that failed to load must never replace the working origin")
        XCTAssertEqual(PairingStore.load(), originalPairing,
                       "failure must preserve the exact non-empty pairing for the next cold start")
    }

    /// The other half: an origin that DID load is worth keeping.
    func testASuccessfulRemoteNavigationPersistsTheOrigin() {
        let model = model()
        model.adoptOrigin(relay, isLan: false)

        XCTAssertNil(PairingStore.load(),
                     "an unproven remote origin must not be durable")

        model.webView(model.webView, didFinish: nil)

        XCTAssertEqual(model.pairing.origin, relay,
                       "an origin that served a page has earned persistence")
        XCTAssertEqual(
            PairingStore.load(),
            Pairing(
                origin: relay,
                fingerprint: "certificate-fingerprint",
                relayOrigin: relay,
                lanOrigin: lan
            ),
            "mutation pin: removing PairingStore.save must fail this exact cold-start round trip"
        )
    }

    /// A refused TLS handshake is a reason to try the next door. These codes
    /// were absent from the connectivity set, so an off-Wi-Fi TLS failure never
    /// armed the retry ladder and the view simply sat blank.
    func testTlsRefusalArmsTheRetryLadder() {
        for code in [
            NSURLErrorSecureConnectionFailed,
            NSURLErrorServerCertificateUntrusted,
            NSURLErrorAppTransportSecurityRequiresSecureConnection,
        ] {
            let model = model()
            model.webView(
                model.webView,
                didFailProvisionalNavigation: nil,
                withError: NSError(domain: NSURLErrorDomain, code: code)
            )
            XCTAssertTrue(model.connectionLost,
                          "code \(code) must fall back to the next door")
            XCTAssertEqual(model.lastNavigationErrorCode, code,
                           "the code must be recorded — an off-Wi-Fi refusal leaves no server-side trace")
        }
    }

    /// THE NEGATIVE. -999 is the certificate pin refusing a certificate it does
    /// not recognise. Retrying another door after a failed pin would be the one
    /// change that actually weakens the trust decision, so it must stay a hard
    /// stop even though it is a navigation failure like the others.
    func testAPinRefusalIsAHardStopAndNeverFallsBack() {
        let model = model()
        model.webView(
            model.webView,
            didFailProvisionalNavigation: nil,
            withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
        )
        XCTAssertFalse(model.connectionLost,
                       "a refused pin must not send the app looking for another door")
    }
}
