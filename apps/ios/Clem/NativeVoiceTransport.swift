import Foundation
import Security
import CryptoKit
import Network

struct NativeVoiceProvisioningRequest: Sendable, Encodable {
    let requestId: String
    let publicKeyJwk: [String: String]
    var dictionary: [String: Any] { ["requestId": requestId, "publicKeyJwk": publicKeyJwk] }
}

struct NativeVoiceHTTPResponse: Sendable {
    let status: Int
    let headers: [String: String]
    let body: Data
}

enum NativeVoiceTransportError: LocalizedError, Equatable {
    case setup, unpaired, unauthorized, correlation, invalidRequest, invalidResponse, oversized, redirect, busy, pin, timeout
    var errorDescription: String? {
        switch self {
        case .setup: return "Native voice could not save its secure connection. Open Clem and try again."
        case .unpaired: return "Open Clem once to prepare voice for this Mac."
        case .unauthorized: return "Voice needs to reconnect. Open Clem to restore the connection."
        case .correlation: return "Voice setup changed. Open Clem and try again."
        case .invalidRequest, .invalidResponse: return "The voice connection returned an unsupported response."
        case .oversized: return "This voice recording or reply is too large. Try a shorter message."
        case .redirect: return "Voice refused an unexpected connection destination."
        case .busy: return "The previous voice request is still finishing."
        case .pin: return "This Mac’s security fingerprint no longer matches your pairing."
        case .timeout: return "The Mac did not answer. Check its connection and try again."
        }
    }
}

