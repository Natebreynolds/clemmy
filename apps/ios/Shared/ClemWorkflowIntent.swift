import AppIntents
import Foundation

/// Included in both targets. WidgetKit runs an openAppWhenRun intent in the
/// app process; the extension has no launch authority or paired credentials.
@available(iOS 17.0, *)
struct RunClemWorkflowIntent: AppIntent {
    static var title: LocalizedStringResource = "Run a pinned Clem workflow"
    static var description = IntentDescription("Open Clem and run a pinned workflow when it is ready. Required inputs and approvals still apply.")
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "Workflow") var slug: String

    init() { slug = "" }
    init(slug: String) { self.slug = slug }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if CLEM_WIDGET_EXTENSION
        throw ClemWorkflowIntentError.openClem
        #else
        guard let fingerprint = PairingStore.load()?.fingerprint, !fingerprint.isEmpty else {
            throw ClemWorkflowIntentError.openClem
        }
        guard let workflow = ClemWidgetWorkflowStore.shared.load().first(where: { $0.slug == slug }) else {
            throw ClemWorkflowIntentError.notPinned
        }
        let id = UUID()
        let launches = PendingWidgetWorkflowLaunchRepository.shared
        guard launches.park(slug: slug, pairingFingerprint: fingerprint, navigationID: id) else {
            throw ClemWorkflowIntentError.unavailable
        }
        guard PendingWidgetNavigationRepository.shared.park(url: workflow.url, pairingFingerprint: fingerprint, id: id) else {
            launches.clear()
            throw ClemWorkflowIntentError.unavailable
        }
        PendingPushNavigationStore.clear()
        NotificationCenter.default.post(name: AppDelegate.pendingNavigationChanged, object: nil)
        #endif
        return .result()
    }
}

private enum ClemWorkflowIntentError: LocalizedError {
    case openClem, notPinned, unavailable
    var errorDescription: String? {
        switch self {
        case .openClem: return "Open Clem and connect to your Mac, then try the widget again."
        case .notPinned: return "This workflow is no longer pinned. Open Clem to choose it again."
        case .unavailable: return "Clem could not prepare this run. Open the workflow and try again."
        }
    }
}
