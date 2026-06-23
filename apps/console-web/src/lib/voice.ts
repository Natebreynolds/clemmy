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
  // Session features returned by /api/console/realtime/session.
  private features: { oneLoop?: boolean; progressUpdates?: boolean; reconnect?: boolean } = {};
  // Idempotency: a re-emitted function_call must not run twice (duplicate brain
  // runs / sends). Mirrors the legacy console handledCalls guard.
  private handledCalls = new Set<string>();

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
    this.features = (payload && payload.features) || {};

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
      // THE ROUTING FIX (2026-06-23): when gpt-realtime decides real work is
      // needed it emits a `send_to_clementine` function call. Previously the
      // React client ignored it, so the realtime model self-answered and the
      // user's actual brain (Claude/Codex/GLM) + tools + gates were bypassed.
      // Relay it to /api/console/home/chat/stream (= assistant.respond → the
      // configured brain), then speak the result.
      case 'response.function_call_arguments.done':
        void this.routeToClementine(ev.name, ev.arguments, ev.call_id);
        break;
      case 'response.done': {
        // A function_call can also arrive in the response output sweep.
        let routed = false;
        for (const item of (ev.response?.output ?? [])) {
          if (item?.type === 'function_call') {
            routed = true;
            void this.routeToClementine(item.name, item.arguments, item.call_id);
          }
        }
        if (!routed) this.handlers.onStatus('listening', 'Listening — speak naturally');
        break;
      }
    }
  }

  /** Relay a spoken request into the local Clementine agent (the configured
   *  brain + tools + gates + memory + Tasks/Discord visibility), then hand the
   *  result back to gpt-realtime to speak. Persona path (default). */
  private async routeToClementine(name: string, rawArguments: string, callId?: string): Promise<void> {
    if (name !== 'send_to_clementine' || !callId || this.handledCalls.has(callId) || this.stopped) return;
    this.handledCalls.add(callId);

    let args: { request?: string } = {};
    try { args = JSON.parse(rawArguments || '{}'); } catch { /* ignore */ }
    const request = String(args.request || '').trim();
    if (!request) return;

    this.handlers.onStatus('thinking', 'Routing into the local Clementine agent…');

    // Optional immediate spoken ack so there's no dead air while the brain runs
    // (gated on the server feature flag CLEMMY_VOICE_PROGRESS; off by default).
    if (this.features.progressUpdates) {
      this.send({
        type: 'response.create',
        response: { output_modalities: ['audio'], instructions: 'Give one short, natural acknowledgement that you are on it and looking into this now.' },
      });
    }

    let result: { ok: boolean; text: string; pendingApprovalId: string | null } = { ok: false, text: '', pendingApprovalId: null };
    try {
      result = await this.streamHomeChat(`[Voice command] ${request}`);
    } catch (err) {
      result = { ok: false, text: `The local agent could not be reached: ${err instanceof Error ? err.message : String(err)}`, pendingApprovalId: null };
    }
    if (this.stopped) return;

    // Hand the structured result back so gpt-realtime can speak the summary.
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    });
    this.send({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions: result.pendingApprovalId
          ? 'In one short sentence, tell the user the request needs their approval in the Clementine dashboard or Discord before it can proceed.'
          : 'Summarize the local Clementine result in one or two short spoken sentences. Do not read it verbatim.',
      },
    });
  }

  /** POST to the same streaming chat endpoint the dashboard chat uses and parse
   *  the NDJSON to the final {ok,text,pendingApprovalId}. Routes through the
   *  user's configured brain — all gates/approvals/memory apply automatically. */
  private async streamHomeChat(message: string): Promise<{ ok: boolean; text: string; pendingApprovalId: string | null }> {
    const t = getAuthToken();
    const url = `/api/console/home/chat/stream${t ? `?token=${encodeURIComponent(t)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, sessionId: 'console:voice' }),
    });
    if (!res.ok || !res.body) {
      const e = await res.json().catch(() => ({}));
      throw new Error((e as { error?: string }).error || `voice relay HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let out: { ok: boolean; text: string; pendingApprovalId: string | null } = { ok: false, text: '', pendingApprovalId: null };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'status' || ev.type === 'tool') {
          this.handlers.onStatus('thinking', ev.text || (ev.toolName ? `Using ${ev.toolName}…` : 'Working…'));
        } else if (ev.type === 'done') {
          out = { ok: (ev.stoppedReason ?? 'success') === 'success', text: ev.text || '', pendingApprovalId: ev.pendingApprovalId ?? null };
        } else if (ev.type === 'error') {
          throw new Error(ev.error || 'voice relay stream error');
        }
      }
    }
    return out;
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
