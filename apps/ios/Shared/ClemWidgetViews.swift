import SwiftUI
import WidgetKit
import AppIntents

struct ClemEntry: TimelineEntry {
    let date: Date
    let space: ClemWidgetSpace?
}

enum ClemWidgetStyle {
    static func tint(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark ? Color(red: 1, green: 0.59, blue: 0.32) : Color(red: 0.74, green: 0.28, blue: 0.08)
    }
}

struct QuickActionsView: View {
    @Environment(\.colorScheme) private var colorScheme
    let entry: ClemEntry
    let family: WidgetFamily
    private var clemOrange: Color {
        ClemWidgetStyle.tint(for: colorScheme)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Clem").font(.headline).lineLimit(1)
            if family == .systemSmall {
                if #available(iOS 18.0, *) {
                    VStack(alignment: .leading, spacing: 0) {
                        recordingButton(.voice)
                        recordingButton(.dictate)
                    }
                    Spacer(minLength: 0)
                } else {
                    Spacer(minLength: 0)
                    Label("Talk", systemImage: "waveform").font(.headline).foregroundStyle(clemOrange)
                    Text("Tap to open voice").font(.caption).foregroundStyle(.secondary)
                }
            } else {
                HStack(spacing: 16) {
                    if #available(iOS 18.0, *) {
                        recordingButton(.voice)
                        recordingButton(.dictate)
                    } else {
                        Link(destination: URL(string: "clem://voice")!) {
                            actionLabel("Talk", symbol: "waveform")
                        }
                        .accessibilityLabel("Open voice in Clem")
                        Link(destination: URL(string: "clem://dictate")!) {
                            actionLabel("Dictate", symbol: "mic")
                        }
                        .accessibilityLabel("Open dictation in Clem")
                    }
                }.foregroundStyle(clemOrange)
                if let space = entry.space {
                    Link(destination: space.url) {
                        HStack {
                            Text(space.name).lineLimit(1)
                            Spacer(minLength: 8)
                            Image(systemName: "arrow.up.right")
                        }.font(.subheadline).frame(minHeight: 44)
                    }.privacySensitive()
                } else {
                    Text("Choose a Space in Clem to keep it here.").font(.caption).foregroundStyle(Color.primary.opacity(0.66))
                }
            }
        }
        .tint(clemOrange)
        .widgetURL(URL(string: "clem://voice"))
        .containerBackground(.background, for: .widget)
    }

    @available(iOS 18.0, *)
    private func recordingButton(_ mode: ClemRecordingMode) -> some View {
        Button(intent: StartClemRecordingIntent(mode: mode)) {
            actionLabel(mode == .voice ? "Talk" : "Dictate", symbol: mode == .voice ? "waveform" : "mic")
        }
        .buttonStyle(.plain)
        .foregroundStyle(clemOrange)
        .accessibilityLabel(mode == .voice ? "Start voice with Clem" : "Start dictation")
        .accessibilityHint(mode == .voice ? "Starts microphone recording. End voice from the Live Activity." : "Starts microphone recording. Stop or cancel from the Live Activity.")
    }

    private func actionLabel(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(.headline)
            .lineLimit(1)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
    }
}

struct SpaceWidgetView: View {
    let entry: ClemEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let space = entry.space {
                Text(space.name).font(.headline).lineLimit(2).layoutPriority(1)
                if !space.summary.isEmpty {
                    Text(space.summary).font(.subheadline).lineLimit(3)
                }
                Spacer(minLength: 0)
                HStack(spacing: 4) {
                    Text("Updated")
                    Text(space.updatedAt, style: .relative)
                }.font(.caption2).foregroundStyle(Color.primary.opacity(0.66)).lineLimit(1)
                Text("Saved snapshot").font(.caption2).foregroundStyle(Color.primary.opacity(0.66)).lineLimit(1).layoutPriority(1)
            } else {
                Text("Your Space").font(.headline)
                Text("Open a Space in Clem and choose Use in iPhone widget.").font(.subheadline).foregroundStyle(Color.primary.opacity(0.66))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .privacySensitive()
        .widgetURL(entry.space?.url ?? URL(string: "clem://space"))
        .containerBackground(.background, for: .widget)
    }
}

/// Presentation follows the recorder's state only. No transcript or response text
/// belongs in the widget or on the Lock Screen.
struct ClemRecordingPresentation {
    let mode: ClemRecordingMode
    let phase: ClemRecordingPhase
    var isStale = false

    var title: String {
        if isStale { return "Open Clem to check" }
        switch phase {
        case .idle: return "Ready to record"
        case .preparing: return "Starting microphone"
        case .recording: return mode == .voice ? "Clem is listening" : "Recording dictation"
        case .finishing: return "Finishing recording"
        case .processing: return mode == .voice ? "Clem is working" : "Transcribing dictation"
        case .speaking: return "Clem is speaking"
        case .ready: return mode == .voice ? "Ready to listen" : "Dictation ready"
        case .finished: return mode == .voice ? "Voice session ended" : "Dictation ready"
        case .cancelled: return mode == .voice ? "Voice session ended" : "Dictation cancelled"
        case .failed: return mode == .voice ? "Voice needs attention" : "Dictation needs attention"
        case .needsPermission: return "Microphone access needed"
        }
    }

