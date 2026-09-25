/**
 * THE ANSWER STREAM.
 *
 * The reply a model step is writing, shown while it is written. It is
 * provisional by construction: the durable `conversation_completed` reply is
 * the only delivered answer, and every client replaces the draft with it.
 *
 * Contract: one `stream_token` frame, public, never persisted, `seq` 0.
 *
 *   { public, streamId, sourceUserSeq, offset, delta }
 *     Place `delta` at character `offset` of draft `streamId`. Offset 0
 *     replaces whatever the client shows for the draft: a new draft, a
 *     corrected draft, or the text so far for a client that just attached.
 *     A client ignores a frame whose offset is neither 0 nor the length it
 *     already holds for that draft.
 *   { public, streamId, sourceUserSeq, reset: true }
 *     The draft will not become the answer; the client removes it.
 *
 * One draft per model step. A draft is retracted when its step turns into
 * tool calls, fails or is not admitted, and when the host takes any further
 * step after it: a rejected review, a continuation, a chosen writer. A step
 * whose draft a chosen writer is expected to rewrite is held, and shown only
 * if it goes to review as written.
 *
 * Frames reach only the live viewers of the session (the chat event routes
 * attach here). Text is coalesced, opens only once a draft is more than a
 * lead-in, and holds back its unfinished last word, so a secret or a protocol
 * shape is refused before any part of it is shown. Observing never alters the
 * model request, its response, or the turn.
 */
import { randomUUID } from 'node:crypto';
import { actionBus } from '../action-bus.js';
import type { EventRow } from './eventlog.js';
import { scanSecrets } from './guardrails.js';
import { projectHarnessEventForPublic, publicLiveTextUnsafe, publicReplyText } from './public-presentation.js';
import { createJsonFieldStreamer } from './stream-reply.js';
import { streamingReplyHead, toOrchestratorDecision } from './turn-decision.js';

/** `held` drafts are not shown while written; see presentAnswerDraft. */
export type AnswerDraftMode = 'live' | 'held';

/** One model step's view of the stream. Every method is observational. */
export interface AnswerDraftStep {
  readonly streamId: string;
  /** Visible output text as the provider streams it. */
  text(delta: string): void;
  /** The response began a tool call: its text is not an answer. */
  toolCall(): void;
  /** The step was admitted as a completed reply with this exact text. */
  complete(frameText: string): void;
  /** The step's text will not become the answer. */
  retract(): void;
}

const FLUSH_MS = 75;
/** A draft opens once it is longer than a lead-in sentence; a shorter reply
 *  appears when its step completes. */
const OPEN_MIN_CHARS = 120;
/** A draft whose turn never reached a terminal stops being offered. */
const ABANDONED_DRAFT_MS = 30 * 60_000;
const TERMINAL_TYPES: ReadonlySet<string> = new Set([
  'conversation_completed', 'run_failed', 'conversation_limit_exceeded',
]);

type AnswerStreamListener = (event: EventRow) => void;

const drafts = new Map<string, AnswerDraft>();
const viewers = new Map<string, Set<AnswerStreamListener>>();
let stopTerminalWatch: (() => void) | undefined;
let frameCounter = 0;

export type LiveDraftView =
  | { status: 'pending' }
  | { status: 'private' }
  | { status: 'text'; text: string };

function unsafeLiveText(text: string): boolean {
  return scanSecrets(text).length > 0 || publicLiveTextUnsafe(text);
}

function jsonReplyField(raw: string): string {
  let reply = '';
  createJsonFieldStreamer(['reply'], (delta) => { reply += delta; })(raw);
  return reply;
}

/** End of the last whole word, before the whitespace that precedes the word
 *  still being written. */
function completeWordsEnd(text: string): number {
  let index = text.length - 1;
  while (index >= 0 && !/\s/.test(text[index]!)) index -= 1;
  while (index >= 0 && /\s/.test(text[index]!)) index -= 1;
  return index + 1;
}

/** What may be shown of raw, still-forming step text: the reply the turn
 *  contract would read from it, refused whole if any of it is a secret or tool
 *  or reasoning protocol, and (unless `final`) cut back to whole words. */
