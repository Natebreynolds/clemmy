import SwiftUI
import WidgetKit

struct ClemEntry: TimelineEntry {
    let date: Date
    let space: ClemWidgetSpace?
}

struct QuickActionsView: View {
    @Environment(\.colorScheme) private var colorScheme
    let entry: ClemEntry
    let family: WidgetFamily
    private var clemOrange: Color {
        colorScheme == .dark ? Color(red: 1, green: 0.59, blue: 0.32) : Color(red: 0.74, green: 0.28, blue: 0.08)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Clem").font(.headline)
            if family == .systemSmall {
                Spacer(minLength: 0)
                Label("Talk", systemImage: "waveform").font(.headline).foregroundStyle(clemOrange)
                Text("Tap to open voice").font(.caption).foregroundStyle(Color.primary.opacity(0.66))
            } else {
                HStack(spacing: 24) {
                    Link(destination: URL(string: "clem://voice")!) {
                        Label("Talk", systemImage: "waveform").font(.headline).frame(minHeight: 44)
                    }
                    Link(destination: URL(string: "clem://dictate")!) {
                        Label("Dictate", systemImage: "mic").font(.headline).frame(minHeight: 44)
                    }
                    Spacer(minLength: 0)
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
