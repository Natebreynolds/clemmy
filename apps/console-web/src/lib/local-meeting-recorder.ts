import { clemmy } from './clemmy';

const OUTPUT_SAMPLE_RATE = 16_000;
const PROCESSOR_BUFFER_SIZE = 4096;

export type LocalMeetingCapturePhase = 'idle' | 'requesting' | 'recording' | 'stopping' | 'error';

export interface LocalMeetingCaptureState {
  phase: LocalMeetingCapturePhase;
  sessionId?: string;
  startedAt?: string;
  elapsedSeconds: number;
  error?: string;
}

export interface LocalMeetingCaptureHandlers {
  onState?: (state: LocalMeetingCaptureState) => void;
}

/**
 * Stateful linear resampler. It carries the boundary sample and fractional
 * cursor between Web Audio callbacks, avoiding a click/gap at every chunk.
 */
export class StreamingPcmResampler {
  private carry = new Float32Array(0);
  private position = 0;
  private readonly ratio: number;

  constructor(inputSampleRate: number, outputSampleRate = OUTPUT_SAMPLE_RATE) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) throw new Error('invalid input sample rate');
    if (!Number.isFinite(outputSampleRate) || outputSampleRate <= 0) throw new Error('invalid output sample rate');
    this.ratio = inputSampleRate / outputSampleRate;
  }

  append(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0);
    const samples = new Float32Array(this.carry.length + input.length);
    samples.set(this.carry);
    samples.set(input, this.carry.length);

    const output: number[] = [];
    while (this.position < samples.length - 1) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      output.push(samples[left] + ((samples[left + 1] - samples[left]) * fraction));
      this.position += this.ratio;
    }

    const consumed = Math.min(Math.floor(this.position), samples.length - 1);
    this.carry = samples.slice(consumed);
    this.position -= consumed;
    return Float32Array.from(output);
  }

  flush(): Float32Array {
    if (this.carry.length === 0) return new Float32Array(0);
    const index = Math.min(Math.round(this.position), this.carry.length - 1);
    const output = new Float32Array([this.carry[index]]);
    this.carry = new Float32Array(0);
    this.position = 0;
    return output;
  }
}

export function float32ToPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new ArrayBuffer(samples.length * 2);
  const view = new DataView(pcm);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767), true);
  }
  return pcm;
}

function captureErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow Clementine in System Settings → Privacy & Security → Microphone, then try again.';
  }
  if (name === 'NotFoundError') return 'No microphone was found. Connect one and try again.';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Captures the microphone in the sandboxed renderer and streams 16 kHz mono
 * signed PCM over the narrow Electron bridge. No remote service receives the
 * raw audio, and the browser never accumulates a full meeting in memory.
 */
export class LocalMeetingCapture {
  private phase: LocalMeetingCapturePhase = 'idle';
  private sessionId: string | null = null;
  private startedAt: string | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentOutput: GainNode | null = null;
  private resampler: StreamingPcmResampler | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private writeError: Error | null = null;
  private elapsedTimer: number | null = null;
  private cancelRequested = false;
  private releasePromise: Promise<void> | null = null;

  constructor(private readonly handlers: LocalMeetingCaptureHandlers = {}) {}

