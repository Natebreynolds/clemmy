import XCTest
import SwiftUI
import WidgetKit
@testable import Clem

@MainActor
final class WidgetRenderingTests: XCTestCase {
    func testNativeWidgetLayoutsAtBothFamiliesAndLargeType() throws {
        let date = Date(timeIntervalSince1970: 1_790_000_000)
        let space = ClemWidgetSpace(slug: "fixture-space", name: "Product launch planning", summary: "Three decisions are ready for your review.", updatedAt: date, savedAt: date)
        let entry = ClemEntry(date: date, space: space)
        for scheme in [ColorScheme.light, .dark] {
            for largeType in [false, true] {
                let content = VStack(spacing: 20) {
                    HStack(spacing: 16) {
                        QuickActionsView(entry: entry, family: .systemSmall)
                            .frame(width: 138, height: 138).padding(16)
                        SpaceWidgetView(entry: entry)
                            .frame(width: 138, height: 138).padding(16)
                    }
                    QuickActionsView(entry: entry, family: .systemMedium)
                        .frame(width: 324, height: 138).padding(16)
                    SpaceWidgetView(entry: ClemEntry(date: date, space: nil))
                        .frame(width: 324, height: 138).padding(16)
                }
                .padding(20)
                .background(Color(uiColor: .systemBackground))
                .environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, largeType ? .xxxLarge : .large)
                let renderer = ImageRenderer(content: content)
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.uiImage)
                XCTAssertGreaterThan(image.size.height, 500)
                let attachment = XCTAttachment(image: image)
                attachment.name = "widgets-\(scheme)-\(largeType ? "large-type" : "default")"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    /// Actual SwiftUI renderings for the configurable widget, including the
    /// smallest content width used by the current medium/large phone fixtures.
    /// Attachments are inspected as a cohort; image size alone cannot prove that
    /// every text line fits. These do not prove WidgetKit hosting or tap delivery.
    func testDashboardWidgetsAcrossModesContentAndDynamicType() throws {
        let date = Date(timeIntervalSince1970: 1_790_000_000)
        let space = ClemWidgetSpace(slug: "fixture-space", name: "Your day ahead",
            summary: "The project review is at 10. You have time for a walk before the family call.",
            updatedAt: date.addingTimeInterval(-900), savedAt: date.addingTimeInterval(-900))
        let longSpace = ClemWidgetSpace(slug: "fixture-long-space",
            name: "Customer experience and regional operations planning",
            summary: "The team has finished its first review. Two decisions remain before Friday: confirm the customer preview date and choose the reporting scope. The afternoon is clear after your planning call. CustomerExperienceAndRegionalOperationsReviewAcrossAllTeams is deliberately long to check wrapping.",
            updatedAt: date.addingTimeInterval(-86_400), savedAt: date.addingTimeInterval(-86_400))
        let workflows = [
            ClemWidgetWorkflow(slug: "morning-brief", name: "Morning brief", summary: "Your calendar, decisions and next steps.", updatedAt: date, savedAt: date),
            ClemWidgetWorkflow(slug: "project-review", name: "Project review", summary: "Check what changed before the planning call.", updatedAt: date, savedAt: date),
            ClemWidgetWorkflow(slug: "weekend-plan", name: "Weekend plan", summary: "Bring family plans and errands together.", updatedAt: date, savedAt: date)
        ]
        let longWorkflows = workflows.enumerated().map { index, workflow in
            ClemWidgetWorkflow(slug: workflow.slug,
                name: index == 0 ? "Customer experience and regional operations review" : index == 1 ? "CustomerExperienceAndRegionalOperationsReviewAcrossAllTeams" : "Prepare the family weekend and travel plan",
                summary: "Review the latest saved information, identify outstanding decisions, and prepare a useful brief before the next meeting.",
                updatedAt: date.addingTimeInterval(-86_400), savedAt: date.addingTimeInterval(-86_400))
        }
        let fixtures: [(name: String, entry: ClemEntry)] = [
            ("Saved content", ClemEntry(date: date, space: space, workflows: workflows)),
            ("Long text and older snapshot", ClemEntry(date: date, space: longSpace, workflows: longWorkflows)),
            ("Not set up", ClemEntry(date: date, space: nil))
        ]
        // One standalone deliverable preview, rendered by the same native view
        // and fixture as the cohort below, without a test-sheet heading.
        let preview = ClemDashboardView(entry: fixtures[0].entry, mode: .overview, family: .systemLarge)
            .frame(width: 306, height: 322, alignment: .topLeading)
            .padding(16)
            .background(ClemPalette.peel)
            .clipShape(RoundedRectangle(cornerRadius: 24))
            .environment(\.colorScheme, .light)
            .environment(\.dynamicTypeSize, .large)
        let previewRenderer = ImageRenderer(content: preview)
        previewRenderer.scale = 2
        let previewAttachment = XCTAttachment(image: try XCTUnwrap(previewRenderer.uiImage))
        previewAttachment.name = "dashboard-large-overview-preview"
        previewAttachment.lifetime = .keepAlways
        add(previewAttachment)

        for family in [WidgetFamily.systemMedium, .systemLarge] {
            let height: CGFloat = family == .systemLarge ? 322 : 138
            for scheme in [ColorScheme.light, .dark] {
                for largeType in [false, true] {
                    let content = VStack(alignment: .leading, spacing: 18) {
                        ForEach(ClemDashboardMode.allCases, id: \.self) { mode in
                            ForEach(fixtures.indices, id: \.self) { index in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("\(mode.rawValue) · \(fixtures[index].name)")
                                        .font(.caption).foregroundStyle(.secondary)
                                    ClemDashboardView(entry: fixtures[index].entry, mode: mode, family: family)
                                        .frame(width: 306, height: height, alignment: .topLeading)
                                        .padding(16)
                                        .background(ClemPalette.peel)
                                        .clipShape(RoundedRectangle(cornerRadius: 24))
                                }
                            }
                        }
                    }
                    .padding(20)
                    .background(Color(uiColor: .systemBackground))
                    .environment(\.colorScheme, scheme)
                    .environment(\.dynamicTypeSize, largeType ? .xxxLarge : .large)
                    let renderer = ImageRenderer(content: content)
                    renderer.scale = 2
                    let image = try XCTUnwrap(renderer.uiImage)
                    XCTAssertEqual(image.size.width, 378, accuracy: 1)
                    XCTAssertGreaterThan(image.size.height, height * 9)
                    let attachment = XCTAttachment(image: image)
                    attachment.name = "dashboard-\(family == .systemLarge ? "large" : "medium")-\(scheme)-\(largeType ? "xxxLarge" : "default")"
                    attachment.lifetime = .keepAlways
                    add(attachment)
                }
            }
        }
    }

