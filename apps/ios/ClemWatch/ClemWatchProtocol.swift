import Foundation

enum ClemWatchOperation: String, Codable, Sendable {
    case checkIn, ask, result
}

enum ClemWatchStatus: String, Codable, Sendable {
    case completed, working, needsOwner, unavailable, failed

    var title: String {
        switch self {
        case .completed: return "Ready"
        case .working: return "Working"
        case .needsOwner: return "Needs you on iPhone"
        case .unavailable: return "Not connected"
        case .failed: return "Couldn’t finish"
        }
    }
}

enum ClemWatchError: Error {
    case invalidPacket, invalidText, pendingRequest, noTask, storageUnavailable
    case unsupported, connecting, companionMissing, unreachable, timeout

    var spokenText: String {
        switch self {
        case .invalidText: return "Ask a question of up to 8,000 characters."
        case .pendingRequest: return "Your earlier request is still pending. Read its latest result, or open Clem on iPhone."
        case .noTask: return "There is no Watch task to read yet. Ask Clem first."
        case .storageUnavailable: return "I couldn’t safely save this request. Unlock your Watch and open Clem, then try again."
        case .unsupported, .companionMissing: return "Open the paired Clem app on iPhone first."
        case .connecting: return "I’m connecting to your iPhone. Your request is saved; try again shortly."
        case .unreachable: return "Your iPhone isn’t reachable. Your request is saved; retry it when connected."
        case .timeout: return "Your iPhone hasn’t confirmed a result yet. Read the latest result or retry the saved request."
        case .invalidPacket: return "I couldn’t verify the iPhone’s reply. Open Clem on iPhone to check the request."
        }
    }
}

struct ClemWatchRequest: Codable, Equatable, Sendable {
    let version: Int
    let operation: ClemWatchOperation
    let requestID: UUID
    let text: String?
    let conversationID: String?

    enum CodingKeys: String, CodingKey {
        case version, operation, text
        case requestID = "requestId"
        case conversationID = "conversationId"
    }

    static func ask(_ text: String, id: UUID, conversationID: String?) throws -> Self {
        let value = Self(version: 1, operation: .ask, requestID: id, text: text, conversationID: conversationID)
        try value.validate()
        return value
    }

    static func checkIn(_ id: UUID) -> Self {
        Self(version: 1, operation: .checkIn, requestID: id, text: nil, conversationID: nil)
    }

    static func result(_ id: UUID) -> Self {
        Self(version: 1, operation: .result, requestID: id, text: nil, conversationID: nil)
    }

    func validate() throws {
        guard version == 1 else { throw ClemWatchError.invalidPacket }
        if operation == .ask {
            guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.count <= 8_000, text.utf8.count <= 32_000 else { throw ClemWatchError.invalidText }
            if let conversationID {
                guard Self.validConversationID(conversationID) else { throw ClemWatchError.invalidPacket }
            }
        } else if text != nil || conversationID != nil {
            throw ClemWatchError.invalidPacket
        }
    }

    static func validConversationID(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 512
            && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    var dictionary: [String: Any] {
        var value: [String: Any] = [
            "version": version, "operation": operation.rawValue, "requestId": requestID.uuidString
        ]
        if let text { value["text"] = text }
        if let conversationID { value["conversationId"] = conversationID }
        return value
    }
}

struct ClemWatchReply: Codable, Equatable, Sendable {
    let version: Int
    let requestID: UUID
    let status: ClemWatchStatus
    let spokenText: String
    let conversationID: String?
    let taskRequestID: UUID?

    enum CodingKeys: String, CodingKey {
        case version, status, spokenText
        case requestID = "requestId"
        case conversationID = "conversationId"
        case taskRequestID = "taskRequestId"
    }

    init(requestID: UUID, status: ClemWatchStatus, spokenText: String,
         conversationID: String? = nil, taskRequestID: UUID? = nil) {
        self.version = 1
        self.requestID = requestID
        self.status = status
        self.spokenText = spokenText
        self.conversationID = conversationID
        self.taskRequestID = taskRequestID
    }

