import AppIntents
import SwiftUI
import WidgetKit

/// WidgetKit owns this choice. It changes the presentation of explicitly saved
/// data, never what Clem runs or which account she uses.
enum ClemDashboardMode: String, AppEnum, CaseIterable {
    case overview
    case information
    case workflows

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Widget view"
    static var caseDisplayRepresentations: [ClemDashboardMode: DisplayRepresentation] = [
        .overview: "Overview",
        .information: "Information",
        .workflows: "Workflows"
    ]
}

/// A single open surface: voice controls, saved information and a short list of
/// explicitly pinned workflows. Run buttons hand off to the native intent;
/// the app owns validation and execution. This view has no network client.
struct ClemDashboardView: View {
    let entry: ClemEntry
    let mode: ClemDashboardMode
    let family: WidgetFamily
    @Environment(\.dynamicTypeSize) private var typeSize

    private var isLarge: Bool { family == .systemLarge }
    private var largerType: Bool { typeSize >= .xxLarge }
    private var workflows: [ClemWidgetWorkflow] { Array(entry.workflows.prefix(3)) }

    var body: some View {
        VStack(alignment: .leading, spacing: isLarge ? 12 : 8) {
            header
            switch mode {
            case .overview:
                if isLarge {
                    savedInformation(compact: true)
                    separator
                    workflowList(showSummaries: false)
                } else {
                    savedInformation(compact: true)
                }
            case .information:
                savedInformation(compact: !isLarge)
            case .workflows:
                if isLarge { workflowList(showSummaries: true) }
                else { workflowColumns }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .multilineTextAlignment(.leading)
        .environment(\.colorScheme, .light)
        .containerBackground(for: .widget) { ClemPalette.peel }
    }

    private var header: some View {
        HStack(spacing: 8) {
            ClemMark(size: isLarge ? 30 : 26)
            Text("Clem")
                .font(.system(.headline, design: .rounded).weight(.heavy))
                .foregroundStyle(ClemPalette.ink)
                .lineLimit(1)
                .layoutPriority(1)
            Spacer(minLength: 4)
            DashboardRecordingButton(mode: .voice) {
                Label("Talk", systemImage: "waveform")
                    .font(.system(.subheadline, design: .rounded).weight(.bold))
                    .labelStyle(.titleAndIcon)
                    .lineLimit(1)
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 13)
                    .frame(minWidth: 70, minHeight: 44)
                    .background(Capsule().fill(ClemPalette.accent))
                    .widgetAccentable()
            }
            DashboardRecordingButton(mode: .dictate) {
                Image(systemName: "mic")
                    .font(.system(.headline, design: .rounded).weight(.bold))
                    .foregroundStyle(ClemPalette.accentText)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(ClemPalette.accentSoft))
            }
        }
    }

