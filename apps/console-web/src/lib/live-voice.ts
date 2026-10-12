/**
 * Live voice: this device's side of a full-duplex conversation with Clem.
 *
 * The microphone and the voice travel over WebRTC between this device and the
 * voice service; the daemon only exchanges the connection offer, so the key
 * stays on the computer. The conversation itself (requests, Clem's replies)
 * is the shared live voice protocol.
 */
import { LiveVoiceProtocol, type LiveHistoryMessage, type LiveVoiceHandlers, type LiveVoiceLink } from '@clem/chat-engine';
import { getAuthToken } from './bootstrap';

export type { LiveHistoryMessage, LiveVoiceHandlers, LiveVoiceLink } from '@clem/chat-engine';
export { liveSpokenText } from '@clem/chat-engine';

const CLOSE_TIMEOUT_MS = 6_000;
const ICE_TIMEOUT_MS = 10_000;

/** A live voice session over WebRTC in this page. */
export class WebRtcLiveVoice implements LiveVoiceLink {
  private readonly protocol: LiveVoiceProtocol;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private released = false;

  constructor(handlers: LiveVoiceHandlers, private readonly sessionUrl = '/api/console/voice/live-session') {
    this.protocol = new LiveVoiceProtocol({
      ...handlers,
      onClosed: (reason, expected) => { this.release(); handlers.onClosed(reason, expected); },
    });
  }

  async start(history: readonly LiveHistoryMessage[]): Promise<void> {
    const peer = new RTCPeerConnection();
    this.peer = peer;
    const audio = new Audio();
    audio.autoplay = true;
    this.audio = audio;
    peer.addEventListener('track', (event) => {
      audio.srcObject = new MediaStream([event.track]);
      void audio.play().catch(() => undefined);
    });
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.protocol.transportClosed();
    });
    try {
      this.microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      for (const track of this.microphone.getAudioTracks()) peer.addTrack(track, this.microphone);
      // The event channel exists before the offer so the offer carries it.
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;
      channel.addEventListener('message', ({ data }) => {
        try { this.protocol.receive(JSON.parse(String(data))); } catch { /* not an event */ }
      });
      channel.addEventListener('close', () => this.protocol.transportClosed());
      this.protocol.attach(event => { if (channel.readyState === 'open') channel.send(JSON.stringify(event)); });
      await peer.setLocalDescription(await peer.createOffer());
      await iceGathered(peer);
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('This device could not prepare a voice connection.');
      const token = getAuthToken();
      const res = await fetch(`${this.sessionUrl}${token ? `?token=${encodeURIComponent(token)}` : ''}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sdp, history }),
      });
      const payload = await res.json().catch(() => ({})) as { sdp?: string; error?: string; code?: string };
      if (!res.ok || !payload.sdp) throw new LiveVoiceStartError(payload.error || `Live voice could not start (HTTP ${res.status}).`, payload.code);
      await peer.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
    } catch (error) {
      this.release();
      throw error;
    }
  }

  say(text: string, requestId: string | null): void { this.protocol.say(text, requestId); }
  note(text: string, requestId: string | null): void { this.protocol.note(text, requestId); }
  direct(text: string): void { this.protocol.direct(text); }

  /** End gracefully: the service confirms, then the microphone and connection
   *  are released. A session that never confirms is released anyway. */
  close(): void {
    if (this.released) return;
    // Stop hearing the owner at once; the confirmation only settles usage.
    for (const track of this.microphone?.getTracks() ?? []) track.enabled = false;
    if (!this.protocol.close()) { this.release(); return; }
    this.closeTimer = setTimeout(() => this.protocol.transportClosed(), CLOSE_TIMEOUT_MS);
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    for (const track of this.microphone?.getTracks() ?? []) track.stop();
    try { this.channel?.close(); } catch { /* already closed */ }
    try { this.peer?.close(); } catch { /* already closed */ }
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    this.microphone = null; this.channel = null; this.peer = null; this.audio = null;
  }
}

export class LiveVoiceStartError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

function iceGathered(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', check); reject(new Error('The voice connection took too long to prepare.')); }, ICE_TIMEOUT_MS);
    function check(): void {
      if (peer.iceGatheringState !== 'complete') return;
      clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    peer.addEventListener('icegatheringstatechange', check);
  });
}

/** Whether this computer can hold a live conversation (a key is saved). */
export async function liveVoiceAvailable(statusUrl = '/api/console/voice/live'): Promise<boolean> {
  if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  try {
    const token = getAuthToken();
    const res = await fetch(`${statusUrl}${token ? `?token=${encodeURIComponent(token)}` : ''}`, { credentials: 'same-origin' });
    if (!res.ok) return false;
    const status = await res.json() as { available?: boolean };
    return status.available === true;
  } catch {
    return false;
  }
}
