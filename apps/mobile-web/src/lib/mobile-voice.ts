import { speakVoice, transcribeVoice } from './api';
import { StreamingPcmResampler, float32ToPcm16, pcm16Seconds, pcm16ToWav } from './pcm';
import { microphoneProblem } from './dictation-support';
import { spokenWords, voiceReadableText, voiceTurnEnded, voiceTurnNoticeFacts, voiceUtterances, voiceUtteranceCurrent, type VoiceChatMessage, type VoiceUtterance } from './voice-turns';
import { liveSpokenText, type LiveHistoryMessage, type LiveVoiceHandlers, type LiveVoiceLink } from '@clem/chat-engine';
import { PhoneLiveVoice, phoneLiveVoiceAvailable } from './live-voice';

export type { VoiceChatMessage } from './voice-turns';
export type VoiceSpeech = Blob | { text: string; fallback: 'system' };
export type MobileVoicePhase = 'off' | 'starting' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
export interface MobileVoiceState {
  enabled: boolean; phase: MobileVoicePhase; heard: string; error: string;
  /** 'live' for a full-duplex conversation, 'standard' for turn by turn. */
  engine: 'live' | 'standard' | null;
}
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
  /** A full-duplex conversation, when the Mac can hold one. */
  live?: { available: () => Promise<boolean>; create: (handlers: LiveVoiceHandlers) => LiveVoiceLink };
}
const defaultDependencies: MobileVoiceDependencies = {
  createAudio: onError => new BrowserVoiceAudio(onError),
  transcribe: async (wav, signal) => (await transcribeVoice(wav, signal)).text,
  speak: speakVoice,
  live: { available: phoneLiveVoiceAvailable, create: handlers => new PhoneLiveVoice(handlers) },
};
/** A live conversation nobody is using ends; it is billed while it runs. */
const LIVE_IDLE_MS = 180_000;
const LIVE_END_WORDS: Record<string, string> = {
  expired: 'Live voice reached its time limit. Tap Talk to Clem to start again.',
  content: 'Live voice was ended by the voice service.',
  remote_hangup: 'Live voice was disconnected. Tap Talk to Clem to start again.',
  connection_lost: 'Live voice lost its connection. Tap Talk to Clem to start again.',
};
const errorWords = (error: unknown) => error instanceof Error ? error.message : 'Voice stopped. Tap Talk to Clem to try again.';

/** One foreground conversation. Live when the Mac can hold one: the voice
 * listens and talks at once and every request it hears is sent as the owner's
 * spoken turn, so Clem's brain answers and her words go back to be said.
 * Otherwise one half-duplex loop. Stop cancels capture, transcription and
 * playback, but never pretends to cancel an admitted chat. */
