import XCTest
@testable import ClemWatch

final class ClemWatchRequestTests: XCTestCase {
    private let task = UUID(uuidString: "C2E21705-A609-4BB2-AED7-FD07F7C15811")!

    func testAskCarriesOnlyItsExactTextThreadAndRequest() throws {
        let request = try ClemWatchRequest.ask("Draft a short check-in.", id: task, conversationID: "controlled-thread")
        XCTAssertEqual(request.dictionary["text"] as? String, "Draft a short check-in.")
        XCTAssertEqual(request.dictionary["conversationId"] as? String, "controlled-thread")
        XCTAssertEqual(request.dictionary["requestId"] as? String, task.uuidString)
        XCTAssertEqual(Set(request.dictionary.keys), ["version", "operation", "requestId", "text", "conversationId"])
    }

    func testEmptyAndOversizedAsksAreNotPrepared() {
        XCTAssertThrowsError(try ClemWatchRequest.ask(" \n ", id: task, conversationID: nil))
        XCTAssertThrowsError(try ClemWatchRequest.ask(String(repeating: "x", count: 8_001), id: task, conversationID: nil))
    }

    func testResultIsReadOnlyAndUsesOriginalTaskKey() {
        let request = ClemWatchRequest.result(task)
        XCTAssertEqual(request.requestID, task)
        XCTAssertEqual(request.operation, .result)
        XCTAssertNil(request.dictionary["text"])
        XCTAssertNil(request.dictionary["conversationId"])
    }

    func testReplyRequiresSameRequestAndClosedStatus() throws {
        var packet: [String: Any] = ["version": 1, "requestId": task.uuidString,
                                    "status": "working", "spokenText": "Still working."]
        XCTAssertEqual(try ClemWatchReply.decode(packet, for: task).status, .working)
        XCTAssertThrowsError(try ClemWatchReply.decode(packet, for: UUID()))
        packet["status"] = "answered"
        XCTAssertThrowsError(try ClemWatchReply.decode(packet, for: task))
    }

    func testBooleanVersionAndUnrelatedTaskReceiptAreRejected() {
        var packet: [String: Any] = ["version": true, "requestId": task.uuidString,
                                    "status": "completed", "spokenText": "A controlled result."]
        XCTAssertThrowsError(try ClemWatchReply.decode(packet, for: task))
        packet["version"] = 1
        packet["taskRequestId"] = UUID().uuidString
        XCTAssertThrowsError(try ClemWatchReply.decode(packet, for: task))
    }

    func testUnknownCredentialFieldsAndBlankReplyFailClosed() {
        var packet: [String: Any] = ["version": 1, "requestId": task.uuidString,
                                    "status": "completed", "spokenText": "A controlled result.",
                                    "credential": "controlled-unwanted-field"]
        XCTAssertThrowsError(try ClemWatchReply.decode(packet, for: task))
        packet.removeValue(forKey: "credential")
        packet["spokenText"] = " \n"
        XCTAssertThrowsError(try ClemWatchReply.decode(packet, for: task))
    }

