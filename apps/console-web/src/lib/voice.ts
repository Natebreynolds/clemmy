/**
 * Clementine Live — realtime voice over WebRTC, ported from the legacy
 * console (console.ts ~21198). Flow: POST /api/console/realtime/session
 * for an ephemeral client secret, then a standard OpenAI Realtime WebRTC
 * handshake (offer → /v1/realtime/calls → answer). Mic in, audio out,
 * events over a data channel. Same-origin session call (cookie/token);
 * the SDP POST to api.openai.com is covered by the daemon CSP connect-src.
 */
import { getAuthToken } from './bootstrap';

export type VoiceStatus = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error' | 'idle';

export interface VoiceHandlers {
  onStatus: (status: VoiceStatus, label?: string) => void;
  onUserText?: (text: string) => void;
  onAssistantText?: (text: string) => void;
}

function clientSecret(payload: any): string {
  return payload && (
    payload.value
    || payload?.client_secret?.value
    || payload?.client_secret?.secret
    || payload?.secret?.value
    || ''
  );
}

export class RealtimeVoice {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private assistant = '';
  private stopped = false;

  constructor(private handlers: VoiceHandlers) {}

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access is not available here.');
    }
    this.handlers.onStatus('connecting', 'Connecting…');

    const tokenUrl = (() => {
      const t = getAuthToken();
      const base = '/api/console/realtime/session';
      return t ? `${base}?token=${encodeURIComponent(t)}` : base;
    })();
    const res = await fetch(tokenUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'console:voice' }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || 'Could not start a voice session.');
    const key = clientSecret(payload);
    if (!key) throw new Error('Voice session did not return a client secret.');

    const pc = new RTCPeerConnection();
    this.pc = pc;
    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;

    const audio = new Audio();
    audio.autoplay = true;
    this.audio = audio;
    pc.ontrack = (event) => { audio.srcObject = event.streams[0]; };
    pc.onconnectionstatechange = () => {
      if (this.stopped) return;
      if (pc.connectionState === 'connected') this.handlers.onStatus('listening', 'Listening — speak naturally');
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.handlers.onStatus('error', 'Connection dropped');
    };

    dc.addEventListener('open', () => {
      this.handlers.onStatus('listening', 'Listening — speak naturally');
      this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Clementine Live just connected. Briefly say you are online and listening, under one sentence.' }] } });
      this.send({ type: 'response.create', response: { output_modalities: ['audio'], instructions: 'Say one short sentence that Clementine Live is online and listening.' } });
    });
    dc.addEventListener('message', (e) => { try { this.handleEvent(JSON.parse(e.data)); } catch { /* ignore */ } });

    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.stream = stream;
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/sdp' },
    });
    const answer = await sdpRes.text();
    if (!sdpRes.ok) throw new Error(answer || 'Voice handshake failed.');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }

  private send(event: unknown): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event));
  }

  private handleEvent(ev: any): void {
    if (!ev?.type || this.stopped) return;
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.assistant = '';
        this.handlers.onStatus('listening', 'Listening to you…');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.handlers.onStatus('thinking', 'Thinking…');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript) this.handlers.onUserText?.(ev.transcript);
        break;
      case 'response.created':
        this.handlers.onStatus('thinking', 'Thinking…');
        break;
      case 'response.output_audio_transcript.delta':
        if (ev.delta) { this.assistant += ev.delta; this.handlers.onStatus('speaking', 'Clementine is speaking…'); this.handlers.onAssistantText?.(this.assistant); }
        break;
      case 'response.output_audio_transcript.done':
        if (ev.transcript) this.handlers.onAssistantText?.(ev.transcript);
        this.assistant = '';
        break;
      case 'response.done':
        this.handlers.onStatus('listening', 'Listening — speak naturally');
        break;
    }
  }

  stop(): void {
    this.stopped = true;
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    if (this.audio) { try { this.audio.pause(); this.audio.srcObject = null; } catch { /* ignore */ } }
    this.pc = null; this.dc = null; this.stream = null; this.audio = null;
  }
}