    static func decode(_ packet: [String: Any], for requestID: UUID) throws -> Self {
        let allowed: Set<String> = ["version", "requestId", "status", "spokenText", "conversationId", "taskRequestId"]
        guard Set(packet.keys).isSubset(of: allowed), JSONSerialization.isValidJSONObject(packet) else {
            throw ClemWatchError.invalidPacket
        }
        let reply: Self
        do {
            let data = try JSONSerialization.data(withJSONObject: packet)
            guard data.count <= 64_000 else { throw ClemWatchError.invalidPacket }
            reply = try JSONDecoder().decode(Self.self, from: data)
        } catch {
            throw ClemWatchError.invalidPacket
        }
        guard reply.version == 1, reply.requestID == requestID,
              reply.taskRequestID == nil || reply.taskRequestID == requestID,
              !reply.spokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              reply.spokenText.count <= 16_000,
              reply.conversationID.map(ClemWatchRequest.validConversationID) ?? true else {
            throw ClemWatchError.invalidPacket
        }
        return reply
    }
}

/// One unresolved packet, one last task and one returned thread. No credentials,
/// audio, result transcript, authority or queue is stored on the Watch.
struct ClemWatchPendingState: Codable, Equatable {
    var version = 1
    private(set) var pendingRequest: ClemWatchRequest?
    private(set) var lastTaskRequest: ClemWatchRequest?
    private(set) var conversationID: String?

    var resultTaskRequest: ClemWatchRequest? {
        guard pendingRequest?.operation != .checkIn else { return nil }
        if let pendingRequest, pendingRequest.operation == .ask { return pendingRequest }
        return lastTaskRequest
    }

    func validate() throws {
        guard version == 1,
              conversationID.map(ClemWatchRequest.validConversationID) ?? true else {
            throw ClemWatchError.invalidPacket
        }
        try pendingRequest?.validate()
        try lastTaskRequest?.validate()
        guard pendingRequest?.operation != .result,
              lastTaskRequest == nil || lastTaskRequest?.operation == .ask else {
            throw ClemWatchError.invalidPacket
        }
    }

    mutating func beginAsk(_ text: String, id: UUID) throws -> ClemWatchRequest {
        guard pendingRequest == nil else { throw ClemWatchError.pendingRequest }
        let request = try ClemWatchRequest.ask(text, id: id, conversationID: conversationID)
        pendingRequest = request
        return request
    }

    mutating func beginCheckIn(id: UUID) throws -> ClemWatchRequest {
        guard pendingRequest == nil else { throw ClemWatchError.pendingRequest }
        let request = ClemWatchRequest.checkIn(id)
        pendingRequest = request
        return request
    }

    func resultRequest() throws -> ClemWatchRequest {
        guard let task = resultTaskRequest else {
            throw ClemWatchError.noTask
        }
        return .result(task.requestID)
    }

    mutating func accept(_ reply: ClemWatchReply, for request: ClemWatchRequest) -> Bool {
        guard reply.version == 1, reply.requestID == request.requestID,
              reply.taskRequestID == nil || reply.taskRequestID == request.requestID,
              pendingRequest == nil || pendingRequest?.requestID == request.requestID else { return false }
        switch request.operation {
        case .ask:
            guard pendingRequest == request || lastTaskRequest == request else { return false }
        case .result:
            guard resultTaskRequest?.requestID == request.requestID else { return false }
        case .checkIn:
            guard pendingRequest == request else { return false }
        }
        // Closed phone contract: needsOwner with no task receipt and no
        // conversation is a pre-admission refusal of this NEW ask. It is not
        // an approval/question result from an accepted task.
        if request.operation == .ask, reply.status == .needsOwner, reply.taskRequestID == nil {
            guard reply.conversationID == nil, pendingRequest == request else { return false }
            pendingRequest = nil
            return true
        }
        if request.operation != .checkIn, reply.status == .completed, reply.taskRequestID == nil {
            return false
        }
        if request.operation != .checkIn, reply.taskRequestID == request.requestID {
            guard let original = resultTaskRequest, original.requestID == request.requestID else { return false }
            lastTaskRequest = original
        }
        if request.operation != .checkIn, reply.taskRequestID != nil, let thread = reply.conversationID {
            guard ClemWatchRequest.validConversationID(thread) else { return false }
            conversationID = thread
        }
        // A failure or lost acknowledgement never grants a fresh task key.
        // Read latest/retry always retains the original immutable ask.
        if reply.status == .completed, pendingRequest?.requestID == request.requestID {
            pendingRequest = nil
        }
        return true
    }
}

/// Ephemeral presentation ownership only. Canonical task/receipt state is
/// untouched. A Siri action and a visible UI interaction cannot both read a
/// terminal aloud; cleanup from an older interaction cannot revoke the newer.
struct ClemWatchSpeechOwnership {
    private(set) var current: UUID?

    mutating func begin() -> UUID {
        let token = UUID()
        current = token
        return token
    }

    func owns(_ token: UUID) -> Bool { current == token }

    mutating func end(_ token: UUID) {
        if current == token { current = nil }
    }
}
