/**
 * Live voice: the conversation protocol of a full-duplex session with Clem,
 * shared by every surface that holds one. Transport-free: the consuming app
 * connects the audio and the event channel and attaches a sender.
 *
 * A data channel carries what each side said and the voice's requests for
 * Clem. A request carries no words of its own, and the voice may ask before
 * the owner has finished: the request is the owner's words since the previous
 * one, gathered until they pause, which the app sends as a turn of the open
 * conversation. Clem's replies come back to be said by the voice, tied to the
 * request they answer.
 */

/** What the voice service accepts in one append (500 tokens), with room. */
export const LIVE_APPEND_MAX_CHARS = 1_600;
/** The pause after the owner's last words that ends a request. */
const REQUEST_SETTLE_MS = 700;
/** The longest a request waits for the owner to pause. */
const REQUEST_MAX_WAIT_MS = 4_000;
/** A request made this long after the owner's last words needs only a brief
 *  wait for their transcript to land. */
const ALREADY_PAUSED_MS = 400;
const LANDING_MS = 250;
/** Quiet after the voice's last words before it counts as done talking. */
const SPEAKING_TAIL_MS = 900;

export interface LiveVoiceHandlers {
  /** The voice is connected and listening. */
  onLive(): void;
  /** The voice asks Clem for something: the owner's words since the last ask. */
  onRequest(request: { id: string; words: string }): void;
  /** The voice started (true) or stopped (false) talking. */
  onSpeaking(speaking: boolean): void;
  /** The owner is talking. */
  onHearing(): void;
  /** The session ended. `expected` is false when the owner did not end it. */
  onClosed(reason: string, expected: boolean): void;
  onError(message: string): void;
}

export interface LiveHistoryMessage { role: 'user' | 'assistant'; text: string }

/** The connection voice mode drives. */
export interface LiveVoiceLink {
  start(history: readonly LiveHistoryMessage[]): Promise<void>;
  /** Clem's words, for the voice to say. */
  say(text: string, requestId: string | null): void;
  /** Something the voice should know without saying it now. */
  note(text: string, requestId: string | null): void;
  /** Direction for the voice itself (stop talking, ask again). */
  direct(text: string): void;
  close(): void;
}

interface Fragment { text: string; start: number; end: number }

/** The owner's words, in session-timeline order, until a request takes them. */
export class LiveTranscript {
  private fragments: Fragment[] = [];

  add(text: string, start: number, end: number): void {
    if (!text) return;
    this.fragments.push({ text, start, end });
  }

  /** Everything heard that no earlier request took. */
  take(): string {
    const taken = [...this.fragments].sort((a, b) => a.start - b.start);
    this.fragments = [];
    return taken.map(fragment => fragment.text).join('').replace(/\s+/g, ' ').trim();
  }
}

/** Clem's reply as it should be heard: no markdown read as punctuation, no
 *  code, no tables, links by name, bounded to one append. */