/// App-process transport. Neither the widget extension nor the web page owns
/// this private key. The widget App Group contains no voice credentials.
actor NativeVoiceTransport {
    private let pairing: Pairing
    private let account: String
    private var requestInFlight = false

    init(pairing: Pairing) {
        self.pairing = pairing
        self.account = nativeDigest(Data((pairing.fingerprint ?? "").utf8))
    }

    var isProvisioned: Bool {
        guard pairing.fingerprint?.isEmpty == false,
              let stored = NativeVoiceCredentialStore.load(account),
              let credential = stored.credential,
              credential.expiresAt > Date(), NativeVoiceCredentialStore.key(account, create: false) != nil else { return false }
        return stored.pairingFingerprint == pairing.fingerprint
    }

    func prepareProvisioning() throws -> NativeVoiceProvisioningRequest {
        let epoch = NativeVoiceCredentialStore.generation
        guard let fingerprint = pairing.fingerprint, !fingerprint.isEmpty,
              let key = NativeVoiceCredentialStore.key(account, create: true) else { throw NativeVoiceTransportError.unpaired }
        let jwk = try nativePublicJwk(key)
        let thumbprint = try nativeKeyThumbprint(jwk)
        if let stored = NativeVoiceCredentialStore.load(account), stored.pairingFingerprint == fingerprint,
           stored.keyThumbprint == thumbprint,
           stored.credential == nil || stored.credential!.expiresAt > Date() {
            // Readiness/unlock can repeat during a call. Never clear a live
            // credential merely because native readiness was announced again.
            return NativeVoiceProvisioningRequest(requestId: stored.requestId, publicKeyJwk: jwk)
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw NativeVoiceTransportError.setup }
        let requestId = nativeBase64URL(Data(bytes))
        let pending = NativeVoiceStoredCredential(pairingFingerprint: fingerprint, requestId: requestId,
            keyThumbprint: thumbprint, credential: nil)
        try NativeVoiceCredentialStore.save(pending, account: account, expectedGeneration: epoch)
        return NativeVoiceProvisioningRequest(requestId: requestId, publicKeyJwk: jwk)
    }

    /// Call only for the trusted paired main-frame bridge. Exact request and
    /// key receipts prevent a late page response replacing a new pairing.
    func acceptProvisioning(_ body: [String: Any]) throws {
        let epoch = NativeVoiceCredentialStore.generation
        guard let stored = NativeVoiceCredentialStore.load(account),
              stored.pairingFingerprint == pairing.fingerprint,
              body["requestId"] as? String == stored.requestId,
              body["ok"] as? Bool == true,
              body["keyThumbprint"] as? String == stored.keyThumbprint,
              let key = NativeVoiceCredentialStore.key(account, create: false),
              try nativeKeyThumbprint(nativePublicJwk(key)) == stored.keyThumbprint,
              let token = body["token"] as? String, nativeValidSecret(token),
              let sessionFingerprint = body["sessionFingerprint"] as? String,
              sessionFingerprint == nativeSessionFingerprint(token),
              let deviceId = body["deviceId"] as? String, !deviceId.isEmpty, deviceId.utf8.count <= 160,
              let expires = body["expiresAt"] as? String, let expiresAt = nativeDate(expires), expiresAt > Date() else {
            throw NativeVoiceTransportError.correlation
        }
        if let current = stored.credential {
            // A duplicate initial receipt cannot roll a rotated credential
            // back to the token that the server has already retired.
            guard current.token == token else { throw NativeVoiceTransportError.correlation }
            return
        }
        try NativeVoiceCredentialStore.save(NativeVoiceStoredCredential(pairingFingerprint: stored.pairingFingerprint,
            requestId: stored.requestId, keyThumbprint: stored.keyThumbprint,
            credential: .init(token: token, deviceId: deviceId, expiresAt: expiresAt)), account: account, expectedGeneration: epoch)
    }

    func clearCredentials() { NativeVoiceCredentialStore.remove(account) }
    nonisolated static func clearAllCredentials() { NativeVoiceCredentialStore.clearAll() }

    func request(path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil,
                 idempotencyKey: String? = nil) async throws -> NativeVoiceHTTPResponse {
        guard !requestInFlight else { throw NativeVoiceTransportError.busy }
        guard let fingerprint = pairing.fingerprint, !fingerprint.isEmpty,
              var stored = NativeVoiceCredentialStore.load(account), stored.pairingFingerprint == fingerprint,
              let credential = stored.credential, credential.expiresAt > Date(),
              let key = NativeVoiceCredentialStore.key(account, create: false) else { throw NativeVoiceTransportError.unpaired }
        guard path.hasPrefix("/m/"), !path.hasPrefix("//"), path.utf8.count <= 4096,
              !path.contains("#"), !path.contains("\\"), !path.unicodeScalars.contains(where: { $0.value < 33 || $0.value == 127 }),
              ["GET", "POST"].contains(method), (body?.count ?? 0) <= 15 * 1024 * 1024,
              [contentType, idempotencyKey].compactMap({ $0 }).allSatisfy({ !$0.contains("\r") && !$0.contains("\n") && $0.utf8.count <= 256 }) else {
            throw NativeVoiceTransportError.invalidRequest
        }
        let epoch = NativeVoiceCredentialStore.generation
        requestInFlight = true
        defer { requestInFlight = false }
        var lastError: Error = NativeVoiceTransportError.unpaired
        for origin in pairing.candidateOrigins {
            try Task.checkCancellation()
            guard epoch == NativeVoiceCredentialStore.generation else { throw NativeVoiceTransportError.unauthorized }
            guard let url = URLComponents(string: origin), url.scheme == "https", let host = url.host,
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
                  url.path.isEmpty || url.path == "/", let port = NWEndpoint.Port(rawValue: UInt16(exactly: url.port ?? 443) ?? 0), port.rawValue > 0 else { continue }
            var headers = ["Cookie": "clem_mobile_session=\(credential.token)",
                "x-clem-device-proof": try nativeProof(key: key, method: method, path: path, token: credential.token),
                "Accept": "application/json, audio/*", "Accept-Encoding": "identity"]
            if let contentType { headers["Content-Type"] = contentType }
            if let idempotencyKey { headers["idempotency-key"] = idempotencyKey }
            let operation = NativePinnedHTTPRequest(host: host, port: port, fingerprint: fingerprint, path: path,
                method: method, headers: headers, body: body ?? Data())
            let response: NativeVoiceHTTPResponse
            do {
                response = try await withTaskCancellationHandler(operation: { try await operation.run() }, onCancel: { operation.cancel() })
            } catch {
                // Never retry a trust failure at another door. A failed send
                // can be uncertain; only an idempotency-protected send retries.
                if error is CancellationError || (error as? NativeVoiceTransportError) == .pin { throw error }
                if method == "POST" && operation.didSendRequest && idempotencyKey == nil { throw error }
                lastError = error; continue
            }
            guard epoch == NativeVoiceCredentialStore.generation,
                  NativeVoiceCredentialStore.load(account)?.requestId == stored.requestId else { throw NativeVoiceTransportError.unauthorized }
            if (300...399).contains(response.status) { throw NativeVoiceTransportError.redirect }
            if response.status == 401 {
                NativeVoiceCredentialStore.removeCredential(account)
                return response
            }
            if let cookie = response.headers["set-cookie"] {
                guard let token = nativeSessionCookie(cookie), let nextFingerprint = response.headers["x-clem-session-fp"],
                      nextFingerprint == nativeSessionFingerprint(token) else { throw NativeVoiceTransportError.unauthorized }
                var next = credential; next.token = token
                stored.credential = next
                try NativeVoiceCredentialStore.save(stored, account: account, expectedGeneration: epoch)
            } else if let announced = response.headers["x-clem-session-fp"], announced != nativeSessionFingerprint(credential.token) {
                throw NativeVoiceTransportError.unauthorized
            }
            return response
        }
        throw lastError
    }
}

