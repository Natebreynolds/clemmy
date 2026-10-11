import XCTest
import JavaScriptCore
import CryptoKit
@testable import Clem

final class NativeVoiceTransportTests: XCTestCase {
    func testLateEnrollmentReceiptsCannotReplaceTheReconnectedCredential() async throws {
        let transport = NativeVoiceTransport(pairing: Pairing(origin: "https://fixture.invalid", fingerprint: "fixture-\(UUID().uuidString)"))
        func receipt(_ request: NativeVoiceProvisioningRequest, token: String) throws -> [String: Any] {
            let jwkBytes = try JSONSerialization.data(withJSONObject: request.publicKeyJwk, options: [.sortedKeys, .withoutEscapingSlashes])
            let thumbprint = Data(SHA256.hash(data: jwkBytes)).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let fingerprint = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32)
            return ["requestId": request.requestId, "ok": true, "keyThumbprint": thumbprint,
                "token": token, "sessionFingerprint": String(fingerprint), "deviceId": "synthetic-device",
                "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))]
        }
        do {
            let a = try await transport.prepareProvisioning()
            let oldSuccess = try receipt(a, token: String(repeating: "a", count: 43))
            await transport.clearCredentials()
            let b = try await transport.prepareProvisioning()
            XCTAssertNotEqual(a.requestId, b.requestId)
            let currentSuccess = try receipt(b, token: String(repeating: "b", count: 43))
            let accepted = try await transport.acceptProvisioning(currentSuccess)
            XCTAssertEqual(accepted, .accepted)
            let lateSuccess = try await transport.acceptProvisioning(oldSuccess)
            XCTAssertEqual(lateSuccess, .obsolete)
            let readyAfterSuccess = await transport.isProvisioned
            XCTAssertTrue(readyAfterSuccess)
            let lateFailure = try await transport.acceptProvisioning(["requestId": a.requestId, "ok": false, "reason": "unauthorized"])
            XCTAssertEqual(lateFailure, .obsolete)
            let readyAfterFailure = await transport.isProvisioned
            XCTAssertTrue(readyAfterFailure)
            let stillB = try await transport.prepareProvisioning()
            XCTAssertEqual(stillB.requestId, b.requestId)
            XCTAssertEqual(stillB.publicKeyJwk, b.publicKeyJwk)
            let unchangedCredential = try await transport.acceptProvisioning(currentSuccess)
            XCTAssertEqual(unchangedCredential, .accepted)
        } catch {
            await transport.clearCredentials()
            throw error
        }
        await transport.clearCredentials()
    }

    func testNativeKeychainProvisioningAndRepeatedReadiness() async throws {
        // A unique synthetic pairing creates only this test's own app-Keychain
        // account; do not clear other pairings or contact any server.
        let transport = NativeVoiceTransport(pairing: Pairing(origin: "https://fixture.invalid", fingerprint: "fixture-\(UUID().uuidString)"))
        do {
            let first = try await transport.prepareProvisioning()
            let pendingRetry = try await transport.prepareProvisioning()
            XCTAssertEqual(first.requestId, pendingRetry.requestId)
            XCTAssertEqual(first.publicKeyJwk, pendingRetry.publicKeyJwk)
            XCTAssertEqual(first.publicKeyJwk["x"]?.count, 43)
            XCTAssertEqual(first.publicKeyJwk["y"]?.count, 43)
            XCTAssertNil(first.publicKeyJwk["d"])
            do {
                try await transport.acceptProvisioning(["requestId": "unrelated", "ok": false, "reason": "timeout"])
                XCTFail("An unrelated receipt must not classify or change this enrollment")
            } catch { XCTAssertEqual(error as? NativeVoiceTransportError, .correlation) }
            do {
                try await transport.acceptProvisioning(["requestId": first.requestId, "ok": false, "reason": "timeout"])
                XCTFail("A failed enrollment must report its bounded cause")
            } catch { XCTAssertEqual(error as? NativeVoiceTransportError, .timeout) }
            let retryAfterFailure = try await transport.prepareProvisioning()
            XCTAssertEqual(retryAfterFailure.requestId, first.requestId)
            let jwkBytes = try JSONSerialization.data(withJSONObject: first.publicKeyJwk, options: [.sortedKeys, .withoutEscapingSlashes])
            let thumbprint = Data(SHA256.hash(data: jwkBytes)).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let token = String(repeating: "a", count: 43)
            let sessionFingerprint = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32)
            let body: [String: Any] = ["requestId": first.requestId, "ok": true, "keyThumbprint": thumbprint,
                "token": token, "sessionFingerprint": String(sessionFingerprint), "deviceId": "synthetic-device",
                "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))]
            try await transport.acceptProvisioning(body)
            let ready = await transport.isProvisioned
            XCTAssertTrue(ready)
            let liveRetry = try await transport.prepareProvisioning()
            XCTAssertEqual(liveRetry.requestId, first.requestId)
            let remainsReady = await transport.isProvisioned
            XCTAssertTrue(remainsReady)
        } catch {
            await transport.clearCredentials()
            throw error
        }
        await transport.clearCredentials()
        let cleared = await transport.isProvisioned
        XCTAssertFalse(cleared)
    }

