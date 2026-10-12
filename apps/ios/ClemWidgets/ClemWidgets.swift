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

@main
struct ClemWidgets: WidgetBundle {
    var body: some Widget {
        ClemQuickActionsWidget()
        ClemSpaceWidget()
        ClemRecordingActivity()
        if #available(iOS 18.0, *) {
            ClemTalkControl()
            ClemDictateControl()
        }
    }
}
