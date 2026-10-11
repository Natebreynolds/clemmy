import ActivityKit
import AppIntents
import Foundation

enum ClemRecordingMode: String, AppEnum, Codable, Sendable {
    case voice
    case dictate

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Recording mode"
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .voice: "Talk to Clem",
        .dictate: "Dictate"
    ]
}

enum ClemRecordingPhase: String, Codable, Hashable, Sendable {
    case idle, preparing, recording, finishing, processing, speaking, ready
    case finished, cancelled, failed, needsPermission
}

/// Only recording status goes to the Lock Screen. No transcript, credentials,
/// conversation contents, file paths, or server response lives in this value.
struct ClemRecordingAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var phase: ClemRecordingPhase
        var message: String?
    }

    let recordingID: UUID
    let mode: ClemRecordingMode
    let startedAt: Date
    let deadline: Date
}
