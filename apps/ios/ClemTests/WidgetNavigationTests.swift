import Foundation
import XCTest
import WebKit
@testable import Clem

final class WidgetNavigationRepositoryTests: XCTestCase {
    func testOnlyBoundedWidgetRoutesAreAccepted() throws {
        XCTAssertEqual(route("clem://voice"), "/m/?tab=chats&compose=voice")
        XCTAssertEqual(route("clem://dictate"), "/m/?tab=chats&compose=dictate")
        XCTAssertEqual(route("clem://space?id=sample-space"), "/m/?tab=spaces&workspace=sample-space")
        XCTAssertEqual(route("clem://space"), "/m/?tab=spaces")
        for bad in ["https://evil.example/m/", "clem://voice/start", "clem://voice?text=send", "clem://voice#start",
                    "clem://user:password@voice", "clem://voice:443", "clem://space?id=../admin", "clem://space?id=",
                    "clem://space?id=one&id=two", "clem://space?id=one&adopt=token", "clem://space?id=%0A", "clem://unknown"] {
            XCTAssertNil(route(bad), bad)
        }
    }

    func testPendingIntentSurvivesColdStartAndOnlyExactLatestReceiptConsumesIt() throws {
        let store = WidgetMemoryStore()
        let first = PendingWidgetNavigationRepository(storage: store)
        XCTAssertTrue(first.park(url: URL(string: "clem://voice")!, pairingFingerprint: "fixture"))
        let old = try XCTUnwrap(first.current(pairingFingerprint: "fixture"))
        let restored = PendingWidgetNavigationRepository(storage: store)
        XCTAssertEqual(restored.current(pairingFingerprint: "fixture"), old)
        XCTAssertTrue(restored.park(url: URL(string: "clem://dictate")!, pairingFingerprint: "fixture"))
        let current = try XCTUnwrap(restored.current(pairingFingerprint: "fixture"))
        XCTAssertFalse(restored.acknowledge(id: old.id, pairingFingerprint: "fixture"))
        XCTAssertEqual(restored.current(pairingFingerprint: "fixture"), current)
        XCTAssertTrue(restored.acknowledge(id: current.id, pairingFingerprint: "fixture"))
        XCTAssertNil(store.data)
    }

    func testPairingChangeExpiryAndMalformedEnvelopeFailClosed() {
        let store = WidgetMemoryStore()
        var now = Date(timeIntervalSince1970: 2_000_000)
        let repository = PendingWidgetNavigationRepository(storage: store, now: { now })
        XCTAssertTrue(repository.park(url: URL(string: "clem://voice")!, pairingFingerprint: "one"))
        XCTAssertNil(repository.current(pairingFingerprint: "two"))
        XCTAssertNil(store.data)
        XCTAssertTrue(repository.park(url: URL(string: "clem://voice")!, pairingFingerprint: "one"))
        now = now.addingTimeInterval(24 * 60 * 60)
        XCTAssertNil(repository.current(pairingFingerprint: "one"))
        store.data = Data("bad json".utf8)
        XCTAssertNil(repository.current(pairingFingerprint: "one"))
        XCTAssertNil(store.data)
    }

    func testOnlyExplicitBoundedSnapshotIsStoredAndClearRemovesIt() throws {
        let now = Date(timeIntervalSince1970: 2_000_000)
        let body: [String: Any] = ["requestId": UUID().uuidString, "slug": "fixture-space", "name": "Fixture Space", "summary": "Saved result", "updatedAt": ISO8601DateFormatter().string(from: now)]
        let snapshot = try XCTUnwrap(ClemWidgetSpace.parse(body, now: now))
        let suite = "clem.widget.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ClemWidgetSpaceStore(defaults: defaults)
        XCTAssertTrue(store.save(snapshot))
        XCTAssertEqual(ClemWidgetSpaceStore(defaults: defaults).load(), snapshot)
        store.clear()
        XCTAssertNil(store.load())
        for (key, bad): (String, Any) in [("slug", "../bad"), ("name", String(repeating: "a", count: 161)), ("summary", "hidden\ntext"), ("updatedAt", "tomorrow"), ("requestId", "not-a-request")] {
            var invalid = body; invalid[key] = bad
            XCTAssertNil(ClemWidgetSpace.parse(invalid, now: now), key)
        }
        var extra = body; extra["token"] = "not-allowed"
        XCTAssertNil(ClemWidgetSpace.parse(extra, now: now))
        XCTAssertFalse(ClemWidgetSpaceStore(defaults: nil).save(snapshot))
    }

