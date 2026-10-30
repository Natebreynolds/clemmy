import XCTest
@testable import ClemWatch

@MainActor
private final class MemoryWatchStore: ClemWatchPersisting {
    var value = ClemWatchPendingState()
    var loadError: Error?
    var failSaveNumber: Int?
    var saves = 0

    func load() throws -> ClemWatchPendingState {
        if let loadError { throw loadError }
        return value
    }

    func save(_ state: ClemWatchPendingState) throws {
        saves += 1
        if saves == failSaveNumber { throw ClemWatchError.storageUnavailable }
        value = state
    }
}

@MainActor
private final class ControlledWatchConnection: ClemWatchMessaging {
    var requests: [ClemWatchRequest] = []
    var respond: (ClemWatchRequest) throws -> ClemWatchReply = { _ in throw ClemWatchError.unreachable }

    func send(_ request: ClemWatchRequest) async throws -> ClemWatchReply {
        requests.append(request)
        return try respond(request)
    }
}

final class ClemWatchAccessTests: XCTestCase {
    @MainActor
    func testOfflineAskIsSavedBeforeSendAndRetryUsesExactOriginalPacket() async throws {
        let store = MemoryWatchStore()
        let connection = ControlledWatchConnection()
        connection.respond = { request in
            XCTAssertEqual(store.value.pendingRequest, request, "persist before any transport call")
            throw ClemWatchError.unreachable
        }
        let access = ClemWatchAccess(store: store, connection: connection)
        let saved = await access.ask("A controlled offline question.")
        XCTAssertTrue(saved)
        let original = try XCTUnwrap(store.value.pendingRequest)
        connection.respond = { request in
            ClemWatchReply(requestID: request.requestID, status: .completed, spokenText: "A controlled answer.",
                           conversationID: "controlled-thread", taskRequestID: request.requestID)
        }
        await access.retryPending()
        XCTAssertEqual(connection.requests, [original, original])
        XCTAssertNil(access.state.pendingRequest)
        XCTAssertEqual(access.state.conversationID, "controlled-thread")
    }

    @MainActor
    func testWorkingPollUsesSameTaskKeyWithoutRewritingOrResubmittingAsk() async throws {
        let store = MemoryWatchStore()
        let connection = ControlledWatchConnection()
        connection.respond = { request in
            ClemWatchReply(requestID: request.requestID, status: .working, spokenText: "Still working.",
                           taskRequestID: request.requestID)
        }
        let access = ClemWatchAccess(store: store, connection: connection)
        let saved = await access.ask("Prepare a controlled draft.")
        XCTAssertTrue(saved)
        let original = try XCTUnwrap(access.state.pendingRequest)
        await access.readLatest()
        XCTAssertEqual(connection.requests, [original, .result(original.requestID)])
        XCTAssertEqual(access.state.pendingRequest, original)
        XCTAssertEqual(access.state.lastTaskRequest, original)
        XCTAssertEqual(access.reply?.status, .working)
    }

    @MainActor
    func testNeedsOwnerRetainsRequestAndNeverConvertsNewTextIntoApproval() async throws {
        let store = MemoryWatchStore()
        let connection = ControlledWatchConnection()
        connection.respond = { request in
            ClemWatchReply(requestID: request.requestID, status: .needsOwner,
                           spokenText: "Open Clem on iPhone to review.", taskRequestID: request.requestID)
        }
        let access = ClemWatchAccess(store: store, connection: connection)
        let saved = await access.ask("Prepare a controlled draft.")
        XCTAssertTrue(saved)
        let original = try XCTUnwrap(access.state.pendingRequest)
        let acceptedNewText = await access.ask("Yes")
        XCTAssertFalse(acceptedNewText)
        XCTAssertEqual(connection.requests, [original])
        XCTAssertEqual(access.state.pendingRequest, original)
    }

    @MainActor
    func testStorageFailurePreventsAnyDispatchAndDoesNotOverwriteUnreadableState() async {
        let store = MemoryWatchStore()
        store.loadError = ClemWatchError.invalidPacket
        let connection = ControlledWatchConnection()
        let access = ClemWatchAccess(store: store, connection: connection)
        let saved = await access.ask("A controlled question.")
        XCTAssertFalse(saved)
        XCTAssertEqual(store.saves, 0)
        XCTAssertTrue(connection.requests.isEmpty)
        XCTAssertFalse(access.storageAvailable)
    }

    @MainActor
    func testInitialSaveFailureDoesNotDispatchOrChangeLocalTaskIdentity() async {
        let store = MemoryWatchStore()
        store.failSaveNumber = 1
        let connection = ControlledWatchConnection()
        let access = ClemWatchAccess(store: store, connection: connection)
        let saved = await access.ask("A controlled question.")
        XCTAssertFalse(saved)
        XCTAssertTrue(connection.requests.isEmpty)
        XCTAssertNil(access.state.pendingRequest)
        XCTAssertNil(access.state.lastTaskRequest)
    }

