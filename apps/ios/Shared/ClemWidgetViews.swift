import SwiftUI
import WidgetKit
import AppIntents

struct ClemEntry: TimelineEntry {
    let date: Date
    let space: ClemWidgetSpace?
}

/// Clem's widget look: clementine peel ground, one strong orange action, the
/// bulldog mark. Widgets and the Lock Screen banner stay light in dark mode;
/// iOS's own tinted and clear Home Screens still recolour them.
enum ClemPalette {
    static let peel = Color(red: 1.0, green: 0.957, blue: 0.918)        // #FFF4EA
    static let card = Color.white
    static let ink = Color(red: 0.141, green: 0.090, blue: 0.059)       // #24170F
    static let muted = Color(red: 0.431, green: 0.329, blue: 0.267)     // #6E5444
    static let accent = Color(red: 0.761, green: 0.290, blue: 0.063)    // #C24A10
    static let accentSoft = Color(red: 1.0, green: 0.878, blue: 0.769)  // #FFE0C4
    static let accentText = Color(red: 0.620, green: 0.227, blue: 0.039) // #9E3A0A
    /// The Dynamic Island is always black; its contents use the bright orange.
    static let islandAccent = Color(red: 1.0, green: 0.580, blue: 0.278) // #FF9447
}

enum ClemWidgetStyle {
    static func tint(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark ? ClemPalette.islandAccent : ClemPalette.accent
    }
}

extension Font {
    static func clemRounded(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }
}

/// The bulldog mark, kept crisp (it is pixel art) and in full colour even on a
/// tinted Home Screen.
struct ClemMark: View {
    var size: CGFloat = 26
    var body: some View {
        let image = Image("ClemMark").resizable().interpolation(.none)
        Group {
            if #available(iOS 18.0, *) {
                image.widgetAccentedRenderingMode(.fullColor)
            } else {
                image
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct ClemHeader: View {
    var body: some View {
        HStack(spacing: 7) {
            ClemMark(size: 26)
            Text("Clem").font(.clemRounded(15, .heavy)).foregroundStyle(ClemPalette.ink).lineLimit(1)
        }
    }
}

private struct WaveformGlyph: View {
    var size: CGFloat = 20
    var body: some View {
        Image(systemName: "waveform").font(.system(size: size * 0.9, weight: .bold)).accessibilityHidden(true)
    }
}

// MARK: - Talk / Dictate widget

struct QuickActionsView: View {
    let entry: ClemEntry
    let family: WidgetFamily

    var body: some View {
        Group {
            switch family {
            case .systemMedium: medium
            case .accessoryCircular: accessoryTalk
            case .accessoryRectangular: SpaceAccessoryView(space: entry.space)
            case .accessoryInline: accessoryInline
            default: small
            }
        }
        .environment(\.colorScheme, .light)
        .widgetURL(URL(string: "clem://voice"))
        .containerBackground(for: .widget) { ClemPalette.peel }
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            ClemHeader()
            Spacer(minLength: 6)
            Text("Ask, plan or capture a thought")
                .font(.clemRounded(13, .semibold))
                .foregroundStyle(ClemPalette.muted)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
            Spacer(minLength: 8)
            HStack(spacing: 8) {
                ClemActionButton(mode: .voice) { TalkPill(height: 48, fontSize: 16) }
                ClemActionButton(mode: .dictate) { DictateCircle(size: 48) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var medium: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                ClemHeader()
                Spacer(minLength: 4)
                ClemActionButton(mode: .voice) { TalkPill(height: 46, fontSize: 16) }
                ClemActionButton(mode: .dictate) { DictatePill(height: 40) }
            }
            .frame(width: 128)
            SpaceCard(space: entry.space, now: entry.date)
        }
    }

    private var accessoryTalk: some View {
        ZStack {
            AccessoryWidgetBackground()
            Image(systemName: "waveform").font(.system(size: 22, weight: .bold))
        }
        .widgetAccentable()
        .accessibilityLabel("Talk to Clem")
    }

    private var accessoryInline: some View {
        Label(entry.space.map { "Clem · \($0.name)" } ?? "Talk to Clem", systemImage: "waveform")
    }
}

/// On iOS 18 the button starts recording through the app's audio intent; on
/// iOS 17 it opens Clem at the matching control. Either way the label is the same.
private struct ClemActionButton<Label: View>: View {
    let mode: ClemRecordingMode
    @ViewBuilder let label: () -> Label

    var body: some View {
        if #available(iOS 18.0, *) {
            Button(intent: StartClemRecordingIntent(mode: mode)) { label() }
                .buttonStyle(.plain)
                .accessibilityLabel(mode == .voice ? "Talk to Clem" : "Dictate to Clem")
                .accessibilityHint(mode == .voice
                    ? "Starts listening. It sends when you pause; end it from the Lock Screen banner."
                    : "Starts recording a draft. Finish it from the Lock Screen banner.")
        } else {
            Link(destination: URL(string: mode == .voice ? "clem://voice" : "clem://dictate")!) { label() }
                .accessibilityLabel(mode == .voice ? "Open voice in Clem" : "Open dictation in Clem")
        }
    }
}

private struct TalkPill: View {
    let height: CGFloat
    let fontSize: CGFloat
    var body: some View {
        HStack(spacing: 6) {
            WaveformGlyph(size: 20)
            Text("Talk").font(.clemRounded(fontSize, .heavy)).lineLimit(1)
        }
        .foregroundStyle(Color.white)
        .frame(maxWidth: .infinity, minHeight: height, maxHeight: height)
        .background(Capsule().fill(ClemPalette.accent))
        .widgetAccentable()
        .contentShape(Capsule())
    }
}

private struct DictateCircle: View {
    let size: CGFloat
    var body: some View {
        Image(systemName: "mic").font(.system(size: 19, weight: .bold))
            .foregroundStyle(ClemPalette.accentText)
            .frame(width: size, height: size)
            .background(Circle().fill(ClemPalette.accentSoft))
            .contentShape(Circle())
    }
}

private struct DictatePill: View {
    let height: CGFloat
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "mic").font(.system(size: 15, weight: .bold))
            Text("Dictate").font(.clemRounded(14, .heavy)).lineLimit(1)
        }
        .foregroundStyle(ClemPalette.accentText)
        .frame(maxWidth: .infinity, minHeight: height, maxHeight: height)
        .background(Capsule().fill(ClemPalette.accentSoft))
        .contentShape(Capsule())
    }
}

