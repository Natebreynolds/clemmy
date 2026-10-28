/**
 * Read one reply aloud from its speaker button: the same voice as voice mode,
 * one reply at a time. Pressing the button on the reply being read stops it;
 * pressing another reply's button switches to that reply.
 */
import { VoiceSpeaker } from './voice-speaker';

type Listener = (speakingKey: string | null) => void;

export interface ReplySpeakerPort {
  say: (text: string) => void;
  stop: () => void;
}

export class ReplySpeaker {
  private speakingKey: string | null = null;
  private listeners = new Set<Listener>();
  constructor(private readonly port: ReplySpeakerPort) {}

  get current(): string | null { return this.speakingKey; }

  /** Start reading `text` as `key`, or stop when `key` is already being read. */
  toggle(key: string, text: string): boolean {
    if (this.speakingKey === key) { this.stop(); return false; }
    this.port.stop();
    this.speakingKey = key;
    this.emit();
    this.port.say(text);
    return true;
  }

  stop(): void {
    this.port.stop();
    if (this.speakingKey === null) return;
    this.speakingKey = null;
    this.emit();
  }

  /** The player finished on its own. */
  idle(): void {
    if (this.speakingKey === null) return;
    this.speakingKey = null;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void { for (const listener of this.listeners) listener(this.speakingKey); }
}

let shared: ReplySpeaker | null = null;
/** The page's one reply speaker; made on first use so tests never touch audio. */
export function replySpeaker(): ReplySpeaker {
  if (shared) return shared;
  let speakerRef: VoiceSpeaker | null = null;
  const instance = new ReplySpeaker({
    say: (text) => { speakerRef?.say(text); },
    stop: () => { speakerRef?.stop(); },
  });
  speakerRef = new VoiceSpeaker({ onIdle: () => instance.idle() });
  shared = instance;
  return instance;
}
