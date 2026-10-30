import Combine
import Foundation
import WatchConnectivity

@MainActor
protocol ClemWatchPersisting {
    func load() throws -> ClemWatchPendingState
    func save(_ state: ClemWatchPendingState) throws
}

@MainActor
protocol ClemWatchMessaging {
    func send(_ request: ClemWatchRequest) async throws -> ClemWatchReply
}

/// Protected Watch-app storage only. Never place requests in an App Group,
/// WatchConnectivity background queue, logs or shared credential storage.
@MainActor
final class ClemWatchFileStore: ClemWatchPersisting {
    private let directory: URL
    private let file: URL

    init(directory: URL? = nil) {
        let root = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ClemQuickAccess", isDirectory: true)
        self.directory = root
        self.file = root.appendingPathComponent("pending-request.json")
    }

    func load() throws -> ClemWatchPendingState {
        guard FileManager.default.fileExists(atPath: file.path) else { return ClemWatchPendingState() }
        let data = try Data(contentsOf: file)
        guard data.count <= 128_000 else { throw ClemWatchError.invalidPacket }
        let state = try JSONDecoder().decode(ClemWatchPendingState.self, from: data)
        try state.validate()
        return state
    }

    func save(_ state: ClemWatchPendingState) throws {
        try state.validate()
        let data = try JSONEncoder().encode(state)
        guard data.count <= 128_000 else { throw ClemWatchError.invalidPacket }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.protectionKey: FileProtectionType.complete])
        var protectedDirectory = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try protectedDirectory.setResourceValues(values)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
    }
}

@MainActor
private final class ClemWatchReplyGate {
    private var continuation: CheckedContinuation<ClemWatchReply, Error>?
    private var finished = false
    var deadline: Task<Void, Never>?

    func install(_ continuation: CheckedContinuation<ClemWatchReply, Error>) -> Bool {
        guard !finished else {
            continuation.resume(throwing: CancellationError())
            return false
        }
        self.continuation = continuation
        return true
    }

    func finish(_ result: Result<ClemWatchReply, Error>) {
        guard !finished else { return }
        finished = true
        let continuation = self.continuation
        self.continuation = nil
        deadline?.cancel()
        deadline = nil
        continuation?.resume(with: result)
    }
}

@MainActor
final class ClemWatchPhoneConnection: NSObject, ClemWatchMessaging, WCSessionDelegate {
    private let session: WCSession?

    override init() {
        session = WCSession.isSupported() ? WCSession.default : nil
        super.init()
        session?.delegate = self
    }

    func activate() {
        session?.activate()
    }

    func send(_ request: ClemWatchRequest) async throws -> ClemWatchReply {
        try request.validate()
        guard let session else { throw ClemWatchError.unsupported }
        if session.activationState != .activated {
            session.activate()
            // Activation is asynchronous. Wait briefly without blocking the UI
            // or treating a cold launch as a delivered request.
            for _ in 0..<50 {
                if session.activationState == .activated { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        guard session.activationState == .activated else { throw ClemWatchError.connecting }
        guard session.isCompanionAppInstalled else { throw ClemWatchError.companionMissing }
        guard session.isReachable else { throw ClemWatchError.unreachable }
        try Task.checkCancellation()
        let gate = ClemWatchReplyGate()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                guard gate.install(continuation) else { return }
                gate.deadline = Task { @MainActor in
                    do { try await Task.sleep(nanoseconds: 12_000_000_000) }
                    catch { return }
                    gate.finish(.failure(ClemWatchError.timeout))
                }
                session.sendMessage(request.dictionary, replyHandler: { packet in
                    Task { @MainActor in
                        do { gate.finish(.success(try ClemWatchReply.decode(packet, for: request.requestID))) }
                        catch { gate.finish(.failure(ClemWatchError.invalidPacket)) }
                    }
                }, errorHandler: { _ in
                    Task { @MainActor in gate.finish(.failure(ClemWatchError.unreachable)) }
                })
            }
        }, onCancel: {
            Task { @MainActor in gate.finish(.failure(CancellationError())) }
        })
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                             error: Error?) {}
}

@MainActor
final class ClemWatchAccess: ObservableObject {
    static let shared = ClemWatchAccess(store: ClemWatchFileStore(), connection: ClemWatchPhoneConnection())

    @Published private(set) var state = ClemWatchPendingState()
    @Published private(set) var reply: ClemWatchReply?
    @Published private(set) var isSending = false
    @Published private(set) var storageAvailable = true

    private let store: ClemWatchPersisting
    private let connection: ClemWatchMessaging
    private var speechOwnership = ClemWatchSpeechOwnership()