    func testUnknownOutcomeRetainsOriginalPacketAcrossPersistence() throws {
        var state = ClemWatchPendingState()
        let original = try state.beginAsk("Keep this exact question.", id: task)
        let restored = try JSONDecoder().decode(ClemWatchPendingState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(restored.pendingRequest, original)
        XCTAssertNil(restored.lastTaskRequest, "an unsent or unconfirmed packet is not an accepted task binding")
        XCTAssertThrowsError(try state.beginAsk("A different question.", id: UUID()))
        XCTAssertEqual(state.pendingRequest, original)
    }

    func testPollDoesNotRewriteOriginalAskOrMintAnotherTask() throws {
        var state = ClemWatchPendingState()
        let original = try state.beginAsk("Prepare a controlled draft.", id: task)
        let poll = try state.resultRequest()
        XCTAssertEqual(poll, .result(task))
        XCTAssertEqual(state.pendingRequest, original)
        XCTAssertNil(state.lastTaskRequest)
    }

    func testWorkingNeedsOwnerAndUnavailableNeverBecomeCompletion() throws {
        for status in [ClemWatchStatus.working, .needsOwner, .unavailable, .failed] {
            var state = ClemWatchPendingState()
            let original = try state.beginAsk("A controlled task.", id: task)
            let reply = ClemWatchReply(requestID: task, status: status, spokenText: "Open Clem on iPhone.",
                                       taskRequestID: task)
            XCTAssertTrue(state.accept(reply, for: original))
            XCTAssertEqual(state.pendingRequest, original, "\(status) is not permission to replay with a new key")
        }
    }

    func testCompletedResultClearsOnlyItsPendingPacketAndKeepsThread() throws {
        var state = ClemWatchPendingState()
        _ = try state.beginAsk("First controlled task.", id: task)
        let reply = ClemWatchReply(requestID: task, status: .completed, spokenText: "The draft is ready.",
                                   conversationID: "controlled-thread", taskRequestID: task)
        XCTAssertTrue(state.accept(reply, for: .result(task)))
        XCTAssertNil(state.pendingRequest)
        let followupID = UUID()
        let followup = try state.beginAsk("Make it shorter.", id: followupID)
        XCTAssertEqual(followup.conversationID, "controlled-thread")
        XCTAssertEqual(followup.requestID, followupID)
        XCTAssertNotEqual(followup.requestID, task)
    }

    func testLateReplyCannotClearOrReplaceAnotherPendingTask() throws {
        var state = ClemWatchPendingState()
        let original = try state.beginAsk("First task.", id: task)
        XCTAssertTrue(state.accept(ClemWatchReply(requestID: task, status: .completed, spokenText: "Done.",
                                                  taskRequestID: task),
                                   for: original))
        let newer = try state.beginAsk("New task.", id: UUID())
        XCTAssertFalse(state.accept(ClemWatchReply(requestID: task, status: .completed, spokenText: "Old reply.",
                                                   conversationID: "wrong-thread", taskRequestID: task), for: original))
        XCTAssertEqual(state.pendingRequest, newer)
        XCTAssertNil(state.conversationID)
    }

    func testCheckInDoesNotLoseExistingConversationOrLastTask() throws {
        var state = ClemWatchPendingState()
        let original = try state.beginAsk("First task.", id: task)
        XCTAssertTrue(state.accept(ClemWatchReply(requestID: task, status: .completed, spokenText: "Done.",
                                                  conversationID: "controlled-thread", taskRequestID: task), for: original))
        let checkIn = try state.beginCheckIn(id: UUID())
        XCTAssertTrue(state.accept(ClemWatchReply(requestID: checkIn.requestID, status: .completed,
                                                  spokenText: "Nothing urgent."), for: checkIn))
        XCTAssertEqual(state.conversationID, "controlled-thread")
        XCTAssertEqual(state.lastTaskRequest, original)
        XCTAssertEqual(try state.resultRequest().requestID, task)
    }

    func testNonacceptedNeedsOwnerRefusalPreservesEarlierTaskAndThread() throws {
        var state = ClemWatchPendingState()
        let first = try state.beginAsk("First task.", id: task)
        XCTAssertTrue(state.accept(ClemWatchReply(requestID: task, status: .completed, spokenText: "Done.",
                                                  conversationID: "controlled-thread", taskRequestID: task), for: first))
        let next = try state.beginAsk("A new task.", id: UUID())
        XCTAssertEqual(state.lastTaskRequest, first)
        XCTAssertTrue(state.accept(ClemWatchReply(requestID: next.requestID, status: .needsOwner,
                                                  spokenText: "Open Clem on iPhone; earlier work is unconfirmed."), for: next))
        XCTAssertNil(state.pendingRequest)
        XCTAssertEqual(state.lastTaskRequest, first)
        XCTAssertEqual(state.conversationID, "controlled-thread")
        XCTAssertEqual(try state.resultRequest().requestID, task)
    }

    func testUnavailableWithoutTaskReceiptRetainsOriginalUnknownRequest() throws {
        var state = ClemWatchPendingState()
        let original = try state.beginAsk("A controlled question.", id: task)
        XCTAssertTrue(state.accept(ClemWatchReply(requestID: task, status: .unavailable,
                                                  spokenText: "The result is not confirmed."), for: original))
        XCTAssertEqual(state.pendingRequest, original)
        XCTAssertNil(state.lastTaskRequest)
        XCTAssertEqual(try state.resultRequest().requestID, task)
    }

    func testCompletedAskWithoutTaskReceiptCannotInventAcceptedBinding() throws {
        var state = ClemWatchPendingState()
        let original = try state.beginAsk("A controlled question.", id: task)
        XCTAssertFalse(state.accept(ClemWatchReply(requestID: task, status: .completed,
                                                   spokenText: "An unbound answer."), for: original))
        XCTAssertEqual(state.pendingRequest, original)
        XCTAssertNil(state.lastTaskRequest)
    }

    func testNewSpeechInteractionInvalidatesPriorOwnerAndOldCleanupCannotClearNewOwner() {
        var ownership = ClemWatchSpeechOwnership()
        let foreground = ownership.begin()
        XCTAssertTrue(ownership.owns(foreground))
        let siri = ownership.begin()
        XCTAssertFalse(ownership.owns(foreground))
        XCTAssertTrue(ownership.owns(siri))
        ownership.end(foreground)
        XCTAssertTrue(ownership.owns(siri))
        ownership.end(siri)
        XCTAssertFalse(ownership.owns(siri))
    }

    func testReadOnlyOwnershipChecksDoNotAcquireAnotherSpeechOwner() {
        var ownership = ClemWatchSpeechOwnership()
        let owner = ownership.begin()
        for _ in 0..<20 { XCTAssertTrue(ownership.owns(owner)) }
        XCTAssertEqual(ownership.current, owner)
    }
}
