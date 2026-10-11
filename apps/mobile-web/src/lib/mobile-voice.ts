import { speakVoice, transcribeVoice } from './api';
import { StreamingPcmResampler, float32ToPcm16, pcm16Seconds, pcm16ToWav } from './pcm';
import { microphoneProblem } from './dictation-support';
import { spokenWords, voiceTurnEnded, voiceUtterances, voiceUtteranceCurrent, type VoiceChatMessage, type VoiceUtterance } from './voice-turns';

export type { VoiceChatMessage } from './voice-turns';
export type VoiceSpeech = Blob | { text: string; fallback: 'system' };
export type MobileVoicePhase = 'off' | 'starting' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
export interface MobileVoiceState { enabled: boolean; phase: MobileVoicePhase; heard: string; error: string }
export interface MobileVoiceConversation {
  scope: string;
  messages: readonly VoiceChatMessage[];
  busy: boolean;
  /** Check stillCurrent after any asynchronous setup, immediately before admission. */
  onSend: (text: string, stillCurrent: () => boolean) => Promise<void>;
}
/** Injectable boundaries keep lifecycle tests away from real audio and providers. */
export interface MobileVoiceAudio {
  unlock(): Promise<void>;
  listen(onUtterance: (wav: Blob) => void, signal: AbortSignal): Promise<void>;
  stopListening(): void;
  play(speech: VoiceSpeech, signal: AbortSignal): Promise<void>;
  close(): void;
}
export interface MobileVoiceDependencies {
  createAudio: (onError: (error: unknown) => void) => MobileVoiceAudio;
  transcribe: (wav: Blob, signal: AbortSignal) => Promise<string>;
  speak: (text: string, signal: AbortSignal) => Promise<VoiceSpeech>;
}
const defaultDependencies: MobileVoiceDependencies = {
  createAudio: onError => new BrowserVoiceAudio(onError),
  transcribe: async (wav, signal) => (await transcribeVoice(wav, signal)).text,
  speak: speakVoice,
};
const errorWords = (error: unknown) => error instanceof Error ? error.message : 'Voice stopped. Tap Talk to Clem to try again.';

/** One foreground conversation, one half-duplex loop. Stop cancels capture,
 * transcription and playback, but never pretends to cancel an admitted chat. */
export class MobileVoiceController {
  private state: MobileVoiceState = { enabled: false, phase: 'off', heard: '', error: '' };
  private listeners = new Set<() => void>();
  private conversation: MobileVoiceConversation | null = null;
  private generation = 0;
  private audio: MobileVoiceAudio | null = null;
  private unlocked = false;
  private capture: AbortController | null = null;
  private operation: AbortController | null = null;
  private processing = false;
  private awaitingTurn = false;
  private turnFrom = 0;
  private baseline = new Set<string>();
  private heard = new Map<string, string>();
  private queue: VoiceUtterance[] = [];
  private activeUtterance: VoiceUtterance | null = null;

