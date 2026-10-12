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

export class PhoneLiveVoice implements LiveVoiceLink {
  private readonly protocol: LiveVoiceProtocol;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private released = false;

  constructor(handlers: LiveVoiceHandlers) {
    this.protocol = new LiveVoiceProtocol({
      ...handlers,
      onClosed: (reason, expected) => { this.release(); handlers.onClosed(reason, expected); },
    });
  }

  async start(history: readonly LiveHistoryMessage[]): Promise<void> {
    const peer = new RTCPeerConnection();
    this.peer = peer;
    // Made in the owner's tap so the phone lets it play when the voice arrives.
    const audio = new Audio();
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
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
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
      for (const track of this.microphone.getAudioTracks()) peer.addTrack(track, this.microphone);
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
      if (!sdp) throw new Error('This phone could not prepare a voice connection.');
      const session = await startLiveVoiceSession({ sdp, history });
      await peer.setRemoteDescription({ type: 'answer', sdp: session.sdp });
    } catch (error) {
      this.release();
      throw error;
    }
  }

  say(text: string, requestId: string | null): void { this.protocol.say(text, requestId); }
  note(text: string, requestId: string | null): void { this.protocol.note(text, requestId); }
  direct(text: string): void { this.protocol.direct(text); }

  close(): void {
    if (this.released) return;
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

/** Whether this phone and its Mac can hold a live conversation. */
export async function phoneLiveVoiceAvailable(): Promise<boolean> {
  if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  try { return (await liveVoiceStatus()).available === true; } catch { return false; }
}
