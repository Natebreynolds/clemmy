import AppIntents
import SwiftUI
import WidgetKit

private struct ClemProvider: TimelineProvider {
    func placeholder(in context: Context) -> ClemEntry { ClemEntry(date: Date(), space: nil) }
    func getSnapshot(in context: Context, completion: @escaping (ClemEntry) -> Void) {
        completion(ClemEntry(date: Date(), space: ClemWidgetSpaceStore.shared.load()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ClemEntry>) -> Void) {
        // No background network or invented freshness: only the app updates the
        // snapshot. Hourly entries re-render the same snapshot so its age
        // ("Updated 3 hours ago") stays true as time passes.
        let now = Date()
        let space = ClemWidgetSpaceStore.shared.load()
        let entries = (0..<12).map { hour in
            ClemEntry(date: now.addingTimeInterval(TimeInterval(hour) * 3_600), space: space)
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

private struct QuickActionsEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ClemEntry
    var body: some View { QuickActionsView(entry: entry, family: family) }
}

struct ClemQuickActionsWidget: Widget {
    let kind = "ClemQuickActions"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ClemProvider()) { QuickActionsEntryView(entry: $0) }
            .configurationDisplayName("Talk to Clem")
            .description("Tap Talk and speak. Clem sends when you pause and answers out loud. Dictate saves a draft.")
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryInline])
    }
}

struct ClemSpaceWidget: Widget {
    let kind = "ClemSpace"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ClemProvider()) { SpaceWidgetView(entry: $0) }
            .configurationDisplayName("Your Space")
            .description("The Space you pin in Clem, with how fresh it is.")
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

/// Explicit system entry points; no URL or timeline starts audio or work.
@available(iOS 18.0, *)
struct ClemQuickCheckInWidget: Widget {
    let kind = "ClemQuickCheckIn"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ClemProvider()) { _ in
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    ClemMark(size: 28)
                    Text("Clem").font(.headline).foregroundStyle(ClemPalette.ink)
                }
                Button(intent: CheckInWithClemIntent(readAloud: true)) {
                    Label("Check in", systemImage: "checkmark.bubble")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }.buttonStyle(.borderedProminent).tint(ClemPalette.accent)
                Button(intent: StartClemLiveConversationIntent()) {
                    Label("Talk live", systemImage: "waveform")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }.buttonStyle(.bordered).tint(ClemPalette.accentText)
            }.containerBackground(ClemPalette.peel, for: .widget)
        }.configurationDisplayName("Check in with Clem")
            .description("Hear a quick work update or open a live conversation.")
            .supportedFamilies([.systemSmall, .systemMedium])
    }
}

/// Edit Widget chooses a view, not a task or an execution policy.
struct ClemDashboardConfiguration: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Clem dashboard"
    static var description = IntentDescription("Choose saved information, your pinned workflows, or an overview.")

    @Parameter(title: "Show", default: .overview)
    var mode: ClemDashboardMode
}

private struct ClemDashboardEntry: TimelineEntry {
    let snapshot: ClemEntry
    let mode: ClemDashboardMode
    var date: Date { snapshot.date }
}

private struct ClemDashboardProvider: AppIntentTimelineProvider {
    typealias Intent = ClemDashboardConfiguration
    typealias Entry = ClemDashboardEntry

    func placeholder(in context: Context) -> ClemDashboardEntry { ClemDashboardEntry(snapshot: ClemEntry(date: Date(), space: nil), mode: .overview) }

    func snapshot(for configuration: ClemDashboardConfiguration, in context: Context) async -> ClemDashboardEntry {
        ClemDashboardEntry(snapshot: ClemEntry(date: Date(), space: ClemWidgetSpaceStore.shared.load(), workflows: ClemWidgetWorkflowStore.shared.load()), mode: configuration.mode)
    }

