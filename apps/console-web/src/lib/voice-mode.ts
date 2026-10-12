/**
 * Voice mode: talk to Clem in the open conversation and hear her answer.
 *
 * One loop, no second brain: what the owner says is transcribed on this
 * computer and sent as an ordinary turn of the conversation they are looking
 * at, marked spoken, so the same brain, tools, memory and approvals run. What
 * Clem says back in that conversation (her first words while she works, her
 * answer, a question, a card, a finished background task) is read aloud.
 *
 * Voice mode is the owner's switch, not one screen's: once on it stays on
 * while they move between chats, and whichever chat composer is showing picks
 * it up (a new chat's first words open the conversation, and her answer is
 * still read there).
 *
 * When this computer can hold a live conversation, voice is full duplex: a
 * voice model listens and talks at the same time, and every request it hears
 * is sent here as the owner's spoken turn, so Clem's brain still answers; her
 * words go back to the voice to be said. Otherwise turn-taking is half-duplex:
 * the microphone is closed while Clem speaks and while her turn runs, and
 * opens again when she is done. Interrupting stops her and listens.
 */
import { useSyncExternalStore } from 'react';
import { NotchVoice, type NotchVoiceHandlers, type NotchVoiceOptions } from './notch-voice';
import { VoiceSpeaker, type VoiceSpeakerHandlers } from './voice-speaker';
import { heardCue, workingTick } from './voice-cues';
import { spokenWords, voiceBaseline, voiceReadableText, voiceTurnEnded, voiceTurnNoticeFacts, voiceTurnRunning, voiceUtterances, voiceUtteranceCurrent, type VoiceChatMessage, type VoiceUtterance } from './voice-turns';
import { liveSpokenText, liveVoiceAvailable, WebRtcLiveVoice, type LiveHistoryMessage, type LiveVoiceHandlers, type LiveVoiceLink } from './live-voice';

export type VoicePhase = 'off' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export interface VoiceModeState {
  /** The owner's switch. */
  enabled: boolean;
  phase: VoicePhase;
  /** The chat composer voice mode is working in right now, if one is showing. */
  surface: string | null;
  /** What the owner last said, while it is being sent. */
  heard: string;
  error: string;
  /** 'live' while a full-duplex conversation runs, 'standard' for turn by turn. */
  engine: 'live' | 'standard' | null;
  /** Why voice is running the way it is, when that is worth saying. */
  notice: string;
}

export type { VoiceChatMessage } from './voice-turns';

const SILENCE_MS = 900;
/** How often a quiet tick says she is still working while she is silent. */
const WORKING_TICK_MS = 4_000;
/** A live conversation nobody is using ends; it is billed while it runs. */
const LIVE_IDLE_MS = 180_000;
/** A composer that goes away briefly (moving between chats) keeps the live
 *  conversation; one gone longer ends it until a composer shows again. */
const LIVE_DETACHED_MS = 5_000;
/** At most one automatic reconnect per this long after an unexpected end. */
const LIVE_RECONNECT_WINDOW_MS = 60_000;
const LIVE_HISTORY_MESSAGES = 24;

const LIVE_END_WORDS: Record<string, string> = {
  expired: 'Live voice reached its time limit.',
  content: 'Live voice was ended by the voice service.',
  remote_hangup: 'Live voice was disconnected.',
  connection_lost: 'Live voice lost its connection.',
};

type Send = (text: string) => Promise<void> | void;

export interface VoiceModeDependencies {
  createSpeaker: (handlers: VoiceSpeakerHandlers) => Pick<VoiceSpeaker, 'speaking' | 'say' | 'stop'>;
  createMic: (handlers: NotchVoiceHandlers, options: NotchVoiceOptions) => Pick<NotchVoice, 'startRecording' | 'cancel'>;
  /** A full-duplex conversation, when this computer can hold one. */
  live?: { available: () => Promise<boolean>; create: (handlers: LiveVoiceHandlers) => LiveVoiceLink };
}
const defaultDependencies: VoiceModeDependencies = {
  createSpeaker: handlers => new VoiceSpeaker(handlers),
  createMic: (handlers, options) => new NotchVoice(handlers, options),
  live: { available: () => liveVoiceAvailable(), create: handlers => new WebRtcLiveVoice(handlers) },
};

