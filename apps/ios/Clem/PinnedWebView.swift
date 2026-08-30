import Combine
import CryptoKit
import SwiftUI
import WebKit

/// Owns the WKWebView so SwiftUI, the push registrar, and Bonjour rediscovery
/// all talk to one instance. The PWA inside owns the session (device-bound
/// key in IndexedDB), so the data store must be the persistent default.
@MainActor
final class WebViewModel: NSObject, ObservableObject {
    @Published private(set) var pairing: Pairing
    /// Flips when navigation fails for connectivity reasons — the signal for
    /// Bonjour rediscovery, not for auth or page errors.
    @Published var connectionLost = false
    /// Last navigation failure code. Off-Wi-Fi refusals never reach the
    /// daemon — a TLS handshake that sends no request leaves no server-side
    /// trace — so without this the only symptom is a blank view. Lets the
    /// next real off-Wi-Fi attempt say whether ATS refused (-1200/-1202/-1022)
    /// or the certificate pin did (-999).
    @Published private(set) var lastNavigationErrorCode: Int?
    @Published private(set) var hasLoadedOnce = false
    /// Exact navigation requested by the native shell. Besides being useful
    /// diagnostics, this gives the hosted tests a causal oracle without
    /// asking the simulator to contact a real daemon.
    private(set) var lastRequestedURL: URL?

    let webView: WKWebView
    /// Deferred until the page is up so the bridge function exists.
    private var pendingApnsToken: String?

    /// Pre-warmed so the first tap is as crisp as the hundredth — a cold
    /// generator costs a few milliseconds, which is exactly the delay that
    /// makes a web app feel like a web app.
    private let impactLight = UIImpactFeedbackGenerator(style: .light)
    private let impactMedium = UIImpactFeedbackGenerator(style: .medium)
    private let notify = UINotificationFeedbackGenerator()
    private let refreshControl = UIRefreshControl()

    init(pairing: Pairing) {
        self.pairing = pairing
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        // WKWebView copies its configuration during initialization. Install
        // every JS bridge first, then attach this model after Swift finishes
        // initializing self; otherwise a copied empty controller can silently
        // drop the very path-change/handoff messages remote access needs.
        let scriptProxy = ScriptProxy()
        for name in [
            "clemHaptic",
            "clemRepair",
            "clemHandoff",
            "clemHandoffResult",
            "clemConnectionLost",
        ] {
            config.userContentController.add(scriptProxy, name: name)
        }
        webView = WKWebView(frame: .zero, configuration: config)
        // The app is daylight-only: without this the web view inherits the
        // SYSTEM appearance, so a phone in dark mode summons a dark keyboard
        // and dark form accessories over the light page (live 2026-08-26).
        webView.overrideUserInterfaceStyle = .light
        super.init()
        scriptProxy.attach(self)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true

        impactLight.prepare()
        impactMedium.prepare()
        notify.prepare()

        // Pull-to-refresh belongs to the scroll view, not to JavaScript: the
        // rubber-band, the threshold, and the spinner are all things iOS
        // already does correctly and no web reimplementation matches.
        refreshControl.tintColor = UIColor(red: 1, green: 0.54, blue: 0.24, alpha: 1)
        refreshControl.addTarget(self, action: #selector(handlePullToRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refreshControl
        // The page owns safe-area padding via env(); the shell stays dark and
        // silent — no white flash before first paint, no double insets.
        // 100% light mode (owner directive 2026-08-25): the shell paints the
        // same warm paper the page uses, so there is no dark flash before
        // first paint and no dark halo behind rubber-band overscroll.
        // Matches --bg-0 and the theme-color meta exactly. Any difference here
        // shows as a tinted flash before first paint and as a tinted band under
        // the over-scroll bounce, which reads as "the app isn't white".
        let paper = UIColor.white
        webView.isOpaque = false
        webView.backgroundColor = paper
        webView.underPageBackgroundColor = paper
        webView.scrollView.backgroundColor = paper
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
    }

    func load(_ url: URL) {
        connectionLost = false
        lastRequestedURL = url
        webView.load(URLRequest(url: url))
    }

    /// Asks the page to reload its data in place. Falls back to a navigation
    /// reload if the bridge isn't up yet, so the gesture is never a no-op.
    @objc private func handlePullToRefresh() {
        impactLight.impactOccurred()
        webView.evaluateJavaScript(
            "(window.clemNative && window.clemNative.refresh) ? (window.clemNative.refresh(), true) : false"
        ) { [weak self] handled, _ in
            guard let self else { return }
            if (handled as? Bool) != true { self.webView.reload() }
            // The spinner is a promise about freshness; hold it just long
            // enough to read as deliberate rather than dropped.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                self.refreshControl.endRefreshing()
            }
        }
    }

