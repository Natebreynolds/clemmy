import AVFoundation
import SwiftUI
import UIKit

/// Pairing screen: live camera QR scan, with a paste-the-link fallback for
/// the Simulator (no camera) and for setups where the Mac is remote-desktop'd.
struct ScannerScreen: View {
    let onPaired: (Pairing, URL) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var manualEntry = ""
    @State private var errorMessage: String?
    @State private var cameraDenied = false
    @State private var cameraUnavailable = false
    @AccessibilityFocusState private var errorIsFocused: Bool

    private let paper = Color(red: 252 / 255, green: 249 / 255, blue: 244 / 255)

    var body: some View {
        ZStack {
            paper.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 16) {
                    Text("Pair with your Mac")
                        .font(.title2.bold())
                        .multilineTextAlignment(.center)
                        .padding(.top, 24)
                    Text("Open Clementine's Mobile panel on your Mac and scan the QR code.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)

                    cameraContent

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(Color(red: 0.65, green: 0.08, blue: 0.08))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                            .accessibilityLabel("Pairing error: \(errorMessage)")
                            .accessibilityFocused($errorIsFocused)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Or use a pairing link")
                            .font(.headline)
                        TextField("Paste the pairing link", text: $manualEntry)
                            .textFieldStyle(.roundedBorder)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.go)
                            .frame(minHeight: 44)
                            .accessibilityLabel("Pairing link")
                            .accessibilityHint("Paste the pairing link shown by Clementine on your Mac.")
                            .onSubmit(pairManualEntry)
                        Button("Pair") { pairManualEntry() }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.large)
                            .frame(maxWidth: .infinity)
                            .disabled(!canPairManually)
                    }
                    .padding(.horizontal)
                    .padding(.top, 8)
                    .padding(.bottom, 24)
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .preferredColorScheme(.light)
        .onChange(of: scenePhase) { _, newPhase in
            // Recreate the camera after returning from Settings so a newly
            // granted permission takes effect without relaunching Clem.
            if newPhase == .active, cameraDenied {
                cameraDenied = false
            }
        }
    }

    @ViewBuilder
    private var cameraContent: some View {
        if cameraDenied {
            VStack(spacing: 8) {
                ContentUnavailableView(
                    "Camera access is off",
                    systemImage: "camera.fill",
                    description: Text("Enable the camera for Clem in Settings, or paste the pairing link below.")
                )
                Button("Open Settings", systemImage: "gear") {
                    guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else { return }
                    openURL(settingsURL)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .accessibilityHint("Opens Settings so you can allow Clem to use the camera.")
            }
            .padding(.horizontal)
        } else if cameraUnavailable {
            ContentUnavailableView(
                "Camera unavailable",
                systemImage: "camera.fill",
                description: Text("Paste the pairing link shown by Clementine on your Mac below.")
            )
            .padding(.horizontal)
        } else {
            QRCameraView { payload in
                handle(payload)
            } onDenied: {
                cameraDenied = true
            } onUnavailable: {
                cameraUnavailable = true
            }
            .frame(height: cameraPreviewHeight)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .padding(.horizontal)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("QR code scanner")
            .accessibilityHint("Point the camera at the pairing QR code shown on your Mac.")
        }
    }

    private var cameraPreviewHeight: CGFloat {
        dynamicTypeSize.isAccessibilitySize || verticalSizeClass == .compact ? 200 : 340
    }

    private var canPairManually: Bool {
        !manualEntry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func pairManualEntry() {
        guard canPairManually else { return }
        handle(manualEntry)
    }

    private func handle(_ payload: String) {
        errorIsFocused = false
        do {
            let (pairing, launchURL) = try PairingParser.parse(payload)
            errorMessage = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onPaired(pairing, launchURL)
        } catch {
            errorMessage = error.localizedDescription
            // Wait until the error text is in the hierarchy before moving
            // VoiceOver focus to it. This also re-announces repeated errors.
            Task { @MainActor in
                errorIsFocused = true
            }
        }
    }
}

/// Thin AVFoundation wrapper. Fires `onCode` once per distinct QR payload so a
/// steady camera pointed at the screen doesn't spam the handler.
struct QRCameraView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onDenied: () -> Void
    let onUnavailable: () -> Void

    func makeUIViewController(context: Context) -> QRCameraController {
        let controller = QRCameraController()
        controller.onCode = onCode
        controller.onDenied = onDenied
        controller.onUnavailable = onUnavailable
        return controller
    }

    func updateUIViewController(_ uiViewController: QRCameraController, context: Context) {}
}

final class QRCameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onDenied: (() -> Void)?
    var onUnavailable: (() -> Void)?

    private let session = AVCaptureSession()
    private var lastPayload: String?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var previewRotationObservation: NSKeyValueObservation?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                granted ? self.configureSession() : self.onDenied?()
            }
        }
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            onUnavailable?()
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            onUnavailable?()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: preview)
        rotationCoordinator = coordinator
        previewRotationObservation = coordinator.observe(
            \.videoRotationAngleForHorizonLevelPreview,
            options: [.initial, .new]
        ) { [weak preview] _, change in
            guard let angle = change.newValue,
                  let connection = preview?.connection,
                  connection.isVideoRotationAngleSupported(angle) else { return }
            connection.videoRotationAngle = angle
        }

        DispatchQueue.global(qos: .userInitiated).async { [session] in
            session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        session.stopRunning()
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let payload = object.stringValue,
              payload != lastPayload else { return }
        lastPayload = payload
        onCode?(payload)
    }
}