    func timeline(for configuration: ClemDashboardConfiguration, in context: Context) async -> Timeline<ClemDashboardEntry> {
        // Same snapshot-only contract as the existing Space widget. Refreshes
        // advance the displayed age, without fetching or starting any work.
        let now = Date()
        let space = ClemWidgetSpaceStore.shared.load()
        let workflows = ClemWidgetWorkflowStore.shared.load()
        let entries = (0..<12).map { hour in
            ClemDashboardEntry(snapshot: ClemEntry(date: now.addingTimeInterval(TimeInterval(hour) * 3_600), space: space, workflows: workflows), mode: configuration.mode)
        }
        return Timeline(entries: entries, policy: .atEnd)
    }
}

private struct DashboardEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ClemEntry
    let mode: ClemDashboardMode
    var body: some View { ClemDashboardView(entry: entry, mode: mode, family: family) }
}

struct ClemDashboardWidget: Widget {
    let kind = "ClemDashboard"
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: ClemDashboardConfiguration.self, provider: ClemDashboardProvider()) { entry in
            DashboardEntryView(entry: entry.snapshot, mode: entry.mode)
        }
        .configurationDisplayName("Clem dashboard")
        .description("Talk to Clem, keep a saved Space in view, or run your pinned workflows. Touch and hold to choose the view.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

/// Control Center, the Lock Screen and the Action button: one press starts
/// Talk through the same audio intent as the widget's Talk button.
@available(iOS 18.0, *)
struct ClemTalkControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "ai.breakthroughcoaching.clem.talk") {
            ControlWidgetButton(action: StartClemRecordingIntent(mode: .voice)) {
                Label("Talk to Clem", systemImage: "waveform")
            }
            .tint(ClemPalette.islandAccent)
        }
        .displayName("Talk to Clem")
        .description("Start talking to Clem. It sends when you pause.")
    }
}

@available(iOS 18.0, *)
struct ClemDictateControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "ai.breakthroughcoaching.clem.dictate") {
            ControlWidgetButton(action: StartClemRecordingIntent(mode: .dictate)) {
                Label("Dictate to Clem", systemImage: "mic")
            }
            .tint(ClemPalette.islandAccent)
        }
        .displayName("Dictate to Clem")
        .description("Record a draft for Clem.")
    }
}

@available(iOS 18.0, *)
struct ClemLiveConversationControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "ai.breakthroughcoaching.clem.live") {
            ControlWidgetButton(action: StartClemLiveConversationIntent()) {
                Label("Talk live with Clem", systemImage: "waveform")
            }.tint(ClemPalette.islandAccent)
        }.displayName("Talk live with Clem")
            .description("Open a live conversation with one press.")
    }
}

@available(iOS 18.0, *)
struct ClemCheckInControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "ai.breakthroughcoaching.clem.check-in") {
            ControlWidgetButton(action: CheckInWithClemIntent(readAloud: true)) {
                Label("Check in with Clem", systemImage: "checkmark.bubble")
            }.tint(ClemPalette.islandAccent)
        }.displayName("Check in with Clem")
            .description("Hear the current work and decisions waiting for you.")
    }
}

@main
struct ClemWidgets: WidgetBundle {
    var body: some Widget {
        ClemQuickActionsWidget()
        ClemSpaceWidget()
        ClemDashboardWidget()
        recordingActivity
        if #available(iOS 18.0, *) {
            ClemQuickCheckInWidget()
            ClemTalkControl()
            ClemDictateControl()
            ClemLiveConversationControl()
            ClemCheckInControl()
        }
    }

    // WidgetBundleBuilder supports #available additions, but not an else or
    // #unavailable replacement. Its public availability wrapper keeps one
    // recording configuration registered while preserving iOS 17 support.
    private var recordingActivity: some Widget {
        if #available(iOS 18.0, *) {
            return WidgetBundleBuilder.buildOptional(
                WidgetBundleBuilder.buildLimitedAvailability(ClemSupplementalRecordingActivity()))
        }
        return WidgetBundleBuilder.buildOptional(
            WidgetBundleBuilder.buildLimitedAvailability(ClemRecordingActivity()))
    }
}
