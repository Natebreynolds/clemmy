import XCTest
import ActivityKit
import Combine
@testable import Clem

final class WidgetVoiceRecoveryTests: XCTestCase {
    private final class SetupRequestFixture: ObservableObject {
        @Published var requested = false
    }

    func testRepeatedPublishedSetupRequestsPresentAgainAfterDismissal() {
        let fixture = SetupRequestFixture()
        var presented = false
        var presentations = 0
        let observation = fixture.$requested.sink { requested in
            if WidgetVoiceRecoveryPolicy.shouldPresent(requested: requested,
                paired: true, unlocked: true, foreground: true) {
                presented = true; presentations += 1
            }
        }
        defer { observation.cancel() }
        fixture.requested = true
        XCTAssertTrue(presented)
        presented = false // Done does not clear the permission/setup banner.
        fixture.requested = true
        XCTAssertTrue(presented)
        XCTAssertEqual(presentations, 2)
    }

    func testRepeatedPublishedRequestsCannotBypassPairingUnlockOrForeground() {
        let fixture = SetupRequestFixture()
        var paired = false, unlocked = false, foreground = false
        var presentations = 0
        let observation = fixture.$requested.sink { requested in
            if WidgetVoiceRecoveryPolicy.shouldPresent(requested: requested,
                paired: paired, unlocked: unlocked, foreground: foreground) { presentations += 1 }
        }
        defer { observation.cancel() }
        fixture.requested = true
        paired = true; fixture.requested = true
        unlocked = true; fixture.requested = true
        XCTAssertEqual(presentations, 0)
        foreground = true; fixture.requested = true
        XCTAssertEqual(presentations, 1)
    }

    func testWarmIntentRequestPresentsWithoutAnotherSceneTransition() {
        XCTAssertFalse(WidgetVoiceRecoveryPolicy.shouldPresent(requested: false, paired: true, unlocked: true, foreground: true))
        XCTAssertTrue(WidgetVoiceRecoveryPolicy.shouldPresent(requested: true, paired: true, unlocked: true, foreground: true))
    }

    func testSetupRemainsParkedUntilPairedUnlockedAndForeground() {
        for (paired, unlocked, foreground) in [(false, true, true), (true, false, true), (true, true, false)] {
            XCTAssertFalse(WidgetVoiceRecoveryPolicy.shouldPresent(requested: true,
                paired: paired, unlocked: unlocked, foreground: foreground))
        }
    }

    func testUnauthorizedResponseRevokesReadinessAndMakesReconnectReachable() throws {
        for status in [401, 403] {
            let issue = try XCTUnwrap(WidgetVoiceRecoveryIssue.httpStatus(status))
            let connected = WidgetVoiceRecoveryPolicy.connectionUsable(true, after: issue)
            XCTAssertFalse(connected)
            // Recovery does not depend on the presence of a saved draft/audio/receipt.
            XCTAssertTrue(WidgetVoiceRecoveryPolicy.showReconnect(connected: connected, working: false, recording: false))
        }
        XCTAssertNil(WidgetVoiceRecoveryIssue.httpStatus(409))
        XCTAssertTrue(WidgetVoiceRecoveryPolicy.connectionUsable(true, after: .connectionTimedOut))
    }

    func testReconnectCannotResetAnActiveRecordingOrRequest() {
        XCTAssertFalse(WidgetVoiceRecoveryPolicy.showReconnect(connected: false, working: true, recording: false))
        XCTAssertFalse(WidgetVoiceRecoveryPolicy.showReconnect(connected: false, working: false, recording: true))
        XCTAssertFalse(WidgetVoiceRecoveryPolicy.showReconnect(connected: true, working: false, recording: false))
    }

    func testDiagnosticIsBoundedTypedDataWithoutArbitraryFailureText() throws {
        let sensitiveError = NSError(domain: "private-host.example secret-token transcript", code: 900,
            userInfo: [NSLocalizedDescriptionKey: "Do not persist this personal content"])
        let value = WidgetVoiceDiagnostic(stage: .sending, issue: .classify(sensitiveError),
            updatedAt: Date(timeIntervalSince1970: 1_000))
        let data = try JSONEncoder().encode(value)
        XCTAssertLessThan(data.count, 1_024)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["stage", "issue", "updatedAt"])
        XCTAssertEqual(try JSONDecoder().decode(WidgetVoiceDiagnostic.self, from: data), value)
        XCTAssertEqual(value.code, "sending.requestFailed")
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("secret-token"))
    }

    func testPermissionTrustAndTimeoutHaveDistinctRecoverableDiagnostics() {
        XCTAssertEqual(WidgetVoiceRecoveryIssue.classify(WidgetAudioRecorderError.microphoneDenied), .microphoneDenied)
        XCTAssertEqual(WidgetVoiceRecoveryIssue.classify(WidgetAudioRecorderError.activitiesDisabled), .liveActivityUnavailable)
        XCTAssertEqual(WidgetVoiceRecoveryIssue.classify(NativeVoiceTransportError.pin), .securityMismatch)
        XCTAssertEqual(WidgetVoiceRecoveryIssue.classify(NativeVoiceTransportError.timeout), .connectionTimedOut)
        XCTAssertEqual(WidgetVoiceRecoveryIssue.classify(NativeVoiceTransportError.unauthorized), .unauthorized)
        XCTAssertEqual(WidgetVoiceRecoveryIssue.classify(NativeVoiceTransportError.unreachable), .connectionUnavailable)
        XCTAssertEqual(WidgetVoiceRecoveryIssue.classify(NativeVoiceTransportError.unavailable), .serviceUnavailable)
        XCTAssertEqual(WidgetVoiceRecoveryIssue.classify(ActivityAuthorizationError.visibility), .liveActivityVisibility)
        XCTAssertEqual(WidgetVoiceRecoveryIssue.classify(ActivityAuthorizationError.targetMaximumExceeded), .liveActivityLimit)
    }
}
