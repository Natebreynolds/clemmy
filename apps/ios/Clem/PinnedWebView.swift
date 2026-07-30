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

    func loadHome() {
        if let url = pairing.homeURL { load(url) }
    }

    /// Bonjour found the Mac at a new address: persist and reload.
    func adoptOrigin(_ origin: String) {
        guard origin != pairing.origin else { return }
        pairing.origin = origin
        PairingStore.save(pairing)
        loadHome()
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
