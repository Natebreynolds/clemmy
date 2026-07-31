import LocalAuthentication
import SwiftUI

/// The lock in front of Clem.
///
/// A paired phone can drive an agent that runs commands on the owner's Mac, so
/// possession of an unlocked handset must not be the same thing as authority
/// over that Mac. This gate stands between the two.
///
/// `deviceOwnerAuthentication` is deliberate: it accepts Face ID or Touch ID
/// and falls back to the device passcode, so the gate is available on every
/// device — including ones where biometrics are unenrolled or have been locked
/// out by failed attempts. A gate that can be dodged by disabling Face ID
/// would not be a gate.
@MainActor
final class BiometricGate: ObservableObject {
    /// Locked until proven otherwise: the app must never render Clem first and
    /// authenticate second, because the transcript is visible in that gap.
    @Published private(set) var unlocked = false
    @Published private(set) var failureMessage: String?
    @Published private(set) var prompting = false

    /// Re-lock threshold. Short enough that a handed-over phone is protected,
    /// long enough that answering a notification isn't a second Face ID scan.
    private static let graceSeconds: TimeInterval = 60
    private var backgroundedAt: Date?

    /// Whether this device can authenticate at all. Kept for messaging only —
    /// there is no "skip" path.
    static var isAvailable: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    func authenticate() {
        guard !prompting else { return }
        prompting = true
        failureMessage = nil

        let context = LAContext()
        // The passcode fallback is the point, so no custom fallback title.
        context.localizedCancelTitle = "Cancel"
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            // No passcode set on the device at all. Refuse rather than degrade:
            // an unprotected phone should not hold an unlocked agent.
            prompting = false
            unlocked = false
            failureMessage = "Set a device passcode to use Clem. Your Mac is reachable from this app, so it can't be left unlocked."
            return
        }

        context.evaluatePolicy(
            .deviceOwnerAuthentication,
            localizedReason: "Unlock Clem to reach your Mac"
        ) { [weak self] success, error in
            Task { @MainActor in
                guard let self else { return }
                self.prompting = false
                if success {
                    self.unlocked = true
                    self.failureMessage = nil
                    self.backgroundedAt = nil
                    return
                }
                self.unlocked = false
                let code = (error as? LAError)?.code
                self.failureMessage = code == .userCancel || code == .appCancel || code == .systemCancel
                    ? nil                       // A cancel is a choice, not an error to shout about.
                    : "Couldn't verify it's you."
            }
        }
    }

    /// Called when the app leaves the foreground — the moment a phone is most
    /// likely to change hands.
    func noteBackgrounded() {
        backgroundedAt = Date()
    }

    /// Re-locks if the app was away long enough to have been put down.
    func noteForegrounded() {
        guard unlocked, let since = backgroundedAt else { return }
        if Date().timeIntervalSince(since) >= Self.graceSeconds {
            unlocked = false
        }
        backgroundedAt = nil
    }
}

/// What the owner sees while locked. Deliberately blank of content: no chat
/// preview, no counts, nothing that leaks over a shoulder.
struct LockScreen: View {
    @ObservedObject var gate: BiometricGate

    private let peelBlack = Color(red: 12 / 255, green: 9 / 255, blue: 6 / 255)

    var body: some View {
        ZStack {
            peelBlack.ignoresSafeArea()
            VStack(spacing: 18) {
                Image(systemName: "lock.circle.fill")
                    .font(.system(size: 72))
                    .foregroundStyle(Color(red: 1, green: 0.54, blue: 0.24))
                Text("Clem is locked")
                    .font(.system(.title2, design: .rounded).weight(.bold))
                    .foregroundStyle(.white)
                if let message = gate.failureMessage {
                    Text(message)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 32)
                }
                Button(action: { gate.authenticate() }) {
                    Text(gate.prompting ? "Verifying…" : "Unlock")
                        .font(.system(.body, design: .rounded).weight(.bold))
                        .foregroundStyle(Color(red: 0.1, green: 0.05, blue: 0.01))
                        .frame(maxWidth: 260)
                        .padding(.vertical, 15)
                        .background(
                            LinearGradient(
                                colors: [Color(red: 1, green: 0.65, blue: 0.4), Color(red: 0.94, green: 0.37, blue: 0.05)],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            in: RoundedRectangle(cornerRadius: 20)
                        )
                }
                .disabled(gate.prompting)
            }
        }
        .preferredColorScheme(.dark)
    }
}
