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
}