    var symbol: String {
        if isStale { return "exclamationmark.circle" }
        switch phase {
        case .idle, .ready: return "mic"
        case .preparing, .finishing, .processing: return "ellipsis"
        case .recording: return mode == .voice ? "waveform" : "mic.fill"
        case .speaking: return "speaker.wave.2.fill"
        case .finished: return "checkmark"
        case .cancelled: return "stop.fill"
        case .failed, .needsPermission: return "exclamationmark.triangle"
        }
    }

    var isActive: Bool {
        switch phase {
        case .preparing, .recording, .finishing, .processing, .speaking, .ready: return true
        case .idle, .finished, .cancelled, .failed, .needsPermission: return false
        }
    }

    var showsTimer: Bool { isActive && !isStale && !(mode == .dictate && phase == .ready) }
    var canFinishUtterance: Bool { phase == .recording && !isStale }
    var endLabel: String { mode == .voice ? "End voice" : phase == .ready ? "Done" : "Cancel" }
    var openURL: URL { URL(string: "clem://recording")! }
}

struct ClemRecordingTimer: View {
    let attributes: ClemRecordingAttributes

    var body: some View {
        Text(timerInterval: attributes.startedAt...max(attributes.startedAt, attributes.deadline), countsDown: false, showsHours: false)
            .font(.caption.monospacedDigit())
            .accessibilityLabel("Session elapsed time")
            .accessibilityValue(Text(timerInterval: attributes.startedAt...max(attributes.startedAt, attributes.deadline), countsDown: false, showsHours: false))
    }
}

/// Shared with the app's native rendering tests; the widget extension supplies
/// authoritative ActivityKit values and never starts a recording from a view.
struct ClemRecordingActivityView: View {
    @Environment(\.colorScheme) private var colorScheme
    let attributes: ClemRecordingAttributes
    let state: ClemRecordingAttributes.ContentState
    var isStale = false
    var showsHeader = true

    private var presentation: ClemRecordingPresentation {
        ClemRecordingPresentation(mode: attributes.mode, phase: state.phase, isStale: isStale)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                if showsHeader {
                    Image(systemName: presentation.symbol)
                        .font(.title2)
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(presentation.title)
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                    if let message = statusMessage {
                        Text(message)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                if showsHeader && presentation.showsTimer {
                    Spacer(minLength: 0)
                    ClemRecordingTimer(attributes: attributes)
                        .fixedSize()
                }
            }
            .accessibilityElement(children: .combine)
            ClemRecordingControls(attributes: attributes, presentation: presentation)
        }
        .tint(ClemWidgetStyle.tint(for: colorScheme))
    }

    private var statusMessage: String? {
        if isStale { return "Status not updated." }
        if let message = state.message, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return message
        }
        switch state.phase {
        case .needsPermission: return "Open Clem to allow microphone access."
        case .failed: return "Open Clem to review what happened."
        case .ready where attributes.mode == .dictate, .finished where attributes.mode == .dictate:
            return "Open Clem to review your draft."
        default: return nil
        }
    }
}

private struct ClemRecordingControls: View {
    let attributes: ClemRecordingAttributes
    let presentation: ClemRecordingPresentation

    var body: some View {
        HStack(spacing: 8) {
            if #available(iOS 18.0, *), presentation.isActive {
                if presentation.canFinishUtterance {
                    Button(intent: FinishClemRecordingIntent(recordingID: attributes.recordingID.uuidString)) {
                        controlLabel(attributes.mode == .voice ? "Send now" : "Stop")
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel(attributes.mode == .voice ? "Send this utterance to Clem" : "Finish dictation")
                    .accessibilityHint(attributes.mode == .voice ? "Finish this recording and keep the voice session open." : "Stop recording and prepare your dictation draft.")
                }

                Button(intent: CancelClemRecordingIntent(recordingID: attributes.recordingID.uuidString)) {
                    controlLabel(presentation.endLabel)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(attributes.mode == .voice ? "End voice session" : presentation.endLabel == "Done" ? "Close dictation" : "Cancel dictation")
                .accessibilityHint(endHint)
            }
            Link(destination: presentation.openURL) {
                controlLabel("Open")
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Open Clem")
        }
    }

    private func controlLabel(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .lineLimit(2)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
    }

    private var endHint: String {
        if attributes.mode == .voice { return "Stop recording and spoken replies. Tasks already sent to Clem may continue." }
        if presentation.phase == .ready { return "Keep your saved draft." }
        if presentation.phase == .finishing || presentation.phase == .processing {
            return "Stop transcription and keep this recording available to retry."
        }
        return "Discard this recording."
    }
}