// MARK: - Space

/// How a saved Space snapshot describes its age. The widget never fetches;
/// past a few hours it says how old the snapshot is instead of looking current.
struct ClemSpaceFreshness {
    static let staleAfter: TimeInterval = 6 * 60 * 60
    let text: String
    let isStale: Bool

    init(space: ClemWidgetSpace, now: Date) {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        let age = formatter.localizedString(for: min(space.updatedAt, now), relativeTo: now)
        isStale = now.timeIntervalSince(space.savedAt) > Self.staleAfter
        text = isStale ? "From \(age) · tap to refresh" : "Updated \(age)"
    }
}

private struct SpaceCard: View {
    let space: ClemWidgetSpace?
    let now: Date

    var body: some View {
        Group {
            if let space {
                Link(destination: space.url) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            SpaceCaption()
                            Spacer(minLength: 4)
                            Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .bold)).foregroundStyle(ClemPalette.muted)
                        }
                        Text(space.name).font(.clemRounded(17, .heavy)).foregroundStyle(ClemPalette.ink).lineLimit(2).minimumScaleFactor(0.85)
                        if !space.summary.isEmpty {
                            Text(space.summary).font(.clemRounded(13, .bold)).foregroundStyle(ClemPalette.ink.opacity(0.85)).lineLimit(2)
                        }
                        Spacer(minLength: 0)
                        FreshnessLine(freshness: ClemSpaceFreshness(space: space, now: now))
                    }
                }
                .privacySensitive()
            } else {
                Link(destination: URL(string: "clem://space")!) {
                    VStack(alignment: .leading, spacing: 6) {
                        SpaceCaption()
                        HStack(spacing: 10) {
                            Image(systemName: "plus").font(.system(size: 16, weight: .heavy))
                                .foregroundStyle(ClemPalette.accentText)
                                .frame(width: 34, height: 34)
                                .background(Circle().fill(ClemPalette.accentSoft))
                            Text("Pin a Space here").font(.clemRounded(15, .heavy)).foregroundStyle(ClemPalette.ink).lineLimit(2)
                        }
                        Text("Open a Space in Clem and tap Use in iPhone widget.")
                            .font(.clemRounded(12, .semibold)).foregroundStyle(ClemPalette.muted).lineLimit(2)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(ClemPalette.card))
    }
}

private struct SpaceCaption: View {
    var body: some View {
        Text("SPACE").font(.clemRounded(11, .heavy)).kerning(0.6).foregroundStyle(ClemPalette.muted)
    }
}

private struct FreshnessLine: View {
    let freshness: ClemSpaceFreshness
    var body: some View {
        HStack(spacing: 4) {
            if freshness.isStale {
                Image(systemName: "arrow.clockwise").font(.system(size: 10, weight: .heavy))
            }
            Text(freshness.text).lineLimit(1).minimumScaleFactor(0.8)
        }
        .font(.clemRounded(11, .bold))
        .foregroundStyle(freshness.isStale ? ClemPalette.accentText : ClemPalette.muted)
    }
}