private struct NativeVoiceStoredCredential: Codable {
    let pairingFingerprint: String
    let requestId: String
    let keyThumbprint: String
    var credential: Credential?
    struct Credential: Codable { var token: String; let deviceId: String; var expiresAt: Date }
}

private enum NativeVoiceCredentialStore {
    static let service = "ai.breakthroughcoaching.clem.native-voice"
    private static let lock = NSRecursiveLock()
    private static var epoch: UInt64 = 0
    static var generation: UInt64 { lock.lock(); defer { lock.unlock() }; return epoch }
    static func load(_ account: String) -> NativeVoiceStoredCredential? {
        lock.lock(); defer { lock.unlock() }
        var query = base(account); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data, data.count < 8192 else { return nil }
        return try? JSONDecoder().decode(NativeVoiceStoredCredential.self, from: data)
    }
    static func save(_ value: NativeVoiceStoredCredential, account: String, expectedGeneration: UInt64) throws {
        lock.lock(); defer { lock.unlock() }
        guard epoch == expectedGeneration else { throw NativeVoiceTransportError.unauthorized }
        let data = try JSONEncoder().encode(value)
        let status = SecItemUpdate(base(account) as CFDictionary, [kSecValueData: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw NativeVoiceTransportError.setup }
        var query = base(account); query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw NativeVoiceTransportError.setup }
    }
    static func key(_ account: String, create: Bool) -> SecKey? {
        lock.lock(); defer { lock.unlock() }
        let tag = Data("\(service).\(account)".utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecReturnRef as String: true]
        var existing: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &existing) == errSecSuccess { return (existing as! SecKey) }
        guard create else { return nil }
        let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: tag,
                kSecAttrLabel as String: service, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]]
        return SecKeyCreateRandomKey(attributes as CFDictionary, nil)
    }
    static func removeCredential(_ account: String) {
        lock.lock(); defer { lock.unlock() }
        epoch &+= 1
        SecItemDelete(base(account) as CFDictionary)
    }
    static func remove(_ account: String) {
        lock.lock(); defer { lock.unlock() }
        removeCredential(account)
        SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: Data("\(service).\(account)".utf8)] as CFDictionary)
    }
    static func clearAll() {
        lock.lock(); defer { lock.unlock() }
        epoch &+= 1
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service] as CFDictionary)
        SecItemDelete([kSecClass: kSecClassKey, kSecAttrLabel: service] as CFDictionary)
    }
    private static func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
}