export class MobileVoiceController {
  private state: MobileVoiceState = { enabled: false, phase: 'off', heard: '', error: '', engine: null };
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
  /** Learned before the tap, so the tap itself starts the right voice. */
  private liveAvailable: boolean | null = null;
  private liveChecking = false;
  private live: LiveVoiceLink | null = null;
  /** The voice's request that the awaited turn answers. */
  private liveRequestId: string | null = null;
  /** A request heard while Clem was still working goes once she finishes. */
  private heldRequest: { id: string; words: string } | null = null;
  private liveSending = false;
  private liveIdle: ReturnType<typeof setTimeout> | null = null;

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
    this.learnLive();
    if (!this.state.enabled) return;
    if (this.awaitingTurn && !conversation.busy && conversation.messages.slice(this.turnFrom)
      .some(message => message.role === 'assistant' && !message.checkIn && message.status === 'stopped')) {
      this.stop();
      return;
    }
    if (this.state.engine === 'live') { this.relayToLive(conversation); return; }
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
    if (this.deps.live && this.liveAvailable) { this.startLive(generation); return; }
    this.update({ enabled: true, phase: 'starting', heard: '', error: '', engine: 'standard' });
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
    const live = this.live;
    this.live = null; this.liveRequestId = null; this.heldRequest = null; this.liveSending = false;
    if (this.liveIdle) { clearTimeout(this.liveIdle); this.liveIdle = null; }
    live?.close();
    this.unlocked = false; this.processing = false; this.awaitingTurn = false; this.queue = []; this.activeUtterance = null;
    this.update({ enabled: false, phase: 'off', engine: null });
  }
  private current(generation: number): boolean { return this.state.enabled && this.generation === generation; }

  private learnLive(): void {
    if (this.liveAvailable !== null || this.liveChecking || !this.deps.live) return;
    this.liveChecking = true;
    void this.deps.live.available().then(available => { this.liveAvailable = available; }, () => { this.liveAvailable = false; })
      .finally(() => { this.liveChecking = false; });
  }

  private startLive(generation: number): void {
    this.update({ enabled: true, phase: 'starting', heard: '', error: '', engine: 'live' });
    const link: LiveVoiceLink = this.deps.live!.create({
      onLive: () => { if (this.live === link) { this.update({ phase: this.awaitingTurn ? 'thinking' : 'listening' }); this.armLiveIdle(); } },
      onRequest: ({ id, words }) => { if (this.live === link) this.liveRequest(link, id, words, generation); },
      onSpeaking: (speaking) => {
        if (this.live !== link) return;
        this.armLiveIdle();
        this.update({ phase: speaking ? 'speaking' : this.awaitingTurn ? 'thinking' : 'listening' });
      },
      onHearing: () => { if (this.live === link) this.armLiveIdle(); },
      onClosed: (reason, expected) => {
        if (this.live !== link) return;
        this.live = null;
        if (expected || !this.state.enabled) return;
        this.stop();
        this.update({ error: LIVE_END_WORDS[reason] ?? 'Live voice ended. Tap Talk to Clem to start again.' });
      },
      onError: (message) => { if (this.live === link) console.warn('live voice:', message); },
    });
    this.live = link;
    link.start(liveHistory(this.conversation?.messages ?? [])).catch((error: unknown) => {
      if (this.live !== link || !this.current(generation)) return;
      this.live = null;
      // The next tap talks turn by turn; this one says why live voice did not start.
      this.liveAvailable = false;
      this.fail(new Error(`Live voice could not start: ${errorWords(error)} Tap Talk to Clem to talk turn by turn.`));
    });
  }

  /** The voice asked Clem for something: the owner's words become their turn,
   *  or wait for the turn Clem is still working on. */
  private liveRequest(link: LiveVoiceLink, id: string, heard: string, generation: number): void {
    const words = spokenWords(heard);
    if (!words) { link.direct('The owner\'s last request was not heard clearly. Ask them to say it again.'); return; }
    if (this.heldRequest || this.liveSending || this.conversation?.busy) {
      if (this.heldRequest) {
        this.heldRequest.words = `${this.heldRequest.words} ${words}`;
        link.note('This joins the request waiting for Clem; she answers it there.', id);
      } else {
        this.heldRequest = { id, words };
        link.note('Clem is still finishing the previous request; this one goes to her as soon as she does.', id);
      }
      return;
    }
    void this.sendLive(link, id, words, generation);
  }

  private async sendLive(link: LiveVoiceLink, id: string, words: string, generation: number): Promise<void> {
    const conversation = this.conversation;
    if (!conversation) return;
    this.liveSending = true;
    this.turnFrom = conversation.messages.length;
    this.awaitingTurn = true;
    this.liveRequestId = id;
    this.update({ heard: words, ...(this.state.phase === 'speaking' ? {} : { phase: 'thinking' as const }) });
    try {
      await conversation.onSend(words, () => this.current(generation) && this.live === link && this.conversation?.scope === conversation.scope);
    } catch (error) {
      if (!this.current(generation) || this.live !== link) return;
      this.awaitingTurn = false;
      this.liveRequestId = null;
      if (this.state.phase === 'thinking') this.update({ phase: 'listening' });
      link.direct(`That request did not reach Clem: ${errorWords(error)} Tell the owner briefly.`);
    } finally {
      if (this.current(generation) && this.live === link) {
        this.liveSending = false;
        this.sendHeld(link, generation);
      }
    }
  }

  private sendHeld(link: LiveVoiceLink, generation: number): void {
    const held = this.heldRequest;
    if (!held || this.liveSending || this.conversation?.busy) return;
    this.heldRequest = null;
    void this.sendLive(link, held.id, held.words, generation);
  }

  /** What Clem newly said goes to the voice, tied to the request it answers. */
  private relayToLive(conversation: MobileVoiceConversation): void {
    const link = this.live;
    const requestId = this.awaitingTurn ? this.liveRequestId : null;
    for (const utterance of voiceUtterances(conversation.messages, this.heard, this.baseline)) {
      this.heard.set(utterance.key, utterance.text);
      const words = liveSpokenText(utterance.text);
      if (!link || !words) continue;
      if (utterance.kind === 'progress') link.note(`Clem's progress: ${words}`, requestId);
      else link.say(words, requestId);
      this.armLiveIdle();
    }
    if (this.awaitingTurn && !conversation.busy && voiceTurnEnded(conversation.messages, this.turnFrom)) {
      // A turn that ended on the app's notice has no words of Clem's for the
      // request; the voice gets the typed fact so it can tell the owner.
      if (link) for (const fact of voiceTurnNoticeFacts(conversation.messages, this.turnFrom)) link.note(fact, requestId);
      this.awaitingTurn = false;
      this.liveRequestId = null;
      if (this.state.phase === 'thinking') this.update({ phase: 'listening' });
    }
    if (link && !conversation.busy) this.sendHeld(link, this.generation);
  }

  /** A live conversation with nothing said and nothing running ends. */
  private armLiveIdle(): void {
    if (this.liveIdle) clearTimeout(this.liveIdle);
    this.liveIdle = setTimeout(() => {
      this.liveIdle = null;
      if (!this.live) return;
      if (this.awaitingTurn || this.heldRequest) { this.armLiveIdle(); return; }
      this.stop();
      this.update({ error: 'Live voice ended after a few quiet minutes.' });
    }, LIVE_IDLE_MS);
  }
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

/** The recent conversation the voice starts with. */
function liveHistory(messages: readonly VoiceChatMessage[]): LiveHistoryMessage[] {
  return messages
    .filter(message => !message.checkIn)
    .map(message => ({ role: message.role, text: voiceReadableText(message) }))
    .filter(message => message.text)
    .slice(-24);
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
