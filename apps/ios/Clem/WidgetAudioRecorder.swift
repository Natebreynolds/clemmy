import ActivityKit
import AVFAudio
import Combine
import Foundation
import UIKit

struct WidgetAudioRecording: Identifiable, Equatable {
    let id: UUID
    let mode: ClemRecordingMode
    let url: URL
    let startedAt: Date
    let endedAt: Date
}

/// Metering is only an end-of-utterance hint, never a transcript or authority to
/// send a message. Quiet beginnings do not immediately finish a voice turn.
struct WidgetSpeechSilenceGate {
    var speechThreshold: Float = -38
    /// Quiet that ends a turn once the speaker has said a phrase.
    var silenceDuration: TimeInterval = 1.8
    /// A lone word followed by a thinking pause is not a finished thought
    /// (live 2026-10-11: "the" was sent on its own). Until this much speech
    /// has been heard, the turn waits for the longer quiet below.
    var shortUtteranceSpeech: TimeInterval = 1.0
    var shortUtteranceSilence: TimeInterval = 3.0
    var minimumSpeechDuration: TimeInterval = 0.35
    private(set) var heardSpeech = false
    private(set) var spokenTime: TimeInterval = 0
    private var speechBeganAt: TimeInterval?
    private var lastSpeechAt: TimeInterval?
    private var lastSampleAt: TimeInterval?

    mutating func shouldFinish(power: Float, elapsed: TimeInterval) -> Bool {
        guard power.isFinite, elapsed.isFinite, elapsed >= 0 else { return false }
        // Meter samples arrive about every 100 ms; a long gap never counts as speech.
        let step = lastSampleAt.map { max(0, min(elapsed - $0, 0.5)) } ?? 0
        lastSampleAt = elapsed
        if power >= speechThreshold {
            if speechBeganAt == nil { speechBeganAt = elapsed }
            if let began = speechBeganAt, elapsed - began >= minimumSpeechDuration { heardSpeech = true }
            spokenTime += step
            lastSpeechAt = elapsed
            return false
        }
        if !heardSpeech { speechBeganAt = nil }
        guard heardSpeech, let last = lastSpeechAt else { return false }
        let quietNeeded = spokenTime >= shortUtteranceSpeech ? silenceDuration : shortUtteranceSilence
        return elapsed - last >= quietNeeded
    }
}

enum WidgetAudioRecorderError: LocalizedError, Equatable {
    case alreadyRecording, pendingRecording, microphoneSetup, microphoneDenied
    case activitiesDisabled, activityLost, unableToRecord, noRecording, noSpeech, interrupted

    var errorDescription: String? {
        switch self {
        case .alreadyRecording: return "Clem is already recording. Finish or cancel that recording first."
        case .pendingRecording: return "Clem is still handling the previous recording."
        case .microphoneSetup: return "Open Clem once to allow microphone access, then try the widget again."
        case .microphoneDenied: return "Allow microphone access for Clem in iPhone Settings, then try again."
        case .activitiesDisabled: return "Allow Live Activities for Clem in iPhone Settings to record from the widget."
        case .activityLost: return "Recording stopped because its Live Activity ended."
        case .unableToRecord: return "Clem couldn’t start recording. Please try again."
        case .noRecording: return "There is no active recording to finish."
        case .noSpeech: return "No speech was heard. Tap Talk to Clem to try again."
        case .interrupted: return "Recording stopped because another audio session interrupted it."
        }
    }
}

/// Shared by explicit starts and automatic next utterances. A continuation
/// carries the exact visible session ID; an absent or changed ID never falls
/// back to creating a new session and recording again.
enum WidgetRecordingAdmission {
    static func validate(hasActiveRecording: Bool, hasCompletedRecording: Bool,
                         continuingActivityID: UUID?, activityID: UUID?,
                         activityIsLive: Bool, activityMode: ClemRecordingMode?,
                         requestedMode: ClemRecordingMode) throws {
        if hasActiveRecording { throw WidgetAudioRecorderError.alreadyRecording }
        if hasCompletedRecording { throw WidgetAudioRecorderError.pendingRecording }
        if let expected = continuingActivityID {
            guard expected == activityID, activityIsLive, activityMode == requestedMode else {
                throw WidgetAudioRecorderError.activityLost
            }
        } else if activityID != nil {
            throw WidgetAudioRecorderError.alreadyRecording
        }
    }
}

