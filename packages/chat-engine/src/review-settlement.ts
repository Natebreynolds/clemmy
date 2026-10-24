/**
 * An answer published before its review carries the chip `checking`. Its
 * review rules on it right after, and that ruling arrives as its own event:
 * this module lands it on the answer's chip, live and on reopen. A ruling
 * with no `checking` answer to land on changes nothing.
 */
import type { BackgroundOutcomeReport } from './background-outcome-report.js';
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
  correctableSource?: number;
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
      // A no leaves the answer findable by the correction that replaces it.
      ...(settled.review === 'rejected' ? { correctableSource: settled.sourceUserSeq } : {}),
      terminal: { ...terminal, review: settled.review, ...(settled.reviewNote ? { reviewNote: settled.reviewNote } : {}) },
    } as M;
  });
  return changed ? next : messages;
}

/** A correction Clem wrote after a review said no names the answer it
 *  corrects in its report's source id (ANSWER_CHECK_SOURCE_PREFIX in
 *  src/runtime/harness/review-after-delivery.ts): that answer's source. */
const ANSWER_CHECK_SOURCE = /^answer-check:([1-9]\d{0,15})$/;

export function answerCheckCorrectedSource(report: Pick<BackgroundOutcomeReport, 'sourceId'> | null): number | null {
  const match = report ? ANSWER_CHECK_SOURCE.exec(report.sourceId) : null;
  const seq = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

/** What a correction brings to the answer it replaces. */
export interface AnswerCheckCorrection {
  text: string;
  status?: ChatMessage['status'];
}

type CorrectableMessage = SettleableMessage & { text: string; status?: ChatMessage['status'] };

/**
 * One ask, one reply: Clem's correction takes the place of the answer its
 * review said no to, and the chip says it was corrected (the finding stays
 * on it). Returns null when that answer is not among these messages, so the
 * caller shows the correction as a reply of its own rather than dropping it.
 */
export function applyAnswerCheckCorrection<M extends CorrectableMessage>(
  messages: M[],
  sourceUserSeq: number,
  correction: AnswerCheckCorrection,
): M[] | null {
  const text = correction.text.trim();
  if (!text) return null;
  const index = messages.findIndex((message) => message.role === 'assistant'
    && message.terminal?.review === 'rejected'
    && (message.correctableSource ?? message.acceptedSource?.sourceUserSeq) === sourceUserSeq);
  if (index < 0) return null;
  return messages.map((message, i) => {
    if (i !== index) return message;
    const { correctableSource: _source, ...rest } = message;
    return {
      ...rest,
      text,
      ...(correction.status ? { status: correction.status } : {}),
      terminal: { ...message.terminal, review: 'corrected' as const },
    } as M;
  });
}