    /// Native ImageRenderer evidence only. These fixtures do not prove WidgetKit
    /// hosting, intent execution, microphone capture, or physical-device layout.
    func testRecordingActivityLayoutsAtDefaultAndLargeType() throws {
        let now = Date()
        let recordingID = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
        let fixtures: [(name: String, mode: ClemRecordingMode, phase: ClemRecordingPhase, message: String?, stale: Bool)] = [
            ("Voice · recording", .voice, .recording, nil, false),
            ("Voice · processing", .voice, .processing, "Clem is working…", false),
            ("Voice · stale processing", .voice, .processing, "Clem is working…", true),
            ("Dictation · draft ready", .dictate, .ready, "Draft ready · tap to review", false),
            ("Voice · speaking", .voice, .speaking, "Clem is speaking…", false),
            ("Voice · recovery", .voice, .failed, "Open Clem to continue", false)
        ]
        for scheme in [ColorScheme.light, .dark] {
            for largeType in [false, true] {
                let content = VStack(alignment: .leading, spacing: 16) {
                    ForEach(fixtures.indices, id: \.self) { index in
                        let fixture = fixtures[index]
                        let attributes = ClemRecordingAttributes(recordingID: recordingID, mode: fixture.mode,
                            startedAt: now.addingTimeInterval(-12), deadline: now.addingTimeInterval(588))
                        VStack(alignment: .leading, spacing: 8) {
                            Text(fixture.name).font(.caption).foregroundStyle(.secondary)
                            ClemRecordingActivityView(attributes: attributes,
                                state: .init(phase: fixture.phase, message: fixture.message), isStale: fixture.stale)
                                .padding(16)
                                .frame(width: 356, height: 160, alignment: .top)
                                .background(Color(uiColor: .secondarySystemBackground))
                                .clipShape(RoundedRectangle(cornerRadius: 24))
                        }
                    }
                    Text("Expanded activity · recording content").font(.caption).foregroundStyle(.secondary)
                    ClemRecordingActivityView(attributes: .init(recordingID: recordingID, mode: .voice,
                        startedAt: now.addingTimeInterval(-12), deadline: now.addingTimeInterval(588)),
                        state: .init(phase: .recording, message: nil), showsHeader: false)
                        .padding(16)
                        .frame(width: 356)
                        .background(Color(uiColor: .secondarySystemBackground))
                }
                .padding(20)
                .background(Color(uiColor: .systemBackground))
                .environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, largeType ? .xxxLarge : .large)
                let renderer = ImageRenderer(content: content)
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.uiImage)
                XCTAssertEqual(image.size.width, 396, accuracy: 1)
                XCTAssertGreaterThan(image.size.height, 1_000)
                XCTAssertLessThan(image.size.height, 1_800)
                let attachment = XCTAttachment(image: image)
                attachment.name = "recording-activities-\(scheme)-\(largeType ? "large-type" : "default")"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    func testRecordingActionsFollowAuthoritativePhaseAndStaleness() {
        let recording = ClemRecordingPresentation(mode: .voice, phase: .recording)
        XCTAssertTrue(recording.canFinishUtterance)
        XCTAssertTrue(recording.isActive)
        XCTAssertTrue(recording.showsTimer)
        XCTAssertEqual(recording.endLabel, "End voice")
        XCTAssertEqual(recording.openURL.absoluteString, "clem://recording")

        for phase: ClemRecordingPhase in [.preparing, .finishing, .processing, .speaking, .ready] {
            let presentation = ClemRecordingPresentation(mode: .voice, phase: phase)
            XCTAssertTrue(presentation.isActive, "End voice must remain available during \(phase)")
            XCTAssertFalse(presentation.canFinishUtterance, "Only a live capture can be submitted")
        }
        let stale = ClemRecordingPresentation(mode: .voice, phase: .recording, isStale: true)
        XCTAssertTrue(stale.isActive, "A stale activity still offers a bounded end action")
        XCTAssertFalse(stale.canFinishUtterance)
        XCTAssertFalse(stale.showsTimer)
        XCTAssertEqual(stale.title, "Open Clem to check")

        let ready = ClemRecordingPresentation(mode: .dictate, phase: .ready)
        XCTAssertTrue(ready.isActive)
        XCTAssertFalse(ready.canFinishUtterance)
        XCTAssertFalse(ready.showsTimer)
        XCTAssertEqual(ready.endLabel, "Done")
        XCTAssertEqual(ready.title, "Dictation ready")
        XCTAssertEqual(ClemRecordingPresentation(mode: .dictate, phase: .recording).endLabel, "Cancel")

        for mode: ClemRecordingMode in [.voice, .dictate] {
            for phase: ClemRecordingPhase in [.idle, .finished, .cancelled, .failed, .needsPermission] {
                let presentation = ClemRecordingPresentation(mode: mode, phase: phase)
                XCTAssertFalse(presentation.isActive, "A terminal snapshot must not offer capture controls")
                XCTAssertFalse(presentation.canFinishUtterance)
                XCTAssertFalse(presentation.showsTimer)
            }
        }
    }
}
