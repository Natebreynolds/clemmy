import SwiftUI

/// Warm near-black behind everything — matches the web UI's --bg-0 so the
/// native shell is invisible: no white band, no flash while loading.
private let paper = Color(red: 252 / 255, green: 249 / 255, blue: 244 / 255)

struct RootView: View {
    @State private var model: WebViewModel?
    /// Set only right after a scan — carries the one-time ?pair= token.
    @State private var launchURL: URL?
    @State private var confirmUnpair = false
    @State private var searching = false
    @StateObject private var gate = BiometricGate()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        if let pairing = PairingStore.load() {
            _model = State(initialValue: WebViewModel(pairing: pairing))
        }
    }

    var body: some View {
        ZStack {
            paper.ignoresSafeArea()
            if let model {
                // The gate wraps the paired experience only. Scanning a QR is
                // itself a physical act at the Mac, and requiring Face ID
                // before the camera would just be a step in front of a step.
                if gate.unlocked {
                    CommandCenterView(
                        model: model,
                        launchURL: launchURL,
                        searching: $searching,
                        confirmUnpair: $confirmUnpair,
                        onUnpair: unpair
                    )
                } else {
                    LockScreen(gate: gate)
                        .onAppear { gate.authenticate() }
                }
            } else {
                ScannerScreen { newPairing, newLaunchURL in
                    // A handoff belongs to one exact paired daemon. Never
                    // carry a credential from the previous pairing into the
                    // newly scanned origin.
                    OriginHandoffStore.clear()
                    PendingPushNavigationStore.clear()
                    PairingStore.save(newPairing)
                    launchURL = newLaunchURL
                    model = WebViewModel(pairing: newPairing)
                    // A fresh pair is a deliberate in-person act; unlock it
                    // rather than demanding a second proof immediately.
                    gate.authenticate()
                }
            }
        }
        // iOS photographs the app as it leaves the foreground, and that image
        // lives in the task switcher. Covering the UI the moment we go
        // inactive keeps the conversation out of that snapshot.
        .overlay {
            if scenePhase != .active {
                ZStack {
                    paper.ignoresSafeArea()
                    Image(systemName: "lock.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(Color(red: 1, green: 0.54, blue: 0.24).opacity(0.85))
                }
                .transition(.opacity)
            }
        }
        .preferredColorScheme(.light)
        .onAppear { synchronizePendingNavigationDelivery() }
        .onChange(of: gate.unlocked) { _, _ in
            synchronizePendingNavigationDelivery()
        }
        .onReceive(
            NotificationCenter.default.publisher(for: AppDelegate.pendingNavigationChanged)
        ) { _ in
            // The signal may arrive while Face ID is covering the app. In that
            // case this disables delivery and leaves the persisted intent for
            // the successful unlock transition above.
            synchronizePendingNavigationDelivery()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            // .inactive fires before the app is visible in the switcher, so
            // locking here keeps the transcript out of the task snapshot.
            case .inactive, .background:
                // Stop pending deep links before the gate/scene transition. A
                // page finishing behind the privacy cover must not drain one.
                model?.setPendingPushNavigationAllowed(false)
                model?.setConnectionRouteReady(false)
                gate.noteBackgrounded()
            case .active:
                gate.noteForegrounded()
                synchronizePendingNavigationDelivery()
            @unknown default: break
            }
        }
    }

    private func unpair() {
        OriginHandoffStore.clear()
        PendingPushNavigationStore.clear()
        PairingStore.clear()
        launchURL = nil
        model = nil
    }

    private func synchronizePendingNavigationDelivery() {
        let allowed = scenePhase == .active && gate.unlocked
        model?.setPendingPushNavigationAllowed(allowed)
    }
}

private struct CommandCenterView: View {
    @ObservedObject var model: WebViewModel
    let launchURL: URL?
    @Binding var searching: Bool
    @Binding var confirmUnpair: Bool
    let onUnpair: () -> Void

