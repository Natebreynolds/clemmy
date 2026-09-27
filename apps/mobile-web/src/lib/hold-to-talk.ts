/**
 * Hold to talk: press the mic, speak, let go. The microphone is captured as
 * 16 kHz mono PCM and sent to the Mac, which transcribes it on-device (the
 * promise the app has made since day one; before 09-26 the mic used Apple's
 * speech service and nothing ever reached the Mac). Web Speech stays as the
 * fallback where a microphone stream is not available.
 */
import { transcribeVoice } from './api';
import { StreamingPcmResampler, float32ToPcm16, pcm16Seconds, pcm16ToWav } from './pcm';

const PROCESSOR_BUFFER_SIZE = 4096;
const MIN_SECONDS = 0.35;

export function holdToTalkAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const AudioCtor = (window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown }).AudioContext
    ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  return Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(AudioCtor);
}

export class HoldToTalk {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private resampler: StreamingPcmResampler | null = null;
  private pcm: ArrayBuffer[] = [];
  private bytes = 0;
  private active = false;

  async start(): Promise<void> {
    if (this.active) return;
    const AudioCtor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioCtor) throw new Error('The microphone is not available here.');
    this.active = true;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (!this.active) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.stream = stream;
    const context = new AudioCtor({ latencyHint: 'interactive' });
    this.context = context;
    await context.resume();
    if (!this.active) { this.teardown(); return; }
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
    const silent = context.createGain();
    silent.gain.value = 0;
    this.resampler = new StreamingPcmResampler(context.sampleRate);
    this.pcm = [];
    this.bytes = 0;
    processor.onaudioprocess = (event) => {
      const resampler = this.resampler;
      if (!this.active || !resampler) return;
      const resampled = resampler.append(event.inputBuffer.getChannelData(0));
      if (resampled.length) {
        const chunk = float32ToPcm16(resampled);
        this.pcm.push(chunk);
        this.bytes += chunk.byteLength;
      }
    };
    source.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);
    this.processor = processor;
  }

  /** Stop and transcribe on the Mac. Resolves with the words, or '' for a tap that recorded nothing. */
  async stop(): Promise<string> {
    if (!this.active) return '';
    this.active = false;
    const chunks = this.pcm;
    const bytes = this.bytes;
    this.teardown();
    if (pcm16Seconds(bytes) < MIN_SECONDS) return '';
    const result = await transcribeVoice(pcm16ToWav(chunks));
    return (result.text || '').trim();
  }

  cancel(): void {
    this.active = false;
    this.teardown();
  }

  private teardown(): void {
    try { this.processor?.disconnect(); } catch { /* already gone */ }
    this.processor = null;
    this.resampler = null;
    this.pcm = [];
    this.bytes = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const context = this.context;
    this.context = null;
    void context?.close().catch(() => undefined);
  }
}
