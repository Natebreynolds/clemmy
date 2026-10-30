import AVFoundation
import SwiftUI

/// Foreground widget check-ins have their own brief native readback. Siri
/// actions use IntentDialog instead, so the same answer is never spoken twice.
@MainActor
final class ClemQuickVoicePresentation: ObservableObject {
    static let shared = ClemQuickVoicePresentation()
    @Published var reply: ClemQuickVoiceReply?
    private let speaker = AVSpeechSynthesizer()
    func show(_ value: ClemQuickVoiceReply, readAloud: Bool) {
        reply = value
        guard readAloud else { return }
        if #available(iOS 18.0, *), WidgetAudioRecorder.shared.hasActiveRecording { return }
        speaker.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: value.spokenText)
        speaker.speak(utterance)
    }
    func clear() { speaker.stopSpeaking(at: .immediate); reply = nil }
}

struct ClemQuickVoiceResultSheet: View {
    let reply: ClemQuickVoiceReply
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(reply.status == .working ? "Clem is working" : reply.status == .needsOwner ? "Your next step" : "From Clem")
                        .font(.title2.weight(.semibold))
                    Text(reply.spokenText).textSelection(.enabled)
                    if reply.taskRequestId != nil && reply.status == .working {
                        Button("Read latest result") {
                            let delivery = ClemQuickVoiceDelivery.capture()
                            Task { let value = await ClemQuickVoiceService.shared.latestResult()
                                let next = ClemQuickVoiceDelivery.fence(value, captured: delivery)
                                ClemQuickVoicePresentation.shared.show(next, readAloud: true) }
                        }.buttonStyle(.borderedProminent)
                        Button("Retry original request") {
                            let delivery = ClemQuickVoiceDelivery.capture()
                            Task { let value = await ClemQuickVoiceService.shared.retryLatest()
                                let next = ClemQuickVoiceDelivery.fence(value, captured: delivery)
                                ClemQuickVoicePresentation.shared.show(next, readAloud: true) }
                        }.buttonStyle(.bordered)
                    }
                    if let conversation = reply.conversationId {
                        Button("Open conversation") {
                            NotificationCenter.default.post(name: .clemQuickVoiceOpenConversation, object: conversation)
                            dismiss()
                        }.buttonStyle(.bordered)
                    }
                }.padding(24).frame(maxWidth: 620, alignment: .leading).frame(maxWidth: .infinity)
            }.navigationTitle("Clem").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

extension Notification.Name { static let clemQuickVoiceOpenConversation = Notification.Name("clem.quick-voice.open-conversation") }