  constructor(private readonly deps: MobileVoiceDependencies = defaultDependencies) {}
  getSnapshot = (): MobileVoiceState => this.state;
  clearError(): void { if (!this.state.enabled) this.update({ error: '', heard: '' }); }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  observe(conversation: MobileVoiceConversation): void {
    if (this.conversation && this.conversation.scope !== conversation.scope) this.stop();
    this.conversation = { ...conversation };
    if (!this.state.enabled) return;
    if (this.awaitingTurn && !conversation.busy && conversation.messages.slice(this.turnFrom)
      .some(message => message.role === 'assistant' && !message.checkIn && message.status === 'stopped')) {
      this.stop();
      return;
    }
    this.queue = this.queue.filter(utterance => {
      if (voiceUtteranceCurrent(utterance, conversation.messages)) return true;
      this.heard.delete(utterance.key);
      return false;
    });
    if (this.activeUtterance && !voiceUtteranceCurrent(this.activeUtterance, conversation.messages)) {
      this.heard.delete(this.activeUtterance.key);
      this.activeUtterance = null;
      this.operation?.abort(); this.operation = null;
      this.processing = false;
    }
    for (const utterance of voiceUtterances(conversation.messages, this.heard, this.baseline)) {
      this.heard.set(utterance.key, utterance.text);
      const words = utterance.text.slice(0, 900).trim();
      if (words) this.queue.push({ ...utterance, text: words });
    }
    if (this.awaitingTurn && !conversation.busy && voiceTurnEnded(conversation.messages, this.turnFrom)) this.awaitingTurn = false;
    if (conversation.busy || this.queue.length > 0) this.closeMic();
    this.pump();
  }
  /** Invoke directly from the Start button, before awaiting any work. */
  async start(): Promise<void> {
    if (this.state.enabled || !this.conversation) return;
    const generation = ++this.generation;
    this.baseline = new Set(this.conversation.messages.map(message => message.id));
    this.heard.clear(); this.queue = []; this.awaitingTurn = false;
    this.update({ enabled: true, phase: 'starting', heard: '', error: '' });
    if (!this.current(generation)) return;
    try {
      const audio = this.deps.createAudio(error => { if (this.current(generation)) this.fail(error); });
      this.audio = audio;
      // BrowserVoiceAudio creates and resumes output synchronously in this tap.
      await audio.unlock();
      if (!this.current(generation)) return;
      this.unlocked = true;
      this.pump();
    } catch (error) { if (this.current(generation)) this.fail(error); }
  }
  stop(): void {
    ++this.generation;
    this.closeMic();
    this.operation?.abort(); this.operation = null;
    this.audio?.close(); this.audio = null;
    this.unlocked = false; this.processing = false; this.awaitingTurn = false; this.queue = []; this.activeUtterance = null;
    this.update({ enabled: false, phase: 'off' });
  }
  private current(generation: number): boolean { return this.state.enabled && this.generation === generation; }
  private fail(error: unknown): void { this.stop(); this.update({ error: errorWords(error) }); }
  private closeMic(): void { this.capture?.abort(); this.capture = null; this.audio?.stopListening(); }
  private update(patch: Partial<MobileVoiceState>): void {
    if (Object.entries(patch).every(([key, value]) => this.state[key as keyof MobileVoiceState] === value)) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private pump(): void {
    if (!this.state.enabled || !this.unlocked || this.processing || !this.audio || !this.conversation) return;
    if (this.queue.length > 0) { void this.sayNext(); return; }
    if (this.awaitingTurn || this.conversation.busy) { this.closeMic(); this.update({ phase: 'thinking' }); return; }
    if (this.capture) return;
    const generation = this.generation;
    const capture = new AbortController(); this.capture = capture;
    this.update({ phase: 'starting' });
    void this.audio.listen(wav => {
      if (!this.current(generation) || this.capture !== capture) return;
      this.closeMic();
      void this.heardUtterance(wav, generation);
    }, capture.signal).then(() => {
      if (this.current(generation) && this.capture === capture) this.update({ phase: 'listening' });
    }).catch(error => { if (this.current(generation) && !capture.signal.aborted) this.fail(error); });
  }
  private async heardUtterance(wav: Blob, generation: number): Promise<void> {
    this.processing = true;
    const operation = new AbortController(); this.operation = operation;
    this.update({ phase: 'transcribing' });
    try {
      const words = spokenWords(await this.deps.transcribe(wav, operation.signal));
      if (!this.current(generation)) return;
      if (!words) return;
      this.update({ heard: words });
      if (!this.conversation || this.conversation.busy) throw new Error('Clem started another turn. Your spoken message is below; send it when that turn finishes.');
      const conversation = this.conversation;
      this.turnFrom = conversation.messages.length;
      this.awaitingTurn = true;
      this.update({ phase: 'thinking' });
      await conversation.onSend(words, () => this.current(generation) && this.conversation?.scope === conversation.scope);
    } catch (error) { if (this.current(generation)) this.fail(error); }
    finally {
      if (this.current(generation)) {
        if (this.operation === operation) this.operation = null;
        this.processing = false;
        this.pump();
      }
    }
  }
  private async sayNext(): Promise<void> {
    const generation = this.generation;
    const utterance = this.queue.shift();
    if (!utterance || !this.audio) return;
    if (!this.conversation || !voiceUtteranceCurrent(utterance, this.conversation.messages)) {
      this.heard.delete(utterance.key); this.pump(); return;
    }
    const words = utterance.text;
    this.activeUtterance = utterance;
    this.processing = true; this.closeMic();
    const operation = new AbortController(); this.operation = operation;
    this.update({ phase: 'speaking' });
    try {
      const speech = await this.deps.speak(words, operation.signal);
      if (!this.current(generation) || operation.signal.aborted || !this.conversation
        || !voiceUtteranceCurrent(utterance, this.conversation.messages)) return;
      await this.audio!.play(speech, operation.signal);
    } catch (error) { if (this.current(generation) && !operation.signal.aborted) this.fail(error); }
    finally {
      // A revoked speech request may resolve after its replacement started.
      // Its old callback must not clear or resume the new operation.
      if (this.current(generation) && this.operation === operation) {
        this.operation = null; this.activeUtterance = null;
        this.processing = false;
        this.pump();
      }
    }
  }
}

/** Bounded audio with a short pre-roll. Quiet rooms never accumulate minutes
 * of samples, and a single breath/noise spike never submits a chat message. */
export class VoiceUtteranceBuffer {
  private readonly resampler: StreamingPcmResampler;
  private chunks: ArrayBuffer[] = [];
  private bytes = 0;
  private speakingMs = 0;
  private quietMs = 0;
  constructor(private readonly sampleRate: number) { this.resampler = new StreamingPcmResampler(sampleRate); }
  append(input: Float32Array): Blob | null {
    let sum = 0;
    for (const value of input) sum += value * value;
    const speaking = input.length > 0 && Math.sqrt(sum / input.length) > 0.012;
    const duration = input.length / this.sampleRate * 1000;
    const chunk = float32ToPcm16(this.resampler.append(input));
    this.chunks.push(chunk); this.bytes += chunk.byteLength;
    if (speaking) { this.speakingMs += duration; this.quietMs = 0; }
    else if (this.speakingMs > 0) this.quietMs += duration;
    else while (this.chunks.length > 1 && pcm16Seconds(this.bytes) > 0.3) this.bytes -= this.chunks.shift()!.byteLength;
    if (this.quietMs < 900 && pcm16Seconds(this.bytes) < 60) return null;
    const wav = this.speakingMs >= 180 ? pcm16ToWav(this.chunks) : null;
    this.chunks = []; this.bytes = 0; this.speakingMs = 0; this.quietMs = 0;
    return wav;
  }
}

const aborted = () => new DOMException('Voice stopped', 'AbortError');
const check = (signal: AbortSignal) => { if (signal.aborted) throw aborted(); };

/** Capture and output share the context unlocked by the owner's Start tap.
 * Audio never relies on a new HTMLAudioElement autoplay after a network wait. */
export class BrowserVoiceAudio implements MobileVoiceAudio {
  private context: AudioContext | null = null;
  private ready = false;
  private cancelCapture: (() => void) | null = null;
  private cancelPlayback: (() => void) | null = null;
  constructor(private readonly onError: (error: unknown) => void) {}
  async unlock(): Promise<void> {
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor || !navigator.mediaDevices?.getUserMedia) throw new Error('Voice needs microphone access in the Clem app or a secure browser.');
    const context = new AudioCtor({ latencyHint: 'interactive' }); this.context = context;
    const resumed = context.resume();
    // A graph failure must not leave a later resume rejection unobserved.
    void resumed.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const silent = context.createBufferSource();
      silent.buffer = context.createBuffer(1, 1, context.sampleRate);
      silent.connect(context.destination); silent.onended = () => silent.disconnect(); silent.start();
      await Promise.race([resumed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Audio did not start. Tap Talk to Clem to try again.')), 8_000);
      })]);
    } finally { clearTimeout(timer); }
    if (this.context !== context) return;
    if (context.state !== 'running') throw new Error('Audio could not start. Tap Talk to Clem to try again.');
    this.ready = true;
    context.onstatechange = () => {
      if (this.ready && this.context === context && context.state !== 'running') this.onError(new Error('Audio was interrupted. Tap Talk to Clem to continue.'));
    };
  }
  async listen(onUtterance: (wav: Blob) => void, signal: AbortSignal): Promise<void> {
    check(signal); this.stopListening();
    const context = this.context;
    if (!context || context.state !== 'running') throw new Error('Audio is paused. Tap Talk to Clem to continue.');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
    catch (error) { throw new Error(microphoneProblem(error).replace('tap Dictate again', 'tap Talk to Clem again')); }
    if (signal.aborted || this.context !== context) { stream.getTracks().forEach(track => track.stop()); return; }
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: ScriptProcessorNode | null = null;
    let silent: GainNode | null = null;
    const ended = () => { if (!signal.aborted) this.onError(new Error('The microphone stopped. Tap Talk to Clem to try again.')); };
    const clean = () => {
      signal.removeEventListener('abort', clean);
      for (const track of stream.getTracks()) { track.removeEventListener('ended', ended); track.stop(); }
      if (processor) { processor.onaudioprocess = null; try { processor.disconnect(); } catch { /* partially connected */ } }
      try { source?.disconnect(); } catch { /* partially connected */ }
      try { silent?.disconnect(); } catch { /* partially connected */ }
      if (this.cancelCapture === clean) this.cancelCapture = null;
    };
    this.cancelCapture = clean; signal.addEventListener('abort', clean, { once: true });
    try {
      const buffer = new VoiceUtteranceBuffer(context.sampleRate);
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      silent = context.createGain(); silent.gain.value = 0;
      processor.onaudioprocess = event => {
        if (signal.aborted) return;
        const wav = buffer.append(event.inputBuffer.getChannelData(0));
        if (wav) { clean(); onUtterance(wav); }
      };
      stream.getTracks().forEach(track => track.addEventListener('ended', ended, { once: true }));
      source.connect(processor); processor.connect(silent); silent.connect(context.destination);
    } catch (error) { clean(); throw error; }
  }
  stopListening(): void { this.cancelCapture?.(); this.cancelCapture = null; }
  async play(speech: VoiceSpeech, signal: AbortSignal): Promise<void> {
    check(signal); this.stopListening();
    if (!(speech instanceof Blob)) { await this.playSystem(speech.text, signal); return; }
    const context = this.context;
    if (!context || context.state !== 'running') throw new Error('Audio is paused. Tap Talk to Clem to continue.');
    const bytes = await speech.arrayBuffer(); check(signal);
    const buffer = await context.decodeAudioData(bytes); check(signal);
    if (this.context !== context) throw aborted();
    await new Promise<void>((resolve, reject) => {
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
      const finish = (error?: Error) => {
        signal.removeEventListener('abort', cancel); source.onended = null;
        try { source.stop(); } catch { /* already ended */ }
        try { source.disconnect(); } catch { /* already disconnected */ }
        if (this.cancelPlayback === cancel) this.cancelPlayback = null;
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(aborted()); this.cancelPlayback = cancel;
      signal.addEventListener('abort', cancel, { once: true });
      source.onended = () => finish();
      try { source.start(); } catch (error) { finish(error instanceof Error ? error : new Error('Could not play Clem’s reply.')); }
    });
  }
  private async playSystem(text: string, signal: AbortSignal): Promise<void> {
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') throw new Error('Spoken replies are unavailable on this phone. Clem’s answer is still in the conversation.');
    await new Promise<void>((resolve, reject) => {
      const utterance = new window.SpeechSynthesisUtterance(text);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimeout); clearTimeout(timeout); signal.removeEventListener('abort', cancel);
        utterance.onstart = null; utterance.onend = null; utterance.onerror = null;
        if (this.cancelPlayback === cancel) this.cancelPlayback = null;
        if (error) reject(error); else resolve();
      };
      const cancel = () => { finish(aborted()); synth.cancel(); };
      const notPlaying = () => { finish(new Error('This phone did not play the spoken reply. The answer is still in your conversation.')); synth.cancel(); };
      const startTimeout = setTimeout(notPlaying, 5_000);
      const timeout = setTimeout(notPlaying, 120_000);
      this.cancelPlayback = cancel; signal.addEventListener('abort', cancel, { once: true });
      utterance.onstart = () => clearTimeout(startTimeout);
      utterance.onend = () => finish();
      utterance.onerror = () => finish(new Error('This phone could not play the spoken reply. The answer is still in your conversation.'));
      try { synth.speak(utterance); } catch { finish(new Error('Spoken replies are unavailable on this phone.')); }
    });
  }
  close(): void {
    this.ready = false; this.stopListening(); this.cancelPlayback?.(); this.cancelPlayback = null;
    const context = this.context; this.context = null;
    if (context) { context.onstatechange = null; void context.close().catch(() => undefined); }
  }
}