    private func route(_ raw: String) -> String? {
        URL(string: raw).flatMap(WidgetNavigationRoute.path)
    }
}

@MainActor
final class WidgetNavigationDeliveryTests: XCTestCase {
    func testSpokenReplyPlaybackAllowsAsyncAudioButKeepsVideoGestureGate() {
        let model = model(PendingWidgetNavigationRepository(storage: WidgetMemoryStore()))
        defer { model.webView.stopLoading() }
        let media = model.webView.configuration.mediaTypesRequiringUserActionForPlayback
        XCTAssertFalse(media.contains(.audio))
        XCTAssertTrue(media.contains(.video))
        // Playback admission never expands which origins can request capture.
        XCTAssertFalse(PinnedWebNavigationPolicy.isPairedOrigin(scheme: "https", host: "other.example.test", port: 443, pairing: model.pairing))
        XCTAssertTrue(PinnedWebNavigationPolicy.isPairedOrigin(scheme: "https", host: "fixture.example.test", port: 443, pairing: model.pairing))
    }

    func testWarmDeliveryKeepsTheDocumentAndUnsentDraft() async throws {
        let repository = PendingWidgetNavigationRepository(storage: WidgetMemoryStore())
        let model = model(repository)
        defer { model.webView.stopLoading() }
        model.webView.loadHTMLString("""
        <!doctype html><script>
        window.unsentDraft = 'Keep these unsent words';
        window.routeReady = false;
        window.clemNative = {openWidgetRoute: function(request) {
          if (!window.routeReady) { window.deferredRoute = true; return false; }
          if (request.navigationId !== new URL(request.path, location.href).searchParams.get('widgetNavigation')) return false;
          window.landedRoute = request.path; return true;
        }};
        </script>
        """, baseURL: URL(string: "https://fixture.example.test/m/")!)
        for _ in 0..<200 {
            if (try? await model.webView.evaluateJavaScript("window.unsentDraft || null")) as? String != nil { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        let originalURL = model.webView.url
        let beforeDraft = try await model.webView.evaluateJavaScript("window.unsentDraft || null") as? String
        XCTAssertEqual(beforeDraft, "Keep these unsent words")
        XCTAssertTrue(repository.park(url: URL(string: "clem://dictate")!, pairingFingerprint: "fixture-pin"))
        let pending = try XCTUnwrap(repository.current(pairingFingerprint: "fixture-pin"))
        model.setConnectionRouteReady(true)
        model.setPendingPushNavigationAllowed(true)
        for _ in 0..<200 {
            if (try? await model.webView.evaluateJavaScript("Boolean(window.deferredRoute)")) as? Bool == true { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        let deferredDraft = try await model.webView.evaluateJavaScript("window.unsentDraft || null") as? String
        XCTAssertEqual(deferredDraft, beforeDraft, "A not-yet-ready warm bridge must not reload away the draft")
        XCTAssertNotNil(repository.current(pairingFingerprint: "fixture-pin"))
        _ = try await model.webView.evaluateJavaScript("window.routeReady = true; window.webkit.messageHandlers.clemWidgetNavigationReady.postMessage(true); true")
        for _ in 0..<200 {
            if (try? await model.webView.evaluateJavaScript("window.landedRoute || null")) as? String != nil { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        let landed = try await model.webView.evaluateJavaScript("window.landedRoute || null") as? String
        XCTAssertEqual(landed, pending.path)
        XCTAssertEqual(model.webView.url, originalURL)
        let afterDraft = try await model.webView.evaluateJavaScript("window.unsentDraft || null") as? String
        XCTAssertEqual(afterDraft, "Keep these unsent words")
        XCTAssertTrue(model.acknowledgePendingWidgetNavigation(id: pending.id))
    }

    func testColdWidgetWaitsForForegroundUnlockAndConnectionThenExactReceipt() throws {
        let store = WidgetMemoryStore()
        let repository = PendingWidgetNavigationRepository(storage: store)
        XCTAssertTrue(repository.park(url: URL(string: "clem://voice")!, pairingFingerprint: "fixture-pin"))
        let pending = try XCTUnwrap(repository.current(pairingFingerprint: "fixture-pin"))
        let model = model(repository)
        defer { model.webView.stopLoading() }
        model.webView(model.webView, didFinish: nil)
        XCTAssertNil(model.lastRequestedURL)
        model.setPendingPushNavigationAllowed(true)
        XCTAssertNil(model.lastRequestedURL, "Unlock alone must not bypass the connection gate")
        model.setConnectionRouteReady(true)
        let target = try XCTUnwrap(model.lastRequestedURL)
        XCTAssertEqual(target.host, "fixture.example.test")
        let query = URLComponents(url: target, resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(query?.first(where: { $0.name == "compose" })?.value, "voice")
        XCTAssertEqual(query?.first(where: { $0.name == "widgetNavigation" })?.value, pending.id.uuidString)
        XCTAssertFalse(model.acknowledgePendingWidgetNavigation(id: UUID()))
        model.setPendingPushNavigationAllowed(false)
        XCTAssertFalse(model.acknowledgePendingWidgetNavigation(id: pending.id))
        XCTAssertNotNil(repository.current(pairingFingerprint: "fixture-pin"))
        model.setPendingPushNavigationAllowed(true)
        XCTAssertTrue(model.acknowledgePendingWidgetNavigation(id: pending.id))
        XCTAssertNil(repository.current(pairingFingerprint: "fixture-pin"))
    }

    func testReconnectAndNewTapRetainLatestIntent() throws {
        let repository = PendingWidgetNavigationRepository(storage: WidgetMemoryStore())
        XCTAssertTrue(repository.park(url: URL(string: "clem://voice")!, pairingFingerprint: "fixture-pin"))
        let old = try XCTUnwrap(repository.current(pairingFingerprint: "fixture-pin"))
        let model = model(repository)
        defer { model.webView.stopLoading() }
        model.setConnectionRouteReady(true)
        model.setPendingPushNavigationAllowed(true)
        model.webView(model.webView, didFinish: nil)
        model.load(URL(string: "https://fixture.example.test/m/")!)
        XCTAssertNotNil(repository.current(pairingFingerprint: "fixture-pin"))
        XCTAssertTrue(repository.park(url: URL(string: "clem://space?id=fixture-space")!, pairingFingerprint: "fixture-pin"))
        model.setConnectionRouteReady(true)
        let current = try XCTUnwrap(repository.current(pairingFingerprint: "fixture-pin"))
        XCTAssertFalse(model.acknowledgePendingWidgetNavigation(id: old.id))
        XCTAssertTrue(model.acknowledgePendingWidgetNavigation(id: current.id))
    }

    private func model(_ repository: PendingWidgetNavigationRepository) -> WebViewModel {
        WebViewModel(pairing: Pairing(origin: "https://fixture.example.test", fingerprint: "fixture-pin"),
                     pendingPushNavigations: PendingPushNavigationRepository(storage: WidgetMemoryStore()),
                     pendingWidgetNavigations: repository)
    }
}

private final class WidgetMemoryStore: PendingPushNavigationDataStore {
    var data: Data?
    func load() -> Data? { data }
    func save(_ data: Data) -> Bool { self.data = data; return true }
    func clear() { data = nil }
}
