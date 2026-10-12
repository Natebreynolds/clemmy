import XCTest
@testable import Clem

final class WidgetAudioRecorderPolicyTests: XCTestCase {
    func testExplicitStartAdmitsOnlyAnEmptyRecorder() throws {
        try validate()
        XCTAssertThrowsError(try validate(active: true)) { XCTAssertEqual($0 as? WidgetAudioRecorderError, .alreadyRecording) }
        XCTAssertThrowsError(try validate(completed: true)) { XCTAssertEqual($0 as? WidgetAudioRecorderError, .pendingRecording) }
    }

    func testSecondWidgetTapCannotReplaceExistingSession() {
        XCTAssertThrowsError(try validate(activityID: UUID(), live: true)) {
            XCTAssertEqual($0 as? WidgetAudioRecorderError, .alreadyRecording)
        }
    }

    func testContinuationRequiresExactLiveActivityAndSameMode() throws {
        let id = UUID()
        try validate(continuing: id, activityID: id, live: true)
        for (actualID, live, mode): (UUID?, Bool, ClemRecordingMode) in [
            (nil, false, .voice), (UUID(), true, .voice), (id, false, .voice), (id, true, .dictate)
        ] {
            XCTAssertThrowsError(try validate(continuing: id, activityID: actualID, live: live, mode: mode)) {
                XCTAssertEqual($0 as? WidgetAudioRecorderError, .activityLost)
            }
        }
    }

    func testUnacceptedAudioBlocksEvenAnOtherwiseValidContinuation() {
        let id = UUID()
        XCTAssertThrowsError(try validate(completed: true, continuing: id, activityID: id, live: true)) {
            XCTAssertEqual($0 as? WidgetAudioRecorderError, .pendingRecording)
        }
    }

    func testInitialSilenceAndShortTapNoiseNeverFinishAnUtterance() {
        var gate = WidgetSpeechSilenceGate()
        XCTAssertFalse(gate.shouldFinish(power: -80, elapsed: 0))
        XCTAssertFalse(gate.shouldFinish(power: -80, elapsed: 5))
        XCTAssertFalse(gate.shouldFinish(power: -15, elapsed: 5.1))
        XCTAssertFalse(gate.shouldFinish(power: -80, elapsed: 5.2))
        XCTAssertFalse(gate.shouldFinish(power: -80, elapsed: 8))
        XCTAssertFalse(gate.heardSpeech)
    }

    /// Speech sampled every 100 ms from `start` through `end`.
    private func speak(_ gate: inout WidgetSpeechSilenceGate, from start: Double, to end: Double) {
        var t = start
        while t <= end + 0.0001 { XCTAssertFalse(gate.shouldFinish(power: -20, elapsed: t)); t += 0.1 }
    }

    func testAPhraseFinishesAfterTheQuietWindow() {
        var gate = WidgetSpeechSilenceGate()
        speak(&gate, from: 1.0, to: 2.2)
        XCTAssertTrue(gate.heardSpeech)
        XCTAssertFalse(gate.shouldFinish(power: -80, elapsed: 3.9))
        XCTAssertTrue(gate.shouldFinish(power: -80, elapsed: 4.0))
    }

    func testALoneWordThenAThinkingPauseKeepsListening() {
        // Live 2026-10-11: "the", a pause, and the turn was sent.
        var gate = WidgetSpeechSilenceGate()
        speak(&gate, from: 1.0, to: 1.4)
        XCTAssertTrue(gate.heardSpeech)
        XCTAssertFalse(gate.shouldFinish(power: -80, elapsed: 3.2), "1.8 s of quiet after one word is a pause")
        XCTAssertFalse(gate.shouldFinish(power: -80, elapsed: 4.3))
        XCTAssertTrue(gate.shouldFinish(power: -80, elapsed: 4.4), "a short answer still sends on its own")
    }

    func testResumedSpeechResetsTheQuietWindow() {
        var gate = WidgetSpeechSilenceGate()
        speak(&gate, from: 0, to: 0.7)
        XCTAssertFalse(gate.shouldFinish(power: -80, elapsed: 1.5))
        speak(&gate, from: 1.6, to: 2.0)
        XCTAssertFalse(gate.shouldFinish(power: -80, elapsed: 3.5))
        XCTAssertTrue(gate.shouldFinish(power: -80, elapsed: 3.8))
    }

    func testInvalidMeterValuesCannotCreateSpeech() {
        var gate = WidgetSpeechSilenceGate()
        XCTAssertFalse(gate.shouldFinish(power: .nan, elapsed: 0))
        XCTAssertFalse(gate.shouldFinish(power: .infinity, elapsed: 2))
        XCTAssertFalse(gate.shouldFinish(power: -20, elapsed: -.infinity))
        XCTAssertFalse(gate.shouldFinish(power: -20, elapsed: -1))
        XCTAssertFalse(gate.heardSpeech)
    }

    private func validate(active: Bool = false, completed: Bool = false,
                          continuing: UUID? = nil, activityID: UUID? = nil,
                          live: Bool = false, mode: ClemRecordingMode = .voice) throws {
        try WidgetRecordingAdmission.validate(hasActiveRecording: active, hasCompletedRecording: completed,
            continuingActivityID: continuing, activityID: activityID, activityIsLive: live,
            activityMode: activityID == nil ? nil : mode, requestedMode: .voice)
    }
    @available(iOS 18.0, *)
    @MainActor
    func testTranscriptionRequiresWordsAndKeepsInternationalSpeech() {
        for noise in ["[SOUND]", "(music) *sigh*", "… !! 🎵", "  "] {
            XCTAssertEqual(WidgetVoiceSession.spokenWords(noise), "")
        }
        XCTAssertEqual(WidgetVoiceSession.spokenWords("[noise] remind me  at  5"), "remind me at 5")
        XCTAssertEqual(WidgetVoiceSession.spokenWords("你好 123"), "你好 123")
    }

    func testRecoveredExactReceiptConsumesDraftWithoutChangingRetryBody() throws {
        var state = WidgetVoiceSavedState(pairingFingerprint: "fixture-pin", draft: "A saved request",
            requestId: "fixture-request", requestedText: "A saved request", requestedSessionId: "original-session",
            requestedVoice: true)
        state = try JSONDecoder().decode(WidgetVoiceSavedState.self, from: JSONEncoder().encode(state))
        XCTAssertTrue(state.acknowledge(requestId: "fixture-request", sessionId: "accepted-session"))
        XCTAssertEqual(state.draft, "")
        XCTAssertTrue(state.accepted)
        XCTAssertEqual(state.sessionId, "accepted-session")
        XCTAssertEqual(state.requestedText, "A saved request")
        XCTAssertEqual(state.requestedSessionId, "original-session")
        XCTAssertEqual(state.requestedVoice, true)
    }

    func testUnrelatedOrIncompleteReceiptCannotConsumeSavedDraft() {
        var state = WidgetVoiceSavedState(pairingFingerprint: "fixture-pin", draft: "Keep these words", requestId: "current-request")
        XCTAssertFalse(state.acknowledge(requestId: "older-request", sessionId: "unrelated-session"))
        XCTAssertFalse(state.acknowledge(requestId: "current-request", sessionId: ""))
        XCTAssertEqual(state.draft, "Keep these words")
        XCTAssertFalse(state.accepted)
        XCTAssertNil(state.sessionId)
    }

}