    @ViewBuilder private func savedInformation(compact: Bool) -> some View {
        if let space = entry.space {
            let freshness = ClemSpaceFreshness(space: space, now: entry.date)
            Link(destination: space.url) {
                VStack(alignment: .leading, spacing: compact ? 4 : 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(space.name)
                            .multilineTextAlignment(.leading)
                            .font(.system(compact ? .headline : .title2, design: .rounded).weight(.bold))
                            .foregroundStyle(ClemPalette.ink)
                            .lineLimit(compact && isLarge ? 1 : 2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(ClemPalette.accentText)
                            .accessibilityHidden(true)
                    }
                    if !space.summary.isEmpty && (isLarge || !largerType) {
                        Text(space.summary)
                            .multilineTextAlignment(.leading)
                            .font(.system(compact ? .caption : .body, design: .rounded))
                            .foregroundStyle(ClemPalette.ink)
                            .lineLimit(compact ? (isLarge && !largerType ? 2 : 1) : (largerType ? 5 : 7))
                    }
                    if !compact { Spacer(minLength: 0) }
                    Text(freshness.text)
                        .multilineTextAlignment(.leading)
                        .font(.system(.caption2, design: .rounded).weight(.medium))
                        .foregroundStyle(freshness.isStale ? ClemPalette.accentText : ClemPalette.muted)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, maxHeight: compact ? nil : .infinity, alignment: .topLeading)
                .contentShape(Rectangle())
            }
            .privacySensitive()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(space.name). \(space.summary). \(freshness.text)")
            .accessibilityHint("Open this Space in Clem to read the full information.")
        } else {
            Link(destination: URL(string: "clem://space")!) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Keep a Space in view")
                        .multilineTextAlignment(.leading)
                        .font(.system(.headline, design: .rounded).weight(.bold))
                        .foregroundStyle(ClemPalette.ink)
                        .lineLimit(2)
                    Text(compact ? "Open a Space and choose Use in iPhone widget." : "Open a Space in Clem and choose Use in iPhone widget. Its saved summary and update time will appear here.")
                        .multilineTextAlignment(.leading)
                        .font(.system(.caption, design: .rounded))
                        .foregroundStyle(ClemPalette.muted)
                        .lineLimit(compact ? 2 : 5)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .topLeading)
                .contentShape(Rectangle())
            }
            .accessibilityHint("Open Spaces in Clem.")
        }
    }

    private func workflowList(showSummaries: Bool) -> some View {
        VStack(alignment: .leading, spacing: showSummaries ? 4 : 2) {
            if workflows.isEmpty {
                workflowSetup
            } else {
                ForEach(Array(workflows.enumerated()), id: \.element.slug) { index, workflow in
                    if index > 0 { separator }
                    workflowRow(workflow, showSummary: showSummaries)
                }
                if showSummaries {
                    Text("Opens Clem. Workflows needing input open for review.")
                        .font(.system(.caption2, design: .rounded))
                        .foregroundStyle(ClemPalette.muted)
                        .lineLimit(2)
                        .padding(.top, 4)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func workflowRow(_ workflow: ClemWidgetWorkflow, showSummary: Bool) -> some View {
        Button(intent: RunClemWorkflowIntent(slug: workflow.slug)) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(workflow.name)
                        .font(.system(.subheadline, design: .rounded).weight(.semibold))
                        .foregroundStyle(ClemPalette.ink)
                        .lineLimit(showSummary ? 2 : 1)
                    if showSummary && !workflow.summary.isEmpty && !largerType {
                        Text(workflow.summary)
                            .font(.system(.caption, design: .rounded))
                            .foregroundStyle(ClemPalette.muted)
                            .lineLimit(1)
                    }
                    Text("Run workflow")
                        .font(.system(.caption2, design: .rounded).weight(.semibold))
                        .foregroundStyle(ClemPalette.accentText)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "play.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ClemPalette.accentText)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .privacySensitive()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Run \(workflow.name)")
        .accessibilityHint("Opens Clem. Workflows needing input open for review.")
    }

    private var workflowColumns: some View {
        Group {
            if workflows.isEmpty {
                workflowSetup
            } else {
                HStack(alignment: .top, spacing: 10) {
                    ForEach(workflows, id: \.slug) { workflow in
                        Button(intent: RunClemWorkflowIntent(slug: workflow.slug)) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(workflow.name)
                                    .font(.system(.caption, design: .rounded).weight(.semibold))
                                    .foregroundStyle(ClemPalette.ink)
                                    .lineLimit(2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Label("Run", systemImage: "play.fill")
                                    .font(.system(.caption2, design: .rounded).weight(.semibold))
                                    .foregroundStyle(ClemPalette.accentText)
                                    .lineLimit(2)
                            }
                            .frame(maxWidth: .infinity, minHeight: 60, alignment: .topLeading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .privacySensitive()
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Run \(workflow.name)")
                        .accessibilityHint("Opens Clem. Workflows needing input open for review.")
                    }
                }
            }
        }
    }

    private var workflowSetup: some View {
        Link(destination: URL(string: "clem://workflow")!) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Keep your workflows here")
                    .multilineTextAlignment(.leading)
                    .font(.system(.headline, design: .rounded).weight(.bold))
                    .foregroundStyle(ClemPalette.ink)
                    .lineLimit(2)
                Text("Open a workflow in Clem and pin it to your iPhone widget.")
                    .multilineTextAlignment(.leading)
                    .font(.system(.caption, design: .rounded))
                    .foregroundStyle(ClemPalette.muted)
                    .lineLimit(isLarge ? 3 : 2)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .topLeading)
            .contentShape(Rectangle())
        }
        .accessibilityHint("Open workflows in Clem.")
    }

    private var separator: some View {
        Rectangle().fill(ClemPalette.muted.opacity(0.18)).frame(height: 1).accessibilityHidden(true)
    }
}

/// This intentionally mirrors the existing private action helper. The original
/// widgets keep their implementation and behaviour; both use the same intent.
private struct DashboardRecordingButton<Label: View>: View {
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