  state(): LocalMeetingCaptureState {
    const elapsedSeconds = this.startedAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(this.startedAt)) / 1000))
      : 0;
    return {
      phase: this.phase,
      sessionId: this.sessionId ?? undefined,
      startedAt: this.startedAt ?? undefined,
      elapsedSeconds,
      error: this.writeError?.message,
    };
  }

  async start(title?: string): Promise<LocalMeetingCaptureState> {
    if (this.phase !== 'idle' && this.phase !== 'error') throw new Error('a local meeting is already starting or recording');
    const bridge = clemmy();
    if (!bridge?.localMeetingStart || !bridge.localMeetingAppend) {
      throw new Error('Local meeting recording is available in the Clementine desktop app.');
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone recording is not available here.');

    this.writeError = null;
    this.cancelRequested = false;
    this.setPhase('requesting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      this.throwIfCancelRequested();

      this.context = new AudioContext({ latencyHint: 'interactive' });
      await this.context.resume();
      this.throwIfCancelRequested();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
      this.silentOutput = this.context.createGain();
      this.silentOutput.gain.value = 0;
      this.resampler = new StreamingPcmResampler(this.context.sampleRate);

      const response = await bridge.localMeetingStart({ title: title?.trim() || undefined });
      const recorder = response.recorder as { sessionId?: unknown; startedAt?: unknown } | undefined;
      if (typeof recorder?.sessionId !== 'string' || !recorder.sessionId) {
        throw new Error('Desktop recorder did not return a meeting session ID.');
      }
      this.sessionId = recorder.sessionId;
      this.startedAt = typeof recorder.startedAt === 'string' ? recorder.startedAt : new Date().toISOString();
      this.throwIfCancelRequested();

      this.processor.onaudioprocess = (event) => {
        if (this.phase !== 'recording' || !this.resampler) return;
        // getChannelData is owned by Web Audio and reused after this callback.
        // Resampling synchronously produces our own immutable chunk.
        const samples = this.resampler.append(event.inputBuffer.getChannelData(0));
        if (samples.length > 0) this.enqueue(float32ToPcm16(samples));
      };
      this.source.connect(this.processor);
      this.processor.connect(this.silentOutput);
      this.silentOutput.connect(this.context.destination);
      this.setPhase('recording');
      this.elapsedTimer = window.setInterval(() => this.emit(), 1000);
      return this.state();
    } catch (error) {
      await this.releaseMedia();
      if (this.sessionId && bridge.localMeetingCancel) {
        await bridge.localMeetingCancel(this.sessionId).catch(() => undefined);
      }
      this.sessionId = null;
      this.startedAt = null;
      this.writeError = new Error(captureErrorMessage(error));
      this.setPhase('error');
      throw this.writeError;
    }
  }

  async stop(): Promise<Record<string, unknown>> {
    const bridge = clemmy();
    const sessionId = this.sessionId;
    if (!sessionId || !bridge?.localMeetingStop) throw new Error('no local meeting is recording');
    if (this.phase === 'stopping') throw new Error('local meeting is already stopping');

    this.setPhase('stopping');
    const finalSamples = this.resampler?.flush();
    if (finalSamples?.length && !this.writeError) this.enqueue(float32ToPcm16(finalSamples));
    await this.releaseMedia();
    await this.writeQueue;
    const priorWriteError = this.writeError;

    try {
      const result = await bridge.localMeetingStop(sessionId);
      this.reset();
      if (priorWriteError) {
        throw new Error(`The recording stopped early (${priorWriteError.message}). The captured portion was saved.`);
      }
      return result;
    } catch (error) {
      // If main already finalized the WAV, keep the client idle; retrying stop
      // with the same session would only hide the durable recording.
      this.reset();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    const sessionId = this.sessionId;
    const bridge = clemmy();
    await this.releaseMedia();
    await this.writeQueue;
    if (sessionId && bridge?.localMeetingCancel) await bridge.localMeetingCancel(sessionId);
    this.reset();
  }

  private enqueue(chunk: ArrayBuffer): void {
    if (this.writeError || !this.sessionId) return;
    const sessionId = this.sessionId;
    const bridge = clemmy();
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.writeError) return;
      if (!bridge?.localMeetingAppend) throw new Error('desktop recording bridge disconnected');
      await bridge.localMeetingAppend(sessionId, chunk);
    }).catch((error) => {
      if (!this.writeError) {
        this.writeError = new Error(captureErrorMessage(error));
        this.setPhase('error');
        // Stop listening immediately after a write failure. The valid prefix
        // remains open in main and the UI offers "Stop & transcribe" to save it.
        void this.releaseMedia();
      }
    });
  }

  private releaseMedia(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    this.releasePromise = this.releaseMediaNow().finally(() => {
      this.releasePromise = null;
    });
    return this.releasePromise;
  }

  private async releaseMediaNow(): Promise<void> {
    if (this.elapsedTimer !== null) window.clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
    if (this.processor) this.processor.onaudioprocess = null;
    this.source?.disconnect();
    this.processor?.disconnect();
    this.silentOutput?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close().catch(() => undefined);
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.silentOutput = null;
    this.resampler = null;
  }

  private reset(): void {
    if (this.elapsedTimer !== null) window.clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
    this.sessionId = null;
    this.startedAt = null;
    this.writeError = null;
    this.writeQueue = Promise.resolve();
    this.setPhase('idle');
  }

  private setPhase(phase: LocalMeetingCapturePhase): void {
    this.phase = phase;
    this.emit();
  }

  private emit(): void {
    this.handlers.onState?.(this.state());
  }

  private throwIfCancelRequested(): void {
    if (this.cancelRequested) throw new Error('Local meeting recording start was cancelled.');
  }
}
