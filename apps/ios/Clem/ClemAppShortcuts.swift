import AppIntents
import Foundation

@available(iOS 18.0, *)
struct AskClemIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Clem"
    static var description = IntentDescription("Ask Clem a question or request work using her connected tools and memory.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Question", requestValueDialog: "What would you like to ask Clem?") var question: String
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let delivery = ClemQuickVoiceDelivery.capture()
        let value = await ClemQuickVoiceService.shared.ask(question)
        let result = ClemQuickVoiceDelivery.fence(value, captured: delivery)
        ClemQuickVoicePresentation.shared.show(result, readAloud: false)
        return .result(value: result.spokenText, dialog: IntentDialog(stringLiteral: result.spokenText))
    }
}

@available(iOS 18.0, *)
struct ReadClemLatestResultIntent: AppIntent {
    static var title: LocalizedStringResource = "Read Clem’s latest result"
    static var description = IntentDescription("Hear the answer to your last quick-voice request without sending it again.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let delivery = ClemQuickVoiceDelivery.capture()
        let value = await ClemQuickVoiceService.shared.latestResult()
        let result = ClemQuickVoiceDelivery.fence(value, captured: delivery)
        ClemQuickVoicePresentation.shared.show(result, readAloud: false)
        return .result(value: result.spokenText, dialog: IntentDialog(stringLiteral: result.spokenText))
    }
}

@available(iOS 18.0, *)
struct RetryClemOriginalRequestIntent: AppIntent {
    static var title: LocalizedStringResource = "Retry Clem’s saved request"
    static var description = IntentDescription("Check your original receipt before retrying the same saved request. No new task key is created.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let delivery = ClemQuickVoiceDelivery.capture()
        let value = await ClemQuickVoiceService.shared.retryLatest()
        let result = ClemQuickVoiceDelivery.fence(value, captured: delivery)
        ClemQuickVoicePresentation.shared.show(result, readAloud: false)
        return .result(value: result.spokenText, dialog: IntentDialog(stringLiteral: result.spokenText))
    }
}

@available(iOS 18.0, *)
struct ClemAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskClemIntent(), phrases: ["Ask \(.applicationName)"], shortTitle: "Ask Clem", systemImageName: "bubble.left.and.bubble.right")
        AppShortcut(intent: CheckInWithClemIntent(), phrases: ["Check in with \(.applicationName)"], shortTitle: "Check in", systemImageName: "checkmark.bubble")
        AppShortcut(intent: ReadClemLatestResultIntent(), phrases: ["Read my latest result from \(.applicationName)"], shortTitle: "Latest result", systemImageName: "text.bubble")
        AppShortcut(intent: RetryClemOriginalRequestIntent(), phrases: ["Retry my saved request with \(.applicationName)"], shortTitle: "Retry saved request", systemImageName: "arrow.clockwise")
        AppShortcut(intent: StartClemLiveConversationIntent(), phrases: ["Talk live with \(.applicationName)"], shortTitle: "Talk live", systemImageName: "waveform")
    }
}