export function liveSpokenText(markdown: string, maxChars = LIVE_APPEND_MAX_CHARS): string {
  let text = (markdown ?? '')
    .split('\n').filter(line => !/^\s*\|.*\|\s*$/.test(line)).join('\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, ' ')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxChars) return text;
  const more = ' The rest is on screen.';
  const room = text.slice(0, maxChars - more.length);
  const end = Math.max(room.lastIndexOf('. '), room.lastIndexOf('? '), room.lastIndexOf('! '));
  text = (end > room.length / 3 ? room.slice(0, end + 1) : room.trimEnd()) + more;
  return text;
}

type ServerEvent = {
  type?: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  offset_ms?: number;
  reason?: string;
  delegation?: { id?: string; target?: string };
  error?: { message?: string; code?: string | null; client_event_id?: string | null };
};

/**
 * The session's conversation: what was heard, the voice's requests and the
 * words sent back. Transport-free so the protocol is testable; `connect`
 * supplies the channel.
 */
export class LiveVoiceProtocol {
  private send: ((event: Record<string, unknown>) => void) | null = null;
  private readonly transcript = new LiveTranscript();
  private readonly requests = new Set<string>();
  /** Requests waiting for the owner to pause, oldest first. */
  private pending: string[] = [];
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where on the session timeline the owner's last heard words ended. */
  private heardUntil = -1;
  private speakingTimer: ReturnType<typeof setTimeout> | null = null;
  private speaking = false;
  private sequence = 0;
  private started = false;
  /** Words for the voice sent before the session started go out once it has. */
  private held: Array<Record<string, unknown>> = [];
  private closing = false;
  private ended = false;

  constructor(private readonly handlers: LiveVoiceHandlers) {}

  attach(send: (event: Record<string, unknown>) => void): void { this.send = send; }

  receive(event: ServerEvent): void {
    switch (event.type) {
      case 'session.started': {
        this.started = true;
        const held = this.held;
        this.held = [];
        for (const event of held) this.send?.(event);
        this.handlers.onLive();
        return;
      }
      case 'session.input_transcript.delta':
        this.transcript.add(event.delta ?? '', event.start_ms ?? 0, event.end_ms ?? 0);
        this.heardUntil = Math.max(this.heardUntil, event.end_ms ?? 0);
        this.handlers.onHearing();
        if (this.pending.length > 0) this.armSettle();
        return;
      case 'session.output_transcript.delta': this.voiceTalking(); return;
      case 'session.delegation.created': {
        const id = event.delegation?.id;
        if (!id || event.delegation?.target !== 'client') return;
        this.requests.add(id);
        this.pending.push(id);
        const paused = typeof event.offset_ms === 'number' && this.heardUntil >= 0 && event.offset_ms - this.heardUntil >= ALREADY_PAUSED_MS;
        this.armSettle(paused ? LANDING_MS : REQUEST_SETTLE_MS);
        this.waitTimer ??= setTimeout(() => this.release(), REQUEST_MAX_WAIT_MS);
        return;
      }
      case 'session.closed': this.finish(event.reason ?? 'closed'); return;
      case 'error':
        // Rejected appends and moderation cut-offs leave the session running.
        this.handlers.onError(event.error?.message || 'The voice service reported a problem.');
        return;
      default:
    }
  }

  /** The channel or the connection went away without a final event. */
  transportClosed(): void { this.finish(this.closing ? 'close_requested' : 'connection_lost'); }

  say(text: string, requestId: string | null): void { this.append('session.commentary.append', text, requestId); }
  note(text: string, requestId: string | null): void { this.append('session.thinking.append', text, requestId); }
  direct(text: string): void { this.append('session.instructions.append', text, null); }

  /** Ask the session to end; it confirms with session.closed. */
  close(): boolean {
    if (this.closing || this.ended) return false;
    this.closing = true;
    this.emit({ type: 'session.close' });
    return true;
  }

  get isEnded(): boolean { return this.ended; }

  private append(type: string, text: string, requestId: string | null): void {
    const content = text.trim();
    if (!content || this.closing || this.ended) return;
    const delegation = requestId && this.requests.has(requestId) ? requestId : null;
    this.emit({ type, delegation_id: delegation, content: content.slice(0, LIVE_APPEND_MAX_CHARS) });
  }

  private emit(event: Record<string, unknown>): void {
    this.sequence += 1;
    const numbered = { event_id: `clem_${this.sequence}`, ...event };
    if (!this.started && event.type !== 'session.close') { this.held.push(numbered); return; }
    this.send?.(numbered);
  }

  private armSettle(wait = REQUEST_SETTLE_MS): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.release(), wait);
  }

  /** The owner paused: what they said is one request, answered under the
   *  voice's first ask. Further asks made while they spoke are the same
   *  request, and the voice is told so instead of waiting on them. */
  private release(): void {
    this.clearRequestTimers();
    const [id, ...same] = this.pending;
    this.pending = [];
    if (!id || this.ended) return;
    for (const other of same) this.note('This is part of the same request as before; Clem answers it there.', other);
    this.handlers.onRequest({ id, words: this.transcript.take() });
  }

  private clearRequestTimers(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.settleTimer = null;
    this.waitTimer = null;
  }

  private voiceTalking(): void {
    if (!this.speaking) { this.speaking = true; this.handlers.onSpeaking(true); }
    if (this.speakingTimer) clearTimeout(this.speakingTimer);
    this.speakingTimer = setTimeout(() => {
      this.speakingTimer = null;
      this.speaking = false;
      this.handlers.onSpeaking(false);
    }, SPEAKING_TAIL_MS);
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.clearRequestTimers();
    this.pending = [];
    if (this.speakingTimer) clearTimeout(this.speakingTimer);
    this.speakingTimer = null;
    if (this.speaking) { this.speaking = false; this.handlers.onSpeaking(false); }
    this.handlers.onClosed(reason, this.closing || reason === 'close_requested');
  }
}