    func testProvisioningFailureReasonsAreBounded() {
        XCTAssertEqual(NativeVoiceProvisioningFailure.error(reason: "timeout"), .timeout)
        XCTAssertEqual(NativeVoiceProvisioningFailure.error(reason: "offline"), .unreachable)
        XCTAssertEqual(NativeVoiceProvisioningFailure.error(reason: "unauthorized"), .unauthorized)
        XCTAssertEqual(NativeVoiceProvisioningFailure.error(reason: "unavailable"), .unavailable)
        XCTAssertEqual(NativeVoiceProvisioningFailure.error(reason: "invalidResponse"), .invalidResponse)
        XCTAssertEqual(NativeVoiceProvisioningFailure.error(reason: "private server payload"), .invalidResponse)
    }

    func testUsesNewlyDiscoveredDoorsOnlyForTheBoundMac() {
        let old = Pairing(origin: "https://old.invalid", fingerprint: "paired-pin")
        let discovered = Pairing(origin: "https://new.invalid", fingerprint: "paired-pin", relayOrigin: "https://relay.invalid")
        XCTAssertEqual(NativeVoiceOriginSelection.candidates(bound: old, current: discovered), ["https://new.invalid", "https://relay.invalid"])
        XCTAssertEqual(NativeVoiceOriginSelection.candidates(bound: old, current: nil), [])
        XCTAssertEqual(NativeVoiceOriginSelection.candidates(bound: old, current: Pairing(origin: "https://other.invalid", fingerprint: "other-pin")), [])
    }

    func testBridgeReportsMissingCallbackAndDispatchesExactRequest() throws {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript("var window = {};")
        let json = #"{"requestId":"synthetic-request","publicKeyJwk":{"kty":"EC"}}"#
        let script = NativeVoiceBridgeDispatch.script(requestJSON: json)
        XCTAssertFalse(try XCTUnwrap(context.evaluateScript(script)).toBool())
        context.evaluateScript("window.clemNative = {};")
        XCTAssertFalse(try XCTUnwrap(context.evaluateScript(script)).toBool())
        context.evaluateScript("window.clemNative.prepareVoice = request => { window.received = request; };")
        XCTAssertTrue(try XCTUnwrap(context.evaluateScript(script)).toBool())
        XCTAssertEqual(context.evaluateScript("window.received.requestId")?.toString(), "synthetic-request")
        XCTAssertNil(context.exception)
        XCTAssertTrue(NativeVoiceBridgeDispatch.wasDispatched(true))
        XCTAssertFalse(NativeVoiceBridgeDispatch.wasDispatched(false))
        XCTAssertFalse(NativeVoiceBridgeDispatch.wasDispatched(nil))
    }

    private func response(_ text: String, closed: Bool = true) throws -> NativeVoiceHTTPResponse? {
        try NativeVoiceHTTPParser.parse(Data(text.utf8), closed: closed)
    }
    func testBoundedContentLengthAndPartialBody() throws {
        XCTAssertNil(try response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe", closed: false))
        XCTAssertEqual(try response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello")?.body, Data("hello".utf8))
        XCTAssertThrowsError(try response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe"))
        XCTAssertThrowsError(try response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloextra"))
    }
    func testChunkedAudioAndPartialChunks() throws {
        let start = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: audio/mpeg\r\n\r\n"
        XCTAssertNil(try response(start + "5\r\nhel", closed: false))
        XCTAssertEqual(try response(start + "5\r\nhello\r\n1\r\n!\r\n0\r\n\r\n")?.body, Data("hello!".utf8))
        for bad in ["\r\n", ";extension\r\n", "g\r\n", "0\r\nSet-Cookie: stolen\r\n\r\n", "1\r\naXX0\r\n\r\n"] {
            XCTAssertThrowsError(try response(start + bad))
        }
    }
    func testRefusesAmbiguousFramingCredentialHeadersAndCompression() throws {
        for fields in ["Content-Length: 0\r\nContent-Length: 0", "Transfer-Encoding: chunked\r\nContent-Length: 0", "Set-Cookie: a\r\nSet-Cookie: b", "x-clem-session-fp: a\r\nx-clem-session-fp: b", "Content-Encoding: gzip", " Bad: folded"] {
            XCTAssertThrowsError(try response("HTTP/1.1 200 OK\r\n" + fields + "\r\n\r\n"))
        }
    }
    func testLimitsAndClosedUnframedResponse() throws {
        XCTAssertThrowsError(try response("HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n"))
        XCTAssertThrowsError(try response(String(repeating: "x", count: NativeVoiceHTTPParser.maximumHeaders + 1), closed: false))
        XCTAssertNil(try response("HTTP/1.1 200 OK\r\n\r\nhello", closed: false))
        XCTAssertEqual(try response("HTTP/1.1 200 OK\r\n\r\nhello")?.body, Data("hello".utf8))
        XCTAssertEqual(try response("HTTP/1.1 302 Found\r\nLocation: https://unpaired.invalid\r\nContent-Length: 0\r\n\r\n")?.status, 302)
    }
}
