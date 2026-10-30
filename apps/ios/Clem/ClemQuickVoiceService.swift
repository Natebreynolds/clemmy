import Foundation
import Security

/// Shared by Siri and the paired Watch. A result lookup keeps the original
/// task key; it never resubmits work or infers completion from spoken words.
struct ClemQuickVoicePacket: Codable, Equatable, Sendable {
    enum Operation: String, Codable, Sendable { case checkIn, ask, result }
    let version: Int
    let operation: Operation
    let requestId: String
    var text: String?
    var conversationId: String?

    var valid: Bool {
        version == 1 && UUID(uuidString: requestId) != nil
            && (text?.count ?? 0) <= 8_000
            && (conversationId?.utf8.count ?? 0) <= 256
            && (operation != .ask || !(text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true))
    }
    var key: String { UUID(uuidString: requestId)?.uuidString ?? requestId }
}

struct ClemQuickVoiceReply: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable { case completed, working, needsOwner, unavailable, failed }
    let version: Int = 1
    let requestId: String
    let status: Status
    let spokenText: String
    var conversationId: String?
    var taskRequestId: String?

    var dictionary: [String: Any] {
        var value: [String: Any] = ["version": version, "requestId": requestId,
            "status": status.rawValue, "spokenText": spokenText]
        if let conversationId { value["conversationId"] = conversationId }
        if let taskRequestId { value["taskRequestId"] = taskRequestId }
        return value
    }
}

struct ClemQuickVoiceDeliveryContext: Equatable, Sendable {
    let pairingFingerprint: String?
    let generation: UInt64
}

enum ClemQuickVoiceDelivery {
    static func capture() -> ClemQuickVoiceDeliveryContext {
        .init(pairingFingerprint: PairingStore.load()?.fingerprint,
            generation: KeychainQuickVoiceStorage.shared.generation)
    }
    static func fence(_ reply: ClemQuickVoiceReply, captured: ClemQuickVoiceDeliveryContext,
                      current: ClemQuickVoiceDeliveryContext = capture()) -> ClemQuickVoiceReply {
        guard captured == current else {
            return .init(requestId: reply.requestId, status: .unavailable,
                spokenText: "Voice access changed. Open Clem on your iPhone to reconnect and check your work.")
        }
        return reply
    }
}

protocol ClemQuickVoiceHTTP: Sendable {
    func ready() async -> Bool
    func request(path: String, method: String, body: Data?, contentType: String?, idempotencyKey: String?) async throws -> NativeVoiceHTTPResponse
}

extension NativeVoiceTransport: ClemQuickVoiceHTTP {
    func ready() -> Bool { isProvisioned }
}

struct ClemQuickVoiceTask: Codable, Equatable, Sendable {
    enum Disposition: String, Codable, Sendable { case accepted, rejected, completed }
    let requestId: String
    let text: String
    let requestedConversationId: String?
    let body: Data
    let createdAt: Date
    var conversationId: String?
    var reply: ClemQuickVoiceReply?
    /// Recoverable questions/approvals are accepted work, not a cached final.
    var disposition: Disposition?
}

struct ClemQuickVoiceLedger: Codable, Sendable {
    var version = 1
    let pairingFingerprint: String
    var tasks: [ClemQuickVoiceTask] = []
}

protocol ClemQuickVoiceStorage: Sendable {
    var generation: UInt64 { get }
    func load() throws -> ClemQuickVoiceLedger?
    func save(_ value: ClemQuickVoiceLedger, generation: UInt64) throws
}

