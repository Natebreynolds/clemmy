import AppIntents
import SwiftUI

/// A compact presentation of the iPhone's existing recording activity. The
/// Watch neither starts a microphone nor owns recording state. No transcript,
/// reply or free-form status message is rendered on this glanceable surface.
struct ClemWatchRecordingView: View {
    let attributes: ClemRecordingAttributes
    let state: ClemRecordingAttributes.ContentState
    var isStale = false

    private var presentation: ClemRecordingPresentation {
        ClemRecordingPresentation(mode: attributes.mode, phase: state.phase, isStale: isStale)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 7) {
                ClemMark(size: 28)
                Text(presentation.title)
                    .font(.system(.caption, design: .rounded).weight(.semibold))
                    .foregroundStyle(ClemPalette.ink)
                    .multilineTextAlignment(.leading)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Clem. \(presentation.title). On your iPhone.")
                    .privacySensitive()
            }
            action
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .environment(\.colorScheme, .light)
    }

    @ViewBuilder private var action: some View {
        if presentation.needsAttention || !presentation.isActive {
            openAction
        } else if #available(iOS 18.0, *) {
            if attributes.mode == .dictate && presentation.canFinishUtterance {
                Button(intent: FinishClemRecordingIntent(recordingID: attributes.recordingID.uuidString)) {
                    pill("Done")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Finish dictation")
                .accessibilityHint("Stop recording and prepare your dictation draft.")
            } else if attributes.mode == .dictate && presentation.phase == .ready {
                Link(destination: presentation.openURL) { pill("Review") }
                    .accessibilityLabel("Review your dictation draft")
            } else {
                Button(intent: CancelClemRecordingIntent(recordingID: attributes.recordingID.uuidString)) {
                    pill(attributes.mode == .voice ? "End voice" : "Cancel")
                }
                .buttonStyle(.plain)
                .accessibilityLabel(attributes.mode == .voice ? "End voice session" : "Cancel dictation")
                .accessibilityHint(attributes.mode == .voice
                    ? "Stop recording and spoken replies. Tasks already sent to Clem may continue."
                    : presentation.phase == .finishing || presentation.phase == .processing
                        ? "Stop transcription and keep this recording available to retry."
                        : "Discard this recording.")
            }
        } else {
            openAction
        }
    }

    private var openAction: some View {
        Link(destination: presentation.openURL) { pill("Open Clem") }
            .accessibilityLabel("Open Clem")
            .accessibilityHint("Check the recording on your iPhone.")
    }

    private func pill(_ title: String) -> some View {
        VStack(spacing: 0) {
            Text(title)
                .font(.system(.caption, design: .rounded).weight(.bold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
            Text("On iPhone")
                .font(.system(.caption2, design: .rounded))
                .foregroundStyle(Color.white.opacity(0.9))
                .lineLimit(1)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(Capsule().fill(ClemPalette.accent))
        .contentShape(Capsule())
    }
}
