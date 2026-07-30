import AVFoundation
import SwiftUI

/// Pairing screen: live camera QR scan, with a paste-the-link fallback for
/// the Simulator (no camera) and for setups where the Mac is remote-desktop'd.
struct ScannerScreen: View {
    let onPaired: (Pairing, URL) -> Void

    @State private var manualEntry = ""
    @State private var errorMessage: String?
    @State private var cameraDenied = false

    var body: some View {
        VStack(spacing: 16) {
            Text("Pair with your Mac")
                .font(.title2.bold())
                .padding(.top, 24)
            Text("Open Clementine's Mobile panel on your Mac and scan the QR code.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            if cameraDenied {
                ContentUnavailableView(
                    "Camera access is off",
                    systemImage: "camera.fill",
                    description: Text("Enable the camera for Clem in Settings, or paste the pairing link below.")
                )
                .frame(maxHeight: 280)
            } else {
                QRCameraView { payload in
                    handle(payload)
                } onDenied: {
                    cameraDenied = true
                }
                .frame(maxHeight: 380)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .padding(.horizontal)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            Spacer()

            VStack(spacing: 8) {
                TextField("…or paste the pairing link", text: $manualEntry)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Pair") { handle(manualEntry) }
                    .buttonStyle(.borderedProminent)
                    .disabled(manualEntry.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding([.horizontal, .bottom])
        }
    }

    private func handle(_ payload: String) {
        do {
            let (pairing, launchURL) = try PairingParser.parse(payload)
            errorMessage = nil
            onPaired(pairing, launchURL)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Thin AVFoundation wrapper. Fires `onCode` once per distinct QR payload so a
/// steady camera pointed at the screen doesn't spam the handler.
struct QRCameraView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onDenied: () -> Void

    func makeUIViewController(context: Context) -> QRCameraController {
        let controller = QRCameraController()
        controller.onCode = onCode
        controller.onDenied = onDenied
        return controller
    }

    func updateUIViewController(_ uiViewController: QRCameraController, context: Context) {}
}

final class QRCameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onDenied: (() -> Void)?

    private let session = AVCaptureSession()
    private var lastPayload: String?

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
            onDenied?()
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)

        DispatchQueue.global(qos: .userInitiated).async { [session] in
            session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.sublayers?.first { $0 is AVCaptureVideoPreviewLayer }?.frame = view.bounds
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
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onCode?(payload)
    }
}