    /// The OS-only half of "premium": weight under your thumb.
    fileprivate func playHaptic(_ kind: String) {
        switch kind {
        case "light": impactLight.impactOccurred()
        case "medium": impactMedium.impactOccurred()
        case "success": notify.notificationOccurred(.success)
        case "warning": notify.notificationOccurred(.warning)
        case "error": notify.notificationOccurred(.error)
        default: impactLight.impactOccurred()
        }
    }

    /// Tells the page which door it is on and whether we think it is live, so
    /// the connection pill can stop claiming "Direct" while on the relay —
    /// away from your desk, that label is the difference between trust and
    /// confusion.
    func publishConnectionState() {
        let onRelay = pairing.relayOrigin != nil && pairing.origin == pairing.relayOrigin
        let door = connectionLost ? "offline" : (onRelay ? "relay" : "direct")
        webView.evaluateJavaScript(
            "window.clemNative && window.clemNative.setConnection && window.clemNative.setConnection('\(door)')"
        )
    }

    func loadHome() {
        guard let url = pairing.homeURL else { return }
        // Cookies and the page's device key are per-ORIGIN, so arriving at
        // ANY origin other than the one that minted them means arriving with
        // no credential — the relay door, but equally the Mac's NEW LAN
        // address after DHCP moved it (live 2026-08-25: four re-pairs in
        // four days, one per IP change, because the token was spent only at
        // the relay). The shell is the only thing that survives an origin
        // switch, so it carries a LAN-minted, durably leased handoff token and
        // offers it on every load; the page spends it only when the origin
        // actually lacks a session, and parks a fresh one right after.
        // A legacy token freshly delivered by an older rolled-back daemon must
        // outrank a stale v2 Keychain lease that daemon cannot understand.
        // The next successfully parked v2 lease clears this legacy bridge.
        if let fingerprint = pairing.fingerprint,
           let legacyToken = OriginHandoffStore.currentLegacyToken(pairingFingerprint: fingerprint) {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            var items = components?.queryItems ?? []
            items.append(URLQueryItem(name: "adopt", value: legacyToken))
            components?.queryItems = items
            if let adoptURL = components?.url {
                load(adoptURL)
                return
            }
        }
        if let fingerprint = pairing.fingerprint,
           let handoff = OriginHandoffStore.currentLease(pairingFingerprint: fingerprint) {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            var items = components?.queryItems ?? []
            items.append(URLQueryItem(name: "adopt", value: handoff.token))
            items.append(URLQueryItem(name: "handoffId", value: handoff.handoffId))
            items.append(URLQueryItem(name: "handoffGeneration", value: String(handoff.generation)))
            components?.queryItems = items
            if let adoptURL = components?.url {
                load(adoptURL)
                return
            }
        }
        load(url)
    }

    private func isRelayOrigin(_ origin: String) -> Bool {
        guard let relay = pairing.relayOrigin else { return false }
        return origin == relay
    }

