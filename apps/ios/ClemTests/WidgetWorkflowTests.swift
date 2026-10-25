import Foundation
import XCTest
@testable import Clem

final class WidgetWorkflowTests: XCTestCase {
    func testWorkflowSnapshotAcceptsOnlyBoundedPresentationFields() throws {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let body = snapshotBody(slug: "weekly_brief.v2", now: now)
        let snapshot = try XCTUnwrap(ClemWidgetWorkflow.parse(body, now: now))
        XCTAssertEqual(snapshot.slug, "weekly_brief.v2")
        XCTAssertEqual(snapshot.url.absoluteString, "clem://workflow?id=weekly_brief.v2")
        for (key, value): (String, Any) in [("slug", "../private"), ("slug", "bad/route"),
            ("name", String(repeating: "a", count: 161)), ("summary", "hidden\ncommand"),
            ("updatedAt", "tomorrow"), ("requestId", "invalid")] {
            var invalid = body; invalid[key] = value
            XCTAssertNil(ClemWidgetWorkflow.parse(invalid, now: now), key)
        }
        var extra = body; extra["inputs"] = ["send": "yes"]
        XCTAssertNil(ClemWidgetWorkflow.parse(extra, now: now), "Pins carry no execution arguments")
    }

    func testPinsPersistAndCannotSilentlyReplaceAnotherWorkflowWhenFull() throws {
        let suite = "clem.widget.workflow.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ClemWidgetWorkflowStore(defaults: defaults)
        let now = Date()
        for index in 1...3 {
            XCTAssertTrue(store.save(try XCTUnwrap(ClemWidgetWorkflow.parse(snapshotBody(slug: "fixture-\(index)", now: now)))))
        }
        let before = store.load()
        XCTAssertFalse(store.save(try XCTUnwrap(ClemWidgetWorkflow.parse(snapshotBody(slug: "fixture-4", now: now)))))
        XCTAssertEqual(store.load(), before)
        var updated = snapshotBody(slug: "fixture-2", now: now); updated["name"] = "New display name"
        XCTAssertTrue(store.save(try XCTUnwrap(ClemWidgetWorkflow.parse(updated))))
        XCTAssertEqual(ClemWidgetWorkflowStore(defaults: defaults).load().map(\.slug), before.map(\.slug))
        XCTAssertEqual(store.load()[1].name, "New display name")
        XCTAssertTrue(store.remove(slug: "fixture-2"))
        XCTAssertEqual(store.load().map(\.slug), ["fixture-1", "fixture-3"])
        XCTAssertFalse(store.remove(slug: "../private"))
        store.clear()
        XCTAssertTrue(store.load().isEmpty)
        XCTAssertFalse(ClemWidgetWorkflowStore(defaults: nil).save(before[0]))
    }

    func testWorkflowNavigationNeverCarriesAnExecutionCommand() {
        XCTAssertEqual(route("clem://workflow"), "/m/?tab=workflows")
        XCTAssertEqual(route("clem://workflow?id=weekly_brief.v2"), "/m/?tab=workflows&workflow=weekly_brief.v2")
        for bad in ["clem://workflow?id=../private", "clem://workflow?id=one&id=two",
                    "clem://workflow?id=one&run=true", "clem://workflow?id=one&inputs=send",
                    "clem://workflow?id=one#run", "clem://workflow?id="] {
            XCTAssertNil(route(bad), bad)
        }
    }

    private func route(_ value: String) -> String? { URL(string: value).flatMap(WidgetNavigationRoute.path) }
    private func snapshotBody(slug: String, now: Date) -> [String: Any] {
        ["requestId": UUID().uuidString, "slug": slug, "name": "Fixture briefing",
         "summary": "Review the saved workflow and its latest results.",
         "updatedAt": ISO8601DateFormatter().string(from: now)]
    }
}
