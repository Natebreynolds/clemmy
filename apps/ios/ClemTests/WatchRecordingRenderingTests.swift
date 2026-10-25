import XCTest
import SwiftUI
@testable import Clem

@MainActor
final class WatchRecordingRenderingTests: XCTestCase {
    /// Synthetic native fixtures at compact Watch-sized viewports. These images
    /// exercise the actual shared SwiftUI view, not Smart Stack hosting, intent
    /// delivery, microphone capture or a connected physical Watch.
    func testSmallRecordingActivityStatesAtCompactSizesAndLargeType() throws {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let recordingID = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
        let fixtures: [(name: String, mode: ClemRecordingMode, phase: ClemRecordingPhase, stale: Bool)] = [
            ("Voice · recording", .voice, .recording, false),
            ("Voice · processing", .voice, .processing, false),
            ("Voice · ready", .voice, .ready, false),
            ("Voice · failed", .voice, .failed, false),
            ("Voice · stale recording", .voice, .recording, true),
            ("Dictation · recording", .dictate, .recording, false),
            ("Dictation · ready", .dictate, .ready, false)
        ]
        let sizes: [(width: CGFloat, height: CGFloat)] = [(156, 112), (172, 120)]
        for size in sizes {
            for largeType in [false, true] {
                let content = VStack(alignment: .leading, spacing: 16) {
                    Text("Synthetic native Watch fixtures")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(fixtures.indices, id: \.self) { index in
                        let fixture = fixtures[index]
                        VStack(alignment: .leading, spacing: 6) {
                            Text(fixture.name).font(.caption).foregroundStyle(.secondary)
                            ClemWatchRecordingView(attributes: .init(recordingID: recordingID, mode: fixture.mode,
                                startedAt: now.addingTimeInterval(-12), deadline: now.addingTimeInterval(588)),
                                state: .init(phase: fixture.phase, message: nil), isStale: fixture.stale)
                                .padding(8)
                                .frame(width: size.width, height: size.height, alignment: .topLeading)
                                .background(ClemPalette.peel)
                                .clipShape(RoundedRectangle(cornerRadius: 18))
                                .environment(\.dynamicTypeSize, largeType ? .xxxLarge : .large)
                        }
                    }
                }
                .padding(20)
                .background(Color(uiColor: .systemBackground))
                .environment(\.colorScheme, .light)
                let renderer = ImageRenderer(content: content)
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.uiImage)
                XCTAssertGreaterThanOrEqual(image.size.width, size.width + 40)
                XCTAssertGreaterThan(image.size.height, size.height * CGFloat(fixtures.count))
                let attachment = XCTAttachment(image: image)
                attachment.name = "watch-recording-\(Int(size.width))x\(Int(size.height))-\(largeType ? "xxxLarge" : "default")"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }
}
