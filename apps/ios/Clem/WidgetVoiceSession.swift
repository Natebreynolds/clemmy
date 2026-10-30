import AVFoundation
import ActivityKit
import Combine
import Foundation
import Network
import Security
import UIKit

enum WidgetVoiceError: LocalizedError {
    case setupRequired, microphonePermissionRequired, pendingDraft, unavailable(String)
    var errorDescription: String? {
        switch self {
        case .setupRequired: return "Open Clem once to connect widget voice to your Mac."
        case .microphonePermissionRequired: return "Open Clem to enable the microphone for widgets."
        case .pendingDraft: return "Your last dictation is saved. Open Clem to review it first."
        case .unavailable(let message): return message
        }
    }
}

/// Only fixed diagnostic codes are persisted. Never store a URL, credential,
/// request identifier, transcript, server response, or arbitrary error text.
enum WidgetVoiceRecoveryIssue: String, Codable, CaseIterable {
    case pageNotReady, bridgeUnavailable, connectionTimedOut, connectionUnavailable, serviceUnavailable
    case unauthorized, pairingChanged, secureStorage, invalidResponse, securityMismatch
    case microphoneDenied, liveActivityUnavailable, liveActivityVisibility, liveActivityLimit, liveActivityStartRefused
    case captureFailed, requestFailed

    var message: String {
        switch self {
        case .pageNotReady: return "Open your connected chat in Clem, then tap Connect widget voice again."
        case .bridgeUnavailable: return "This page needs the latest voice connection. Tap Reload Clem, then connect widget voice again."
        case .connectionTimedOut: return "Your Mac did not answer in time. Check its connection, then try again."
        case .connectionUnavailable: return "Clem could not reach your Mac. Check that your Mac is online, then try again."
        case .serviceUnavailable: return "Your Mac could not prepare widget voice. Reconnect widget voice and try again."
        case .unauthorized: return "Widget voice needs to reconnect. Your saved words and last request will stay here."
        case .pairingChanged: return "Voice setup changed before it finished. Connect widget voice again."
        case .secureStorage: return "Clem could not save the secure connection. Unlock your iPhone, then try again."
        case .invalidResponse: return "Your Mac returned an unsupported voice response. Reconnect widget voice and try again."
        case .securityMismatch: return "Your Mac’s security fingerprint no longer matches. Pair Clem with your Mac again."
        case .microphoneDenied: return "Allow microphone access for Clem in iPhone Settings, then return here."
        case .liveActivityUnavailable: return "Allow Live Activities for Clem in iPhone Settings, then try the widget again."
        case .liveActivityVisibility: return "iOS could not show recording controls from the widget. Open Clem and try Talk or Dictate here."
        case .liveActivityLimit: return "iOS has too many Live Activities open. End an existing activity, then try again."
        case .liveActivityStartRefused: return "iOS could not start the recording controls. Open Clem and try Talk or Dictate here."
        case .captureFailed: return "Clem could not start recording. Open Clem and try again."
        case .requestFailed: return "That voice step could not finish. Your draft or last request is saved here."
        }
    }

    var invalidatesConnection: Bool {
        [.pageNotReady, .bridgeUnavailable, .unauthorized, .pairingChanged,
         .secureStorage, .securityMismatch].contains(self)
    }

    static func httpStatus(_ status: Int) -> Self? {
        status == 401 || status == 403 ? .unauthorized : nil
    }

