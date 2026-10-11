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
 * still read there). Turn-taking is half-duplex: the microphone is closed while
 * Clem speaks and while her turn runs, and opens again when she is done.
 * Interrupting stops her and listens.
 */
import { useSyncExternalStore } from 'react';
import { NotchVoice, type NotchVoiceHandlers, type NotchVoiceOptions } from './notch-voice';
import { VoiceSpeaker, type VoiceSpeakerHandlers } from './voice-speaker';
import { heardCue, workingTick } from './voice-cues';
import { spokenWords, voiceBaseline, voiceTurnEnded, voiceTurnRunning, voiceUtterances, voiceUtteranceCurrent, type VoiceChatMessage, type VoiceUtterance } from './voice-turns';

export type VoicePhase = 'off' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export interface VoiceModeState {
  /** The owner's switch. */
  enabled: boolean;
  phase: VoicePhase;
  /** The chat composer voice mode is working in right now, if one is showing. */
  surface: string | null;
  /** What the owner last said, while it is being sent. */
  heard: string;
  error: string;
}

export type { VoiceChatMessage } from './voice-turns';

const SILENCE_MS = 900;
/** How often a quiet tick says she is still working while she is silent. */
const WORKING_TICK_MS = 4_000;

type Send = (text: string) => Promise<void> | void;

export interface VoiceModeDependencies {
  createSpeaker: (handlers: VoiceSpeakerHandlers) => Pick<VoiceSpeaker, 'speaking' | 'say' | 'stop'>;
  createMic: (handlers: NotchVoiceHandlers, options: NotchVoiceOptions) => Pick<NotchVoice, 'startRecording' | 'cancel'>;
}
const defaultDependencies: VoiceModeDependencies = {
  createSpeaker: handlers => new VoiceSpeaker(handlers),
  createMic: (handlers, options) => new NotchVoice(handlers, options),
};

export class VoiceModeController {
  private state: VoiceModeState = { enabled: false, phase: 'off', surface: null, heard: '', error: '' };
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
    this.update({ enabled: true, error: '' });
    this.heardKeys = new Map();
    this.awaitingTurn = false;
    if (this.state.surface !== surface) { this.attach(surface, send, messages); return; }
    this.send = send;
    this.messages = messages;
    this.baselinePending = true;
    this.settleBaseline(messages);
    void this.listen();
  }

  /** The owner turns voice mode off. */
  disable(): void {
    this.closeMic();
    this.clearSpeech();
    this.awaitingTurn = false;
    this.update({ enabled: false, phase: 'off', heard: '', error: '' });
  }

  /** A chat composer is showing: voice mode works in its conversation. The
   *  most recently shown composer wins. */
  attach(surface: string, send: Send, messages: readonly VoiceChatMessage[]): void {
    this.send = send;
    if (this.state.surface === surface) return;
    this.closeMic();
    this.clearSpeech();
    this.messages = messages;
    this.baselinePending = true;
    this.update({ surface });
    this.settleBaseline(messages);
    if (this.state.enabled && !this.awaitingTurn && !this.speaker.speaking) void this.listen();
  }

  /** That composer is gone: stop listening until another one shows. */
  detach(surface: string): void {
    if (this.state.surface !== surface) return;
    this.closeMic();
    this.clearSpeech();
    this.send = null;
    this.update({ surface: null, ...(this.speaker.speaking ? {} : { phase: this.state.enabled ? 'thinking' as const : 'off' as const }) });
  }

  /** Keep the latest send for the showing composer (it closes over state). */
  setSend(surface: string, send: Send): void {
    if (this.state.surface === surface) this.send = send;
  }

  /** Stop Clem mid-sentence and listen. */
  interrupt(): void {
    if (this.state.phase === 'speaking') { this.clearSpeech(); this.afterSpeaking(); }
  }

  /** The showing conversation changed: read aloud whatever Clem newly said. */
  observe(surface: string, messages: readonly VoiceChatMessage[]): void {
    if (this.state.surface !== surface) return;
    this.messages = messages;
    if (!this.state.enabled) return;
    this.settleBaseline(messages);
    if (this.baselinePending) return;
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
    if (this.state.phase === 'thinking') {
      this.tick ??= setInterval(() => {
        if (this.state.phase === 'thinking' && !this.speaker.speaking) workingTick();
      }, WORKING_TICK_MS);
    } else if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }
}

export const voiceMode = new VoiceModeController();

export function useVoiceMode(): VoiceModeState {
  return useSyncExternalStore(voiceMode.subscribe, voiceMode.getSnapshot, voiceMode.getSnapshot);
}