export function liveDraftView(raw: string, final = false): LiveDraftView {
  const head = streamingReplyHead(raw, final);
  if (head.kind === 'pending') return { status: 'pending' };
  if (head.kind === 'private') return { status: 'private' };
  const reply = head.kind === 'json' ? jsonReplyField(raw) : raw.slice(head.skip);
  if (unsafeLiveText(reply)) return { status: 'private' };
  return { status: 'text', text: final ? reply : reply.slice(0, completeWordsEnd(reply)) };
}

/** The reply an admitted completed frame proposes, read exactly as the turn
 *  reads it, or '' when it proposes none that may be shown. */
export function completedDraftReply(frameText: string): string {
  const reply = toOrchestratorDecision(frameText)?.reply;
  if (typeof reply !== 'string') return '';
  const text = publicReplyText(reply, '');
  return text && !unsafeLiveText(text) ? text : '';
}

function hasViewers(sessionId: string): boolean {
  return (viewers.get(sessionId)?.size ?? 0) > 0;
}

function streamFrame(draft: AnswerDraft, fields: Record<string, unknown>): EventRow | null {
  frameCounter += 1;
  return projectHarnessEventForPublic({
    seq: 0,
    id: `answer-stream:${draft.streamId}:${frameCounter}`,
    sessionId: draft.sessionId,
    turn: 0,
    role: 'Clem',
    type: 'stream_token',
    parentEventId: null,
    createdAt: new Date().toISOString(),
    data: { public: true, streamId: draft.streamId, sourceUserSeq: draft.sourceUserSeq, ...fields },
  });
}

function broadcast(draft: AnswerDraft, fields: Record<string, unknown>): void {
  const listeners = viewers.get(draft.sessionId);
  if (!listeners?.size) return;
  const frame = streamFrame(draft, fields);
  if (!frame) return;
  for (const listener of [...listeners]) {
    try { listener(frame); } catch { /* one viewer's socket never affects another or the turn */ }
  }
}