struct SpaceWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ClemEntry

    var body: some View {
        Group {
            switch family {
            case .systemMedium: medium
            case .accessoryRectangular: SpaceAccessoryView(space: entry.space)
            default: small
            }
        }
        .environment(\.colorScheme, .light)
        .widgetURL(entry.space?.url ?? URL(string: "clem://space"))
        .containerBackground(for: .widget) { ClemPalette.peel }
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                SpaceCaption()
                Spacer(minLength: 4)
                ClemMark(size: 20)
            }
            if let space = entry.space {
                Text(space.name).font(.clemRounded(17, .heavy)).foregroundStyle(ClemPalette.ink).lineLimit(2).minimumScaleFactor(0.85)
                if !space.summary.isEmpty {
                    Text(space.summary).font(.clemRounded(13, .bold)).foregroundStyle(ClemPalette.ink.opacity(0.85)).lineLimit(3)
                }
                Spacer(minLength: 0)
                FreshnessLine(freshness: ClemSpaceFreshness(space: space, now: entry.date))
            } else {
                Text("Pin a Space here").font(.clemRounded(16, .heavy)).foregroundStyle(ClemPalette.ink).lineLimit(2)
                Text("In Clem, open a Space and tap Use in iPhone widget.")
                    .font(.clemRounded(12, .semibold)).foregroundStyle(ClemPalette.muted).lineLimit(3)
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .privacySensitive()
    }

    private var medium: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                ClemHeader()
                Spacer(minLength: 0)
                Text("Your pinned Space").font(.clemRounded(13, .semibold)).foregroundStyle(ClemPalette.muted).lineLimit(2)
            }
            .frame(width: 110, alignment: .leading)
            SpaceCard(space: entry.space, now: entry.date)
        }
    }
}

private struct SpaceAccessoryView: View {
    let space: ClemWidgetSpace?
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(space?.name ?? "Clem").font(.clemRounded(15, .heavy)).lineLimit(1).widgetAccentable()
            Text(space.map { $0.summary.isEmpty ? "Open your Space" : $0.summary } ?? "Pin a Space in Clem")
                .font(.clemRounded(13, .semibold)).lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .privacySensitive()
    }
}

// MARK: - Recording banner

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
        case .recording: return mode == .voice ? "Listening" : "Recording dictation"
        case .finishing: return mode == .voice ? "Sending" : "Finishing recording"
        case .processing: return mode == .voice ? "Working on it" : "Transcribing dictation"
        case .speaking: return "Speaking"
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

    /// The trouble states lead with an alert badge instead of the mark.
    var needsAttention: Bool { isStale || phase == .failed || phase == .needsPermission }
    var showsTimer: Bool { isActive && !isStale && !(mode == .dictate && phase == .ready) }
    var canFinishUtterance: Bool { phase == .recording && !isStale }
    /// Talk ends by itself when the speaker pauses, so the banner says so.
    var autoSendHint: String? { mode == .voice && phase == .recording && !isStale ? "Sends when you pause" : nil }
    var endLabel: String { mode == .voice ? "End voice" : phase == .ready ? "Done" : "Cancel" }
    var openURL: URL { URL(string: "clem://recording")! }
}

struct ClemRecordingTimer: View {
    let attributes: ClemRecordingAttributes
    var color: Color = ClemPalette.accentText

    var body: some View {
        Text(timerInterval: attributes.startedAt...max(attributes.startedAt, attributes.deadline), countsDown: false, showsHours: false)
            .font(.clemRounded(14, .bold).monospacedDigit())
            .foregroundStyle(color)
            .accessibilityLabel("Session elapsed time")
            .accessibilityValue(Text(timerInterval: attributes.startedAt...max(attributes.startedAt, attributes.deadline), countsDown: false, showsHours: false))
    }
}

/// A still, decorative waveform: Lock Screen banners do not animate.
private struct LiveBars: View {
    var color: Color = ClemPalette.accent
    private let heights: [CGFloat] = [6, 10, 16, 8, 13, 18, 11, 7, 14, 17, 9, 5, 12, 16, 10, 6]
    var body: some View {
        HStack(spacing: 3) {
            ForEach(heights.indices, id: \.self) { index in
                Capsule().fill(color).frame(width: 3, height: heights[index])
            }
        }
        .frame(height: 18)
        .accessibilityHidden(true)
    }
}

/// Shared with the app's native rendering tests; the widget extension supplies
/// authoritative ActivityKit values and never starts a recording from a view.
struct ClemRecordingActivityView: View {
    let attributes: ClemRecordingAttributes
    let state: ClemRecordingAttributes.ContentState
    var isStale = false
    var showsHeader = true

