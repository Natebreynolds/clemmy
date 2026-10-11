import SwiftUI

@available(iOS 18.0, *)
struct WidgetVoiceSheet: View {
    @ObservedObject var session = WidgetVoiceSession.shared
    @ObservedObject var recorder = WidgetAudioRecorder.shared
    let onReconnect: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Label(session.status, systemImage: recorder.hasActiveRecording ? "mic.fill" : "waveform")
                        .font(.title2.weight(.semibold)).accessibilityAddTraits(.updatesFrequently)
                    if (session.setupRequested || !session.connected) && session.draft.isEmpty
                        && !session.hasUncertainRequest && !session.hasSavedRecording {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Speak from your widget").font(.headline)
                            Text("Enable microphone access once. After that, Talk and Dictate start here from your Home Screen, with recording controls in a Live Activity.")
                            if session.connected {
                                Button(session.mode == .voice ? "Enable microphone and talk" : "Enable microphone and dictate") {
                                    Task { await session.enableAndStart() }
                                }.buttonStyle(.borderedProminent).controlSize(.large)
                            } else {
                                Text("Keep Clem connected to your Mac to finish setup.").foregroundStyle(.secondary)
                                Button("Connect widget voice", action: onReconnect).buttonStyle(.bordered).controlSize(.large)
                            }
                        }
                    }
                    if let error = session.error {
                        Text(error).foregroundStyle(.red).accessibilityLabel("Voice message: \(error)")
                    }
                    if recorder.hasActiveRecording {
                        VStack(spacing: 12) {
                            if recorder.phase == .recording {
                            Button(session.mode == .voice ? "Send now" : "Finish dictation") {
                                Task { await session.finishFromSheet() }
                            }.buttonStyle(.borderedProminent).controlSize(.large)
                            }
                            Button(session.mode == .voice ? "End voice" : "Cancel recording") {
                                Task { await session.cancel() }
                            }.buttonStyle(.bordered).controlSize(.large)
                        }.frame(maxWidth: .infinity)
                    } else if session.working {
                        ProgressView(session.status).frame(maxWidth: .infinity)
                        Button(session.mode == .voice ? "End voice" : "Cancel transcription") { Task { await session.cancel() } }.buttonStyle(.bordered).controlSize(.large)
                    }
                    if !session.draft.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Your draft").font(.headline)
                            TextEditor(text: Binding(get: { session.draft }, set: { session.saveDraft($0) }))
                                .frame(minHeight: 160).padding(8).background(.background, in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(uiColor: .separator)))
                                .accessibilityLabel("Dictated draft").disabled(session.working || session.hasUncertainRequest)
                            Text("Review your words before sending. Your other chat drafts stay where you left them.")
                                .font(.footnote).foregroundStyle(.secondary)
                            HStack {
                                Button("Discard", role: .destructive) { session.discardDraft() }.buttonStyle(.bordered)
                                Spacer()
                                Button("Send to Clem") { session.sendDraft() }.buttonStyle(.borderedProminent)
                                    .disabled(session.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }.controlSize(.large).disabled(session.working || session.hasUncertainRequest)
                        }
                    }
                    if session.hasSavedRecording && !session.working {
                        Button("Retry transcription") { session.retryTranscription() }.buttonStyle(.bordered).controlSize(.large)
                        Button("Discard recording", role: .destructive) { Task { await session.discardRecording() } }.buttonStyle(.bordered).controlSize(.large)
                    }
                    if session.hasUncertainRequest && !session.working {
                        Button("Check last request") { session.checkLastRequest() }.buttonStyle(.borderedProminent).controlSize(.large)
                    }
                    if !session.reply.isEmpty { Text(session.reply).textSelection(.enabled) }
                    if session.sessionId != nil {
                        Button("Open conversation") { session.openConversation(); dismiss() }.buttonStyle(.bordered).controlSize(.large)
                    }
                    if session.connected && !session.setupRequested && !session.working && !recorder.hasActiveRecording
                        && session.draft.isEmpty && !session.hasUncertainRequest && !session.hasSavedRecording {
                        HStack {
                            Button { Task { await session.startFromSheet(mode: .voice) } } label: { Label("Talk", systemImage: "waveform") }
                            Button { Task { await session.startFromSheet(mode: .dictate) } } label: { Label("Dictate", systemImage: "mic") }
                        }.buttonStyle(.borderedProminent).controlSize(.large)
                    }
                }.padding(24).frame(maxWidth: 620, alignment: .leading).frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Clem").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.tint(ClemWidgetStyle.tint(for: colorScheme))
        .overlay {
            if scenePhase != .active { Color(uiColor: .systemBackground).ignoresSafeArea().overlay(Image(systemName: "lock.fill").font(.largeTitle)) }
        }
    }
}