    @State private var rediscovery = Rediscovery()
    @StateObject private var connectionCoordinator = ConnectionCoordinator()
    @State private var reconnectGate = ReconnectAttemptGate()
    @State private var initialNavigationStarted = false
    @State private var relayRetryAttempt = 0
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        // Full-bleed: the web layer owns the header, tabs, and safe-area
        // padding (env(safe-area-inset-*)), so the shell adds no chrome at
        // all. Unpair — a rare recovery action — lives on shake.
        PinnedWebView(model: model)
            .ignoresSafeArea()
            .overlay {
                if !model.hasLoadedOnce {
                    InitialConnectionCover(
                        state: initialConnectionState,
                        canRetry: connectionCoordinator.currentKind?.isReachable == true,
                        onRetry: retryInitialConnection,
                        onRepair: { confirmUnpair = true }
                    )
                } else if searching {
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
                // A persisted push must wait for this foreground's path probe
                // instead of racing the initial Home/relay navigation.
                model.setConnectionRouteReady(false)
                connectionCoordinator.start { update in
                    handlePathUpdate(update)
                }
            }
            .onDisappear {
                reconnectGate.cancel()
                initialNavigationStarted = false
                connectionCoordinator.stop()
                model.setConnectionRouteReady(false)
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
                guard connectionCoordinator.currentKind != .unavailable else { return }
                let preferRelay = connectionCoordinator.currentKind?.prefersRelay == true
                if preferRelay {
                    // Public relay hosts skip URLSession (ATS would veto the
                    // Mac's self-signed cert before the pin). WKWebView is the
                    // proof; a failed navigation must back off instead of
                    // re-entering the ladder on the same run loop.
                    scheduleRelayRetry(afterGeneration: reconnectGate.generation)
                    return
                }
                reconnect(preferRelay: false)
            }
            .onChange(of: scenePhase) { _, phase in
                // A cached web shell can resume successfully while still
                // pointing at yesterday's LAN address. Foregrounding is a
                // transport boundary, so re-probe instead of waiting for an
                // unbounded fetch timeout to notice.
                guard phase == .active,
                      let kind = connectionCoordinator.currentKind,
                      kind.isReachable else { return }
                reconnect(preferRelay: kind.prefersRelay)
            }
            .onReceive(NotificationCenter.default.publisher(for: AppDelegate.tokenNotification)) { note in
                if let token = note.userInfo?["token"] as? String {
                    model.deliverApnsToken(token)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .deviceDidShake)) { _ in
                confirmUnpair = true
            }
            .onReceive(NotificationCenter.default.publisher(for: .repairRequested)) { _ in
                // The web login screen's "Scan a new QR code" — same confirmed
                // unpair as the shake gesture, just discoverable.
                confirmUnpair = true
            }
    }

    private var initialConnectionState: InitialConnectionState {
        if model.certificatePinFailed { return .safetyCheckChanged }
        if model.connectionLost, !searching { return .offline }
        return .looking
    }

    private func retryInitialConnection() {
        guard let kind = connectionCoordinator.currentKind, kind.isReachable else { return }
        reconnect(preferRelay: kind.prefersRelay)
    }

    /// The reconnect ladder, cheapest and most private first:
    ///   1. a known origin that answers right now (LAN, or the relay if that
    ///      is where we already are),
    ///   2. Bonjour — the Mac moved to a new LAN address,
    ///   3. the relay — we are off the LAN entirely.
    /// Every rung enforces the same certificate pin, so "which door" never
    /// widens what the app trusts.
    private func handlePathUpdate(_ update: ConnectionPathUpdate) {
        guard update.kind.isReachable else {
            reconnectGate.cancel()
            searching = false
            model.setConnectionRouteReady(false)
            model.connectionLost = true
            return
        }
        if !initialNavigationStarted {
            initialNavigationStarted = true
            // A fresh QR must be redeemed at its exact LAN URL. On an ordinary
            // cold launch, however, do not even start a dead RFC1918 request
            // when iOS already says the phone is on cellular.
            if let launchURL, !model.hasLoadedOnce {
                model.load(launchURL)
            } else if update.kind.prefersRelay {
                reconnect(preferRelay: true)
            } else if let home = model.pairing.homeURL {
                model.load(home)
            }
            return
        }
        // Every later path transition is an explicit reason to choose the
        // right door now; no failed WK navigation is required first.
        reconnect(preferRelay: update.kind.prefersRelay)
    }

    private func reconnect(preferRelay: Bool, resetBackoff: Bool = true) {
        if resetBackoff { relayRetryAttempt = 0 }
        let pairing = model.pairing
        // RFC1918 probes and Bonjour cannot succeed on a cellular path;
        // spending their timeouts first is why remote access felt dead.
        let kind: ConnectionPathKind = preferRelay ? .cellular : .wifi
        guard let generation = reconnectGate.begin(kind) else { return }
        model.setConnectionRouteReady(false)
        searching = true
        let candidates = ConnectionRoutePolicy.candidates(for: kind, pairing: pairing)
        RelayDiscovery.firstReachable(candidates, fingerprint: pairing.fingerprint) { reachable in
            guard reconnectGate.isCurrent(generation) else { return }
            if let reachable {
                relayRetryAttempt = 0
                _ = reconnectGate.finish(generation)
                searching = false
                model.adoptOrigin(reachable, isLan: reachable != pairing.relayOrigin)
                if reachable != pairing.relayOrigin {
                    refreshRelayOrigin(from: reachable)
                }
                return
            }
            if preferRelay {
                _ = reconnectGate.finish(generation)
                searching = false
                scheduleRelayRetry(afterGeneration: generation)
                return
            }
            guard let fp = pairing.fingerprint else {
                _ = reconnectGate.finish(generation)
                searching = false
                return
            }
            rediscovery = Rediscovery()
            rediscovery.findMac(fingerprint: fp) { origin in
                guard reconnectGate.isCurrent(generation) else { return }
                if let origin {
                    _ = reconnectGate.finish(generation)
                    searching = false
                    model.adoptOrigin(origin)
                    refreshRelayOrigin(from: origin)
                    return
                }
                guard let relay = pairing.relayOrigin else {
                    _ = reconnectGate.finish(generation)
                    searching = false
                    return
                }
                RelayDiscovery.probe(origin: relay, fingerprint: fp, timeout: 8) { ok in
                    guard reconnectGate.isCurrent(generation) else { return }
                    _ = reconnectGate.finish(generation)
                    searching = false
                    if ok { model.adoptOrigin(relay, isLan: false) }
                }
            }
        }
    }

