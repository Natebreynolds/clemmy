import Foundation
import Network

/// Finds the paired Mac after its LAN address changed.
///
/// The daemon advertises `_clemmy._tcp` with `fp=<cert fingerprint>` in the
/// TXT record. We browse, keep only results whose fp matches the certificate
/// we already pin, and resolve one to a host:port origin. The TXT match is a
/// hint, not the proof — a spoofed advertisement can only steer us into the
/// TLS pin check, which it cannot pass without the daemon's private key.
final class Rediscovery {
    static let serviceType = "_clemmy._tcp"

    private var browser: NWBrowser?
    private var connection: NWConnection?
    private var completed = false

    /// Browses for up to `timeout` seconds; calls back on the main queue with
    /// a candidate origin ("https://<ip>:<port>") or nil.
    func findMac(fingerprint: String, timeout: TimeInterval = 8, completion: @escaping (String?) -> Void) {
        let finish: (String?) -> Void = { [weak self] origin in
            guard let self, !self.completed else { return }
            self.completed = true
            self.browser?.cancel()
            self.connection?.cancel()
            DispatchQueue.main.async { completion(origin) }
        }

        let params = NWParameters()
        params.includePeerToPeer = false
        let browser = NWBrowser(
            for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil),
            using: params
        )
        self.browser = browser

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self, !self.completed else { return }
            for result in results {
                guard case let .bonjour(txt) = result.metadata,
                      txt.dictionary["fp"] == fingerprint else { continue }
                self.resolve(result.endpoint, finish: finish)
                return
            }
        }
        browser.stateUpdateHandler = { state in
            if case .failed = state { finish(nil) }
        }
        browser.start(queue: .main)

        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(nil) }
    }

    /// Service endpoints don't expose an address until connected; a short TCP
    /// touch to the advertised port yields the concrete host:port.
    private func resolve(_ endpoint: NWEndpoint, finish: @escaping (String?) -> Void) {
        guard connection == nil else { return }
        let conn = NWConnection(to: endpoint, using: .tcp)
        connection = conn
        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                guard let path = conn.currentPath,
                      case let .hostPort(host, port) = path.remoteEndpoint else {
                    finish(nil)
                    return
                }
                let hostText: String
                switch host {
                case let .ipv4(address): hostText = "\(address)"
                case let .ipv6(address): hostText = "[\(address)]"
                case let .name(name, _): hostText = name
                @unknown default:
                    finish(nil)
                    return
                }
                // Interface scope suffixes (%en0) are socket-level details a
                // URL must not carry.
                let cleaned = hostText.split(separator: "%").first.map(String.init) ?? hostText
                finish("https://\(cleaned):\(port.rawValue)")
            case .failed, .cancelled:
                finish(nil)
            default:
                break
            }
        }
        conn.start(queue: .main)
    }

    func cancel() {
        completed = true
        browser?.cancel()
        connection?.cancel()
    }
}
