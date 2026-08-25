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
    @Published private(set) var hasLoadedOnce = false

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
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true

        // JS → Swift. The web layer is the whole UI, so without this it can
        // never reach the parts of "feels native" that only the OS can do.
        // A proxy holds the handler so WKUserContentController's strong
        // reference doesn't retain this model forever.
        config.userContentController.add(ScriptProxy(self), name: "clemHaptic")
        // The web login screen's "Scan a new QR code" button: when the web
        // session expires inside a paired shell, the page has no way to reach
        // the native scanner — this is that way. The shell still confirms via
        // the same dialog as shake-to-unpair before anything is cleared.
        config.userContentController.add(ScriptProxy(self), name: "clemRepair")
        // The page hands over a short-lived origin-handoff token while it is
        // on the LAN; the shell keeps it so the next relay-origin load can
        // establish a session there. See loadHome().
        config.userContentController.add(ScriptProxy(self), name: "clemHandoff")
        // A failed fetch does not trigger WKNavigationDelegate failure
        // callbacks because the PWA itself is still loaded. Let the page tell
        // us that its current origin stopped answering so the native reconnect
        // ladder can switch from LAN to the relay while the app is open.
        config.userContentController.add(ScriptProxy(self), name: "clemConnectionLost")
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
        let paper = UIColor(red: 252 / 255, green: 249 / 255, blue: 244 / 255, alpha: 1)
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
        // switch, so it carries a LAN-minted, single-use handoff token and
        // offers it on every load; the page spends it only when the origin
        // actually lacks a session, and parks a fresh one right after.
        if let handoff = OriginHandoffStore.take() {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            var items = components?.queryItems ?? []
            items.append(URLQueryItem(name: "adopt", value: handoff))
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
            return
        }
        pairing.origin = origin
        PairingStore.save(pairing)
        loadHome()
    }

    /// Remembers the daemon-published relay door. Silent: it changes nothing
    /// about the current connection, it just makes the next off-LAN attempt
    /// possible — which is why an existing pairing needs no re-scan.
    func rememberRelayOrigin(_ relayOrigin: String) {
        guard pairing.relayOrigin != relayOrigin else { return }
        pairing.relayOrigin = relayOrigin
        PairingStore.save(pairing)
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
        if let token = pendingApnsToken {
            pendingApnsToken = nil
            deliverApnsToken(token)
        }
        publishConnectionState()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        markIfConnectivity(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        markIfConnectivity(error)
    }

    private func markIfConnectivity(_ error: Error) {
        let code = (error as NSError).code
        let connectivityCodes: Set<Int> = [
            NSURLErrorCannotConnectToHost,
            NSURLErrorCannotFindHost,
            NSURLErrorTimedOut,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorNotConnectedToInternet,
        ]
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

/// The one credential that must survive an origin switch.
///
/// In memory only, single use, and it refuses an expired token — the page
/// mints a fresh one on every LAN visit, so there is never a reason to keep
/// one on disk.
enum OriginHandoffStore {
    private static var token: String?
    private static var expiresAt: Date?

    static func park(token newToken: String, expiresAtMs: Double) {
        token = newToken
        expiresAt = Date(timeIntervalSince1970: expiresAtMs / 1000)
    }

    /// Returns the token once, and only while it is still valid.
    static func take() -> String? {
        defer { token = nil; expiresAt = nil }
        guard let token, let expiresAt, expiresAt > Date() else { return nil }
        return token
    }
}

/// Breaks the retain cycle WKUserContentController would otherwise create by
/// holding its message handler strongly for the life of the configuration.
private final class ScriptProxy: NSObject, WKScriptMessageHandler {
    private weak var model: WebViewModel?

    init(_ model: WebViewModel) {
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
            // Opaque single-use token + its expiry. Held only in memory: it is
            // short-lived by design and a fresh one is minted on every LAN
            // visit, so persisting it would widen the window for no gain.
            guard let body = message.body as? [String: Any],
                  let token = body["token"] as? String,
                  let expiresAt = body["expiresAt"] as? Double else { return }
            OriginHandoffStore.park(token: token, expiresAtMs: expiresAt)
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
