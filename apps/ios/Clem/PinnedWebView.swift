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
        let peelBlack = UIColor(red: 12 / 255, green: 9 / 255, blue: 6 / 255, alpha: 1)
        webView.isOpaque = false
        webView.backgroundColor = peelBlack
        webView.underPageBackgroundColor = peelBlack
        webView.scrollView.backgroundColor = peelBlack
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
        if let url = pairing.homeURL { load(url) }
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
    /// The pin. With a fingerprint stored, exactly that certificate is
    /// accepted — self-signed is fine, a rotated or substituted cert is not.
    /// Without one (tunnel-mode pairing), default evaluation runs.
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
            completionHandler(.performDefaultHandling, nil)
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

/// Breaks the retain cycle WKUserContentController would otherwise create by
/// holding its message handler strongly for the life of the configuration.
private final class ScriptProxy: NSObject, WKScriptMessageHandler {
    private weak var model: WebViewModel?

    init(_ model: WebViewModel) {
        self.model = model
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
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