/// Private, device-local receipts. Nothing goes into the widget App Group or
/// Watch defaults. Revocation and saves share a lock, fencing late callbacks.
final class KeychainQuickVoiceStorage: ClemQuickVoiceStorage, @unchecked Sendable {
    static let shared = KeychainQuickVoiceStorage()
    private let lock = NSLock()
    private var epoch: UInt64 = 0
    private let service = "ai.breakthroughcoaching.clem.quick-voice"
    var generation: UInt64 { lock.lock(); defer { lock.unlock() }; return epoch }
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: "receipts"] }

    func load() throws -> ClemQuickVoiceLedger? {
        lock.lock(); defer { lock.unlock() }
        var q = query; q[kSecReturnData as String] = true
        var result: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, data.count <= 200_000,
              let ledger = try? JSONDecoder().decode(ClemQuickVoiceLedger.self, from: data),
              ledger.version == 1 else { throw ClemQuickVoiceFailure.storage }
        return ledger
    }

    func save(_ value: ClemQuickVoiceLedger, generation: UInt64) throws {
        lock.lock(); defer { lock.unlock() }
        guard epoch == generation else { throw CancellationError() }
        let data = try JSONEncoder().encode(value)
        guard data.count <= 200_000 else { throw ClemQuickVoiceFailure.storage }
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var q = query; q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw ClemQuickVoiceFailure.storage }
        } else if status != errSecSuccess { throw ClemQuickVoiceFailure.storage }
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        epoch &+= 1
        SecItemDelete(query as CFDictionary)
    }
}

enum ClemQuickVoiceFailure: Error { case storage, response, pairingChanged }

