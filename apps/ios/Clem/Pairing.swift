import Foundation
import Security

/// What survives a scan of the desktop QR: where the daemon lives and which
/// exact certificate to trust. The session itself lives in the web view's
/// storage (the PWA's device-bound key), so this is identity-of-the-server,
/// not identity-of-the-phone.
struct Pairing: Codable, Equatable {
    /// Origin only — scheme://host:port. Never carries the one-time token.
    var origin: String
    /// base64url(SHA-256(cert DER)) from the QR's `fp` param. Nil when the QR
    /// pointed at a publicly-trusted hostname (tunnel mode) — then the system
    /// trust store applies unmodified.
    var fingerprint: String?
    /// The off-LAN door, learned from GET /m/relay-info on any LAN visit (so
    /// existing pairings gain remote access without re-scanning) or from the
    /// QR's `relay` param. Same certificate pin applies: the relay is a byte
    /// pipe, so the TLS peer through it is still this Mac.
    var relayOrigin: String?
    /// The LAN origin, remembered while connected over the relay so the app
    /// can prefer the fast local path again the moment it is reachable.
    var lanOrigin: String?

    var homeURL: URL? { URL(string: origin + "/m/") }

    /// Origins to try, in order: whatever we last used, then the remembered
    /// LAN address, then the relay. Deduplicated, order preserved.
    var candidateOrigins: [String] {
        var seen = Set<String>()
        return [origin, lanOrigin, relayOrigin]
            .compactMap { $0 }
            .filter { seen.insert($0).inserted }
    }
}

enum PairingParseError: LocalizedError {
    case notAURL
    case notHTTPS
    case notAPairingLink

    var errorDescription: String? {
        switch self {
        case .notAURL: return "That doesn't look like a link."
        case .notHTTPS: return "Pairing links are always https."
        case .notAPairingLink: return "That link has no pairing code. Open the Mobile panel on your Mac and scan the QR it shows."
        }
    }
}

enum PairingParser {
    /// Accepts the exact URL the daemon encodes in its QR:
    ///   https://<host>:<port>/m/?pair=<token>[&fp=<base64url sha-256>][&relay=<origin>]
    /// Returns the durable pairing plus the full one-time launch URL, which is
    /// loaded once so the PWA can consume the token.
    static func parse(_ raw: String) throws -> (pairing: Pairing, launchURL: URL) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme, let host = url.host else {
            throw PairingParseError.notAURL
        }
        guard scheme.lowercased() == "https" else { throw PairingParseError.notHTTPS }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let items = components?.queryItems ?? []
        guard items.contains(where: { $0.name == "pair" && !($0.value ?? "").isEmpty }) else {
            throw PairingParseError.notAPairingLink
        }
        let fp = items.first(where: { $0.name == "fp" })?.value
        var origin = "https://" + host
        if let port = url.port { origin += ":\(port)" }
        let relay = items.first(where: { $0.name == "relay" })?.value
        let pairing = Pairing(
            origin: origin,
            fingerprint: fp?.isEmpty == false ? fp : nil,
            relayOrigin: relay?.isEmpty == false ? relay : nil,
            lanOrigin: origin
        )
        return (pairing, url)
    }
}

/// Keychain persistence. The pairing is small, device-local, and should
/// survive reinstalls no better than the web session does — kSecAttrAccessible
/// keeps it usable in the background without syncing anywhere.
enum PairingStore {
    private static let service = "ai.breakthroughcoaching.clem.pairing"
    private static let account = "daemon"

    static func load() -> Pairing? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let pairing = try? JSONDecoder().decode(Pairing.self, from: data) else {
            return nil
        }
        return pairing
    }

    static func save(_ pairing: Pairing) {
        guard let data = try? JSONEncoder().encode(pairing) else { return }
        var query = baseQuery()
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    static func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
