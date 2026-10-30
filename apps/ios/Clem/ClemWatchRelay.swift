import Foundation
import WatchConnectivity

/// The Watch gets bounded request/result data, never a phone session, API key,
/// Mac origin or certificate. The phone keeps exact task receipts privately.
final class ClemWatchRelay: NSObject, WCSessionDelegate {
    static let shared = ClemWatchRelay()
    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        guard let packet = Self.packet(message) else {
            replyHandler(["version": 1, "requestId": message["requestId"] as? String ?? "", "status": "failed", "spokenText": "That Watch request is not supported."])
            return
        }
        let delivery = ClemQuickVoiceDelivery.capture()
        Task {
            let result = await ClemQuickVoiceService.shared.dialog(packet)
            let response = ClemQuickVoiceDelivery.fence(result, captured: delivery)
            replyHandler(response.dictionary)
        }
    }
    static func packet(_ value: [String: Any]) -> ClemQuickVoicePacket? {
        guard Set(value.keys).isSubset(of: ["version", "operation", "requestId", "text", "conversationId"]),
              let version = value["version"] as? Int, version == 1,
              let raw = value["operation"] as? String, let operation = ClemQuickVoicePacket.Operation(rawValue: raw),
              let id = value["requestId"] as? String,
              value["text"] == nil || value["text"] is String,
              value["conversationId"] == nil || value["conversationId"] is String else { return nil }
        let packet = ClemQuickVoicePacket(version: version, operation: operation, requestId: id,
            text: value["text"] as? String, conversationId: value["conversationId"] as? String)
        return packet.valid ? packet : nil
    }
}