class AnswerDraft implements AnswerDraftStep {
  readonly streamId: string;
  touchedAt = Date.now();
  private raw = '';
  /** The text every attached viewer holds for this draft. */
  private published = '';
  /** The admitted frame, read into a reply only once someone can see it. */
  private frameText = '';
  private reply: string | undefined;
  private state: 'writing' | 'written' | 'closed' = 'writing';
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly sessionId: string,
    readonly sourceUserSeq: number,
    private mode: AnswerDraftMode,
  ) {
    this.streamId = `${sourceUserSeq}-${randomUUID().slice(0, 12)}`;
  }

  text(delta: string): void {
    if (this.state !== 'writing' || !delta) return;
    this.raw += delta;
    this.touchedAt = Date.now();
    if (this.mode !== 'live' || this.timer || !hasViewers(this.sessionId)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  toolCall(): void {
    this.retract();
  }

  complete(frameText: string): void {
    if (this.state !== 'writing') return;
    this.cancelTimer();
    this.state = 'written';
    this.frameText = frameText;
    this.touchedAt = Date.now();
    if (this.mode === 'live' && hasViewers(this.sessionId)) this.showWritten();
  }

  present(): void {
    if (this.state !== 'written' || this.mode === 'live') return;
    this.mode = 'live';
    if (hasViewers(this.sessionId)) this.showWritten();
  }

  retract(): void {
    if (this.state === 'closed') return;
    this.close();
    if (!this.published) return;
    this.published = '';
    broadcast(this, { reset: true });
  }

  /** A terminal superseded the draft on every client; nothing to retract. */
  end(): void {
    if (this.state !== 'closed') this.close();
  }

  /** Bring every viewer up to date with the text written so far. */
  flush(): void {
    if (this.state !== 'writing' || this.mode !== 'live') return;
    const view = liveDraftView(this.raw);
    if (view.status === 'private') {
      this.retract();
      return;
    }
    if (view.status === 'pending' || (!this.published && view.text.length < OPEN_MIN_CHARS)) return;
    this.show(view.text);
  }

  /** The draft as every current viewer holds it, for a viewer attaching now. */
  snapshot(): EventRow | null {
    if (this.state === 'writing') this.flush();
    else if (this.state === 'written' && this.mode === 'live') this.showWritten();
    return this.state !== 'closed' && this.published
      ? streamFrame(this, { offset: 0, delta: this.published })
      : null;
  }

  private showWritten(): void {
    this.reply ??= completedDraftReply(this.frameText);
    if (this.reply) this.show(this.reply);
    else this.retract();
  }

  private show(text: string): void {
    if (text === this.published) return;
    if (this.published && text.startsWith(this.published)) {
      const offset = this.published.length;
      this.published = text;
      broadcast(this, { offset, delta: text.slice(offset) });
      return;
    }
    this.published = text;
    broadcast(this, text ? { offset: 0, delta: text } : { reset: true });
  }

  private close(): void {
    this.cancelTimer();
    this.state = 'closed';
    if (drafts.get(this.sessionId) === this) drafts.delete(this.sessionId);
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function watchTerminals(): void {
  if (stopTerminalWatch) return;
  stopTerminalWatch = actionBus.subscribe((event) => {
    if (event.kind !== 'harness.public_event' || !TERMINAL_TYPES.has(event.event.type)) return;
    const draft = drafts.get(event.sessionId);
    if (!draft) return;
    const source = event.event.data?.sourceUserSeq;
    if (Number.isSafeInteger(source) && source !== draft.sourceUserSeq) return;
    draft.end();
  });
}

function pruneAbandonedDrafts(now: number): void {
  for (const draft of [...drafts.values()]) {
    if (now - draft.touchedAt > ABANDONED_DRAFT_MS) draft.end();
  }
}

/** Open the draft for one model step, retracting whatever draft the session
 *  was still showing: the host taking this step means it did not deliver it. */
export function beginAnswerDraft(input: {
  sessionId: string;
  sourceUserSeq: number;
  mode: AnswerDraftMode;
}): AnswerDraftStep {
  watchTerminals();
  pruneAbandonedDrafts(Date.now());
  drafts.get(input.sessionId)?.retract();
  const draft = new AnswerDraft(input.sessionId, input.sourceUserSeq, input.mode);
  drafts.set(input.sessionId, draft);
  return draft;
}

/** A held draft is going to review as written: show it. */
export function presentAnswerDraft(sessionId: string, sourceUserSeq: number): void {
  const draft = drafts.get(sessionId);
  if (draft?.sourceUserSeq === sourceUserSeq) draft.present();
}

/** The session's current draft, if it belongs to this source, is not the
 *  answer. */
export function retractAnswerDraft(sessionId: string, sourceUserSeq?: number): void {
  const draft = drafts.get(sessionId);
  if (draft && (sourceUserSeq === undefined || draft.sourceUserSeq === sourceUserSeq)) draft.retract();
}

/**
 * Attach one live viewer of a session. A draft already being written reaches
 * the viewer first as one offset-0 frame holding the text so far; later frames
 * extend it. Call from the same synchronous block that writes the replay, so
 * no frame can fall between the snapshot and the subscription.
 */
export function attachAnswerStream(sessionId: string, listener: AnswerStreamListener): () => void {
  const snapshot = drafts.get(sessionId)?.snapshot();
  if (snapshot) {
    try { listener(snapshot); } catch { /* the viewer's socket owns its own failure */ }
  }
  let listeners = viewers.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    viewers.set(sessionId, listeners);
  }
  listeners.add(listener);
  const attached = listeners;
  return () => {
    attached.delete(listener);
    if (attached.size === 0 && viewers.get(sessionId) === attached) viewers.delete(sessionId);
  };
}

/** Test seam: forget every draft and viewer. */
export function resetAnswerStreamForTests(): void {
  for (const draft of [...drafts.values()]) draft.end();
  drafts.clear();
  viewers.clear();
  stopTerminalWatch?.();
  stopTerminalWatch = undefined;
}
