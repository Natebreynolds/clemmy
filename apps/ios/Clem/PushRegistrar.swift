import SwiftUI
import UserNotifications

/// APNs ceremony. The native side asks permission and obtains the device
/// token; delivery of that token to the daemon happens through the PWA's
/// authenticated session (see WebViewModel.deliverApnsToken) so there is
/// exactly one credential path.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let tokenNotification = Notification.Name("clem.apns.token")
    static let openPathNotification = Notification.Name("clem.apns.openPath")

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

    /// Tap → deep link. The daemon puts a path like "/m/?tab=inbox" in the
    /// payload's `url` field (same field the web push payload uses).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let path = response.notification.request.content.userInfo["url"] as? String {
            NotificationCenter.default.post(name: Self.openPathNotification, object: nil, userInfo: ["path": path])
        }
        completionHandler()
    }
}
