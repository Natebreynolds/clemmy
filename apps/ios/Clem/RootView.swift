import SwiftUI

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
        NavigationStack {
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
        PinnedWebView(model: model)
            .ignoresSafeArea(edges: .bottom)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(role: .destructive) {
                            confirmUnpair = true
                        } label: {
                            Label("Unpair from this Mac", systemImage: "qrcode")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
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
                Text("You'll need to scan a fresh QR code from the desktop Mobile panel to reconnect.")
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
    }
}