    func beginSpeechInteraction() -> UUID { speechOwnership.begin() }
    func ownsSpeechInteraction(_ token: UUID) -> Bool { speechOwnership.owns(token) }
    func endSpeechInteraction(_ token: UUID) { speechOwnership.end(token) }

    init(store: ClemWatchPersisting, connection: ClemWatchMessaging) {
        self.store = store
        self.connection = connection
        do { state = try store.load(); try state.validate() }
        catch {
            storageAvailable = false
            show(.storageUnavailable)
        }
    }

    func activate() {
        restoreAfterUnlockIfNeeded()
        (connection as? ClemWatchPhoneConnection)?.activate()
    }

    /// True only after this exact new ask was persisted before dispatch. A
    /// newer draft can stay in the editor while its predecessor is working.
    @discardableResult
    func ask(_ text: String) async -> Bool {
        guard canSend() else { return false }
        var next = state
        do {
            let request = try next.beginAsk(text, id: UUID())
            try store.save(next)
            state = next
            await deliver(request)
            return true
        } catch {
            show(error as? ClemWatchError ?? .storageUnavailable)
            return false
        }
    }

    func checkIn() async {
        guard canSend() else { return }
        var next = state
        do {
            let request = try next.beginCheckIn(id: UUID())
            try store.save(next)
            state = next
            await deliver(request)
        } catch { show(error as? ClemWatchError ?? .storageUnavailable) }
    }

    func retryPending() async {
        guard canSend() else { return }
        guard let original = state.pendingRequest else { show(.noTask); return }
        await deliver(original)
    }

    func readLatest() async {
        guard canSend() else { return }
        do { await deliver(try state.resultRequest()) }
        catch { show(error as? ClemWatchError ?? .invalidPacket) }
    }

    /// Foreground readback only. Every sample is a read-only result operation
    /// for the same task UUID. This never retries or submits an ask.
    func pollLatestWhileWorking(maxAttempts: Int = 20, intervalNanoseconds: UInt64 = 1_000_000_000,
                                budgetNanoseconds: UInt64 = 20_000_000_000,
                                speechOwner: UUID? = nil) async {
        guard !Task.isCancelled, reply?.status == .working,
              speechOwner.map(ownsSpeechInteraction) ?? true,
              let taskID = state.resultTaskRequest?.requestID,
              state.pendingRequest?.operation != .checkIn else { return }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { @MainActor [weak self] in
                guard let self else { return }
                for _ in 0..<max(0, min(20, maxAttempts)) {
                    do { try await Task.sleep(nanoseconds: intervalNanoseconds) }
                    catch { return }
                    guard !Task.isCancelled, self.reply?.status == .working,
                          speechOwner.map(self.ownsSpeechInteraction) ?? true,
                          self.state.resultTaskRequest?.requestID == taskID, !self.isSending else { return }
                    await self.deliver(.result(taskID))
                    if self.reply?.status != .working { return }
                }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: min(20_000_000_000, budgetNanoseconds))
            }
            _ = await group.next()
            group.cancelAll()
        }
    }

    private func canSend() -> Bool {
        restoreAfterUnlockIfNeeded()
        guard storageAvailable else { show(.storageUnavailable); return false }
        guard !isSending else { show(.pendingRequest); return false }
        return true
    }

    private func restoreAfterUnlockIfNeeded() {
        guard !storageAvailable else { return }
        do {
            let restored = try store.load()
            try restored.validate()
            state = restored
            storageAvailable = true
        } catch {
            // Locked or malformed storage stays intact. Never reset it as a
            // shortcut to obtaining a new request identifier.
        }
    }

    private func deliver(_ request: ClemWatchRequest) async {
        isSending = true
        defer { isSending = false }
        do {
            let received = try await connection.send(request)
            guard !Task.isCancelled else { return }
            var next = state
            guard next.accept(received, for: request) else { throw ClemWatchError.invalidPacket }
            do { try store.save(next) }
            catch {
                // Retain the original packet when local confirmation cannot
                // be saved. Never turn this into a fresh submission.
                reply = ClemWatchReply(requestID: request.requestID, status: .unavailable,
                                       spokenText: "Your iPhone replied, but I couldn’t save its confirmation. Open Clem on iPhone to check it.")
                return
            }
            state = next
            reply = received
        } catch {
            guard !Task.isCancelled else { return }
            show(error as? ClemWatchError ?? .unreachable, requestID: request.requestID)
        }
    }

    private func show(_ error: ClemWatchError, requestID: UUID? = nil) {
        reply = ClemWatchReply(requestID: requestID ?? state.pendingRequest?.requestID ?? UUID(),
                               status: .unavailable, spokenText: error.spokenText)
    }
}