    @MainActor
    func testFailedConfirmationSaveKeepsOriginalRequestForSameKeyRecovery() async throws {
        let store = MemoryWatchStore()
        store.failSaveNumber = 2
        let connection = ControlledWatchConnection()
        connection.respond = { request in
            ClemWatchReply(requestID: request.requestID, status: .completed, spokenText: "A controlled result.",
                           taskRequestID: request.requestID)
        }
        let access = ClemWatchAccess(store: store, connection: connection)
        let saved = await access.ask("A controlled question.")
        XCTAssertTrue(saved)
        XCTAssertEqual(access.state.pendingRequest, store.value.pendingRequest)
        XCTAssertNotNil(access.state.pendingRequest)
        XCTAssertEqual(access.reply?.status, .unavailable)
        let original = try XCTUnwrap(access.state.pendingRequest)
        await access.retryPending()
        XCTAssertEqual(connection.requests, [original, original])
        XCTAssertNil(access.state.pendingRequest)
    }

    @MainActor
    func testWrongReplyIdentityCannotConsumeSavedRequest() async throws {
        let store = MemoryWatchStore()
        let connection = ControlledWatchConnection()
        connection.respond = { _ in ClemWatchReply(requestID: UUID(), status: .completed, spokenText: "Wrong result.") }
        let access = ClemWatchAccess(store: store, connection: connection)
        let saved = await access.ask("A controlled question.")
        XCTAssertTrue(saved)
        XCTAssertNotNil(access.state.pendingRequest)
        XCTAssertEqual(access.state, store.value)
        XCTAssertEqual(access.reply?.status, .unavailable)
    }

    @MainActor
    func testUnlockRestoresOriginalRequestWithoutResetOrNewIdentity() async throws {
        let store = MemoryWatchStore()
        let original = try store.value.beginAsk("A controlled saved question.", id: UUID())
        store.loadError = ClemWatchError.storageUnavailable
        let connection = ControlledWatchConnection()
        connection.respond = { request in
            ClemWatchReply(requestID: request.requestID, status: .completed,
                           spokenText: "A controlled answer.", taskRequestID: request.requestID)
        }
        let access = ClemWatchAccess(store: store, connection: connection)
        XCTAssertFalse(access.storageAvailable)
        store.loadError = nil
        await access.retryPending()
        XCTAssertTrue(access.storageAvailable)
        XCTAssertEqual(connection.requests, [original])
        XCTAssertNil(access.state.pendingRequest)
    }

    @MainActor
    func testForegroundPollingReadsSameTaskUntilTerminalWithoutAnotherAsk() async throws {
        let store = MemoryWatchStore()
        let connection = ControlledWatchConnection()
        connection.respond = { request in
            let final = connection.requests.count == 3
            return ClemWatchReply(requestID: request.requestID, status: final ? .completed : .working,
                                  spokenText: final ? "The controlled draft is ready." : "Still working.",
                                  taskRequestID: request.requestID)
        }
        let access = ClemWatchAccess(store: store, connection: connection)
        _ = await access.ask("Prepare a controlled draft.")
        let original = try XCTUnwrap(access.state.pendingRequest)
        await access.pollLatestWhileWorking(maxAttempts: 3, intervalNanoseconds: 0, budgetNanoseconds: 1_000_000_000)
        XCTAssertEqual(connection.requests, [original, .result(original.requestID), .result(original.requestID)])
        XCTAssertEqual(access.reply?.status, .completed)
        XCTAssertNil(access.state.pendingRequest)
    }

    @MainActor
    func testPollingBudgetLeavesWorkingRequestSavedWithoutPostRetry() async throws {
        let store = MemoryWatchStore()
        let connection = ControlledWatchConnection()
        connection.respond = { request in
            ClemWatchReply(requestID: request.requestID, status: .working, spokenText: "Still working.",
                           taskRequestID: request.requestID)
        }
        let access = ClemWatchAccess(store: store, connection: connection)
        _ = await access.ask("A controlled task.")
        let original = try XCTUnwrap(access.state.pendingRequest)
        await access.pollLatestWhileWorking(maxAttempts: 3, intervalNanoseconds: 0, budgetNanoseconds: 1_000_000_000)
        XCTAssertEqual(connection.requests.count, 4)
        XCTAssertTrue(connection.requests.dropFirst().allSatisfy { $0 == .result(original.requestID) })
        XCTAssertEqual(access.state.pendingRequest, original)
        XCTAssertEqual(access.reply?.status, .working)
    }

    @MainActor
    func testCancelledForegroundPollDoesNotStartAnotherLookupOrAsk() async throws {
        let store = MemoryWatchStore()
        let connection = ControlledWatchConnection()
        connection.respond = { request in
            ClemWatchReply(requestID: request.requestID, status: .working, spokenText: "Still working.",
                           taskRequestID: request.requestID)
        }
        let access = ClemWatchAccess(store: store, connection: connection)
        _ = await access.ask("A controlled task.")
        let original = try XCTUnwrap(access.state.pendingRequest)
        let poll = Task { @MainActor in
            await access.pollLatestWhileWorking(maxAttempts: 3, intervalNanoseconds: 0, budgetNanoseconds: 1_000_000_000)
        }
        poll.cancel()
        await poll.value
        XCTAssertEqual(connection.requests, [original])
        XCTAssertEqual(access.state.pendingRequest, original)
    }
}
