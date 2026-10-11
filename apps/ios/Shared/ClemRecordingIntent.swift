import AppIntents
import Foundation

/// LiveActivityIntent executes in the app process. The extension contains the
/// intent metadata and buttons only; it never owns a microphone or a session.
@available(iOS 18.0, *)
struct StartClemRecordingIntent: AudioRecordingIntent, LiveActivityIntent {
    static var title: LocalizedStringResource = "Start recording with Clem"
    static var description = IntentDescription("Start a visible, bounded recording with Clem.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "Mode") var mode: ClemRecordingMode

    init() { mode = .dictate }
    init(mode: ClemRecordingMode) { self.mode = mode }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if CLEM_WIDGET_EXTENSION
        throw ClemRecordingIntentError.openClem
        #else
        do {
            try await WidgetVoiceSession.shared.start(mode: mode)
        } catch WidgetVoiceError.setupRequired {
            throw needsToContinueInForegroundError("Open Clem to enable widget recording.")
        } catch WidgetVoiceError.microphonePermissionRequired {
            throw needsToContinueInForegroundError("Open Clem to allow microphone access.")
        } catch WidgetVoiceError.pendingDraft {
            throw needsToContinueInForegroundError("Open Clem to review your saved recording.")
        }
        #endif
        return .result()
    }
}

#if !CLEM_WIDGET_EXTENSION
@available(iOS 18.0, *)
extension StartClemRecordingIntent: ForegroundContinuableIntent {}
#endif

@available(iOS 18.0, *)
struct FinishClemRecordingIntent: AudioRecordingIntent, LiveActivityIntent {
    static var title: LocalizedStringResource = "Finish recording"
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "Recording") var recordingID: String

    init() { recordingID = "" }
    init(recordingID: String) { self.recordingID = recordingID }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if CLEM_WIDGET_EXTENSION
        throw ClemRecordingIntentError.openClem
        #else
        guard let id = UUID(uuidString: recordingID),
              WidgetAudioRecorder.shared.activityRecordingID == id else {
            throw ClemRecordingIntentError.recordingEnded
        }
        try await WidgetVoiceSession.shared.finish()
        #endif
        return .result()
    }
}

@available(iOS 18.0, *)
struct CancelClemRecordingIntent: AudioRecordingIntent, LiveActivityIntent {
    static var title: LocalizedStringResource = "Cancel recording"
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "Recording") var recordingID: String

    init() { recordingID = "" }
    init(recordingID: String) { self.recordingID = recordingID }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if CLEM_WIDGET_EXTENSION
        throw ClemRecordingIntentError.openClem
        #else
        guard let id = UUID(uuidString: recordingID),
              WidgetAudioRecorder.shared.activityRecordingID == id else {
            throw ClemRecordingIntentError.recordingEnded
        }
        await WidgetVoiceSession.shared.cancel()
        #endif
        return .result()
    }
}

private enum ClemRecordingIntentError: LocalizedError {
    case openClem, recordingEnded
    var errorDescription: String? {
        switch self {
        case .openClem: return "Open Clem to set up microphone access, then try the widget again."
        case .recordingEnded: return "This recording has already ended."
        }
    }
}