    static func classify(_ error: Error) -> Self {
        if let transport = error as? NativeVoiceTransportError {
            switch transport {
            case .setup: return .secureStorage
            case .unpaired, .unauthorized: return .unauthorized
            case .correlation: return .pairingChanged
            case .pin, .redirect: return .securityMismatch
            case .timeout: return .connectionTimedOut
            case .unreachable: return .connectionUnavailable
            case .unavailable: return .serviceUnavailable
            default: return .invalidResponse
            }
        }
        if let activity = error as? ActivityAuthorizationError {
            switch activity {
            case .denied: return .liveActivityUnavailable
            case .visibility: return .liveActivityVisibility
            case .globalMaximumExceeded, .targetMaximumExceeded: return .liveActivityLimit
            default: return .liveActivityStartRefused
            }
        }
        if let capture = error as? WidgetAudioRecorderError {
            switch capture {
            case .microphoneSetup, .microphoneDenied: return .microphoneDenied
            case .activitiesDisabled, .activityLost: return .liveActivityUnavailable
            default: return .captureFailed
            }
        }
        if error is NWError || error is URLError { return .connectionUnavailable }
        return .requestFailed
    }
}

struct WidgetVoiceDiagnostic: Codable, Equatable {
    enum Stage: String, Codable { case setup, connected, microphone, starting, recording, transcribing, sending, waiting, speaking, ready }
    let stage: Stage
    let issue: WidgetVoiceRecoveryIssue?
    let updatedAt: Date
    var code: String { "\(stage.rawValue).\(issue?.rawValue ?? "ok")" }
}

enum WidgetVoiceRecoveryPolicy {
    static func shouldPresent(requested: Bool, paired: Bool, unlocked: Bool, foreground: Bool) -> Bool {
        requested && paired && unlocked && foreground
    }
    static func connectionUsable(_ connected: Bool, after issue: WidgetVoiceRecoveryIssue) -> Bool {
        connected && !issue.invalidatesConnection
    }
    static func showReconnect(connected: Bool, working: Bool, recording: Bool) -> Bool {
        !connected && !working && !recording
    }
}

private enum WidgetVoiceDiagnosticStore {
    private static let key = "clem.widgetVoice.lastDiagnostic"
    static func load() -> WidgetVoiceDiagnostic? {
        guard let data = UserDefaults.standard.data(forKey: key), data.count < 1_024 else { return nil }
        return try? JSONDecoder().decode(WidgetVoiceDiagnostic.self, from: data)
    }
    static func save(_ value: WidgetVoiceDiagnostic?) {
        if let value, let data = try? JSONEncoder().encode(value) { UserDefaults.standard.set(data, forKey: key) }
        else { UserDefaults.standard.removeObject(forKey: key) }
    }
}

struct WidgetVoiceSavedState: Codable {
    var pairingFingerprint: String
    var draft: String = ""
    var sessionId: String?
    var requestId: String?
    var requestedText: String?
    var requestedSessionId: String?
    var requestedVoice: Bool?
    var recordingPath: String?
    var recordingId: UUID?
    var recordingMode: ClemRecordingMode?
    var accepted = false

    /// A durable exact receipt consumes the original draft, including after
    /// restoring an uncertain send following process termination.
    mutating func acknowledge(requestId: String, sessionId: String) -> Bool {
        guard self.requestId == requestId, !sessionId.isEmpty else { return false }
        self.sessionId = sessionId; accepted = true; draft = ""
        return true
    }
}

/// Native drafts and uncertain-send receipts never cross into widget storage.
enum WidgetVoiceStateStore {
    private static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "ai.breakthroughcoaching.clem.widget-voice", kSecAttrAccount as String: "draft"] }
    static func load(fingerprint: String) -> WidgetVoiceSavedState? {
        var q = query; q[kSecReturnData as String] = true
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, data.count <= 100_000,
              let state = try? JSONDecoder().decode(WidgetVoiceSavedState.self, from: data),
              state.pairingFingerprint == fingerprint else { return nil }
        return state
    }
    static func save(_ state: WidgetVoiceSavedState) throws {
        let data = try JSONEncoder().encode(state)
        let update = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var q = query; q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw WidgetVoiceError.unavailable("Your draft could not be saved. Please try again.") }
        } else if status != errSecSuccess { throw WidgetVoiceError.unavailable("Your draft could not be saved. Please try again.") }
    }
    static func clear() { SecItemDelete(query as CFDictionary) }
}