private func nativeBase64URL(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
private func nativeDigest(_ data: Data) -> String { nativeBase64URL(Data(SHA256.hash(data: data))) }
private func nativeValidSecret(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil }
private func nativeSessionFingerprint(_ token: String) -> String { SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32).description }
private func nativeDate(_ string: String) -> Date? {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: string) ?? ISO8601DateFormatter().date(from: string)
}
private func nativePublicJwk(_ key: SecKey) throws -> [String: String] {
    guard let publicKey = SecKeyCopyPublicKey(key), let raw = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?, raw.count == 65, raw.first == 4 else { throw NativeVoiceTransportError.setup }
    return ["kty": "EC", "crv": "P-256", "x": nativeBase64URL(raw.subdata(in: 1..<33)), "y": nativeBase64URL(raw.subdata(in: 33..<65))]
}
private func nativeKeyThumbprint(_ jwk: [String: String]) throws -> String { nativeDigest(try JSONSerialization.data(withJSONObject: jwk, options: [.sortedKeys, .withoutEscapingSlashes])) }
private func nativeProof(key: SecKey, method: String, path: String, token: String) throws -> String {
    let header = nativeBase64URL(try JSONSerialization.data(withJSONObject: ["alg": "ES256", "typ": "clem-dpop+jws"], options: [.sortedKeys]))
    let claims: [String: Any] = ["htm": method, "htu": String(path.split(separator: "?", maxSplits: 1)[0]), "iat": Int(Date().timeIntervalSince1970), "jti": UUID().uuidString, "sfp": nativeSessionFingerprint(token)]
    let payload = nativeBase64URL(try JSONSerialization.data(withJSONObject: claims, options: [.sortedKeys]))
    let signed = Data("\(header).\(payload)".utf8)
    guard let der = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, signed as CFData, nil) as Data? else { throw NativeVoiceTransportError.setup }
    let raw = try P256.Signing.ECDSASignature(derRepresentation: der).rawRepresentation
    return "\(header).\(payload).\(nativeBase64URL(raw))"
}
private func nativeSessionCookie(_ value: String) -> String? {
    let first = value.split(separator: ";", maxSplits: 1).first.map(String.init) ?? ""
    let prefix = "clem_mobile_session="
    guard first.hasPrefix(prefix) else { return nil }
    let token = String(first.dropFirst(prefix.count)); return nativeValidSecret(token) ? token : nil
}

/// Network.framework applies our exact certificate pin directly to TLS,
/// including the self-signed peer behind a public relay. It does not rely on
/// URLSession's ATS exemptions and never follows HTTP redirects.
private final class NativePinVerdict: @unchecked Sendable { var rejected = false }

private final class NativePinnedHTTPRequest: @unchecked Sendable {
    private let queue = DispatchQueue(label: "clem.native-voice.http")
    private let connection: NWConnection
    private let request: Data
    private var continuation: CheckedContinuation<NativeVoiceHTTPResponse, Error>?
    private var timeout: DispatchWorkItem?
    private var received = Data()
    private var completed = false
    private var cancelled = false
    private let pinVerdict = NativePinVerdict()
    private(set) var didSendRequest = false

