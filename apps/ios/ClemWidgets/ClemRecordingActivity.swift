import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct ClemRecordingActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ClemRecordingAttributes.self) { context in
            ClemRecordingActivityView(attributes: context.attributes, state: context.state, isStale: context.isStale)
                .padding(.vertical, 14)
                .padding(.horizontal, 16)
                .activityBackgroundTint(ClemPalette.peel)
                .activitySystemActionForegroundColor(ClemPalette.ink)
                .widgetURL(presentation(context).openURL)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        ClemMark(size: 28)
                        Text(presentation(context).title)
                            .font(.clemRounded(16, .heavy))
                            .lineLimit(1)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if presentation(context).showsTimer {
                        ClemRecordingTimer(attributes: context.attributes, color: ClemPalette.islandAccent)
                            .fixedSize()
                            .padding(.trailing, 4)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    IslandFooter(attributes: context.attributes, presentation: presentation(context))
                        .padding(.top, 6)
                }
            } compactLeading: {
                Image(systemName: presentation(context).symbol)
                    .foregroundStyle(ClemPalette.islandAccent)
                    .accessibilityLabel(presentation(context).title)
            } compactTrailing: {
                if presentation(context).showsTimer {
                    ClemRecordingTimer(attributes: context.attributes, color: ClemPalette.islandAccent)
                        .frame(width: 48)
                } else {
                    Image(systemName: presentation(context).symbol)
                        .foregroundStyle(ClemPalette.islandAccent)
                        .accessibilityLabel(presentation(context).title)
                }
            } minimal: {
                Image(systemName: presentation(context).symbol)
                    .foregroundStyle(ClemPalette.islandAccent)
                    .accessibilityLabel(presentation(context).title)
            }
            .widgetURL(presentation(context).openURL)
            .keylineTint(ClemPalette.islandAccent)
        }
    }

    private func presentation(_ context: ActivityViewContext<ClemRecordingAttributes>) -> ClemRecordingPresentation {
        ClemRecordingPresentation(mode: context.attributes.mode, phase: context.state.phase, isStale: context.isStale)
    }
}

/// The island is black by system design, so its footer uses light text and a
/// translucent End instead of the banner's peel-coloured controls.
private struct IslandFooter: View {
    let attributes: ClemRecordingAttributes
    let presentation: ClemRecordingPresentation

    var body: some View {
        HStack(spacing: 10) {
            Text(presentation.autoSendHint ?? (presentation.needsAttention ? "Open Clem to check" : " "))
                .font(.clemRounded(13, .bold))
                .foregroundStyle(Color.white.opacity(0.7))
                .lineLimit(1)
            Spacer(minLength: 0)
            if #available(iOS 18.0, *), presentation.isActive, !presentation.needsAttention {
                Button(intent: CancelClemRecordingIntent(recordingID: attributes.recordingID.uuidString)) {
                    Text("End").font(.clemRounded(15, .heavy)).foregroundStyle(Color.white)
                        .padding(.horizontal, 20).frame(minHeight: 44)
                        .background(Capsule().fill(Color.white.opacity(0.16)))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(attributes.mode == .voice ? "End voice session" : "Cancel dictation")
            } else {
                Link(destination: presentation.openURL) {
                    Text("Open").font(.clemRounded(15, .heavy)).foregroundStyle(Color.black)
                        .padding(.horizontal, 20).frame(minHeight: 44)
                        .background(Capsule().fill(ClemPalette.islandAccent))
                }
                .accessibilityLabel("Open Clem")
            }
        }
    }
}