    private func scheduleRelayRetry(afterGeneration generation: Int) {
        // A path transition is only an edge; iOS will not emit another
        // "cellular" event when a briefly unavailable relay recovers. Keep a
        // single fenced health probe alive, backing off to 30 seconds, until a
        // path/foreground event supersedes it or the relay answers.
        let exponent = min(relayRetryAttempt, 4)
        let delay = min(30.0, pow(2.0, Double(exponent)))
        relayRetryAttempt = min(relayRetryAttempt + 1, 5)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard generation == reconnectGate.generation,
                  reconnectGate.activeIntent == nil,
                  scenePhase == .active,
                  connectionCoordinator.currentKind?.prefersRelay == true else { return }
            reconnect(preferRelay: true, resetBackoff: false)
        }
    }

    private func refreshRelayOrigin(from origin: String) {
        RelayDiscovery.fetchRelayOrigin(
            from: origin,
            fingerprint: model.pairing.fingerprint
        ) { relay in
            if let relay { model.rememberRelayOrigin(relay) }
        }
    }
}

private enum InitialConnectionState {
    case looking
    case offline
    case safetyCheckChanged
}

private struct InitialConnectionCover: View {
    let state: InitialConnectionState
    let canRetry: Bool
    let onRetry: () -> Void
    let onRepair: () -> Void

    var body: some View {
        VStack(spacing: 22) {
            ContentUnavailableView {
                Label(title, systemImage: systemImage)
            } description: {
                Text(message)
            }

            switch state {
            case .looking:
                ProgressView()
                    .controlSize(.large)
                    .accessibilityLabel("Looking for your Mac")
            case .offline:
                Button("Try Again", systemImage: "arrow.clockwise", action: onRetry)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!canRetry)
            case .safetyCheckChanged:
                Button("Pair Again", systemImage: "qrcode.viewfinder", action: onRepair)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(paper)
        .tint(Color(red: 1, green: 0.45, blue: 0.16))
    }

    private var title: String {
        switch state {
        case .looking: return "Looking for your Mac"
        case .offline: return "Clem is offline"
        case .safetyCheckChanged: return "Safety check changed"
        }
    }

    private var systemImage: String {
        switch state {
        case .looking: return "network"
        case .offline: return "wifi.slash"
        case .safetyCheckChanged: return "exclamationmark.shield.fill"
        }
    }

    private var message: String {
        switch state {
        case .looking:
            return "Checking your saved Mac and its secure relay."
        case .offline:
            return "Clem can’t reach your Mac right now. Keep the Mac awake and check this phone’s connection."
        case .safetyCheckChanged:
            return "This Mac’s security fingerprint no longer matches the one you paired with. Scan a fresh QR code before reconnecting."
        }
    }
}

// ── shake detection ──────────────────────────────────────────────────

extension Notification.Name {
    static let deviceDidShake = Notification.Name("clem.deviceDidShake")
    /// The web layer asked for the pairing scanner (login screen's re-pair button).
    static let repairRequested = Notification.Name("clem.repairRequested")
}

extension UIWindow {
    /// Force every live window to light.
    ///
    /// The on-screen keyboard is rendered by a separate remote text-input
    /// process that reads the WINDOW's trait collection. A web view that
    /// overrides its own style does not reach it, which is why a phone in dark
    /// mode kept showing a dark keyboard under Clem's light surface. Applying it
    /// at the window is the level the keyboard actually observes.
    static func forceLightInterfaceStyle() {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                window.overrideUserInterfaceStyle = .light
            }
        }
    }

    open override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake {
            NotificationCenter.default.post(name: .deviceDidShake, object: nil)
        }
        super.motionEnded(motion, with: event)
    }
}