    /// Bonjour found the Mac at a new address: persist and reload.
    /// `isLan` records whether this is a local address worth preferring later
    /// — the relay origin is durable config, not a discovered LAN address.
    func adoptOrigin(_ origin: String, isLan: Bool = true) {
        if isLan { pairing.lanOrigin = origin }
        guard origin != pairing.origin else {
            PairingStore.save(pairing)
            // A cold process has no failed navigation to set connectionLost.
            // If the saved origin is already the relay, a successful cellular
            // probe must still perform the first navigation instead of leaving
            // a pristine WKWebView blank forever.
            if !hasLoadedOnce || connectionLost { loadHome() }
            return
        }
        // Navigate to the new origin either way — but only PERSIST a remote
        // one once it has actually served a page.
        //
        // Saving first meant a single failed relay navigation replaced a
        // working LAN origin with an unreachable one, permanently: the next
        // cold start loaded the bad origin, failed again, and the only way out
        // was to re-pair. The live store shows exactly that treadmill — a new
        // deviceId on six separate days, and not one session ever established
        // from off-LAN.
        //
        // The LAN path still saves eagerly: it was discovered by Bonjour, so
        // it is reachable by construction, and eager persistence is what lets a
        // cold start find the Mac at a new DHCP address.
        let previousOrigin = pairing.origin
        pairing.origin = origin
        if isLan {
            PairingStore.save(pairing)
            originPendingProof = nil
        } else {
            originPendingProof = PendingOrigin(candidate: origin, previous: previousOrigin)
        }
        loadHome()
    }

    private struct PendingOrigin {
        let candidate: String
        let previous: String
    }

    /// A remote origin navigated to but not yet proven. Promoted on the first
    /// successful load, rolled back on failure.
    private var originPendingProof: PendingOrigin?

    /// Persist a remote origin once it has actually served a page, so that
    /// persistence follows proof rather than preceding it.
    func confirmPendingOrigin() {
        guard let pending = originPendingProof else { return }
        originPendingProof = nil
        pairing.origin = pending.candidate
        PairingStore.save(pairing)
    }

    /// Restore the last working origin after a remote candidate failed to
    /// load, so a bad door is never what a cold start wakes up on.
    func discardPendingOrigin() {
        guard let pending = originPendingProof else { return }
        originPendingProof = nil
        pairing.origin = pending.previous
    }


    /// Remembers the daemon-published relay door. Silent: it changes nothing
    /// about the current connection, it just makes the next off-LAN attempt
    /// possible — which is why an existing pairing needs no re-scan.
    func rememberRelayOrigin(_ relayOrigin: String) {
        guard pairing.relayOrigin != relayOrigin else { return }
        pairing.relayOrigin = relayOrigin
        PairingStore.save(pairing)
    }

    @discardableResult
    fileprivate func parkOriginHandoff(
        token: String,
        expiresAtMs: Double,
        handoffId: String,
        generation: Int,
        deviceId: String
    ) -> Bool {
        guard let fingerprint = pairing.fingerprint else { return false }
        let stored = OriginHandoffStore.park(
            token: token,
            expiresAtMs: expiresAtMs,
            handoffId: handoffId,
            generation: generation,
            deviceId: deviceId,
            pairingFingerprint: fingerprint
        )
        if stored { publishStoredOriginHandoff(handoffId: handoffId, generation: generation) }
        return stored
    }

    fileprivate func acknowledgeOriginHandoff(handoffId: String, generation: Int) {
        guard let fingerprint = pairing.fingerprint else { return }
        OriginHandoffStore.acknowledge(
            handoffId: handoffId,
            generation: generation,
            pairingFingerprint: fingerprint
        )
    }

    fileprivate func parkLegacyOriginHandoff(token: String, expiresAtMs: Double) {
        guard let fingerprint = pairing.fingerprint else { return }
        _ = OriginHandoffStore.parkLegacy(
            token: token,
            expiresAtMs: expiresAtMs,
            pairingFingerprint: fingerprint
        )
    }

    /// Native storage is the commit point for replacing an older relay lease.
    /// Tell the authenticated LAN page only after Keychain accepted the exact
    /// tuple; the page then activates it server-side and may retire older
    /// generations without stranding this process on a dropped response.
    private func publishStoredOriginHandoff(handoffId: String, generation: Int) {
        guard let payload = try? JSONSerialization.data(
            withJSONObject: ["handoffId": handoffId, "generation": generation]
        ), let json = String(data: payload, encoding: .utf8) else { return }
        webView.evaluateJavaScript(
            "window.clemNative && window.clemNative.originHandoffStored && window.clemNative.originHandoffStored(\(json))"
        )
    }

