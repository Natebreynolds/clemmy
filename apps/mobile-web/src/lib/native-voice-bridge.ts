import { api } from './api';

export interface NativeVoiceProvisioningRequest {
  /** Secret random correlation ID. Never log or put in a URL. */
  requestId: string;
  publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}
interface NativeVoiceCredential {
  requestId: string; keyThumbprint: string; token: string;
  sessionFingerprint: string; deviceId: string; expiresAt: string;
}
type VoiceBridge = NonNullable<Window['clemNative']> & {
  prepareVoice?: (request: NativeVoiceProvisioningRequest) => void;
};

/** Install only after authenticated native readiness. Late responses from a
 * removed bridge cannot provision a different login or pairing. */
export function installNativeVoiceBridge(): () => void {
  const handler = window.webkit?.messageHandlers?.clemNativeVoiceSession;
  if (!handler || !window.clemNative) return () => undefined;
  const bridge = window.clemNative as VoiceBridge;
  const previous = bridge.prepareVoice;
  let active = true;
  const pending = new Map<string, AbortController>();
  const post = (body: unknown) => { try { handler.postMessage(body); } catch { /* Native will retry this exact enrollment. */ } };
  const prepare = (request: NativeVoiceProvisioningRequest) => {
    if (!active || !request || !/^[A-Za-z0-9_-]{43}$/.test(request.requestId)
      || request.publicKeyJwk?.kty !== 'EC' || request.publicKeyJwk?.crv !== 'P-256'
      || !/^[A-Za-z0-9_-]{43}$/.test(request.publicKeyJwk.x)
      || !/^[A-Za-z0-9_-]{43}$/.test(request.publicKeyJwk.y) || pending.has(request.requestId)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    pending.set(request.requestId, controller);
    void api<NativeVoiceCredential>('/m/auth/native-voice-session', {
      method: 'POST', signal: controller.signal,
      body: JSON.stringify({ requestId: request.requestId, publicKeyJwk: request.publicKeyJwk }),
    }).then(credential => {
      if (!active || controller.signal.aborted) return;
      if (credential.requestId !== request.requestId) throw new Error('NATIVE_RECEIPT_MISMATCH');
      post({ ...credential, ok: true });
    }).catch(() => {
      if (active) post({ requestId: request.requestId, ok: false,
        error: 'Native voice could not connect. Open Clem and try again.' });
    }).finally(() => { clearTimeout(timeout); pending.delete(request.requestId); });
  };
  bridge.prepareVoice = prepare;
  try { window.webkit?.messageHandlers?.clemNativeVoiceReady?.postMessage(true); } catch { /* Setup can retry when native is ready. */ }
  return () => {
    active = false;
    for (const request of pending.values()) request.abort();
    pending.clear();
    if (bridge.prepareVoice === prepare) bridge.prepareVoice = previous;
  };
}
