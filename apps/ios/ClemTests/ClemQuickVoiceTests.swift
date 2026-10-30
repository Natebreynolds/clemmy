import Foundation
import XCTest
@testable import Clem

final class ClemQuickVoiceTests: XCTestCase {
    private let pin = Pairing(origin: "https://fixture.invalid", fingerprint: "quick-voice-fixture")
    private let id = "11111111-2222-4333-8444-555555555555"
    private func packet(_ operation: ClemQuickVoicePacket.Operation = .ask, text: String? = "Read the synthetic channel and draft a reply.",
                        conversation: String? = nil, id: String? = nil) -> ClemQuickVoicePacket {
        .init(version: 1, operation: operation, requestId: id ?? self.id, text: text, conversationId: conversation)
    }
    private func service(_ http: QuickVoiceHTTPFixture, _ store: QuickVoiceMemoryStorage = .init()) -> ClemQuickVoiceService {
        let pin = self.pin
        return ClemQuickVoiceService(storage: store, pairing: { pin }, client: { _ in http }, sleep: {},
            now: { Date(timeIntervalSince1970: 1_800_000_000) })
    }

    func testCheckInReadsSnapshotWithoutStartingChatAndKeepsPartialWords() async throws {
        let http = QuickVoiceHTTPFixture([
            .object(200, ["status": "partial", "generatedAt": "2026-10-29T20:00:00.000Z", "spokenText": "Two things need you. Running work is unavailable."]),
        ])
        let result = await service(http).perform(packet(.checkIn, text: nil))
        XCTAssertEqual(result.status, .completed, "only the snapshot read finished")
        XCTAssertEqual(result.spokenText, "Two things need you. Running work is unavailable.")
        let requests = await http.requests
        XCTAssertEqual(requests.map(\.method), ["GET"])
        XCTAssertEqual(requests.map(\.path), ["/m/api/voice/check-in"])
    }

    func testAcceptedTaskAndReadLatestNeverResubmitAndNeedTypedCompletion() async throws {
        let http = QuickVoiceHTTPFixture([
            .object(202, ["accepted": true, "sessionId": "synthetic-conversation"]),
            .object(200, ["state": "working", "sessionId": "synthetic-conversation"]),
            .object(200, ["state": "answered", "taskStatus": "done", "kind": "answer", "sessionId": "synthetic-conversation", "text": "Draft ready. Nothing was sent."]),
        ])
        let store = QuickVoiceMemoryStorage()
        let app = service(http, store)
        let accepted = await app.perform(packet())
        XCTAssertEqual(accepted.status, .working)
        XCTAssertEqual(accepted.taskRequestId, id)
        let finished = await app.latestResult()
        XCTAssertEqual(finished.status, .completed)
        XCTAssertEqual(finished.conversationId, "synthetic-conversation")
        XCTAssertEqual(finished.spokenText, "Draft ready. Nothing was sent.")
        let replay = await app.perform(packet())
        XCTAssertEqual(replay.status, .completed)
        let requests = await http.requests
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertEqual(requests.count, 3, "stored terminal replay makes no network call")
        let body = try XCTUnwrap(requests.first?.body)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(sent["message"] as? String, packet().text)
        XCTAssertEqual(sent["requireIdle"] as? Bool, true)
        XCTAssertEqual(sent["voice"] as? Bool, true)
        XCTAssertEqual(requests.first?.key, id)
    }

    func testLostPostResponseThenMissingReceiptDoesNotInventAnotherSend() async {
        let http = QuickVoiceHTTPFixture([.lost, .object(404, ["error": "REQUEST_NOT_FOUND"])])
        let store = QuickVoiceMemoryStorage()
        let app = service(http, store)
        let uncertain = await app.perform(packet())
        XCTAssertEqual(uncertain.status, .working)
        // Simulate process restart: only durable exact receipts survive.
        let recovered = await service(http, store).perform(packet(.result, text: nil))
        XCTAssertEqual(recovered.status, .working)
        let requests = await http.requests
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertTrue(requests.last!.path.contains(id))
    }