    init(host: String, port: NWEndpoint.Port, fingerprint: String, path: String, method: String, headers: [String: String], body: Data) {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, host)
        sec_protocol_options_add_tls_application_protocol(tls.securityProtocolOptions, "http/1.1")
        let verdict = pinVerdict
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
            let match = CertificatePin.trustMatches(sec_trust_copy_ref(trust).takeRetainedValue(), fingerprint: fingerprint)
            if !match { verdict.rejected = true }
            complete(match)
        }, queue)
        let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        self.connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: parameters)
        let hostHeader = (host.contains(":") ? "[\(host)]" : host) + (port.rawValue == 443 ? "" : ":\(port.rawValue)")
        var text = "\(method) \(path) HTTP/1.1\r\nHost: \(hostHeader)\r\nConnection: close\r\nContent-Length: \(body.count)\r\n"
        for (name, value) in headers.sorted(by: { $0.key < $1.key }) { text += "\(name): \(value)\r\n" }
        var data = Data((text + "\r\n").utf8); data.append(body); self.request = data
    }

    func run() async throws -> NativeVoiceHTTPResponse {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.continuation = continuation
                if self.cancelled { self.finish(.failure(CancellationError())); return }
                self.armTimeout(seconds: 6)
                self.connection.stateUpdateHandler = { [weak self] state in
                    guard let self else { return }
                    switch state {
                    case .ready:
                        self.armTimeout(seconds: 90)
                        self.didSendRequest = true
                        self.connection.send(content: self.request, completion: .contentProcessed { error in
                            if let error { self.finish(.failure(error)) } else { self.receive() }
                        })
                    case .failed(let error): self.finish(.failure(self.pinVerdict.rejected ? NativeVoiceTransportError.pin : error))
                    case .cancelled: self.finish(.failure(CancellationError()))
                    default: break
                    }
                }
                self.connection.start(queue: self.queue)
            }
        }
    }
    func cancel() { queue.async { self.cancelled = true; if self.continuation != nil { self.finish(.failure(CancellationError())) } } }
    private func armTimeout(seconds: TimeInterval) {
        timeout?.cancel()
        let next = DispatchWorkItem { [weak self] in self?.finish(.failure(NativeVoiceTransportError.timeout)) }
        timeout = next; queue.asyncAfter(deadline: .now() + seconds, execute: next)
    }
    private func receive() {
        guard !completed else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, closed, error in
            guard let self, !self.completed else { return }
            if let data { self.received.append(data) }
            do {
                if let response = try NativeVoiceHTTPParser.parse(self.received, closed: closed) { self.finish(.success(response)); return }
            } catch { self.finish(.failure(error)); return }
            if let error { self.finish(.failure(error)); return }
            self.receive()
        }
    }
    private func finish(_ result: Result<NativeVoiceHTTPResponse, Error>) {
        guard !completed else { return }; completed = true
        timeout?.cancel(); timeout = nil; connection.stateUpdateHandler = nil; connection.cancel()
        let waiting = continuation; continuation = nil; waiting?.resume(with: result)
    }
}

