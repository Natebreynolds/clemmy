import Foundation

/// Off-LAN reach: learning where the relay door is, and choosing which door
/// to use right now.
///
/// The relay is a byte pipe — the TLS peer through it is still the paired
/// Mac's certificate — so every probe here uses the SAME pin as the direct
/// door. Nothing about "which origin" changes what we trust.
enum RelayDiscovery {
    /// Anonymous endpoint: the daemon publishes its own relay origin so an
    /// already-paired phone gains remote access without re-scanning a QR.
    static func fetchRelayOrigin(from origin: String, fingerprint: String?, completion: @escaping (String?) -> Void) {
        guard let url = URL(string: origin + "/m/relay-info") else { completion(nil); return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        let session = URLSession(
            configuration: .ephemeral,
            delegate: PinnedSessionDelegate(fingerprint: fingerprint),
            delegateQueue: nil
        )
        session.dataTask(with: request) { data, _, _ in
            defer { session.finishTasksAndInvalidate() }
            guard let data,
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let relay = parsed["origin"] as? String, !relay.isEmpty else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            DispatchQueue.main.async { completion(relay) }
        }.resume()
    }

    /// True when /m/health answers on this origin under our pin. Used to pick
    /// the LAN door when it is available and fall back to the relay when not.
    static func probe(origin: String, fingerprint: String?, timeout: TimeInterval = 4, completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: origin + "/m/health") else { completion(false); return }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let session = URLSession(
            configuration: .ephemeral,
            delegate: PinnedSessionDelegate(fingerprint: fingerprint),
            delegateQueue: nil
        )
        session.dataTask(with: request) { _, response, _ in
            defer { session.finishTasksAndInvalidate() }
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { completion(ok) }
        }.resume()
    }

    /// Walks the pairing's candidate origins in order and returns the first
    /// that answers — LAN first (fast, private), relay last.
    static func firstReachable(_ origins: [String], fingerprint: String?, completion: @escaping (String?) -> Void) {
        var remaining = origins
        func next() {
            guard !remaining.isEmpty else { completion(nil); return }
            let candidate = remaining.removeFirst()
            probe(origin: candidate, fingerprint: fingerprint) { ok in
                if ok { completion(candidate) } else { next() }
            }
        }
        next()
    }
}

/// URLSession pinning that mirrors PinnedWebView's WKWebView challenge
/// handler: trust exactly the certificate whose SHA-256 the QR carried.
final class PinnedSessionDelegate: NSObject, URLSessionDelegate {
    private let fingerprint: String?

    init(fingerprint: String?) {
        self.fingerprint = fingerprint
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        // No pin (publicly-trusted host) → system trust store, unmodified.
        guard let fingerprint else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        if CertificatePin.trustMatches(trust, fingerprint: fingerprint) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
