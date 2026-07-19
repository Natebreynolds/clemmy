/**
 * Notch voice companion — on-device speech-to-text, NOT realtime voice.
 *
 * Flow: capture the mic as 16 kHz mono PCM in the renderer (same Web Audio path
 * the local meeting recorder uses), wrap it as a WAV, POST it to
 * /api/console/voice/transcribe (on-device whisper — no cloud), then send the
 * transcript to /api/console/home/chat/stream (= the user's configured brain,
 * tools, gates, memory). No voice model speaks back; the notch just shows what
 * you said and what Clementine did.
 */
import { getAuthToken } from './bootstrap';
import { StreamingPcmResampler, float32ToPcm16 } from './local-meeting-recorder';

const OUTPUT_SAMPLE_RATE = 16_000;
const PROCESSOR_BUFFER_SIZE = 4096;
// Voice-activity detection: raw RMS above this counts as speech. Speech RMS is
// ~0.02–0.1; ambient/silence is well below.
const SPEECH_RMS_THRESHOLD = 0.012;
// Hands-free auto-send fires after this much continuous silence FOLLOWING speech.
const DEFAULT_SILENCE_MS = 1_000;
// Live interim transcription: re-transcribe the growing clip on this cadence so
// the words stream in as you speak. Guarded so only one runs at a time.
const INTERIM_INTERVAL_MS = 1_200;
const INTERIM_MIN_BYTES = 16_000; // ~0.5s of 16 kHz mono PCM16 before the first pass

export type NotchVoiceStatus =
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'done'
  | 'error'
  | 'idle';

export interface NotchVoiceOptions {
  /** Auto-send when the speaker goes quiet (hands-free). Default true. */
  autoSend?: boolean;
  /** Silence duration (ms) after speech that triggers auto-send. */
  silenceMs?: number;
  /** Stream a live interim transcript as you speak. Default true. */
  interim?: boolean;
}

export interface NotchVoiceHandlers {
  onStatus: (status: NotchVoiceStatus, label?: string) => void;
  /** The transcript so far — updated live (interim) as you speak, then final on
   *  send. Same signature as before so existing callers keep working. */
  onUserText?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  /** Live input level 0..1 while recording, for a mic-level meter. */
  onLevel?: (level: number) => void;
}

