/**
 * An answer published before its review carries the chip `checking`. Its
 * review rules on it right after, and that ruling arrives as its own event:
 * this module lands it on the answer's chip, live and on reopen. A ruling
 * with no `checking` answer to land on changes nothing.
 */
import { REVIEW_NOTE_MAX } from './terminal-presentation.js';
import type { ChatMessage, HarnessEvent, TerminalReview } from './types.js';

export interface ReviewSettlement {
  sourceUserSeq: number;
  review: Extract<TerminalReview, 'checked' | 'unchecked' | 'rejected'>;
  reviewNote?: string;
}

const SETTLED: ReadonlySet<string> = new Set(['checked', 'unchecked', 'rejected']);

export function readReviewSettlement(
  event: Pick<HarnessEvent, 'type' | 'data' | 'sessionId'>,
  sessionId?: string | null,
): ReviewSettlement | null {
  if (event.type !== 'completion_review_settled') return null;
  if (sessionId && event.sessionId && event.sessionId !== sessionId) return null;
  const d = event.data ?? {};
  const seq = d.sourceUserSeq;
  if (d.version !== 1 || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1
    || typeof d.review !== 'string' || !SETTLED.has(d.review)) return null;
  const review = d.review as ReviewSettlement['review'];
  const note = review === 'rejected' && typeof d.reviewNote === 'string'
    ? d.reviewNote.replace(/\s+/g, ' ').trim().slice(0, REVIEW_NOTE_MAX) : '';
  return { sourceUserSeq: seq, review, ...(note ? { reviewNote: note } : {}) };
}

/** The source an answer still being checked belongs to, so its ruling can
 *  find it. Only a terminal whose own chip says `checking` is waiting. */
export function reviewPendingSourceFor(
  terminal: ChatMessage['terminal'],
  sourceUserSeq: number | null,
): Pick<ChatMessage, 'reviewPendingSource'> {
  return terminal?.review === 'checking' && sourceUserSeq !== null ? { reviewPendingSource: sourceUserSeq } : {};
}

/** What a message needs for a ruling to find it: the chat engine marks its
 *  waiting answer with `reviewPendingSource`; a client that tracks each
 *  answer's accepted source is matched by that. */
type SettleableMessage = {
  role: string;
  terminal?: ChatMessage['terminal'];
  reviewPendingSource?: number;
  acceptedSource?: { sourceUserSeq: number };
};

export function applyReviewSettlement<M extends SettleableMessage>(messages: M[], settled: ReviewSettlement): M[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== 'assistant' || message.terminal?.review !== 'checking') return message;
    if ((message.reviewPendingSource ?? message.acceptedSource?.sourceUserSeq) !== settled.sourceUserSeq) return message;
    changed = true;
    const { reviewPendingSource: _source, ...rest } = message;
    const { reviewNote: _note, ...terminal } = message.terminal;
    return {
      ...rest,
      terminal: { ...terminal, review: settled.review, ...(settled.reviewNote ? { reviewNote: settled.reviewNote } : {}) },
    } as M;
  });
  return changed ? next : messages;
}