    func testExplicitOriginalRetryRequiresExact404AndUsesIdenticalBytesAndKey() async {
        let http = QuickVoiceHTTPFixture([
            .lost,
            .object(404, ["error": "REQUEST_NOT_FOUND"]),
            .object(202, ["accepted": true, "sessionId": "synthetic-conversation"]),
            .object(200, ["state": "answered", "taskStatus": "done", "kind": "answer", "sessionId": "synthetic-conversation", "text": "The controlled draft is ready."]),
        ])
        let store = QuickVoiceMemoryStorage()
        let first = await service(http, store).perform(packet())
        XCTAssertEqual(first.status, .working)
        let result = await service(http, store).retryLatest()
        XCTAssertEqual(result.status, .completed)
        let requests = await http.requests
        XCTAssertEqual(requests.map(\.method), ["POST", "GET", "POST", "GET"])
        let posts = requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts[0].body, posts[1].body)
        XCTAssertEqual(posts[0].key, posts[1].key)
    }

    func testOriginalRetryWithAcceptedReceiptOnlyReadsAndNeverPostsAgain() async {
        let http = QuickVoiceHTTPFixture([
            .lost,
            .object(200, ["state": "answered", "taskStatus": "done", "kind": "answer", "sessionId": "synthetic-conversation", "text": "That original request finished."]),
        ])
        let app = service(http)
        _ = await app.perform(packet())
        let result = await app.perform(packet())
        XCTAssertEqual(result.status, .completed)
        let requests = await http.requests
        XCTAssertEqual(requests.map(\.method), ["POST", "GET"])
    }

    func testUnexpected404AndChangedPairingCannotReplayOriginalAsk() async {
        let http = QuickVoiceHTTPFixture([.lost, .object(404, ["error": "OTHER_NOT_FOUND"])])
        let store = QuickVoiceMemoryStorage()
        _ = await service(http, store).perform(packet())
        _ = await service(http, store).perform(packet())
        let other = Pairing(origin: "https://other.invalid", fingerprint: "different-fixture-pin")
        let changed = ClemQuickVoiceService(storage: store, pairing: { other }, client: { _ in http }, sleep: {})
        let refused = await changed.perform(packet())
        XCTAssertEqual(refused.status, .unavailable)
        let requests = await http.requests
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 1)
    }

    func testKnownUnacceptedResponseSettlesSoItDoesNotHoldAllLaterAsks() async {
        let http = QuickVoiceHTTPFixture([
            .object(403, ["error": "NO_SESSION"]),
            .object(202, ["accepted": true, "sessionId": "synthetic-conversation"]),
            .object(200, ["state": "working", "sessionId": "synthetic-conversation"]),
        ])
        let app = service(http)
        let refusal = await app.perform(packet())
        XCTAssertEqual(refusal.status, .unavailable)
        let next = await app.perform(packet(text: "Read the controlled fixture.", id: UUID().uuidString))
        XCTAssertEqual(next.status, .working)
        let requests = await http.requests
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 2)
    }

    func testNewAskWhileOriginalUnconfirmedNeverBorrowsItsTaskReceipt() async throws {
        let http = QuickVoiceHTTPFixture([
            .object(202, ["accepted": true, "sessionId": "synthetic-conversation"]),
            .object(200, ["state": "working", "sessionId": "synthetic-conversation"]),
            .object(200, ["state": "answered", "taskStatus": "done", "kind": "answer", "sessionId": "synthetic-conversation", "text": "Original draft ready."]),
        ])
        let store = QuickVoiceMemoryStorage()
        let app = service(http, store)
        _ = await app.perform(packet())
        let newID = UUID().uuidString
        let held = await app.perform(packet(text: "A different explicit request.", id: newID))
        XCTAssertEqual(held.requestId, newID)
        XCTAssertEqual(held.status, .needsOwner)
        XCTAssertNil(held.taskRequestId, "a new unadmitted packet must not inherit another task's receipt")
        XCTAssertNil(held.conversationId)
        XCTAssertEqual(try store.load()?.tasks.count, 1)
        let original = await app.latestResult()
        XCTAssertEqual(original.requestId, id)
        XCTAssertEqual(original.status, .completed)
        let requests = await http.requests
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 1)
    }

    func testRecoverableOwnerHoldReopensCanonicalResultInsteadOfFreezingCachedQuestion() async {
        let http = QuickVoiceHTTPFixture([
            .object(202, ["accepted": true, "sessionId": "synthetic-conversation"]),
            .object(200, ["state": "needs_app", "taskStatus": "needs_approval", "kind": "approval", "sessionId": "synthetic-conversation", "text": "Please review the prepared draft."]),
            .object(200, ["state": "answered", "taskStatus": "done", "kind": "answer", "sessionId": "synthetic-conversation", "text": "The reviewed request is complete."]),
        ])
        let app = service(http)
        let pause = await app.perform(packet())
        XCTAssertEqual(pause.status, .needsOwner)
        let resolved = await app.latestResult()
        XCTAssertEqual(resolved.status, .completed)
        XCTAssertEqual(resolved.spokenText, "The reviewed request is complete.")
        let replay = await app.latestResult()
        XCTAssertEqual(replay, resolved, "a completed answer stays monotone without a fresh GET")
        let requests = await http.requests
        XCTAssertEqual(requests.map(\.method), ["POST", "GET", "GET"])
    }

    func testPreviouslyAcceptedTaskNeverReplaysPostEvenIfStatusReceiptDisappears() async {
        let http = QuickVoiceHTTPFixture([
            .object(202, ["accepted": true, "sessionId": "synthetic-conversation"]),
            .object(200, ["state": "working", "sessionId": "synthetic-conversation"]),
            .object(404, ["error": "REQUEST_NOT_FOUND"]),
        ])
        let app = service(http)
        _ = await app.perform(packet())
        let missing = await app.perform(packet())
        XCTAssertEqual(missing.status, .working)
        let requests = await http.requests
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 1)
    }

    func testSameReceiptChangedWordsAndForeignConversationAreRefusedBeforeDispatch() async {
        let http = QuickVoiceHTTPFixture([
            .object(202, ["accepted": true, "sessionId": "synthetic-conversation"]),
            .object(200, ["state": "working", "sessionId": "synthetic-conversation"]),
        ])
        let app = service(http)
        _ = await app.perform(packet())
        let changed = await app.perform(packet(text: "Send something different."))
        XCTAssertEqual(changed.status, .failed)
        let foreign = await app.perform(packet(conversation: "foreign-conversation", id: UUID().uuidString))
        XCTAssertEqual(foreign.status, .needsOwner)
        let requests = await http.requests
        XCTAssertEqual(requests.count, 2)
    }

    func testOrdinaryQuestionApprovalAndMissingTypedStatusNeverClaimTaskDone() async {
        for fields: [String: Any] in [
            ["state": "answered", "taskStatus": "needs_input", "kind": "question"],
            ["state": "needs_app", "taskStatus": "needs_approval", "kind": "approval"],
            ["state": "answered"],
        ] {
            let terminal = fields.merging(["sessionId": "synthetic-conversation", "text": "What cutoff should I use?"]) { first, _ in first }
            let http = QuickVoiceHTTPFixture([.object(202, ["accepted": true, "sessionId": "synthetic-conversation"]), .object(200, terminal)])
            let result = await service(http).perform(packet())
            XCTAssertEqual(result.status, .needsOwner)
            XCTAssertEqual(result.spokenText, "What cutoff should I use?")
        }
    }

    func testExactAcceptedConversationSupportsNewExplicitFollowUp() async throws {
        let http = QuickVoiceHTTPFixture([
            .object(202, ["accepted": true, "sessionId": "synthetic-conversation"]),
            .object(200, ["state": "answered", "taskStatus": "done", "kind": "answer", "sessionId": "synthetic-conversation", "text": "Draft ready."]),
            .object(202, ["accepted": true, "sessionId": "synthetic-conversation"]),
            .object(200, ["state": "working", "sessionId": "synthetic-conversation"]),
        ])
        let app = service(http)
        _ = await app.perform(packet())
        let next = await app.perform(packet(text: "Make that draft shorter.", conversation: "synthetic-conversation", id: UUID().uuidString))
        XCTAssertEqual(next.status, .working)
        let requests = await http.requests
        let body = try XCTUnwrap(requests.last(where: { $0.method == "POST" })?.body)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(sent["sessionId"] as? String, "synthetic-conversation")
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 2)
    }

    func testRevocationWhileRequestIsInFlightCannotRestoreReceiptsOrSpeech() async {
        let store = QuickVoiceMemoryStorage()
        let http = QuickVoiceHTTPFixture([.object(200, ["status": "ok", "generatedAt": "2026-10-29T20:00:00Z", "spokenText": "This must not be spoken."])])
        await http.beforeResponse { store.revoke() }
        let result = await service(http, store).perform(packet(.checkIn, text: nil))
        XCTAssertEqual(result.status, .unavailable)
        XCTAssertFalse(result.spokenText.contains("This must not"))
        XCTAssertNil(try? store.load())
    }

    func testStorageFailureRefusesAskBeforeAnyPost() async {
        let store = QuickVoiceMemoryStorage(); store.failSave = true
        let http = QuickVoiceHTTPFixture([])
        let result = await service(http, store).perform(packet())
        XCTAssertEqual(result.status, .unavailable)
        let requests = await http.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testWatchEnvelopeRejectsUnknownFieldsAndKeepsExactOperation() {
        XCTAssertNotNil(ClemWatchRelay.packet(["version": 1, "operation": "ask", "requestId": id, "text": "Read my fixture channel."]))
        XCTAssertNotNil(ClemWatchRelay.packet(["version": 1, "operation": "result", "requestId": id]))
        XCTAssertNil(ClemWatchRelay.packet(["version": 1, "operation": "ask", "requestId": id, "text": "Read it", "token": "must-not-cross"]))
        XCTAssertNil(ClemWatchRelay.packet(["version": 1, "operation": "approve", "requestId": id]))
        XCTAssertNil(ClemWatchRelay.packet(["version": 1, "operation": "ask", "requestId": "not-a-uuid", "text": "Read it"]))
    }

    func testActualReadbackFenceDropsLatePrivateAnswerAfterRevocationOrPairingChange() {
        let value = ClemQuickVoiceReply(requestId: id, status: .completed, spokenText: "CONTROLLED_PRIVATE_DRAFT",
            conversationId: "synthetic-conversation", taskRequestId: id)
        let original = ClemQuickVoiceDeliveryContext(pairingFingerprint: "fixture-pin", generation: 10)
        XCTAssertEqual(ClemQuickVoiceDelivery.fence(value, captured: original, current: original), value)
        for changed in [ClemQuickVoiceDeliveryContext(pairingFingerprint: "fixture-pin", generation: 11),
                        .init(pairingFingerprint: "other-fixture-pin", generation: 10),
                        .init(pairingFingerprint: nil, generation: 11)] {
            let redacted = ClemQuickVoiceDelivery.fence(value, captured: original, current: changed)
            XCTAssertEqual(redacted.status, .unavailable)
            XCTAssertNil(redacted.taskRequestId)
            XCTAssertNil(redacted.conversationId)
            XCTAssertFalse(redacted.spokenText.contains("CONTROLLED_PRIVATE"))
        }
    }
}