/** Wrap raw 16-bit little-endian mono PCM chunks in a minimal WAV container. */
function pcm16ToWav(chunks: ArrayBuffer[], sampleRate: number): Blob {
  let dataLength = 0;
  for (const c of chunks) dataLength += c.byteLength;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);           // PCM fmt chunk size
  view.setUint16(20, 1, true);            // audio format = PCM
  view.setUint16(22, 1, true);            // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = sampleRate * blockAlign
  view.setUint16(32, 2, true);            // block align = channels * bytesPerSample
  view.setUint16(34, 16, true);           // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (const c of chunks) { new Uint8Array(buffer, offset, c.byteLength).set(new Uint8Array(c)); offset += c.byteLength; }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class NotchVoice {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silent: GainNode | null = null;
  private resampler: StreamingPcmResampler | null = null;
  private pcm: ArrayBuffer[] = [];
  private stopped = false;
  private captureFinished = false;
  private lifecycleRevision = 0;
  private sendPromise: Promise<void> | null = null;
  private requestController: AbortController | null = null;
  private chatReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // Voice-activity detection (hands-free auto-send).
  private speechDetected = false;
  private silentMs = 0;
  private pcmBytes = 0;
  // Live interim transcription.
  private interimTimer: ReturnType<typeof setInterval> | null = null;
  private interimInFlight = false;
  private interimController: AbortController | null = null;

  constructor(private handlers: NotchVoiceHandlers, private options: NotchVoiceOptions = {}) {}

  /** Begin capturing the microphone as 16 kHz mono PCM. */
  async startRecording(): Promise<void> {
    const revision = this.lifecycleRevision;
    if (!this.isCaptureActive(revision)) return;
    const AudioCtor = typeof AudioContext !== 'undefined'
      ? AudioContext
      : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioCtor) {
      throw new Error('Microphone recording is not available here.');
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (error) {
      // getUserMedia cannot be aborted. If this instance was cancelled while
      // the permission prompt was open, do not let its late rejection update UI.
      if (!this.isCaptureActive(revision)) return;
      throw error;
    }
    if (!this.isCaptureActive(revision)) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.stream = stream;
    try {
      const context = new AudioCtor({ latencyHint: 'interactive' });
      // Store the context before resume(): cancel() can run while resume is
      // pending, and must be able to close this exact context immediately.
      this.context = context;
      await context.resume();
      if (!this.isCaptureActive(revision)) { this.teardownAudio(); return; }
      this.source = context.createMediaStreamSource(stream);
      this.processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
      this.silent = context.createGain();
      this.silent.gain.value = 0;
      this.resampler = new StreamingPcmResampler(context.sampleRate);
      this.pcm = [];
      this.processor.onaudioprocess = (event) => {
        const resampler = this.resampler;
        if (!this.isCaptureActive(revision) || !resampler) return;
        const input = event.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);
        if (this.handlers.onLevel) {
          // RMS → a lively 0..1 meter (speech RMS is small, so scale up + clamp).
          this.handlers.onLevel(Math.min(1, rms * 6));
          // A handler can synchronously close voice mode. Never continue using
          // the resampler it just caused teardownAudio() to release.
          if (!this.isCaptureActive(revision) || this.resampler !== resampler) return;
        }
        // Hands-free VAD: once you've spoken, sustained silence auto-sends.
        if (this.options.autoSend !== false) {
          const chunkMs = (input.length / (this.context?.sampleRate || OUTPUT_SAMPLE_RATE)) * 1000;
          if (rms > SPEECH_RMS_THRESHOLD) {
            this.speechDetected = true;
            this.silentMs = 0;
          } else if (this.speechDetected) {
            this.silentMs += chunkMs;
            if (this.silentMs >= (this.options.silenceMs ?? DEFAULT_SILENCE_MS) && !this.captureFinished) {
              void this.stopAndSend().catch(() => undefined);
            }
          }
        }
        const resampled = resampler.append(input);
        if (resampled.length && this.isCaptureActive(revision)) {
          const bytes = float32ToPcm16(resampled);
          this.pcm.push(bytes);
          this.pcmBytes += bytes.byteLength;
        }
      };
      // The processor must reach a destination to run; a zero-gain node keeps it
      // silent so we never echo the mic back to the speakers.
      this.source.connect(this.processor);
      this.processor.connect(this.silent);
      this.silent.connect(context.destination);
      this.emitStatus(revision, 'recording', 'Listening…');
      if (this.options.interim !== false) this.startInterim(revision);
    } catch (error) {
      this.teardownAudio();
      if (!this.isCaptureActive(revision)) return;
      throw error;
    }
  }

  /** Stop recording, transcribe on-device, send to Clementine, surface the reply. */
  stopAndSend(): Promise<void> {
    if (this.sendPromise) return this.sendPromise;
    if (this.stopped) return Promise.resolve();

    // Latch synchronously so a double-click (or a re-entrant status handler)
    // cannot drain the same PCM buffer into two independent agent requests.
    this.captureFinished = true;
    const revision = this.lifecycleRevision;
    this.sendPromise = Promise.resolve().then(() => this.performStopAndSend(revision));
    return this.sendPromise;
  }

  private async performStopAndSend(revision: number): Promise<void> {
    if (!this.isActive(revision)) return;
    const wav = this.finishRecording();
    if (!this.isActive(revision)) return;
    if (!wav || wav.size <= 44) throw new Error('No audio was captured — try again.');
    const controller = new AbortController();
    this.requestController = controller;
    try {
      this.emitStatus(revision, 'transcribing', 'Transcribing…');
      if (!this.isActive(revision)) return;
      const text = (await this.transcribe(wav, controller.signal)).trim();
      if (!this.isActive(revision)) return;
      if (!text) throw new Error("I didn't catch that — try again.");
      this.handlers.onUserText?.(text);
      if (!this.isActive(revision)) return;
      this.emitStatus(revision, 'thinking', 'Sending to Clementine…');
      if (!this.isActive(revision)) return;
      const result = await this.streamHomeChat(text, controller.signal, revision);
      if (!this.isActive(revision)) return;
      if (result.text) this.handlers.onAssistantText?.(result.text);
      if (!this.isActive(revision)) return;
      this.emitStatus(revision, 'done', result.pendingApprovalId ? 'Waiting for your approval' : 'Done');
    } catch (error) {
      // cancel() is user intent, not a failed voice request. Fetch/read aborts
      // caused by it must not race the owning React effect with a stale error.
      if (!this.isActive(revision) || controller.signal.aborted) return;
      throw error;
    } finally {
      if (this.requestController === controller) this.requestController = null;
    }
  }

  private finishRecording(): Blob | null {
    if (this.resampler) {
      const tail = this.resampler.flush();
      if (tail.length) this.pcm.push(float32ToPcm16(tail));
    }
    this.teardownAudio();
    if (!this.pcm.length) return null;
    return pcm16ToWav(this.pcm, OUTPUT_SAMPLE_RATE);
  }

  /** Stream a live interim transcript: periodically re-transcribe the growing
   *  clip so the words appear as you speak. Best-effort — the send does the
   *  authoritative final transcription. Only one interim runs at a time. */
  private startInterim(revision: number): void {
    if (this.interimTimer) return;
    const tick = async (): Promise<void> => {
      if (this.interimInFlight || !this.isCaptureActive(revision) || this.pcmBytes < INTERIM_MIN_BYTES) return;
      this.interimInFlight = true;
      const controller = new AbortController();
      this.interimController = controller;
      try {
        const wav = pcm16ToWav(this.pcm.slice(), OUTPUT_SAMPLE_RATE);
        const text = (await this.transcribe(wav, controller.signal)).trim();
        if (this.isCaptureActive(revision) && text) this.handlers.onUserText?.(text);
      } catch {
        // Interim is best-effort; the final transcription on send is authoritative.
      } finally {
        this.interimInFlight = false;
        if (this.interimController === controller) this.interimController = null;
      }
    };
    this.interimTimer = setInterval(() => { void tick(); }, INTERIM_INTERVAL_MS);
  }

  private stopInterim(): void {
    if (this.interimTimer) { clearInterval(this.interimTimer); this.interimTimer = null; }
    this.interimController?.abort();
    this.interimController = null;
  }

  private async transcribe(wav: Blob, signal: AbortSignal): Promise<string> {
    const t = getAuthToken();
    const url = `/api/console/voice/transcribe${t ? `?token=${encodeURIComponent(t)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'audio/wav' },
      body: wav,
      signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((payload as { error?: string }).error || 'Could not transcribe your request.');
    return String((payload as { text?: string }).text || '');
  }

  /** POST to the same streaming chat endpoint the dashboard chat uses and parse
   *  the NDJSON to the final {ok,text,pendingApprovalId}. Routes through the
   *  user's configured brain — all gates/approvals/memory apply automatically. */
  private async streamHomeChat(
    message: string,
    signal: AbortSignal,
    revision: number,
  ): Promise<{ ok: boolean; text: string; pendingApprovalId: string | null }> {
    const t = getAuthToken();
    const url = `/api/console/home/chat/stream${t ? `?token=${encodeURIComponent(t)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, sessionId: 'console:voice' }),
      signal,
    });
    if (!this.isActive(revision)) return { ok: false, text: '', pendingApprovalId: null };
    if (!res.ok || !res.body) {
      const e = await res.json().catch(() => ({}));
      if (!this.isActive(revision)) return { ok: false, text: '', pendingApprovalId: null };
      throw new Error((e as { error?: string }).error || `voice relay HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    this.chatReader = reader;
    const decoder = new TextDecoder();
    let buf = '';
    let out: { ok: boolean; text: string; pendingApprovalId: string | null } = { ok: false, text: '', pendingApprovalId: null };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (!this.isActive(revision)) return out;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: { type?: string; text?: string; toolName?: string; stoppedReason?: string; pendingApprovalId?: string | null; error?: string };
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'status' || ev.type === 'tool') {
            this.emitStatus(revision, 'thinking', ev.text || (ev.toolName ? `Using ${ev.toolName}…` : 'Working…'));
          } else if (ev.type === 'done') {
            out = { ok: (ev.stoppedReason ?? 'success') === 'success', text: ev.text || '', pendingApprovalId: ev.pendingApprovalId ?? null };
          } else if (ev.type === 'error') {
            throw new Error(ev.error || 'voice relay stream error');
          }
        }
      }
    } finally {
      if (this.chatReader === reader) this.chatReader = null;
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    return out;
  }

  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifecycleRevision += 1;
    this.requestController?.abort();
    this.requestController = null;
    const reader = this.chatReader;
    this.chatReader = null;
    if (reader) void reader.cancel().catch(() => undefined);
    this.teardownAudio();
  }

  private isActive(revision: number): boolean {
    return !this.stopped && revision === this.lifecycleRevision;
  }

  private isCaptureActive(revision: number): boolean {
    return this.isActive(revision) && !this.captureFinished;
  }

  private emitStatus(revision: number, status: NotchVoiceStatus, label?: string): void {
    if (this.isActive(revision)) this.handlers.onStatus(status, label);
  }

  private teardownAudio(): void {
    this.stopInterim();
    try { if (this.processor) this.processor.onaudioprocess = null; } catch { /* ignore */ }
    try { this.processor?.disconnect(); } catch { /* ignore */ }
    try { this.source?.disconnect(); } catch { /* ignore */ }
    try { this.silent?.disconnect(); } catch { /* ignore */ }
    try { void this.context?.close(); } catch { /* ignore */ }
    try { this.stream?.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
    this.processor = null;
    this.source = null;
    this.silent = null;
    this.context = null;
    this.stream = null;
    this.resampler = null;
  }
}