    private var presentation: ClemRecordingPresentation {
        ClemRecordingPresentation(mode: attributes.mode, phase: state.phase, isStale: isStale)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            if showsHeader { leadingBadge }
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(presentation.title)
                        .font(.clemRounded(16, .heavy))
                        .foregroundStyle(ClemPalette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if presentation.showsTimer {
                        ClemRecordingTimer(attributes: attributes).fixedSize()
                    }
                }
                if presentation.canFinishUtterance && attributes.mode == .voice {
                    LiveBars()
                }
                if let message = statusMessage {
                    Text(message)
                        .font(.clemRounded(13, .semibold))
                        .foregroundStyle(ClemPalette.muted)
                        .lineLimit(2)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            ClemRecordingControls(attributes: attributes, presentation: presentation)
        }
        .environment(\.colorScheme, .light)
    }

    @ViewBuilder private var leadingBadge: some View {
        if presentation.needsAttention {
            badge(symbol: "exclamationmark.circle")
        } else if attributes.mode == .dictate {
            badge(symbol: "mic")
        } else {
            ClemMark(size: 34)
        }
    }

    private func badge(symbol: String) -> some View {
        Image(systemName: symbol).font(.system(size: 17, weight: .bold))
            .foregroundStyle(ClemPalette.accentText)
            .frame(width: 34, height: 34)
            .background(Circle().fill(ClemPalette.accentSoft))
            .accessibilityHidden(true)
    }

    private var statusMessage: String? {
        if isStale { return "Status not updated." }
        if let message = state.message, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return message
        }
        if let hint = presentation.autoSendHint { return hint }
        switch state.phase {
        case .needsPermission: return "Open Clem to allow microphone access."
        case .failed: return "Open Clem to review what happened."
        case .ready where attributes.mode == .dictate, .finished where attributes.mode == .dictate:
            return "Open Clem to review your draft."
        default: return nil
        }
    }
}

/// One clear action per state, plus a quiet end. Talk sends itself on a
/// pause, so it shows only End; dictation waits for Done.
private struct ClemRecordingControls: View {
    let attributes: ClemRecordingAttributes
    let presentation: ClemRecordingPresentation

    var body: some View {
        HStack(spacing: 8) {
            if presentation.needsAttention || !presentation.isActive {
                Link(destination: presentation.openURL) { primaryPill("Open") }
                    .accessibilityLabel("Open Clem")
            } else if #available(iOS 18.0, *) {
                if attributes.mode == .dictate && presentation.canFinishUtterance {
                    Button(intent: FinishClemRecordingIntent(recordingID: attributes.recordingID.uuidString)) { primaryPill("Done") }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Finish dictation")
                        .accessibilityHint("Stop recording and prepare your dictation draft.")
                } else if attributes.mode == .dictate && presentation.phase == .ready {
                    Link(destination: presentation.openURL) { primaryPill("Review") }
                        .accessibilityLabel("Review your dictation draft")
                } else if presentation.phase == .speaking {
                    Button(intent: CancelClemRecordingIntent(recordingID: attributes.recordingID.uuidString)) { quietPill("Stop") }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Stop speaking and end voice")
                }
                if presentation.phase != .speaking {
                    Button(intent: CancelClemRecordingIntent(recordingID: attributes.recordingID.uuidString)) {
                        Image(systemName: "xmark").font(.system(size: 15, weight: .heavy))
                            .foregroundStyle(ClemPalette.accentText)
                            .frame(width: 44, height: 44)
                            .background(Circle().fill(ClemPalette.accentSoft))
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(attributes.mode == .voice ? "End voice session" : presentation.endLabel == "Done" ? "Close dictation" : "Cancel dictation")
                    .accessibilityHint(endHint)
                }
            } else {
                Link(destination: presentation.openURL) { primaryPill("Open") }
                    .accessibilityLabel("Open Clem")
            }
        }
    }

    private func primaryPill(_ title: String) -> some View {
        Text(title).font(.clemRounded(15, .heavy)).foregroundStyle(Color.white).lineLimit(1)
            .padding(.horizontal, 16).frame(minHeight: 44)
            .background(Capsule().fill(ClemPalette.accent))
            .contentShape(Capsule())
    }

    private func quietPill(_ title: String) -> some View {
        Text(title).font(.clemRounded(15, .heavy)).foregroundStyle(ClemPalette.accentText).lineLimit(1)
            .padding(.horizontal, 16).frame(minHeight: 44)
            .background(Capsule().fill(ClemPalette.accentSoft))
            .contentShape(Capsule())
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
