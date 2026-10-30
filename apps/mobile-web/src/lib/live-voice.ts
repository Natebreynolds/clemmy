/**
 * Live voice on the phone: a full-duplex conversation with Clem.
 *
 * The microphone and the voice travel over WebRTC between the phone and the
 * voice service; the Mac only exchanges the connection offer under the paired
 * device's proof, so the key never reaches the phone. The conversation itself
 * (requests, Clem's replies) is the shared live voice protocol.
 */
import { LiveVoiceProtocol, type LiveHistoryMessage, type LiveVoiceHandlers, type LiveVoiceLink } from '@clem/chat-engine';
import { liveVoiceStatus, startLiveVoiceSession } from './api';

const CLOSE_TIMEOUT_MS = 6_000;
const ICE_TIMEOUT_MS = 10_000;

export interface PhoneLiveVoiceDependencies {
  createPeer(): RTCPeerConnection;
  createAudio(): HTMLAudioElement;
  microphone(): Promise<MediaStream>;
  createSession(body: { sdp: string; history: readonly LiveHistoryMessage[] }, signal: AbortSignal): Promise<{ sessionId: string; sdp: string }>;
}
const dependencies: PhoneLiveVoiceDependencies = {
  createPeer: () => new RTCPeerConnection(),
  createAudio: () => new Audio(),
  microphone: () => navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
  }),
  createSession: startLiveVoiceSession,
};

export class PhoneLiveVoice implements LiveVoiceLink {
  private readonly protocol: LiveVoiceProtocol;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private released = false;
  private closing = false;
  private readonly setup = new AbortController();

  constructor(handlers: LiveVoiceHandlers, private readonly deps: PhoneLiveVoiceDependencies = dependencies) {
    this.protocol = new LiveVoiceProtocol({
      ...handlers,
      onClosed: (reason, expected) => { this.release(); handlers.onClosed(reason, expected); },
    });
  }

  async start(history: readonly LiveHistoryMessage[]): Promise<void> {
    if (this.released || this.closing || this.peer) return;
    const peer = this.deps.createPeer();
    this.peer = peer;
    // Made in the owner's tap so the phone lets it play when the voice arrives.
    const audio = this.deps.createAudio();
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    this.audio = audio;
    peer.addEventListener('track', (event) => {
      if (this.closing || this.released) { event.track.stop(); return; }
      audio.srcObject = new MediaStream([event.track]);
      void audio.play().catch(() => undefined);
    });
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.protocol.transportClosed();
    });
    try {
      const microphone = await this.deps.microphone();
      if (this.closing || this.released) {
        for (const track of microphone.getTracks()) track.stop();
        return;
      }
      this.microphone = microphone;
      for (const track of this.microphone.getAudioTracks()) peer.addTrack(track, this.microphone);
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;
      channel.addEventListener('message', ({ data }) => {
        try { this.protocol.receive(JSON.parse(String(data))); } catch { /* not an event */ }
      });
      channel.addEventListener('close', () => this.protocol.transportClosed());
      this.protocol.attach(event => { if (channel.readyState === 'open') channel.send(JSON.stringify(event)); });
      await peer.setLocalDescription(await peer.createOffer());
      if (this.closing || this.released) return;
      await iceGathered(peer, this.setup.signal);
      if (this.closing || this.released) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('This phone could not prepare a voice connection.');
      const session = await this.deps.createSession({ sdp, history }, this.setup.signal);
      if (this.closing || this.released) return;
      await peer.setRemoteDescription({ type: 'answer', sdp: session.sdp });
    } catch (error) {
      this.release();
      if (this.closing) return;
      throw error;
    }
  }

  say(text: string, requestId: string | null): void { this.protocol.say(text, requestId); }
  note(text: string, requestId: string | null): void { this.protocol.note(text, requestId); }
  direct(text: string): void { this.protocol.direct(text); }

  close(): void {
    if (this.released || this.closing) return;
    this.closing = true;
    this.setup.abort();
    for (const track of this.microphone?.getTracks() ?? []) track.enabled = false;
    if (!this.protocol.close()) { this.release(); return; }
    if (!this.channel || this.channel.readyState !== 'open') { this.protocol.transportClosed(); return; }
    this.closeTimer = setTimeout(() => this.protocol.transportClosed(), CLOSE_TIMEOUT_MS);
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.setup.abort();
    if (this.closeTimer) clearTimeout(this.closeTimer);
    for (const track of this.microphone?.getTracks() ?? []) track.stop();
    try { this.channel?.close(); } catch { /* already closed */ }
    try { this.peer?.close(); } catch { /* already closed */ }
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    this.microphone = null; this.channel = null; this.peer = null; this.audio = null;
  }
}

function iceGathered(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); peer.removeEventListener('icegatheringstatechange', check); signal.removeEventListener('abort', abort); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('The voice connection took too long to prepare.')); }, ICE_TIMEOUT_MS);
    const abort = () => { cleanup(); reject(signal.reason); };
    function check(): void {
      if (peer.iceGatheringState !== 'complete') return;
      cleanup();
      resolve();
    }
    peer.addEventListener('icegatheringstatechange', check);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Whether this phone and its Mac can hold a live conversation. */
export async function phoneLiveVoiceAvailable(): Promise<boolean> {
  if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  try { return (await liveVoiceStatus()).available === true; } catch { return false; }
}
