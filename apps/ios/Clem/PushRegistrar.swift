import SwiftUI
import UserNotifications

/// APNs ceremony. The native side asks permission and obtains the device
/// token; delivery of that token to the daemon happens through the PWA's
/// authenticated session (see WebViewModel.deliverApnsToken) so there is
/// exactly one credential path.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let tokenNotification = Notification.Name("clem.apns.token")
    /// Wake signal only. The durable store, not NotificationCenter, is the
    /// source of truth so a cold process or biometric gate cannot lose a tap.
    static let pendingNavigationChanged = Notification.Name("clem.apns.pendingNavigationChanged")

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// Published so a denial can be SHOWN rather than swallowed.
    ///
    /// Notifications are the whole reason this app is in a pocket: they are how
    /// Clem says something needs you while the phone is in a bag. A denied or
    /// revoked permission used to produce exactly nothing — no prompt, no
    /// notice, no log — so the app looked like it was working and simply never
    /// spoke again. Silence is the one failure this product cannot afford to
    /// render as success.
    static let authorizationChanged = Notification.Name("clem.apns.authorizationChanged")

    /// Last known authorization status. `nil` until the first query answers —
    /// UNKNOWN is not DENIED, and the UI must not accuse the user of having
    /// turned something off before it has asked.
    private(set) static var authorizationStatus: UNAuthorizationStatus?

    /// True only when we KNOW the system will not deliver. Never true merely
    /// because the answer has not arrived yet.
    static var notificationsBlocked: Bool {
        guard let status = authorizationStatus else { return false }
        return status == .denied
    }

    /// Re-read the live status. Cheap, and worth doing on every foreground:
    /// the user can revoke permission in Settings while the app is suspended,
    /// and nothing tells the process when they do.
    static func refreshAuthorizationStatus() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                let changed = authorizationStatus != settings.authorizationStatus
                authorizationStatus = settings.authorizationStatus
                if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                    // Re-register every foreground: APNs may hand out a new
                    // token after a restore or an OS upgrade, and a stale token
                    // fails silently on Apple's side.
                    UIApplication.shared.registerForRemoteNotifications()
                }
                if changed { NotificationCenter.default.post(name: authorizationChanged, object: nil) }
            }
        }
    }

    /// Called by RootView once the command center has rendered — asking for
    /// notification permission before showing anything useful is how apps get
    /// reflexively denied.
    static func requestPushAuthorization() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            // Asking again after a denial does NOT re-prompt: iOS answers the
            // saved decision immediately. Record it so the UI can offer the
            // only thing that actually works from here — a trip to Settings.
            guard settings.authorizationStatus == .notDetermined else {
                DispatchQueue.main.async {
                    authorizationStatus = settings.authorizationStatus
                    if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                        UIApplication.shared.registerForRemoteNotifications()
                    }
                    NotificationCenter.default.post(name: authorizationChanged, object: nil)
                }
                return
            }
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
                DispatchQueue.main.async {
                    authorizationStatus = granted ? .authorized : .denied
                    NotificationCenter.default.post(name: authorizationChanged, object: nil)
                    guard granted else { return }
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    /// The only recovery from a denial: the system Settings page for this app.
    static func openSystemNotificationSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(name: Self.tokenNotification, object: nil, userInfo: ["token": hex])
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Non-fatal for the app's other surfaces, but NOT invisible: without a
        // token nothing will ever arrive, and the previous silent return is why
        // "notifications just don't work" had no thread to pull. The status is
        // still whatever the user chose — this failure is APNs-side — so record
        // it as a distinct condition rather than overwriting their decision.
        NSLog("clem: APNs registration failed — remote notifications will not arrive: \(error.localizedDescription)")
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Self.authorizationChanged, object: nil)
        }
    }

    /// Foreground pushes still show — the whole point is surfacing approvals.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    /// Tap → deep link. The daemon puts the exact Inbox context path in the
    /// payload's `url` field (same field the web push payload uses).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let path = response.notification.request.content.userInfo["url"] as? String,
              let fingerprint = PairingStore.load()?.fingerprint,
              PendingPushNavigationStore.park(
                  path: path,
                  pairingFingerprint: fingerprint
              ) else {
            return
        }

        // UNUserNotificationCenter may invoke its delegate off-main. SwiftUI's
        // publisher is a wake-up optimization only, but still deliver it on the
        // main queue; the persisted envelope covers any subscriber race.
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Self.pendingNavigationChanged, object: nil)
        }
    }
}
