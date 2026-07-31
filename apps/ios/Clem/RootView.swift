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
                guard loaded else { return }
                AppDelegate.requestPushAuthorization()
                // Learn the off-LAN door from whichever door just worked, so
                // pairings made before the relay existed gain remote access
                // without re-scanning anything.
                RelayDiscovery.fetchRelayOrigin(
                    from: model.pairing.origin,
                    fingerprint: model.pairing.fingerprint
                ) { relay in
                    if let relay { model.rememberRelayOrigin(relay) }
                }
            }
            .onChange(of: model.connectionLost) { _, lost in
                guard lost, !searching else { return }
                searching = true
                reconnect()
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

    /// The reconnect ladder, cheapest and most private first:
    ///   1. a known origin that answers right now (LAN, or the relay if that
    ///      is where we already are),
    ///   2. Bonjour — the Mac moved to a new LAN address,
    ///   3. the relay — we are off the LAN entirely.
    /// Every rung enforces the same certificate pin, so "which door" never
    /// widens what the app trusts.
    private func reconnect() {
        let pairing = model.pairing
        RelayDiscovery.firstReachable(pairing.candidateOrigins, fingerprint: pairing.fingerprint) { reachable in
            if let reachable {
                searching = false
                model.adoptOrigin(reachable, isLan: reachable != pairing.relayOrigin)
                return
            }
            guard let fp = pairing.fingerprint else {
                searching = false
                return
            }
            rediscovery = Rediscovery()
            rediscovery.findMac(fingerprint: fp) { origin in
                if let origin {
                    searching = false
                    model.adoptOrigin(origin)
                    return
                }
                guard let relay = pairing.relayOrigin else {
                    searching = false
                    return
                }
                RelayDiscovery.probe(origin: relay, fingerprint: fp, timeout: 8) { ok in
                    searching = false
                    if ok { model.adoptOrigin(relay, isLan: false) }
                }
            }
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