private actor QuickVoiceHTTPFixture: ClemQuickVoiceHTTP {
    struct Request: Sendable { let path: String; let method: String; let body: Data?; let key: String? }
    enum Response: @unchecked Sendable {
        case object(Int, [String: Any]), lost
    }
    var requests: [Request] = []
    private var responses: [Response]
    private var callback: (@Sendable () -> Void)?
    init(_ responses: [Response]) { self.responses = responses }
    func ready() -> Bool { true }
    func beforeResponse(_ action: @escaping @Sendable () -> Void) { callback = action }
    func request(path: String, method: String, body: Data?, contentType: String?, idempotencyKey: String?) async throws -> NativeVoiceHTTPResponse {
        requests.append(.init(path: path, method: method, body: body, key: idempotencyKey))
        callback?()
        guard !responses.isEmpty else { throw ClemQuickVoiceFailure.response }
        switch responses.removeFirst() {
        case .lost: throw URLError(.networkConnectionLost)
        case .object(let status, let value): return .init(status: status, headers: [:], body: try JSONSerialization.data(withJSONObject: value))
        }
    }
}

private final class QuickVoiceMemoryStorage: ClemQuickVoiceStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var ledger: ClemQuickVoiceLedger?
    private var epoch: UInt64 = 0
    var failSave = false
    var generation: UInt64 { lock.lock(); defer { lock.unlock() }; return epoch }
    func load() throws -> ClemQuickVoiceLedger? { lock.lock(); defer { lock.unlock() }; return ledger }
    func save(_ value: ClemQuickVoiceLedger, generation: UInt64) throws {
        lock.lock(); defer { lock.unlock() }
        guard !failSave, generation == epoch else { throw ClemQuickVoiceFailure.storage }
        ledger = value
    }
    func revoke() { lock.lock(); defer { lock.unlock() }; epoch &+= 1; ledger = nil }
}
