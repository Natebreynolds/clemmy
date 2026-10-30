import AVFAudio
import SwiftUI

@main
@MainActor
struct ClemWatchApp: App {
    @StateObject private var access = ClemWatchAccess.shared

    var body: some Scene {
        WindowGroup {
            ClemWatchHome(access: access)
                .task { access.activate() }
        }
    }
}

@MainActor
final class ClemWatchSpeech: ObservableObject {
    static let shared = ClemWatchSpeech()
    // Retain the synthesizer until speech ends; Siri owns intent readback.
    private let synthesizer = AVSpeechSynthesizer()

    func speak(_ text: String) {
        synthesizer.stopSpeaking(at: .immediate)
        synthesizer.speak(AVSpeechUtterance(string: text))
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }
}

@MainActor
private struct ClemWatchHome: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var access: ClemWatchAccess
    @StateObject private var speech = ClemWatchSpeech.shared
    @State private var draft = ""
    @State private var interaction: Task<Void, Never>?
    @State private var lastSpoken: SpokenReceipt?

    private struct SpokenReceipt: Equatable {
        let requestID: UUID
        let status: ClemWatchStatus
        let text: String
    }

    private var canAsk: Bool {
        !access.isSending && access.storageAvailable && access.state.pendingRequest == nil
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    // watchOS supplies its own keyboard, Dictation or Scribble.
                    // No app-owned audio recorder or continuous microphone.
                    TextField("Dictate or type a question", text: $draft)
                        .accessibilityLabel("Dictate or type your question for Clem")
                    Button("Ask Clem", systemImage: "waveform") {
                        let submitted = draft
                        runInteraction {
                            let saved = await access.ask(submitted)
                            if saved && draft == submitted { draft = "" }
                        }
                    }
                    .disabled(!canAsk || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    Button("Check in", systemImage: "sun.max") {
                        runInteraction { await access.checkIn() }
                    }
                    .disabled(!canAsk)
                }

                if access.isSending {
                    Section { ProgressView("Checking with iPhone…") }
                }

                if let reply = access.reply {
                    Section(reply.status.title) {
                        Text(reply.spokenText)
                        if reply.status == .needsOwner {
                            Text("Open Clem on iPhone to answer or review an approval.")
                                .font(.footnote)
                        }
                        Button("Read aloud", systemImage: "speaker.wave.2") {
                            speech.speak(reply.spokenText)
                        }
                        Button("Stop reading", systemImage: "speaker.slash") { speech.stop() }
                    }
                }

                if access.state.pendingRequest != nil {
                    Section("Saved request") {
                        Text("Retry sends the same saved request. It won’t create a second task.")
                            .font(.footnote)
                        Button("Retry saved request", systemImage: "arrow.clockwise") {
                            runInteraction { await access.retryPending() }
                        }
                        .disabled(access.isSending || !access.storageAvailable)
                    }
                }

                if access.state.resultTaskRequest != nil {
                    Section {
                        Button("Read latest result", systemImage: "text.bubble") {
                            runInteraction { await access.readLatest() }
                        }
                        .disabled(access.isSending || !access.storageAvailable)
                    }
                }
            }
            .navigationTitle("Clem")
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { access.activate() }
                else { cancelInteraction() }
            }
            .onDisappear { cancelInteraction() }
        }
    }

    private func runInteraction(_ action: @escaping @MainActor () async -> Void) {
        let owner = access.beginSpeechInteraction()
        let previous = interaction
        previous?.cancel()
        speech.stop()
        interaction = Task { @MainActor in
            defer { access.endSpeechInteraction(owner) }
            await previous?.value
            guard !Task.isCancelled, access.ownsSpeechInteraction(owner) else { return }
            await action()
            guard !Task.isCancelled, access.ownsSpeechInteraction(owner) else { return }
            if access.reply?.status == .working {
                await access.pollLatestWhileWorking(speechOwner: owner)
            }
            guard !Task.isCancelled, access.ownsSpeechInteraction(owner), let reply = access.reply else { return }
            let receipt = SpokenReceipt(requestID: reply.requestID, status: reply.status, text: reply.spokenText)
            guard receipt != lastSpoken else { return }
            lastSpoken = receipt
            speech.speak(reply.spokenText)
        }
    }

    private func cancelInteraction() {
        interaction?.cancel()
        interaction = nil
        speech.stop()
    }
}
