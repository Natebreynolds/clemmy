import SwiftUI
import WidgetKit

private struct ClemProvider: TimelineProvider {
    func placeholder(in context: Context) -> ClemEntry { ClemEntry(date: Date(), space: nil) }
    func getSnapshot(in context: Context, completion: @escaping (ClemEntry) -> Void) {
        completion(ClemEntry(date: Date(), space: ClemWidgetSpaceStore.shared.load()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ClemEntry>) -> Void) {
        // No background network or invented freshness. Only the app updates this snapshot.
        completion(Timeline(entries: [ClemEntry(date: Date(), space: ClemWidgetSpaceStore.shared.load())], policy: .never))
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
            .description("Open voice or dictation. Recording starts only after you tap in Clem.")
            .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct ClemSpaceWidget: Widget {
    let kind = "ClemSpace"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ClemProvider()) { SpaceWidgetView(entry: $0) }
            .configurationDisplayName("Your Space")
            .description("A saved snapshot of the Space you choose in Clem.")
            .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct ClemWidgets: WidgetBundle {
    var body: some Widget {
        ClemQuickActionsWidget()
        ClemSpaceWidget()
    }
}
