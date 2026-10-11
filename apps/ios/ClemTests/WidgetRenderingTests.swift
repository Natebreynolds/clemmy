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