/// Owns local audio only. Authentication, transcription, sending, and spoken
/// replies belong to WidgetVoiceSession. Nothing starts from init or relaunch.
@available(iOS 18.0, *)
@MainActor
final class WidgetAudioRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    static let shared = WidgetAudioRecorder()
    static let maximumRecordingDuration: TimeInterval = 120
    static let maximumVoiceSessionDuration: TimeInterval = 600

    @Published private(set) var phase: ClemRecordingPhase = .idle
    @Published private(set) var mode: ClemRecordingMode?
    @Published private(set) var error: String?
    @Published private(set) var activityRecordingID: UUID?
    @Published private(set) var completedRecording: WidgetAudioRecording?
    @Published private(set) var elapsed: TimeInterval = 0

    var onFinished: ((URL, ClemRecordingMode, UUID) -> Void)?
    var onRecoveryNeeded: ((ClemRecordingMode, String) -> Void)?
    var onInterrupted: ((String) -> Void)?

    var hasActiveRecording: Bool { recorder != nil || phase == .preparing || phase == .finishing }
    var liveActivityActive: Bool {
        guard let activity else { return false }
        return activity.activityState == .active &&
            ActivityAuthorizationInfo().areActivitiesEnabled && Date() < activity.attributes.deadline
    }

    private var recorder: AVAudioRecorder?
    private var ownsAudioSession = false
    private var activity: Activity<ClemRecordingAttributes>?
    private var recordingID: UUID?
    private var recordingURL: URL?
    private var startedAt: Date?
    private var meterTask: Task<Void, Never>?
    private var activityTask: Task<Void, Never>?
    private var authorizationTask: Task<Void, Never>?
    private var sessionDeadlineTask: Task<Void, Never>?
    private var interruptionObserver: NSObjectProtocol?
    private var resetObserver: NSObjectProtocol?
    private var silenceGate = WidgetSpeechSilenceGate()

    override init() {
        super.init()
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            Task { @MainActor in await self?.interrupt(.interrupted) }
        }
        resetObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
        ) { [weak self] _ in Task { @MainActor in await self?.interrupt(.interrupted) } }
    }

    /// Foreground recovery only. Call after the app's authentication gate and
    /// an explicit microphone-enablement action; this does not begin recording.
    func requestMicrophonePermission() async -> Bool {
        guard UIApplication.shared.applicationState == .active else { return false }
        return await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in continuation.resume(returning: granted) }
        }
    }

    /// A fresh explicit widget/app action starts a session. Automatic subsequent
    /// voice turns must supply the same activity ID, so dismissal cannot race an
    /// unnoticed creation of a new recording indicator.
    func start(mode: ClemRecordingMode, continuingActivityID: UUID? = nil) async throws {
        try WidgetRecordingAdmission.validate(hasActiveRecording: hasActiveRecording,
            hasCompletedRecording: completedRecording != nil, continuingActivityID: continuingActivityID,
            activityID: activityRecordingID, activityIsLive: liveActivityActive,
            activityMode: activity?.attributes.mode, requestedMode: mode)

        self.mode = mode
        self.error = nil
        elapsed = 0
        let id = UUID()
        recordingID = id
        phase = .preparing
        do {
            try Task.checkCancellation()
            switch AVAudioApplication.shared.recordPermission {
            case .granted: break
            case .denied: throw WidgetAudioRecorderError.microphoneDenied
            default: throw WidgetAudioRecorderError.microphoneSetup
            }
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                throw WidgetAudioRecorderError.activitiesDisabled
            }
            if activity == nil {
                // Stale activities from a terminated process never resume audio.
                for previous in Activity<ClemRecordingAttributes>.activities {
                    await previous.end(nil, dismissalPolicy: .immediate)
                }
                try Task.checkCancellation()
                guard recordingID == id else { throw CancellationError() }
                let now = Date()
                // Capture is separately capped at 120s. The Activity also covers
                // processing afterwards, so reaching the capture cap must not
                // immediately discard its completed transcription handoff.
                let duration = Self.maximumVoiceSessionDuration
                let attributes = ClemRecordingAttributes(recordingID: id, mode: mode, startedAt: now,
                                                          deadline: now.addingTimeInterval(duration))
                let created = try Activity.request(attributes: attributes,
                    content: ActivityContent(state: .init(phase: .preparing, message: nil), staleDate: attributes.deadline))
                activity = created
                activityRecordingID = id
                observeActivity(created)
            }
            try Task.checkCancellation()
            guard recordingID == id, liveActivityActive else { throw WidgetAudioRecorderError.activityLost }
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
            ownsAudioSession = true
            let url = try Self.protectedRecordingURL(id: id)
            recordingURL = url
            let capture = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false
            ])
            capture.isMeteringEnabled = true
            capture.delegate = self
            recorder = capture
            guard capture.prepareToRecord(), recordingID == id, liveActivityActive,
                  capture.record(forDuration: Self.maximumRecordingDuration) else {
                throw WidgetAudioRecorderError.unableToRecord
            }
            startedAt = Date()
            silenceGate = WidgetSpeechSilenceGate()
            await updatePhase(phase: .recording)
            try Task.checkCancellation()
            guard recordingID == id, liveActivityActive else { throw WidgetAudioRecorderError.activityLost }
            startMetering(id: id, autoFinish: mode == .voice)
        } catch {
            guard recordingID == id else { throw error }
            let failure = error
            stopCapture(discard: true)
            let needsPermission = (failure as? WidgetAudioRecorderError).map {
                $0 == .microphoneSetup || $0 == .microphoneDenied
            } ?? false
            self.phase = needsPermission ? .needsPermission : .failed
            self.error = failure.localizedDescription
            await endActivity()
            if needsPermission { onRecoveryNeeded?(mode, failure.localizedDescription) }
            throw failure
        }
    }

    /// Stops the microphone synchronously before any async activity update. The
    /// consumer owns this exact protected file until it acknowledges completion.
    @discardableResult
    func finish() async throws -> URL {
        guard phase == .recording, let id = recordingID, let url = recordingURL,
              let mode, let began = startedAt else { throw WidgetAudioRecorderError.noRecording }
        phase = .finishing
        stopCapture(discard: false)
        let recording = WidgetAudioRecording(id: id, mode: mode, url: url, startedAt: began, endedAt: Date())
        completedRecording = recording
        await updatePhase(phase: .processing)
        guard phase == .processing, completedRecording?.id == id, liveActivityActive else {
            throw CancellationError()
        }
        onFinished?(url, mode, id)
        return url
    }

    /// Cancelling an in-flight capture discards only that capture. Completed
    /// audio is retained until its consumer explicitly accepts or discards it.
    func cancel() async {
        stopCapture(discard: true)
        error = nil
        phase = .cancelled
        await endActivity()
    }

    func acknowledgeCompleted(id: UUID, deleteFile: Bool = true) {
        guard let completed = completedRecording, completed.id == id else { return }
        if deleteFile { try? FileManager.default.removeItem(at: completed.url) }
        completedRecording = nil
    }

    func updatePhase(phase: ClemRecordingPhase, message: String? = nil) async {
        self.phase = phase
        guard let activity else { return }
        // Only bounded status copy belongs on a Lock Screen. The coordinator
        // must never pass transcript/provider errors or other private content.
        let bounded = message.map { String($0.prefix(120)) }
        await activity.update(ActivityContent(state: .init(phase: phase, message: bounded),
                                               staleDate: activity.attributes.deadline))
    }

    func endActivity() async {
        if hasActiveRecording { stopCapture(discard: true) }
        let ended = activity
        activity = nil
        activityRecordingID = nil
        activityTask?.cancel(); activityTask = nil
        authorizationTask?.cancel(); authorizationTask = nil
        sessionDeadlineTask?.cancel(); sessionDeadlineTask = nil
        if let ended { await ended.end(nil, dismissalPolicy: .immediate) }
    }

    private func observeActivity(_ observed: Activity<ClemRecordingAttributes>) {
        activityTask = Task { [weak self] in
            for await state in observed.activityStateUpdates {
                guard !Task.isCancelled, let self, self.activity?.id == observed.id else { return }
                if state != .active { await self.interrupt(.activityLost); return }
            }
        }
        authorizationTask = Task { [weak self] in
            for await enabled in ActivityAuthorizationInfo().activityEnablementUpdates {
                guard !Task.isCancelled, let self, self.activity?.id == observed.id else { return }
                if !enabled { await self.interrupt(.activitiesDisabled); return }
            }
        }
        sessionDeadlineTask = Task { [weak self] in
            let remaining = max(0, observed.attributes.deadline.timeIntervalSinceNow)
            try? await Task.sleep(for: .seconds(remaining))
            guard !Task.isCancelled, let self, self.activity?.id == observed.id else { return }
            await self.interrupt(.activityLost)
        }
    }

    private func startMetering(id: UUID, autoFinish: Bool) {
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled, let self, self.recordingID == id,
                      self.phase == .recording, let capture = self.recorder else { return }
                guard self.liveActivityActive else { await self.interrupt(.activityLost); return }
                capture.updateMeters()
                self.elapsed = capture.currentTime
                if autoFinish {
                    if self.silenceGate.shouldFinish(power: capture.averagePower(forChannel: 0), elapsed: self.elapsed) {
                        _ = try? await self.finish()
                        return
                    }
                    if self.elapsed >= 12 && !self.silenceGate.heardSpeech {
                        await self.interrupt(.noSpeech)
                        return
                    }
                }
            }
        }
    }

    private func interrupt(_ reason: WidgetAudioRecorderError) async {
        guard activity != nil || hasActiveRecording else { return }
        stopCapture(discard: true)
        error = reason.localizedDescription
        phase = .failed
        // Notify before awaiting an ActivityKit round trip so no speech/network
        // continuation can race a lost visible recording session.
        onInterrupted?(reason.localizedDescription)
        await endActivity()
    }

    private func stopCapture(discard: Bool) {
        meterTask?.cancel(); meterTask = nil
        let capture = recorder
        recorder = nil
        capture?.delegate = nil
        capture?.stop()
        if discard, let url = recordingURL { try? FileManager.default.removeItem(at: url) }
        recordingURL = nil
        recordingID = nil
        startedAt = nil
        if ownsAudioSession {
            ownsAudioSession = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private static func protectedRecordingURL(id: UUID) throws -> URL {
        let manager = FileManager.default
        var directory = try manager.url(for: .cachesDirectory, in: .userDomainMask,
                                        appropriateFor: nil, create: true).appendingPathComponent("WidgetRecordings", isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true,
                                    attributes: [.protectionKey: FileProtectionType.completeUnlessOpen])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        let url = directory.appendingPathComponent(id.uuidString).appendingPathExtension("wav")
        guard manager.createFile(atPath: url.path, contents: Data(),
                                 attributes: [.protectionKey: FileProtectionType.completeUnlessOpen]) else {
            throw WidgetAudioRecorderError.unableToRecord
        }
        return url
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self, self.recorder === recorder else { return }
            if flag && self.mode == .voice && !self.silenceGate.heardSpeech { await self.interrupt(.noSpeech) }
            else if flag { _ = try? await self.finish() }
            else { await self.interrupt(.unableToRecord) }
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self, self.recorder === recorder else { return }
            await self.interrupt(.unableToRecord)
        }
    }
}