    /// Hands the APNs token to the PWA, which registers it over its own
    /// proof-signed session — the native shell never needs a credential.
    func deliverApnsToken(_ hexToken: String) {
        guard hasLoadedOnce else {
            pendingApnsToken = hexToken
            return
        }
        // Token is hex from our own AppDelegate — safe to inline.
        webView.evaluateJavaScript("window.clemNative && window.clemNative.registerApnsToken('\(hexToken)')")
    }

    /// Notification tap: payload carries a path like "/m/?tab=inbox".
    func openPath(_ path: String) {
        guard path.hasPrefix("/"), let url = URL(string: pairing.origin + path) else { return }
        load(url)
    }
}

extension WebViewModel: WKNavigationDelegate, WKUIDelegate {
    /// The pin, and the whole basis of trusting this connection: exactly the
    /// certificate the QR carried is accepted — self-signed is fine, a
    /// rotated or substituted one is not.
    ///
    /// A pairing with no fingerprint is REFUSED rather than falling back to
    /// the system trust store. That fallback existed for tunnel-mode pairing,
    /// which no longer exists; leaving it in place meant that anyone able to
    /// obtain a publicly-trusted certificate for the relay hostname could
    /// have been trusted by an unpinned pairing. Off the LAN the pin is the
    /// only thing standing between a relay operator and the session, so it
    /// fails closed.
    func webView(
        _ webView: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let expected = pairing.fingerprint else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        if CertificatePin.trustMatches(trust, fingerprint: expected) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasLoadedOnce = true
        connectionLost = false
        // The page loaded, so a remote origin has now earned persistence.
        confirmPendingOrigin()
        if let token = pendingApnsToken {
            pendingApnsToken = nil
            deliverApnsToken(token)
        }
        publishConnectionState()
        // If the app was suspended between the Keychain save and the LAN
        // page's activation request, replay the storage acknowledgement on
        // the next successful page load. Activation is tuple-idempotent.
        if let fingerprint = pairing.fingerprint,
           let lease = OriginHandoffStore.currentLease(pairingFingerprint: fingerprint) {
            publishStoredOriginHandoff(
                handoffId: lease.handoffId,
                generation: lease.generation
            )
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Provisional failure is where a refused TLS handshake lands, which is
        // exactly the off-Wi-Fi case: roll back before the bad origin can
        // become what the next cold start wakes up on.
        discardPendingOrigin()
        markIfConnectivity(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        discardPendingOrigin()
        markIfConnectivity(error)
    }

    private func markIfConnectivity(_ error: Error) {
        let nsError = error as NSError
        let code = nsError.code

        // Every navigation failure is recorded, whether or not it starts the
        // retry ladder. Off-Wi-Fi failures produce NO daemon log line — a TLS
        // handshake that never sends a request is invisible on the server — so
        // without this the only symptom was a blank view and a re-pair.
        lastNavigationErrorCode = code
        NSLog(
            "[clem] navigation failed code=%d domain=%@ host=%@",
            code,
            nsError.domain,
            lastRequestedURL?.host ?? "?"
        )

        // A TLS refusal is a reason to try the NEXT door, exactly like a
        // refused TCP connection. These were absent, so an off-Wi-Fi TLS
        // failure never set connectionLost: the retry ladder was never armed
        // and the view sat blank rather than falling back.
        let connectivityCodes: Set<Int> = [
            NSURLErrorCannotConnectToHost,
            NSURLErrorCannotFindHost,
            NSURLErrorTimedOut,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorNotConnectedToInternet,
            NSURLErrorSecureConnectionFailed,
            NSURLErrorServerCertificateUntrusted,
            NSURLErrorServerCertificateHasBadDate,
            NSURLErrorServerCertificateNotYetValid,
            NSURLErrorServerCertificateHasUnknownRoot,
            NSURLErrorAppTransportSecurityRequiresSecureConnection,
        ]
        // NSURLErrorCancelled (-999) is deliberately EXCLUDED. That is the pin
        // itself refusing a certificate it does not recognise, which must stay
        // a hard stop — retrying another door after a failed pin would be the
        // one way to weaken the trust decision.
        if connectivityCodes.contains(code) {
            connectionLost = true
        }
    }

    /// target=_blank links stay inside the one pinned view.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}

enum CertificatePin {
    /// base64url(SHA-256(leaf cert DER)) — must equal the daemon's
    /// `certFingerprint()`, which is what the QR carried.
    static func trustMatches(_ trust: SecTrust, fingerprint expected: String) -> Bool {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else { return false }
        let der = SecCertificateCopyData(leaf) as Data
        let actual = Data(SHA256.hash(data: der)).base64URLEncodedString()
        return constantTimeEquals(actual, expected)
    }

    private static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let lhs = Array(a.utf8)
        let rhs = Array(b.utf8)
        guard lhs.count == rhs.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<lhs.count { diff |= lhs[i] ^ rhs[i] }
        return diff == 0
    }
}

/// Breaks the retain cycle WKUserContentController would otherwise create by
/// holding its message handler strongly for the life of the configuration.
private final class ScriptProxy: NSObject, WKScriptMessageHandler {
    private weak var model: WebViewModel?

    func attach(_ model: WebViewModel) {
        self.model = model
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "clemConnectionLost" {
            MainActor.assumeIsolated {
                model?.connectionLost = true
            }
            return
        }
        if message.name == "clemHandoff" {
            // Opaque leased token + its expiry. The durable store is
            // device-only Keychain and remains leased until exact adoption.
            guard let body = message.body as? [String: Any],
                  let token = body["token"] as? String,
                  let expiresAt = (body["expiresAt"] as? NSNumber)?.doubleValue else { return }
            guard (body["version"] as? NSNumber)?.intValue == 2 else {
                // New shell + old cached page/daemon. Preserve the former
                // in-memory behavior without inventing v2 correlation facts.
                MainActor.assumeIsolated {
                    model?.parkLegacyOriginHandoff(token: token, expiresAtMs: expiresAt)
                }
                return
            }
            guard let handoffId = body["handoffId"] as? String,
                  let generation = (body["generation"] as? NSNumber)?.intValue,
                  let deviceId = body["deviceId"] as? String else { return }
            MainActor.assumeIsolated {
                _ = model?.parkOriginHandoff(
                    token: token,
                    expiresAtMs: expiresAt,
                    handoffId: handoffId,
                    generation: generation,
                    deviceId: deviceId
                )
            }
            return
        }
        if message.name == "clemHandoffResult" {
            guard let body = message.body as? [String: Any],
                  let handoffId = body["handoffId"] as? String,
                  let generation = (body["generation"] as? NSNumber)?.intValue,
                  let outcome = body["outcome"] as? String,
                  outcome == "consumed" || outcome == "invalid" else { return }
            MainActor.assumeIsolated {
                model?.acknowledgeOriginHandoff(handoffId: handoffId, generation: generation)
            }
            return
        }
        if message.name == "clemRepair" {
            // The page asked for the scanner; the shell owns the decision.
            NotificationCenter.default.post(name: .repairRequested, object: nil)
            return
        }
        guard message.name == "clemHaptic" else { return }
        // Only ever a short enum from our own bundle; anything else is ignored
        // rather than trusted.
        let kind = (message.body as? String) ?? "light"
        MainActor.assumeIsolated {
            model?.playHaptic(kind)
        }
    }
}

/// Thin SwiftUI wrapper around the model-owned web view.
struct PinnedWebView: UIViewRepresentable {
    @ObservedObject var model: WebViewModel

    func makeUIView(context: Context) -> WKWebView { model.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

extension Data {
    /// Matches Node's Buffer#toString('base64url') — the daemon side of the pin.
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
