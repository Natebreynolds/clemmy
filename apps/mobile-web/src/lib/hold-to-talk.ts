/** Tap dictation: capture 16 kHz mono PCM, then transcribe through the Mac. */
import { transcribeVoice } from './api';
import { microphoneUnavailableReason } from './dictation-support';
import { StreamingPcmResampler, float32ToPcm16, pcm16Seconds, pcm16ToWav } from './pcm';

const PROCESSOR_BUFFER_SIZE = 4096;
const MIN_SECONDS = 0.35;

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext;
}

export function holdToTalkAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(audioContextCtor());
}

/** The historic export is retained for callers; the UI now starts/stops by tap. */
export class HoldToTalk {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private resampler: StreamingPcmResampler | null = null;
  private pcm: ArrayBuffer[] = [];
  private bytes = 0;
  private epoch = 0;
  private phase: 'idle' | 'starting' | 'recording' | 'transcribing' = 'idle';
  private transcription: AbortController | null = null;

  constructor(private readonly transcribe = transcribeVoice) {}

  /** Resume is invoked in the tap's activation, before microphone permission awaits. */
  async start(): Promise<boolean> {
    if (this.phase !== 'idle') return false;
    const AudioCtor = audioContextCtor();
    if (!holdToTalkAvailable() || !AudioCtor) throw new Error(microphoneUnavailableReason());
    const epoch = ++this.epoch;
    this.phase = 'starting';
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const context = new AudioCtor({ latencyHint: 'interactive' });
      this.context = context;
      // Handle rejection immediately: permission can remain open for longer.
      const resumed = context.resume().then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (epoch !== this.epoch) { stream.getTracks().forEach(track => track.stop()); return false; }
      this.stream = stream;
      const result = await Promise.race([
        resumed,
        new Promise<never>((_resolve, reject) => { resumeTimer = setTimeout(() => reject(new Error('Audio could not start. Tap Dictate again to retry.')), 6000); }),
      ]);
      if (epoch !== this.epoch) return false;
      if (!result.ok) throw result.error;
      if (context.state !== 'running') throw new Error('Audio is paused. Tap Dictate again to start the microphone.');
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
      this.processor = processor;
      const silent = context.createGain();
      silent.gain.value = 0;
      this.resampler = new StreamingPcmResampler(context.sampleRate);
      this.pcm = [];
      this.bytes = 0;
      processor.onaudioprocess = event => {
        if (epoch !== this.epoch || this.phase !== 'recording' || !this.resampler) return;
        const resampled = this.resampler.append(event.inputBuffer.getChannelData(0));
        if (resampled.length) {
          const chunk = float32ToPcm16(resampled);
          this.pcm.push(chunk);
          this.bytes += chunk.byteLength;
        }
      };
      source.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      this.phase = 'recording';
      return true;
    } catch (error) {
      if (epoch !== this.epoch) return false;
      this.cancel();
      throw error;
    } finally {
      if (resumeTimer !== undefined) clearTimeout(resumeTimer);
    }
  }

  async stop(): Promise<string> {
    if (this.phase !== 'recording') { this.cancel(); return ''; }
    const epoch = this.epoch;
    this.phase = 'transcribing';
    const chunks = this.pcm;
    const bytes = this.bytes;
    this.teardown();
    const transcription = new AbortController();
    this.transcription = transcription;
    try {
      if (pcm16Seconds(bytes) < MIN_SECONDS) throw new Error('The recording was too short. Tap Dictate, speak for a moment, then tap Finish dictation.');
      const result = await this.transcribe(pcm16ToWav(chunks), transcription.signal);
      if (epoch !== this.epoch) return '';
      const words = (result.text || '').trim();
      if (!words) throw new Error('No speech was heard. Tap Dictate and speak, then tap Finish dictation.');
      return words;
    } finally {
      if (this.transcription === transcription) this.transcription = null;
      if (epoch === this.epoch) this.phase = 'idle';
    }
  }

  cancel(): void {
    this.epoch += 1;
    this.phase = 'idle';
    this.transcription?.abort();
    this.transcription = null;
    this.teardown();
  }

  private teardown(): void {
    if (this.processor) this.processor.onaudioprocess = null;
    try { this.processor?.disconnect(); } catch { /* already gone */ }
    this.processor = null;
    this.resampler = null;
    this.pcm = [];
    this.bytes = 0;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    const context = this.context;
    this.context = null;
    try { void context?.close().catch(() => undefined); } catch { /* already closed */ }
  }
}
