import SwiftUI

/// Warm near-black behind everything — matches the web UI's --bg-0 so the
/// native shell is invisible: no white band, no flash while loading.
private let peelBlack = Color(red: 12 / 255, green: 9 / 255, blue: 6 / 255)

struct RootView: View {
    @State private var model: WebViewModel?
    /// Set only right after a scan — carries the one-time ?pair= token.
    @State private var launchURL: URL?
    @State private var confirmUnpair = false
    @State private var searching = false

    init() {
        if let pairing = PairingStore.load() {
            _model = State(initialValue: WebViewModel(pairing: pairing))
        }
    }

    var body: some View {
        ZStack {
            peelBlack.ignoresSafeArea()
            if let model {
                CommandCenterView(
                    model: model,
                    launchURL: launchURL,
                    searching: $searching,
                    confirmUnpair: $confirmUnpair,
                    onUnpair: unpair
                )
            } else {
                ScannerScreen { newPairing, newLaunchURL in
                    PairingStore.save(newPairing)
                    launchURL = newLaunchURL
                    model = WebViewModel(pairing: newPairing)
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func unpair() {
        PairingStore.clear()
        launchURL = nil
        model = nil
    }
}

private struct CommandCenterView: View {
    @ObservedObject var model: WebViewModel
    let launchURL: URL?
    @Binding var searching: Bool
    @Binding var confirmUnpair: Bool
    let onUnpair: () -> Void

    @State private var rediscovery = Rediscovery()

    var body: some View {
        // Full-bleed: the web layer owns the header, tabs, and safe-area
        // padding (env(safe-area-inset-*)), so the shell adds no chrome at
        // all. Unpair — a rare recovery action — lives on shake.
        PinnedWebView(model: model)
            .ignoresSafeArea()
            .overlay {
                if searching {
                    VStack(spacing: 10) {
                        ProgressView()
                        Text("Looking for your Mac on the network…")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(20)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                }
            }
            .confirmationDialog(
                "Unpair from this Mac?",
                isPresented: $confirmUnpair,
                titleVisibility: .visible
            ) {
                Button("Unpair", role: .destructive) { onUnpair() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You'll scan a fresh QR code from the desktop Mobile panel to reconnect.")
            }
            .onAppear {
                model.load(launchURL ?? model.pairing.homeURL!)
            }
            .onChange(of: model.hasLoadedOnce) { _, loaded in
                if loaded { AppDelegate.requestPushAuthorization() }
            }
            .onChange(of: model.connectionLost) { _, lost in
                guard lost, !searching, let fp = model.pairing.fingerprint else { return }
                searching = true
                rediscovery = Rediscovery()
                rediscovery.findMac(fingerprint: fp) { origin in
                    searching = false
                    if let origin {
                        model.adoptOrigin(origin)
                    }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: AppDelegate.tokenNotification)) { note in
                if let token = note.userInfo?["token"] as? String {
                    model.deliverApnsToken(token)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: AppDelegate.openPathNotification)) { note in
                if let path = note.userInfo?["path"] as? String {
                    model.openPath(path)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .deviceDidShake)) { _ in
                confirmUnpair = true
            }
    }
}

// ── shake detection ──────────────────────────────────────────────────

extension Notification.Name {
    static let deviceDidShake = Notification.Name("clem.deviceDidShake")
}

extension UIWindow {
    open override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake {
            NotificationCenter.default.post(name: .deviceDidShake, object: nil)
        }
        super.motionEnded(motion, with: event)
    }
}