actor ClemQuickVoiceService {
    static let shared = ClemQuickVoiceService()
    private let storage: any ClemQuickVoiceStorage
    private let pairing: @Sendable () -> Pairing?
    private let client: @Sendable (Pairing) -> any ClemQuickVoiceHTTP
    private let sleep: @Sendable () async throws -> Void
    private let now: @Sendable () -> Date
    private var active = Set<String>()

    init(storage: any ClemQuickVoiceStorage = KeychainQuickVoiceStorage.shared,
         pairing: @escaping @Sendable () -> Pairing? = { PairingStore.load() },
         client: @escaping @Sendable (Pairing) -> any ClemQuickVoiceHTTP = { NativeVoiceTransport(pairing: $0) },
         sleep: @escaping @Sendable () async throws -> Void = { try await Task.sleep(for: .milliseconds(700)) },
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.storage = storage; self.pairing = pairing; self.client = client; self.sleep = sleep; self.now = now
    }

    nonisolated static func clearReceipts() { KeychainQuickVoiceStorage.shared.clear() }

    /// Siri and Watch message handlers have a short presentation lifetime.
    /// Cancellation closes the native HTTP operation; its saved key remains
    /// available for exact GET diagnosis rather than a newly generated send.
    nonisolated func dialog(_ packet: ClemQuickVoicePacket) async -> ClemQuickVoiceReply {
        await withTaskGroup(of: ClemQuickVoiceReply.self) { group in
            group.addTask { await self.perform(packet, waitForReply: packet.operation == .ask) }
            group.addTask {
                try? await Task.sleep(for: .milliseconds(7_500))
                return .init(requestId: packet.requestId,
                    status: packet.operation == .checkIn ? .unavailable : .working,
                    spokenText: packet.operation == .checkIn ? "Your computer did not finish the check-in in time. Try Check in again when it is reachable."
                        : "I have not received the final answer yet. Use Read latest result; it will not send your request again.",
                    taskRequestId: packet.operation == .checkIn ? nil : packet.key)
            }
            let first = await group.next()!
            group.cancelAll()
            return first
        }
    }

    /// The Watch receives acknowledgement promptly. Siri may wait briefly for
    /// the exact answer; longer work is recovered by Read latest result.
    func perform(_ packet: ClemQuickVoicePacket, waitForReply: Bool = false) async -> ClemQuickVoiceReply {
        guard packet.valid else { return reply(packet, .failed, "That request is not supported. Ask Clem again from the app.") }
        guard let bound = pairing(), let fingerprint = bound.fingerprint, !fingerprint.isEmpty else {
            return reply(packet, .unavailable, "Open Clem on your iPhone and connect it to your computer first.")
        }
        let generation = storage.generation
        let transport = client(bound)
        do {
            guard await transport.ready() else { return reply(packet, .unavailable, "Use iOS 18 or later on your paired iPhone. Open the current Clem app and connect widget voice once, then try again.") }
            try current(fingerprint, generation)
            if packet.operation == .checkIn { return try await checkIn(packet, transport, fingerprint, generation) }
            var ledger = try storage.load() ?? ClemQuickVoiceLedger(pairingFingerprint: fingerprint)
            guard ledger.pairingFingerprint == fingerprint else { throw ClemQuickVoiceFailure.pairingChanged }
            if packet.operation == .result {
                guard let task = ledger.tasks.first(where: { $0.requestId == packet.key }) else {
                    return reply(packet, .unavailable, "There is no saved request with that receipt. Open Clem to check your conversation.")
                }
                return try await observe(packet, task, transport, fingerprint, generation, waitForReply)
            }
            if let task = ledger.tasks.first(where: { $0.requestId == packet.key }) {
                guard task.text == packet.text, task.requestedConversationId == packet.conversationId else {
                    return reply(packet, .failed, "That request receipt belongs to different words. Your original request has not been repeated.")
                }
                if task.reply != nil || task.disposition != nil || active.contains(task.requestId) {
                    return try await observe(packet, task, transport, fingerprint, generation, waitForReply)
                }
                // This is an explicit retry of the ORIGINAL packet. Prove its
                // receipt absent before reusing the identical bytes and key.
                let status = try await transport.request(path: "/m/api/chat/native-voice-status?requestId=\(task.requestId)",
                    method: "GET", body: nil, contentType: nil, idempotencyKey: nil)
                try current(fingerprint, generation)
                if status.status == 404, (try? json(status))?["error"] as? String == "REQUEST_NOT_FOUND" {
                    return try await sendOriginal(packet, task, transport, fingerprint, generation, waitForReply)
                }
                return try await observe(packet, task, transport, fingerprint, generation, waitForReply, firstResponse: status)
            }
            if let conversation = packet.conversationId,
               !ledger.tasks.contains(where: { $0.conversationId == conversation }) {
                return reply(packet, .needsOwner, "Open that conversation in Clem first. I could not confirm it belongs to this voice session.")
            }
            if ledger.tasks.contains(where: { $0.reply == nil }) {
                // This NEW request has not been admitted. Never attach the
                // previous task's receipt to it: a caller must retain that
                // original independently and diagnose it by its own key.
                return reply(packet, .needsOwner, "Another quick-voice request is still unconfirmed. Open Clem on your iPhone to check it before sending another.")
            }
            // Save the immutable body and key BEFORE the only POST. A lost
            // acknowledgement is recovered by GET, never by a new request.
            var body: [String: Any] = ["message": packet.text!, "async": true, "voice": true, "requireIdle": true]
            if let conversation = packet.conversationId { body["sessionId"] = conversation }
            let task = ClemQuickVoiceTask(requestId: packet.key, text: packet.text!,
                requestedConversationId: packet.conversationId,
                body: try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]), createdAt: now())
            ledger.tasks = Array(ledger.tasks.suffix(11)) + [task]
            try current(fingerprint, generation)
            try storage.save(ledger, generation: generation)
            return try await sendOriginal(packet, task, transport, fingerprint, generation, waitForReply)
        } catch is CancellationError {
            return reply(packet, .unavailable, "Voice access changed. Open Clem to check your conversation; I have not retried the request.")
        } catch {
            return reply(packet, .unavailable, "Clem could not confirm this voice step. Open the app or read your last result before trying again.")
        }
    }

    func latestResult() async -> ClemQuickVoiceReply {
        let id = UUID().uuidString
        guard let fingerprint = pairing()?.fingerprint,
              let ledger = try? storage.load(), ledger.pairingFingerprint == fingerprint,
              let task = ledger.tasks.last else {
            return .init(requestId: id, status: .unavailable, spokenText: "There is no saved quick-voice request yet.")
        }
        return await dialog(.init(version: 1, operation: .result, requestId: task.requestId))
    }

    func retryLatest() async -> ClemQuickVoiceReply {
        guard let fingerprint = pairing()?.fingerprint,
              let ledger = try? storage.load(), ledger.pairingFingerprint == fingerprint,
              let task = ledger.tasks.last else { return await latestResult() }
        return await dialog(.init(version: 1, operation: .ask, requestId: task.requestId,
            text: task.text, conversationId: task.requestedConversationId))
    }

    /// Siri follows the exact conversation this private quick-access lane last
    /// received, never a UI-selected/latest chat or a guessed conversation name.
    func ask(_ text: String, waitForReply: Bool = true) async -> ClemQuickVoiceReply {
        let fingerprint = pairing()?.fingerprint
        let ledger = try? storage.load()
        let conversation = ledger?.pairingFingerprint == fingerprint ? ledger?.tasks.last?.conversationId : nil
        let packet = ClemQuickVoicePacket(version: 1, operation: .ask, requestId: UUID().uuidString,
            text: text, conversationId: conversation)
        return waitForReply ? await dialog(packet) : await perform(packet)
    }

    private func checkIn(_ packet: ClemQuickVoicePacket, _ transport: any ClemQuickVoiceHTTP,
                         _ fingerprint: String, _ generation: UInt64) async throws -> ClemQuickVoiceReply {
        let response = try await transport.request(path: "/m/api/voice/check-in", method: "GET", body: nil, contentType: nil, idempotencyKey: nil)
        try current(fingerprint, generation)
        let value = try json(response)
        guard (200..<300).contains(response.status), let text = value["spokenText"] as? String,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let generated = value["generatedAt"] as? String, Self.date(generated) != nil else { throw ClemQuickVoiceFailure.response }
        switch value["status"] as? String {
        case "ok", "partial": return reply(packet, .completed, String(text.prefix(4_000)))
        case "unavailable": return reply(packet, .unavailable, String(text.prefix(4_000)))
        default: throw ClemQuickVoiceFailure.response
        }
    }

    private func sendOriginal(_ packet: ClemQuickVoicePacket, _ task: ClemQuickVoiceTask,
                              _ transport: any ClemQuickVoiceHTTP, _ fingerprint: String,
                              _ generation: UInt64, _ wait: Bool) async throws -> ClemQuickVoiceReply {
        try current(fingerprint, generation)
        guard active.insert(task.requestId).inserted else { return reply(packet, .working, "Clem is working on that request.", task: task) }
        defer { active.remove(task.requestId) }
        let response: NativeVoiceHTTPResponse
        do {
            response = try await transport.request(path: "/m/api/chat/send", method: "POST",
                body: task.body, contentType: "application/json", idempotencyKey: task.requestId)
        } catch {
            try current(fingerprint, generation)
            return reply(packet, .working, "I have not confirmed that request yet. Read latest result, or retry the original saved request; neither creates a new task key.", task: task)
        }
        try current(fingerprint, generation)
        let object = (try? json(response)) ?? [:]
        if [400, 401, 403, 404, 409, 413, 422, 429].contains(response.status) {
            let code = object["error"] as? String ?? ""
            let needsApp = ["VOICE_REQUIRES_IDLE_CHAT", "VOICE_CONTROL_REQUIRES_CHAT"].contains(code)
            let refused = reply(packet, needsApp ? .needsOwner : .unavailable,
                needsApp ? "Open the conversation in Clem to continue. Its current work or approval needs your attention."
                    : "That request was not accepted. Open Clem to check the connection or request before trying again.", task: task)
            try retain(refused, task: task, fingerprint: fingerprint, generation: generation, disposition: .rejected)
            return refused
        }
        guard (200..<300).contains(response.status), object["accepted"] as? Bool == true,
              let conversation = object["sessionId"] as? String, !conversation.isEmpty else {
            return reply(packet, .working, "I could not confirm acceptance. Read the latest result before trying another request.", task: task)
        }
        var accepted = task; accepted.conversationId = conversation; accepted.disposition = .accepted
        try retain(nil, task: accepted, fingerprint: fingerprint, generation: generation, disposition: .accepted)
        return try await observe(packet, accepted, transport, fingerprint, generation, wait)
    }

    private func observe(_ packet: ClemQuickVoicePacket, _ task: ClemQuickVoiceTask,
                         _ transport: any ClemQuickVoiceHTTP, _ fingerprint: String,
                         _ generation: UInt64, _ wait: Bool,
                         firstResponse: NativeVoiceHTTPResponse? = nil) async throws -> ClemQuickVoiceReply {
        if let stored = task.reply, task.disposition == .completed || task.disposition == .rejected {
            return .init(requestId: packet.requestId, status: stored.status, spokenText: stored.spokenText,
                         conversationId: stored.conversationId, taskRequestId: task.requestId)
        }
        var observed = task
        for index in 0..<(wait ? 10 : 1) {
            try current(fingerprint, generation)
            let response: NativeVoiceHTTPResponse
            if index == 0, let firstResponse { response = firstResponse }
            else { response = try await transport.request(path: "/m/api/chat/native-voice-status?requestId=\(task.requestId)", method: "GET", body: nil, contentType: nil, idempotencyKey: nil) }
            try current(fingerprint, generation)
            if response.status == 404 {
                return reply(packet, .working, "That request has not been confirmed yet. Open Clem to check it; I have not sent it again.", task: task)
            }
            let value = try json(response)
            guard (200..<300).contains(response.status) else { throw ClemQuickVoiceFailure.response }
            if let state = value["state"] as? String, state == "answered" || state == "needs_app" {
                guard let conversation = value["sessionId"] as? String, !conversation.isEmpty,
                      observed.conversationId == nil || observed.conversationId == conversation else { throw ClemQuickVoiceFailure.response }
                var currentTask = observed; currentTask.conversationId = conversation
                let text = (value["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let done = state == "answered" && value["taskStatus"] as? String == "done" && value["kind"] as? String == "answer"
                let result = reply(packet, done ? .completed : .needsOwner,
                    text.isEmpty ? "Open your conversation in Clem to continue. Your work has not been repeated." : String(text.prefix(8_000)), task: currentTask)
                try retain(result, task: currentTask, fingerprint: fingerprint, generation: generation,
                    disposition: done ? .completed : .accepted)
                return result
            }
            guard value["state"] as? String == "working" else { throw ClemQuickVoiceFailure.response }
            if let conversation = value["sessionId"] as? String, !conversation.isEmpty {
                guard observed.conversationId == nil || observed.conversationId == conversation else { throw ClemQuickVoiceFailure.response }
                observed.conversationId = conversation
                observed.disposition = .accepted
                try retain(nil, task: observed, fingerprint: fingerprint, generation: generation, disposition: .accepted)
            }
            if wait && index < 9 { try await sleep() }
        }
        return reply(packet, .working, "Clem is still working. Use Read latest result to hear the answer without sending the request again.", task: observed)
    }

    private func retain(_ result: ClemQuickVoiceReply?, task: ClemQuickVoiceTask,
                        fingerprint: String, generation: UInt64,
                        disposition: ClemQuickVoiceTask.Disposition? = nil) throws {
        try current(fingerprint, generation)
        guard var ledger = try storage.load(), ledger.pairingFingerprint == fingerprint,
              let index = ledger.tasks.firstIndex(where: { $0.requestId == task.requestId }),
              ledger.tasks[index].text == task.text,
              ledger.tasks[index].requestedConversationId == task.requestedConversationId else { throw ClemQuickVoiceFailure.storage }
        let prior = ledger.tasks[index]
        guard prior.conversationId == nil || task.conversationId == nil || prior.conversationId == task.conversationId else { throw ClemQuickVoiceFailure.response }
        // A slower working read can never erase an already-retained terminal.
        if prior.disposition == .completed || prior.disposition == .rejected { return }
        var updated = task; updated.reply = result
        updated.disposition = disposition ?? task.disposition ?? prior.disposition
        if updated.conversationId == nil { updated.conversationId = prior.conversationId }
        ledger.tasks[index] = updated
        try storage.save(ledger, generation: generation)
    }

    private func current(_ fingerprint: String, _ generation: UInt64) throws {
        try Task.checkCancellation()
        guard pairing()?.fingerprint == fingerprint, storage.generation == generation else { throw CancellationError() }
    }
    private func reply(_ packet: ClemQuickVoicePacket, _ status: ClemQuickVoiceReply.Status,
                       _ text: String, task: ClemQuickVoiceTask? = nil) -> ClemQuickVoiceReply {
        .init(requestId: packet.requestId, status: status, spokenText: text,
              conversationId: task?.conversationId ?? task?.requestedConversationId, taskRequestId: task?.requestId)
    }
    private func json(_ response: NativeVoiceHTTPResponse) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: response.body) as? [String: Any] else { throw ClemQuickVoiceFailure.response }
        return value
    }
    private static func date(_ text: String) -> Date? {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}