@available(iOS 18.0, *)
@MainActor
final class WidgetVoiceSession: NSObject, ObservableObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    static let shared = WidgetVoiceSession()
    @Published var setupRequested = false
    @Published private(set) var connected = false
    @Published private(set) var status = "Ready when you are"
    @Published private(set) var error: String?
    @Published var draft = ""
    @Published private(set) var reply = ""
    @Published private(set) var mode: ClemRecordingMode = .voice
    @Published private(set) var working = false
    @Published private(set) var sessionId: String?
    @Published private(set) var diagnostic = WidgetVoiceDiagnosticStore.load()
    private var saved: WidgetVoiceSavedState?
    private var transport: NativeVoiceTransport?
    private var boundFingerprint: String?
    /// Enrollment callbacks have their own lifetime; reconnecting must not
    /// cancel or otherwise change a saved recording or chat request.
    private var provisioningGeneration = UUID()
    private var epoch = UUID()
    private var handledSegments = Set<UUID>()
    private var work: Task<Void, Never>?
    private var player: AVAudioPlayer?
    private let synthesizer = AVSpeechSynthesizer()
    private var spoken: CheckedContinuation<Void, Error>?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var backgroundEpoch: UUID?
    private var voiceEnabled = false
    private var starting = false
    private var cancelling = false
    private var currentUtterance: AVSpeechUtterance?
    private var playbackSessionOwned = false
    private var recordingFingerprint: String?
    private var resettingPairing = false
    private let recorder = WidgetAudioRecorder.shared
    var onOpenConversation: ((String) -> Void)?

    private override init() {
        super.init()
        synthesizer.delegate = self
        recorder.onFinished = { [weak self] url, mode, id in self?.received(url: url, mode: mode, id: id) }
        recorder.onRecoveryNeeded = { [weak self] _, message in self?.setupRequested = true; self?.error = message }
        recorder.onInterrupted = { [weak self] message in
            guard let self else { return }
            self.epoch = UUID(); self.voiceEnabled = false; self.work?.cancel(); self.stopPlayback()
            self.working = false; self.error = message; self.status = "Voice paused"; self.endBackgroundTime()
        }
        refreshPairing()
    }

    func refreshPairing() {
        guard let pairing = PairingStore.load(), let fingerprint = pairing.fingerprint else { return }
        guard boundFingerprint != fingerprint else { return }
        provisioningGeneration = UUID(); connected = false
        epoch = UUID(); voiceEnabled = false; work?.cancel(); stopPlayback(); working = false
        recordingFingerprint = nil
        if boundFingerprint != nil {
            resettingPairing = true
            Task { await recorder.cancel()
                if let recording = recorder.completedRecording { recorder.acknowledgeCompleted(id: recording.id) }
                resettingPairing = false
            }
        }
        boundFingerprint = fingerprint
        transport = NativeVoiceTransport(pairing: pairing)
        saved = WidgetVoiceStateStore.load(fingerprint: fingerprint) ?? WidgetVoiceSavedState(pairingFingerprint: fingerprint)
        draft = saved?.draft ?? ""; sessionId = saved?.sessionId
        if saved?.requestId != nil { status = "Open your conversation to check the last request." }
        let prepared = transport
        let generation = provisioningGeneration
        Task { let ready = await prepared?.isProvisioned == true
            guard generation == provisioningGeneration, prepared === transport,
                  boundFingerprint == fingerprint else { return }
            connected = ready
        }
    }

    func prepareProvisioning() async throws -> NativeVoiceProvisioningRequest {
        refreshPairing()
        guard let transport else { throw WidgetVoiceError.setupRequired }
        return try await transport.prepareProvisioning()
    }

    func needsProvisioning() async -> Bool {
        refreshPairing()
        return await transport?.isProvisioned != true
    }

    func reconnect() async {
        guard !working, !recorder.hasActiveRecording else { return }
        // Invalidate callbacks before the actor hop. A previous acceptance
        // may already be returning while this credential is being replaced.
        provisioningGeneration = UUID(); connected = false
        let currentTransport = transport
        noteProvisioningStarted()
        await currentTransport?.clearCredentials()
    }

    func noteProvisioningStarted() { error = nil; note(.setup) }
    func noteProvisioningWaiting(_ issue: WidgetVoiceRecoveryIssue) {
        connected = false; error = issue.message; note(.setup, issue: issue)
    }
    func noteProvisioningFailure(_ failure: Error) {
        connected = false
        let issue = WidgetVoiceRecoveryIssue.classify(failure)
        error = issue.message; note(.setup, issue: issue)
    }

    func acceptProvisioning(_ body: [String: Any]) async {
        guard let transport else { return }
        let fingerprint = boundFingerprint
        let generation = provisioningGeneration
        do {
            guard try await transport.acceptProvisioning(body) == .accepted else { return }
            guard generation == provisioningGeneration, self.transport === transport,
                  fingerprint == boundFingerprint else { return }
            let ready = await transport.isProvisioned
            guard generation == provisioningGeneration, self.transport === transport,
                  fingerprint == boundFingerprint else { return }
            connected = ready; error = nil; note(ready ? .connected : .setup)
        } catch {
            guard generation == provisioningGeneration, self.transport === transport,
                  fingerprint == boundFingerprint else { return }
            noteProvisioningFailure(error)
        }
    }

    func enableAndStart() async {
        do {
            note(.microphone)
            guard await recorder.requestMicrophonePermission() else { throw WidgetVoiceError.microphonePermissionRequired }
            try await start(mode: mode)
            setupRequested = false
        } catch { recordStartFailure(error) }
    }

    func start(mode: ClemRecordingMode) async throws {
        refreshPairing()
        guard !starting && !cancelling && !working && !recorder.hasActiveRecording && !resettingPairing else { return }
        starting = true; defer { starting = false }
        self.mode = mode
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, saved?.requestId == nil,
              !hasSavedRecording else {
            setupRequested = true; throw WidgetVoiceError.pendingDraft
        }
        let admissionEpoch = epoch
        guard let transport, await transport.isProvisioned else {
            connected = false; note(.setup, issue: .unauthorized)
            setupRequested = true; throw WidgetVoiceError.setupRequired
        }
        try requireCurrent(admissionEpoch)
        guard AVAudioSession.sharedInstance().recordPermission == .granted else {
            note(.microphone, issue: .microphoneDenied)
            setupRequested = true; throw WidgetVoiceError.microphonePermissionRequired
        }
        if recorder.liveActivityActive { await recorder.endActivity(); try requireCurrent(admissionEpoch) }
        epoch = UUID(); error = nil; reply = ""; sessionId = nil
        saved?.sessionId = nil; try persist()
        voiceEnabled = mode == .voice
        recordingFingerprint = boundFingerprint
        note(.starting)
        try await recorder.start(mode: mode)
        note(.recording)
        status = mode == .voice ? "Listening · pause to send" : "Listening · finish when you’re ready"
    }

    func finish() async throws { _ = try await recorder.finish() }

    func startFromSheet(mode: ClemRecordingMode) async {
        do { try await start(mode: mode) } catch { recordStartFailure(error) }
    }

    func recordStartFailure(_ failure: Error) {
        setupRequested = true
        if case WidgetVoiceError.microphonePermissionRequired = failure {
            error = WidgetVoiceRecoveryIssue.microphoneDenied.message; note(.microphone, issue: .microphoneDenied)
        } else if failure is WidgetVoiceError { error = failure.localizedDescription }
        else {
            let issue = WidgetVoiceRecoveryIssue.classify(failure)
            error = issue.message; note(.starting, issue: issue)
        }
    }

    func finishFromSheet() async {
        do { try await finish() } catch { self.error = error.localizedDescription }
    }

    func cancel() async {
        guard !cancelling else { return }
        cancelling = true; defer { cancelling = false }
        epoch = UUID(); voiceEnabled = false; work?.cancel(); work = nil
        stopPlayback(); await recorder.cancel()
        working = false; endBackgroundTime()
        status = saved?.accepted == true ? "Clem’s work continues in your conversation." : draft.isEmpty ? "Voice ended" : "Your draft is saved"
    }

    /// Revoke synchronously at the explicit signout/unpair boundary. Cleanup
    /// captures old files and never resets a newly established pairing later.
    func beginClear() {
        provisioningGeneration = UUID()
        ClemQuickVoiceService.clearReceipts()
        PendingWidgetVoiceLaunchRepository.shared.clear()
        ClemQuickVoicePresentation.shared.clear()
        NativeVoiceTransport.clearAllCredentials()
        let recordingID = recorder.completedRecording?.id
        let recordingPath = saved?.recordingPath
        epoch = UUID(); voiceEnabled = false; work?.cancel(); work = nil
        stopPlayback(); endBackgroundTime()
        WidgetVoiceStateStore.clear(); transport = nil; boundFingerprint = nil; recordingFingerprint = nil
        saved = nil; draft = ""; reply = ""; sessionId = nil; connected = false
        diagnostic = nil; WidgetVoiceDiagnosticStore.save(nil)
        setupRequested = false; working = false; error = nil; status = "Ready when you are"
        resettingPairing = true
        Task {
            await recorder.cancel()
            if let recordingID { recorder.acknowledgeCompleted(id: recordingID) }
            if let recordingPath { try? FileManager.default.removeItem(atPath: recordingPath) }
            resettingPairing = false
        }
    }

    func saveDraft(_ text: String) {
        draft = String(text.prefix(8_000)); saved?.draft = draft
        do { try persist() } catch { self.error = error.localizedDescription }
    }

    func discardDraft() {
        guard !working, saved?.requestId == nil else { return }
        saveDraft(""); setupRequested = false; status = "Ready when you are"
    }

    func discardRecording() async {
        guard !working else { return }
        working = true; defer { working = false }
        await recorder.cancel()
        if let recording = recorder.completedRecording { recorder.acknowledgeCompleted(id: recording.id) }
        if let path = saved?.recordingPath { try? FileManager.default.removeItem(atPath: path) }
        saved?.recordingPath = nil; saved?.recordingId = nil; saved?.recordingMode = nil
        do { try persist(); error = nil; setupRequested = false; status = "Ready when you are" }
        catch { self.error = error.localizedDescription }
    }

    func sendDraft() {
        guard !working, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        setupRequested = false
        epoch = UUID(); let token = epoch; voiceEnabled = false
        work = Task { [weak self] in
            guard let self else { return }
            do { try await self.submit(text: self.draft, token: token, speak: false) }
            catch { await self.failed(error, token: token) }
        }
    }

    func checkLastRequest() {
        guard !working, let requestId = saved?.requestId else { return }
        epoch = UUID(); let token = epoch
        work = Task { [weak self] in
            guard let self else { return }
            do {
                try self.requireCurrent(token)
                self.working = true
                // Only a missing durable receipt permits replay, with the same
                // exact body/key. A timeout never generates a second request.
                let status = try await self.json(path: "/m/api/chat/native-voice-status?requestId=\(requestId)")
                if status.0 == 404, let text = self.saved?.requestedText {
                    try await self.submit(text: text, token: token, speak: self.saved?.requestedVoice == true)
                } else {
                    try self.requireOK(status.0)
                    try await self.observe(requestId: requestId, token: token, speak: false)
                }
            } catch { await self.failed(error, token: token) }
        }
    }

    func openConversation() { if let sessionId { onOpenConversation?(sessionId) } }
    var hasUncertainRequest: Bool { saved?.requestId != nil }
    var hasSavedRecording: Bool { recorder.completedRecording != nil || saved?.recordingPath != nil }

    func retryTranscription() {
        guard !working else { return }
        recordingFingerprint = boundFingerprint
        if let recording = recorder.completedRecording {
            handledSegments.remove(recording.id)
            received(url: recording.url, mode: recording.mode, id: recording.id)
        } else if let path = saved?.recordingPath, let id = saved?.recordingId, let mode = saved?.recordingMode {
            handledSegments.remove(id); received(url: URL(fileURLWithPath: path), mode: mode, id: id)
        }
    }

    private func received(url: URL, mode: ClemRecordingMode, id: UUID) {
        guard recordingFingerprint == boundFingerprint else { recorder.acknowledgeCompleted(id: id); return }
        guard handledSegments.insert(id).inserted else { return }
        saved?.recordingPath = url.path; saved?.recordingId = id; saved?.recordingMode = mode
        do { try persist() } catch { self.error = error.localizedDescription; return }
        let token = epoch
        working = true
        work = Task { [weak self] in
            guard let self else { return }
            do {
                try self.requireCurrent(token)
                self.status = "Transcribing…"; self.note(.transcribing); self.beginBackgroundTime()
                let data = try Data(contentsOf: url)
                let result = try await self.json(path: "/m/api/chat/transcribe", method: "POST", body: data, contentType: "audio/wav")
                try self.requireCurrent(token); try self.requireOK(result.0)
                let words = Self.spokenWords(result.1["text"] as? String ?? "")
                guard !words.isEmpty else { throw WidgetVoiceError.unavailable("No speech was heard. Try recording again.") }
                guard words.count <= 8_000 else { throw WidgetVoiceError.unavailable("That recording is too long for one message. Try a shorter recording.") }
                self.draft = words; self.saved?.draft = words; try self.persist()
                self.saved?.recordingPath = nil; self.saved?.recordingId = nil; self.saved?.recordingMode = nil; try self.persist()
                self.recorder.acknowledgeCompleted(id: id)
                try? FileManager.default.removeItem(at: url)
                if mode == .dictate || !self.voiceEnabled {
                    self.working = false; self.status = "Draft ready · open Clem to review"; self.note(.ready)
                    await self.recorder.updatePhase(phase: .ready, message: "Draft ready · tap to review")
                    self.endBackgroundTime()
                } else { try await self.submit(text: words, token: token, speak: true) }
            } catch { await self.failed(error, token: token) }
        }
    }

    private func submit(text: String, token: UUID, speak: Bool) async throws {
        try requireCurrent(token)
        let requestId = saved?.requestId ?? UUID().uuidString
        if let existing = saved?.requestedText, existing != text { throw WidgetVoiceError.unavailable("Check your last request before sending another.") }
        if saved?.requestId == nil {
            let previousSession = saved?.sessionId
            saved?.requestedSessionId = previousSession; saved?.requestedVoice = speak
        }
        saved?.requestId = requestId; saved?.requestedText = text; try persist()
        working = true; status = "Sending to Clem…"; note(.sending); beginBackgroundTime()
        var body: [String: Any] = ["message": text, "async": true, "voice": saved?.requestedVoice == true, "requireIdle": true]
        if let sessionId = saved?.requestedSessionId { body["sessionId"] = sessionId }
        let result = try await json(path: "/m/api/chat/send", method: "POST", body: JSONSerialization.data(withJSONObject: body), idempotencyKey: requestId)
        try requireCurrent(token)
        if result.0 == 409, let code = result.1["error"] as? String,
           ["VOICE_REQUIRES_IDLE_CHAT", "VOICE_CONTROL_REQUIRES_CHAT"].contains(code) {
            saved?.requestId = nil; saved?.requestedText = nil; saved?.requestedSessionId = nil; saved?.requestedVoice = nil
            try persist()
            throw WidgetVoiceError.unavailable(code == "VOICE_REQUIRES_IDLE_CHAT"
                ? "Clem is already working in this conversation. Your words are saved as a draft."
                : "Your words are saved. Open the conversation in Clem to use this control.")
        }
        try requireOK(result.0)
        guard result.1["accepted"] as? Bool == true, let id = result.1["sessionId"] as? String, !id.isEmpty else {
            throw WidgetVoiceError.unavailable("Your request could not be confirmed. Tap Check last request before trying again.")
        }
        guard saved?.acknowledge(requestId: requestId, sessionId: id) == true else { throw CancellationError() }
        sessionId = id; draft = ""; try persist()
        try await observe(requestId: requestId, token: token, speak: speak)
    }

    private func observe(requestId: String, token: UUID, speak: Bool) async throws {
        try requireCurrent(token)
        status = "Clem is working…"
        note(.waiting)
        if recorder.liveActivityActive { await recorder.updatePhase(phase: .processing, message: status) }
        try requireCurrent(token)
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline {
            try requireCurrent(token)
            let result = try await json(path: "/m/api/chat/native-voice-status?requestId=\(requestId)")
            try requireCurrent(token); try requireOK(result.0)
            if let id = result.1["sessionId"] as? String, !id.isEmpty {
                sessionId = id; saved?.sessionId = id
                // The exact durable receipt proves an uncertain POST was
                // accepted. Retire its draft so recovery cannot send it again.
                if saved?.accepted != true {
                    guard saved?.acknowledge(requestId: requestId, sessionId: id) == true else { throw CancellationError() }
                    draft = ""; try persist()
                }
            }
            let state = result.1["state"] as? String
            if state == "answered" || state == "needs_app" {
                reply = result.1["text"] as? String ?? "Open the conversation in Clem."
                saved?.requestId = nil; saved?.requestedText = nil; saved?.requestedSessionId = nil; saved?.requestedVoice = nil; saved?.accepted = false; try persist()
                if speak && !reply.isEmpty { try await say(reply, token: token) }
                try requireCurrent(token)
                working = false; endBackgroundTime()
                if result.1["canResumeVoice"] as? Bool == true, state == "answered", voiceEnabled, let activityID = recorder.activityRecordingID, recorder.liveActivityActive {
                    try await recorder.start(mode: .voice, continuingActivityID: activityID)
                    status = "Listening · pause to send"
                } else {
                    voiceEnabled = false; status = state == "needs_app" ? "Open your conversation to continue" : "Reply ready"
                    if recorder.liveActivityActive { await recorder.updatePhase(phase: .ready, message: status) }
                }
                return
            }
            try await Task.sleep(for: .seconds(1.5))
        }
        throw WidgetVoiceError.unavailable("Clem is still working. Open your conversation to continue; your request will not be sent twice.")
    }

    private func say(_ text: String, token: UUID) async throws {
        try requireCurrent(token)
        status = "Clem is speaking…"
        note(.speaking)
        await recorder.updatePhase(phase: .speaking, message: status)
        try requireCurrent(token)
        guard let transport else { throw WidgetVoiceError.setupRequired }
        let response = try await transport.request(path: "/m/api/chat/speak", method: "POST", body: JSONSerialization.data(withJSONObject: ["text": text]), contentType: "application/json")
        try requireCurrent(token)
        try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
        try AVAudioSession.sharedInstance().setActive(true)
        playbackSessionOwned = true
        if response.status == 409,
           let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any], object["fallback"] as? String == "system" {
            let utterance = AVSpeechUtterance(string: object["text"] as? String ?? text)
            currentUtterance = utterance
            try await withCheckedThrowingContinuation { continuation in spoken = continuation; synthesizer.speak(utterance) }
        } else {
            try requireOK(response.status)
            let audio = try AVAudioPlayer(data: response.body); player = audio; audio.delegate = self
            try await withCheckedThrowingContinuation { continuation in
                spoken = continuation
                if !audio.play() { spoken = nil; continuation.resume(throwing: WidgetVoiceError.unavailable("Clem’s audio could not play. Her reply is saved in the conversation.")) }
            }
        }
        try requireCurrent(token)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        playbackSessionOwned = false
    }

    private func json(path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json", idempotencyKey: String? = nil) async throws -> (Int, [String: Any]) {
        guard let transport else { throw WidgetVoiceError.setupRequired }
        let response = try await transport.request(path: path, method: method, body: body, contentType: contentType, idempotencyKey: idempotencyKey)
        if WidgetVoiceRecoveryIssue.httpStatus(response.status) != nil { try requireOK(response.status) }
        guard let object = try JSONSerialization.jsonObject(with: response.body) as? [String: Any] else { throw WidgetVoiceError.unavailable("Clem’s connection returned an unreadable reply. Open Clem to reconnect.") }
        return (response.status, object)
    }
    private func requireOK(_ status: Int) throws {
        if let issue = WidgetVoiceRecoveryIssue.httpStatus(status) {
            connected = WidgetVoiceRecoveryPolicy.connectionUsable(connected, after: issue)
            error = issue.message; note(diagnostic?.stage ?? .setup, issue: issue)
            throw NativeVoiceTransportError.unauthorized
        }
        guard (200..<300).contains(status) else { throw WidgetVoiceError.unavailable(status == 401 || status == 403 ? "Open Clem to reconnect widget voice." : "Clem could not complete that step. Your draft or request is saved; open Clem to continue.") }
    }
    private func requireCurrent(_ token: UUID) throws {
        guard token == epoch, !Task.isCancelled, PairingStore.load()?.fingerprint == boundFingerprint else { throw CancellationError() }
    }
    private func persist() throws { if let saved { try WidgetVoiceStateStore.save(saved) } }
    private func failed(_ failure: Error, token: UUID) async {
        guard token == epoch else { return }
        voiceEnabled = false; working = false; stopPlayback(); endBackgroundTime()
        let issue = WidgetVoiceRecoveryIssue.classify(failure)
        connected = WidgetVoiceRecoveryPolicy.connectionUsable(connected, after: issue)
        error = failure is WidgetVoiceError ? failure.localizedDescription : issue.message
        note(diagnostic?.stage ?? .setup, issue: issue); status = "Open Clem to continue"
        if recorder.liveActivityActive { await recorder.updatePhase(phase: .failed, message: "Open Clem to continue") }
    }
    private func note(_ stage: WidgetVoiceDiagnostic.Stage, issue: WidgetVoiceRecoveryIssue? = nil) {
        let value = WidgetVoiceDiagnostic(stage: stage, issue: issue, updatedAt: Date())
        diagnostic = value; WidgetVoiceDiagnosticStore.save(value)
    }
    private func beginBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        let token = epoch
        let backgroundID = UUID(); backgroundEpoch = backgroundID
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Finish widget speech") { [weak self] in
            Task { @MainActor in
                guard let self, self.epoch == token, self.backgroundEpoch == backgroundID else { return }
                self.epoch = UUID(); self.voiceEnabled = false; self.work?.cancel(); self.stopPlayback()
                self.working = false; self.status = "Open Clem to continue"; self.endBackgroundTime()
                await self.recorder.cancel()
            }
        }
    }
    private func endBackgroundTime() {
        backgroundEpoch = nil
        if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask); backgroundTask = .invalid }
    }
    private func stopPlayback() {
        let ownedAudio = playbackSessionOwned
        playbackSessionOwned = false
        player?.stop(); player = nil; synthesizer.stopSpeaking(at: .immediate)
        currentUtterance = nil
        let pending = spoken; spoken = nil; pending?.resume(throwing: CancellationError())
        if ownedAudio { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            guard self.player === player else { return }
            let pending = spoken; spoken = nil; self.player = nil
            if flag { pending?.resume() } else { pending?.resume(throwing: WidgetVoiceError.unavailable("Playback stopped. Open Clem to read the reply.")) } }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            guard self.currentUtterance === utterance else { return }
            self.currentUtterance = nil
            let pending = spoken; spoken = nil; pending?.resume()
        }
    }
    static func spokenWords(_ text: String) -> String {
        let words = text.replacingOccurrences(of: #"\[[^\]]*\]|\([^)]*\)|\*[^*]*\*"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        return words.rangeOfCharacter(from: .alphanumerics) == nil ? "" : words
    }
}
