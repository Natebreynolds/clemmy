import ActivityKit
import SwiftUI
import WidgetKit

struct ClemRecordingActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ClemRecordingAttributes.self) { context in
            ClemRecordingActivityView(attributes: context.attributes, state: context.state, isStale: context.isStale)
                .padding(16)
                .activityBackgroundTint(Color(uiColor: .secondarySystemBackground))
                .activitySystemActionForegroundColor(.primary)
                .widgetURL(presentation(context).openURL)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Clem", systemImage: presentation(context).symbol)
                        .font(.headline)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if presentation(context).showsTimer {
                        ClemRecordingTimer(attributes: context.attributes)
                            .fixedSize()
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ClemRecordingActivityView(attributes: context.attributes, state: context.state, isStale: context.isStale, showsHeader: false)
                        .padding(.top, 4)
                }
            } compactLeading: {
                Image(systemName: presentation(context).symbol)
                    .accessibilityLabel(presentation(context).title)
            } compactTrailing: {
                if presentation(context).showsTimer {
                    ClemRecordingTimer(attributes: context.attributes)
                        .frame(width: 48)
                } else {
                    Image(systemName: presentation(context).symbol)
                        .accessibilityLabel(presentation(context).title)
                }
            } minimal: {
                Image(systemName: presentation(context).symbol)
                    .accessibilityLabel(presentation(context).title)
            }
            .widgetURL(presentation(context).openURL)
            .keylineTint(.orange)
        }
    }

    private func presentation(_ context: ActivityViewContext<ClemRecordingAttributes>) -> ClemRecordingPresentation {
        ClemRecordingPresentation(mode: context.attributes.mode, phase: context.state.phase, isStale: context.isStale)
    }
}
