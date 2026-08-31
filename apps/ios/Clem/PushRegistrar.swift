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

    /// Called by RootView once the command center has rendered — asking for
    /// notification permission before showing anything useful is how apps get
    /// reflexively denied.
    static func requestPushAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(name: Self.tokenNotification, object: nil, userInfo: ["token": hex])
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Non-fatal: the app works fully without push; registration retries
        // next launch via requestPushAuthorization().
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