/// Bounded HTTP/1.1 framing; exposed internally for fixture tests. No redirects,
/// decompression, ambiguous framing, or an unbounded streaming event feed.
enum NativeVoiceHTTPParser {
    static let maximumBody = 20 * 1024 * 1024
    static let maximumHeaders = 32 * 1024
    static func parse(_ data: Data, closed: Bool) throws -> NativeVoiceHTTPResponse? {
        guard data.count <= maximumBody + maximumHeaders else { throw NativeVoiceTransportError.oversized }
        guard let boundary = data.range(of: Data("\r\n\r\n".utf8)) else {
            if closed || data.count > maximumHeaders { throw NativeVoiceTransportError.invalidResponse }; return nil
        }
        guard boundary.lowerBound <= maximumHeaders,
              let head = String(data: data.prefix(upTo: boundary.lowerBound), encoding: .utf8) else { throw NativeVoiceTransportError.invalidResponse }
        let lines = head.components(separatedBy: "\r\n")
        let statusParts = (lines.first ?? "").split(separator: " ", maxSplits: 2)
        guard statusParts.count >= 2, ["HTTP/1.0", "HTTP/1.1"].contains(String(statusParts[0])),
              statusParts[1].count == 3, let status = Int(statusParts[1]), (200...599).contains(status) else { throw NativeVoiceTransportError.invalidResponse }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let split = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw NativeVoiceTransportError.invalidResponse }
            let name = String(line[..<split]).lowercased()
            let value = String(line[line.index(after: split)...]).trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, name.range(of: "^[a-z0-9!#$%&'*+.^_`|~-]+$", options: .regularExpression) != nil,
                  !value.unicodeScalars.contains(where: { $0.value < 32 && $0.value != 9 || $0.value == 127 }) else { throw NativeVoiceTransportError.invalidResponse }
            if headers[name] != nil {
                if ["content-length", "transfer-encoding", "set-cookie", "x-clem-session-fp"].contains(name) { throw NativeVoiceTransportError.invalidResponse }
                headers[name]! += ", " + value
            } else { headers[name] = value }
        }
        guard headers["content-encoding"] == nil || headers["content-encoding"]?.lowercased() == "identity" else { throw NativeVoiceTransportError.invalidResponse }
        let body = Data(data.suffix(from: boundary.upperBound))
        if let transfer = headers["transfer-encoding"] {
            guard transfer.lowercased() == "chunked", headers["content-length"] == nil else { throw NativeVoiceTransportError.invalidResponse }
            guard let decoded = try decodeChunks(body, closed: closed) else { return nil }
            return NativeVoiceHTTPResponse(status: status, headers: headers, body: decoded)
        }
        if let rawLength = headers["content-length"] {
            guard rawLength.range(of: "^[0-9]+$", options: .regularExpression) != nil, let length = Int(rawLength), length <= maximumBody else { throw NativeVoiceTransportError.oversized }
            if body.count < length { if closed { throw NativeVoiceTransportError.invalidResponse }; return nil }
            guard body.count == length else { throw NativeVoiceTransportError.invalidResponse }
            return NativeVoiceHTTPResponse(status: status, headers: headers, body: body)
        }
        if status == 204 || status == 304 {
            guard body.isEmpty else { throw NativeVoiceTransportError.invalidResponse }
            return NativeVoiceHTTPResponse(status: status, headers: headers, body: body)
        }
        guard closed else { return nil }
        return NativeVoiceHTTPResponse(status: status, headers: headers, body: body)
    }
    private static func decodeChunks(_ data: Data, closed: Bool) throws -> Data? {
        var cursor = 0; var output = Data()
        func incomplete() throws -> Data? { if closed { throw NativeVoiceTransportError.invalidResponse }; return nil }
        while cursor < data.count {
            guard let line = data.range(of: Data("\r\n".utf8), in: cursor..<data.count) else { return try incomplete() }
            guard line.lowerBound - cursor <= 256,
                  let raw = String(data: data.subdata(in: cursor..<line.lowerBound), encoding: .ascii) else { throw NativeVoiceTransportError.invalidResponse }
            let digits = raw.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
            guard !digits.isEmpty, digits.range(of: "^[a-fA-F0-9]+$", options: .regularExpression) != nil,
                  let count = Int(digits, radix: 16), count <= maximumBody - output.count else { throw NativeVoiceTransportError.oversized }
            cursor = line.upperBound
            if count == 0 {
                // Express sends no trailers. Refuse them instead of allowing
                // a trailer to change credentials or response framing.
                guard data.count >= cursor + 2 else { return try incomplete() }
                guard data.subdata(in: cursor..<(cursor + 2)) == Data("\r\n".utf8), data.count == cursor + 2 else { throw NativeVoiceTransportError.invalidResponse }
                return output
            }
            guard data.count >= cursor + count + 2 else { return try incomplete() }
            output.append(data.subdata(in: cursor..<(cursor + count))); cursor += count
            guard data.subdata(in: cursor..<(cursor + 2)) == Data("\r\n".utf8) else { throw NativeVoiceTransportError.invalidResponse }; cursor += 2
        }
        return try incomplete()
    }
}
