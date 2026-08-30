import SwiftUI

@main
struct ClemApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                // The keyboard is drawn by a SEPARATE remote text-input process
                // and takes its appearance from the WINDOW's trait collection,
                // not from the web view's. Setting overrideUserInterfaceStyle on
                // the WKWebView alone therefore leaves a dark keyboard sitting
                // under a light app on a phone in dark mode — reported live.
                // Forcing the style at the window is what the keyboard actually
                // reads. Clem's surface is light-only by design, so this is a
                // statement of that, not a per-view workaround.
                .onAppear { UIWindow.forceLightInterfaceStyle() }
        }
    }
}
