import AppIntents
import Foundation

/// These widget actions deliberately foreground the containing app. A plain
/// extension intent has no paired credentials and must never pretend success.
@available(iOS 18.0, *)
struct CheckInWithClemIntent: AppIntent {
    static var title: LocalizedStringResource = "Check in with Clem"
    static var description = IntentDescription("Hear the current work and decisions waiting for you. No model call is needed.")
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Read aloud", default: false) var readAloud: Bool
    init() { readAloud = false }
    init(readAloud: Bool) { self.readAloud = readAloud }
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let words: String
        let dialog: String
        #if CLEM_WIDGET_EXTENSION
        throw ClemQuickAccessError.openClem
        #else
        let delivery = ClemQuickVoiceDelivery.capture()
        let value = await ClemQuickVoiceService.shared.dialog(.init(version: 1, operation: .checkIn, requestId: UUID().uuidString))
        let result = ClemQuickVoiceDelivery.fence(value, captured: delivery)
        ClemQuickVoicePresentation.shared.show(result, readAloud: readAloud)
        words = result.spokenText
        dialog = readAloud ? "Your check-in is ready in Clem." : result.spokenText
        #endif
        return .result(value: words, dialog: IntentDialog(stringLiteral: dialog))
    }
}

struct StartClemLiveConversationIntent: AppIntent {
    static var title: LocalizedStringResource = "Talk live with Clem"
    static var description = IntentDescription("Open a live conversation with Clem. Your microphone starts once after the app is unlocked and ready.")
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @MainActor func perform() async throws -> some IntentResult {
        #if CLEM_WIDGET_EXTENSION
        throw ClemQuickAccessError.openClem
        #else
        guard let fingerprint = PairingStore.load()?.fingerprint, !fingerprint.isEmpty,
              let url = URL(string: "clem://voice") else { throw ClemQuickAccessError.openClem }
        let id = UUID()
        let authority = PendingWidgetVoiceLaunchRepository.shared
        guard authority.park(pairingFingerprint: fingerprint, navigationID: id) else { throw ClemQuickAccessError.unavailable }
        guard PendingWidgetNavigationRepository.shared.park(url: url, pairingFingerprint: fingerprint, id: id) else {
            authority.clear(); throw ClemQuickAccessError.unavailable
        }
        PendingWidgetWorkflowLaunchRepository.shared.clear()
        PendingPushNavigationStore.clear()
        NotificationCenter.default.post(name: AppDelegate.pendingNavigationChanged, object: nil)
        #endif
        return .result()
    }
}

private enum ClemQuickAccessError: LocalizedError {
    case openClem, unavailable
    var errorDescription: String? {
        switch self {
        case .openClem: return "Open Clem on your iPhone and connect to your computer, then try again."
        case .unavailable: return "Clem could not prepare that action. Open the app and try again."
        }
    }
}