export class VoiceModeController {
  private state: VoiceModeState = { enabled: false, phase: 'off', surface: null, heard: '', error: '', engine: null, notice: '' };
  private listeners = new Set<() => void>();
  private send: Send | null = null;
  private mic: Pick<NotchVoice, 'startRecording' | 'cancel'> | null = null;
  private heardKeys = new Map<string, string>();
  private baseline = new Set<string>();
  private baselinePending = true;
  private messages: readonly VoiceChatMessage[] = [];
  private awaitingTurn = false;
  private turnFrom = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private queue: VoiceUtterance[] = [];
  private activeUtterance: VoiceUtterance | null = null;
  private cancellingSpeech = false;
  private readonly speaker: Pick<VoiceSpeaker, 'speaking' | 'say' | 'stop'>;
  private live: LiveVoiceLink | null = null;
  /** Bumped whenever the live conversation is started or abandoned. */
  private liveGeneration = 0;
  /** The voice's request that the awaited turn answers. */
  private liveRequestId: string | null = null;
  private liveSending: Promise<void> = Promise.resolve();
  private liveIdle: ReturnType<typeof setTimeout> | null = null;
  private liveDetached: ReturnType<typeof setTimeout> | null = null;
  private liveReconnectedAt = 0;

  constructor(private readonly deps: VoiceModeDependencies = defaultDependencies) {
    this.speaker = deps.createSpeaker({
      onSpeaking: () => { this.closeMic(); this.update({ phase: 'speaking' }); },
      onIdle: () => {
        this.activeUtterance = null;
        if (this.cancellingSpeech) return;
        if (this.queue.length > 0) this.sayNext(); else this.afterSpeaking();
      },
      onError: message => this.update({ error: message }),
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): VoiceModeState => this.state;

  /** The owner turns voice mode on from a composer. */
  enable(surface: string, send: Send, messages: readonly VoiceChatMessage[]): void {
    this.update({ enabled: true, error: '', notice: '', engine: null });
    this.heardKeys = new Map();
    this.awaitingTurn = false;
    if (this.state.surface !== surface) { this.attach(surface, send, messages); return; }
    this.send = send;
    this.messages = messages;
    this.baselinePending = true;
    this.settleBaseline(messages);
    void this.begin();
  }

  /** The owner turns voice mode off. */
  disable(): void {
    this.closeMic();
    this.clearSpeech();
    this.endLive();
    this.awaitingTurn = false;
    this.update({ enabled: false, phase: 'off', heard: '', error: '', engine: null, notice: '' });
  }

  /** A chat composer is showing: voice mode works in its conversation. The
   *  most recently shown composer wins. */
  attach(surface: string, send: Send, messages: readonly VoiceChatMessage[]): void {
    this.send = send;
    if (this.state.surface === surface) return;
    this.closeMic();
    this.clearSpeech();
    if (this.liveDetached) { clearTimeout(this.liveDetached); this.liveDetached = null; }
    this.messages = messages;
    this.baselinePending = true;
    this.update({ surface });
    this.settleBaseline(messages);
    if (this.live) { this.live.note('The owner is now looking at a different conversation.', null); return; }
    if (!this.state.enabled || this.speaker.speaking) return;
    // A live conversation picks up even while a turn runs; turn-by-turn voice
    // listens once that turn has been answered.
    if (this.state.engine !== 'standard' || !this.awaitingTurn) void this.begin();
  }

  /** That composer is gone: stop listening until another one shows. */
  detach(surface: string): void {
    if (this.state.surface !== surface) return;
    this.closeMic();
    this.clearSpeech();
    this.send = null;
    if (this.live) {
      this.update({ surface: null });
      this.liveDetached ??= setTimeout(() => {
        this.liveDetached = null;
        if (this.state.surface || !this.live) return;
        this.endLive();
        this.update({ engine: null, phase: this.state.enabled ? 'thinking' : 'off' });
      }, LIVE_DETACHED_MS);
      return;
    }
    this.update({ surface: null, ...(this.speaker.speaking ? {} : { phase: this.state.enabled ? 'thinking' as const : 'off' as const }) });
  }

  /** Keep the latest send for the showing composer (it closes over state). */
  setSend(surface: string, send: Send): void {
    if (this.state.surface === surface) this.send = send;
  }

  /** Stop Clem mid-sentence and listen. */
  interrupt(): void {
    if (this.live) { if (this.state.phase === 'speaking') this.live.direct('Stop talking now and listen to the owner.'); return; }
    if (this.state.phase === 'speaking') { this.clearSpeech(); this.afterSpeaking(); }
  }

  /** The showing conversation changed: read aloud whatever Clem newly said. */
  observe(surface: string, messages: readonly VoiceChatMessage[]): void {
    if (this.state.surface !== surface) return;
    this.messages = messages;
    if (!this.state.enabled) return;
    this.settleBaseline(messages);
    if (this.baselinePending) return;
    if (this.state.engine !== 'standard') { this.relayToLive(messages); return; }
    this.queue = this.queue.filter(utterance => {
      if (voiceUtteranceCurrent(utterance, messages)) return true;
      this.heardKeys.delete(utterance.key);
      return false;
    });
    let revokedSpeech = false;
    if (this.activeUtterance && !voiceUtteranceCurrent(this.activeUtterance, messages)) {
      revokedSpeech = true;
      this.heardKeys.delete(this.activeUtterance.key);
      this.activeUtterance = null;
      // stop() invokes onIdle synchronously: do not reopen capture before the
      // replacement message has been inspected and queued.
      this.cancellingSpeech = true;
      try { this.speaker.stop(); } finally { this.cancellingSpeech = false; }
    }
    for (const utterance of voiceUtterances(messages, this.heardKeys, this.baseline)) {
      this.heardKeys.set(utterance.key, utterance.text);
      this.queue.push(utterance);
    }
    if (this.queue.length > 0 && !this.speaker.speaking) this.sayNext();
    else if (revokedSpeech && !this.speaker.speaking) this.afterSpeaking();
    if (this.awaitingTurn && voiceTurnEnded(messages, this.turnFrom)) {
      this.awaitingTurn = false;
      if (!this.speaker.speaking && this.state.phase === 'thinking') void this.listen();
    }
  }

  /** Keep pending text here so message withdrawal can revoke it before TTS
   * generation; the speaker sees only the one currently eligible utterance. */
  private sayNext(): void {
    if (!this.state.enabled || !this.state.surface || this.speaker.speaking) return;
    while (this.queue.length > 0) {
      const utterance = this.queue.shift()!;
      if (!voiceUtteranceCurrent(utterance, this.messages)) { this.heardKeys.delete(utterance.key); continue; }
      this.activeUtterance = utterance;
      this.speaker.say(utterance.text);
      return;
    }
    this.afterSpeaking();
  }

  private clearSpeech(): void {
    this.queue = []; this.activeUtterance = null;
    this.cancellingSpeech = true;
    try { this.speaker.stop(); } finally { this.cancellingSpeech = false; }
  }

  /** A newly shown conversation loads after it appears: its "already seen"
   *  line is drawn on the first load that has messages. */
  private settleBaseline(messages: readonly VoiceChatMessage[]): void {
    if (!this.baselinePending || messages.length === 0) return;
    const { seen, turnFrom } = voiceBaseline(messages, this.awaitingTurn);
    this.baseline = seen;
    this.turnFrom = turnFrom;
    this.baselinePending = false;
  }

  private afterSpeaking(): void {
    if (!this.state.enabled) return;
    if (this.awaitingTurn && !voiceTurnEnded(this.messages, this.turnFrom)) { this.update({ phase: 'thinking' }); return; }
    this.awaitingTurn = false;
    void this.listen();
  }

  private async listen(): Promise<void> {
    if (!this.state.enabled || !this.state.surface) return;
    this.closeMic();
    this.update({ phase: 'listening' });
    const mic = this.deps.createMic({
      onStatus: (status, label) => {
        if (this.mic !== mic) return;
        if (status === 'recording') this.update({ phase: 'listening' });
        else if (status === 'transcribing') this.update({ phase: 'transcribing' });
        else if (status === 'error') this.update({ error: label || 'The microphone stopped.' });
      },
    }, {
      autoSend: false,
      interim: false,
      silenceMs: SILENCE_MS,
      onUtterance: (text) => { if (this.mic === mic) void this.heardUtterance(text); },
    });
    this.mic = mic;
    try {
      await mic.startRecording();
    } catch (error) {
      if (this.mic !== mic) return;
      this.mic = null;
      this.update({ enabled: false, phase: 'off', error: error instanceof Error ? error.message : 'The microphone is not available.' });
    }
  }

  private async heardUtterance(text: string): Promise<void> {
    this.closeMic();
    const words = spokenWords(text);
    if (!words || !this.send) { void this.listen(); return; }
    // Spoken while a turn still runs, the words steer that turn: its answer
    // ends this one. Otherwise the answer comes after what is on screen.
    const running = voiceTurnRunning(this.messages)
      ? this.messages.map((message) => message.role === 'assistant' && !message.checkIn).lastIndexOf(true)
      : -1;
    this.turnFrom = running >= 0 ? running : this.messages.length;
    this.awaitingTurn = true;
    heardCue();
    this.update({ phase: 'thinking', heard: words, error: '' });
    try {
      await this.send(words);
    } catch (error) {
      this.awaitingTurn = false;
      this.update({ error: error instanceof Error ? error.message : 'Could not send that.' });
      void this.listen();
    }
  }

  /** Start talking: live when this computer can hold a live conversation,
   *  turn by turn otherwise. */
  private async begin(): Promise<void> {
    if (!this.state.enabled || !this.state.surface || this.live) return;
    if (this.state.engine === 'standard') { void this.listen(); return; }
    const generation = ++this.liveGeneration;
    const available = this.deps.live ? await this.deps.live.available().catch(() => false) : false;
    if (generation !== this.liveGeneration || !this.state.enabled || !this.state.surface || this.live) return;
    if (!available) { this.update({ engine: 'standard' }); void this.listen(); return; }
    this.startLive(generation);
  }

  private startLive(generation: number): void {
    this.closeMic();
    this.clearSpeech();
    this.update({ engine: 'live', phase: 'connecting' });
    const link: LiveVoiceLink = this.deps.live!.create({
      onLive: () => { if (this.live === link) { this.update({ phase: this.awaitingTurn ? 'thinking' : 'listening' }); this.armLiveIdle(); } },
      onRequest: ({ id, words }) => { if (this.live === link) this.liveSending = this.liveSending.then(() => this.liveRequest(link, id, words)); },
      onSpeaking: (speaking) => {
        if (this.live !== link) return;
        this.armLiveIdle();
        this.update({ phase: speaking ? 'speaking' : this.awaitingTurn ? 'thinking' : 'listening' });
      },
      onHearing: () => { if (this.live === link) this.armLiveIdle(); },
      onClosed: (reason, expected) => { if (this.live === link) this.liveEnded(reason, expected); },
      onError: (message) => { if (this.live === link) console.warn('live voice:', message); },
    });
    this.live = link;
    link.start(liveHistory(this.messages)).catch((error: unknown) => {
      if (this.live !== link || generation !== this.liveGeneration) return;
      this.live = null;
      // Turn-by-turn voice carries the conversation when live voice cannot.
      const reason = error instanceof Error ? error.message : 'it could not connect';
      this.update({ engine: 'standard', notice: `Live voice is unavailable: ${reason} Using turn-by-turn voice.` });
      void this.listen();
    });
  }

  /** The voice asked Clem for something: send the owner's words as their turn. */
  private async liveRequest(link: LiveVoiceLink, id: string, heard: string): Promise<void> {
    if (this.live !== link) return;
    const words = spokenWords(heard);
    if (!words) { link.direct('The owner\'s last request was not heard clearly. Ask them to say it again.'); return; }
    if (!this.send) { link.direct('No conversation is open on screen, so that request has not reached Clem. Ask the owner to open a chat.'); return; }
    const running = voiceTurnRunning(this.messages)
      ? this.messages.map((message) => message.role === 'assistant' && !message.checkIn).lastIndexOf(true)
      : -1;
    this.turnFrom = running >= 0 ? running : this.messages.length;
    this.awaitingTurn = true;
    this.liveRequestId = id;
    this.update({ heard: words, error: '', ...(this.state.phase === 'speaking' ? {} : { phase: 'thinking' as const }) });
    try {
      await this.send(words);
    } catch (error) {
      if (this.live !== link) return;
      this.awaitingTurn = false;
      this.liveRequestId = null;
      const message = error instanceof Error ? error.message : 'Could not send that.';
      this.update({ error: message, ...(this.state.phase === 'thinking' ? { phase: 'listening' as const } : {}) });
      link.direct(`That request did not reach Clem: ${message} Tell the owner briefly.`);
    }
  }

  /** What Clem newly said goes to the voice, tied to the request it answers. */
  private relayToLive(messages: readonly VoiceChatMessage[]): void {
    const link = this.live;
    const requestId = this.awaitingTurn ? this.liveRequestId : null;
    for (const utterance of voiceUtterances(messages, this.heardKeys, this.baseline)) {
      this.heardKeys.set(utterance.key, utterance.text);
      const words = liveSpokenText(utterance.text);
      if (!link || !words) continue;
      if (utterance.kind === 'progress') link.note(`Clem's progress: ${words}`, requestId);
      else link.say(words, requestId);
      this.armLiveIdle();
    }
    if (this.awaitingTurn && voiceTurnEnded(messages, this.turnFrom)) {
      // A turn that ended on the app's notice has no words of Clem's for the
      // request; the voice gets the typed fact so it can tell the owner.
      if (link) for (const fact of voiceTurnNoticeFacts(messages, this.turnFrom)) link.note(fact, requestId);
      this.awaitingTurn = false;
      this.liveRequestId = null;
      if (this.state.phase === 'thinking') this.update({ phase: 'listening' });
    }
  }

  /** A live conversation with nothing said and nothing running ends. */
  private armLiveIdle(): void {
    if (this.liveIdle) clearTimeout(this.liveIdle);
    this.liveIdle = setTimeout(() => {
      this.liveIdle = null;
      if (!this.live) return;
      if (this.awaitingTurn) { this.armLiveIdle(); return; }
      this.endLive();
      this.update({ enabled: false, phase: 'off', engine: null, error: 'Live voice ended after a few quiet minutes.' });
    }, LIVE_IDLE_MS);
  }

  private liveEnded(reason: string, expected: boolean): void {
    this.live = null;
    this.liveRequestId = null;
    if (this.liveIdle) { clearTimeout(this.liveIdle); this.liveIdle = null; }
    if (!this.state.enabled || expected) return;
    const now = Date.now();
    if (reason !== 'content' && this.state.surface && now - this.liveReconnectedAt > LIVE_RECONNECT_WINDOW_MS) {
      this.liveReconnectedAt = now;
      this.startLive(++this.liveGeneration);
      return;
    }
    this.awaitingTurn = false;
    this.update({ enabled: false, phase: 'off', engine: null, error: LIVE_END_WORDS[reason] ?? 'Live voice ended.' });
  }

  private endLive(): void {
    const link = this.live;
    this.live = null;
    this.liveRequestId = null;
    this.liveGeneration += 1;
    if (this.liveIdle) { clearTimeout(this.liveIdle); this.liveIdle = null; }
    if (this.liveDetached) { clearTimeout(this.liveDetached); this.liveDetached = null; }
    link?.close();
  }

  private closeMic(): void {
    const mic = this.mic;
    this.mic = null;
    mic?.cancel();
  }

  private update(patch: Partial<VoiceModeState>): void {
    const before = this.state.phase;
    this.state = { ...this.state, ...patch };
    if (this.state.phase !== before) this.phaseChanged();
    for (const listener of this.listeners) listener();
  }

  /** While she works in silence a quiet tick keeps the line alive; it stops
   *  the moment she speaks, listens or voice mode ends. */
  private phaseChanged(): void {
    if (this.state.phase === 'thinking' && this.state.engine !== 'live') {
      this.tick ??= setInterval(() => {
        if (this.state.phase === 'thinking' && !this.speaker.speaking) workingTick();
      }, WORKING_TICK_MS);
    } else if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }
}

/** The recent conversation the voice starts with. */
function liveHistory(messages: readonly VoiceChatMessage[]): LiveHistoryMessage[] {
  return messages
    .filter(message => !message.checkIn)
    .map(message => ({ role: message.role, text: voiceReadableText(message) }))
    .filter(message => message.text)
    .slice(-LIVE_HISTORY_MESSAGES);
}

export const voiceMode = new VoiceModeController();

export function useVoiceMode(): VoiceModeState {
  return useSyncExternalStore(voiceMode.subscribe, voiceMode.getSnapshot, voiceMode.getSnapshot);
}
