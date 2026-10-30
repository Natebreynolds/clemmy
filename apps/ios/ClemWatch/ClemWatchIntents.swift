import AppIntents

struct AskClemOnWatchIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Clem"
    static var description = IntentDescription("Dictate a question to Clem through your paired iPhone.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    // A required free-form parameter makes Siri ask for dictated text.
    // Free-form text is deliberately not interpolated in shortcut phrases.
    @Parameter(title: "Question", requestValueDialog: "What would you like to ask Clem?")
    var question: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Clem \(\.$question)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        ClemWatchSpeech.shared.stop()
        let access = ClemWatchAccess.shared
        let owner = access.beginSpeechInteraction()
        defer { access.endSpeechInteraction(owner) }
        await access.ask(question)
        guard access.ownsSpeechInteraction(owner) else { throw CancellationError() }
        let text = access.reply?.spokenText ?? "Open Clem on your Watch to check the request."
        return .result(value: text, dialog: IntentDialog("\(text)"))
    }
}

struct CheckInWithClemOnWatchIntent: AppIntent {
    static var title: LocalizedStringResource = "Check in with Clem"
    static var description = IntentDescription("Read a short check-in from Clem through your paired iPhone.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        ClemWatchSpeech.shared.stop()
        let access = ClemWatchAccess.shared
        let owner = access.beginSpeechInteraction()
        defer { access.endSpeechInteraction(owner) }
        await access.checkIn()
        guard access.ownsSpeechInteraction(owner) else { throw CancellationError() }
        let text = access.reply?.spokenText ?? "Open Clem on your Watch to check the connection."
        return .result(value: text, dialog: IntentDialog("\(text)"))
    }
}

struct ReadClemWatchResultIntent: AppIntent {
    static var title: LocalizedStringResource = "Read latest Clem result"
    static var description = IntentDescription("Check the exact saved Watch task without submitting it again.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        ClemWatchSpeech.shared.stop()
        let access = ClemWatchAccess.shared
        let owner = access.beginSpeechInteraction()
        defer { access.endSpeechInteraction(owner) }
        await access.readLatest()
        guard access.ownsSpeechInteraction(owner) else { throw CancellationError() }
        let text = access.reply?.spokenText ?? "There is no Watch task to read yet."
        return .result(value: text, dialog: IntentDialog("\(text)"))
    }
}

struct ClemWatchShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskClemOnWatchIntent(),
                    phrases: ["Ask \(.applicationName)", "Ask a question with \(.applicationName)"],
                    shortTitle: "Ask Clem", systemImageName: "waveform")
        AppShortcut(intent: CheckInWithClemOnWatchIntent(),
                    phrases: ["Check in with \(.applicationName)"],
                    shortTitle: "Check in", systemImageName: "sun.max")
        AppShortcut(intent: ReadClemWatchResultIntent(),
                    phrases: ["Read my latest result with \(.applicationName)"],
                    shortTitle: "Read latest result", systemImageName: "text.bubble")
    }
}
