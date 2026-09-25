/**
 * The live answer draft on an assistant message: the client half of the
 * server's answer stream (src/runtime/harness/answer-stream.ts).
 *
 * A `stream_token` frame either places `delta` at `offset` of draft
 * `streamId` (offset 0 replaces the draft, a matching offset extends it, any
 * other offset is ignored), marks the finished draft as being checked
 * (`checking`), or withdraws it (`reset`, with an optional `reason`).
 *
 * A withdrawn draft keeps its words on screen, marked provisional, so the
 * answer never blinks back to nothing: the next draft's offset-0 frame
 * replaces it in place, and every authoritative turn event (the terminal, a
 * question, a failure) reads and writes the message without it. A draft only
 * ever occupies `text` provisionally, so it can never become the delivered
 * reply.
 */
import type { AnswerDraftWithdrawal, LiveAnswerDraft } from './types.js';

export interface MessageWithAnswerDraft {
  text: string;
  answerDraft?: LiveAnswerDraft;
}

const WITHDRAWAL_REASONS: ReadonlySet<string> = new Set(['review', 'tool_call', 'writer', 'continuation']);

function withdrawalReason(value: unknown): AnswerDraftWithdrawal {
  return typeof value === 'string' && WITHDRAWAL_REASONS.has(value) ? value as AnswerDraftWithdrawal : 'other';
}

export function applyStreamToken<M extends MessageWithAnswerDraft>(message: M, data: Record<string, unknown>): M {
  const delta = typeof data.delta === 'string' ? data.delta : '';
  const streamId = typeof data.streamId === 'string' ? data.streamId : '';
  // A frame without a draft identity predates drafts: plain appended text.
  if (!streamId) return delta ? { ...message, text: message.text + delta } : message;
  const draft = message.answerDraft;
  if (data.reset === true) {
    if (draft?.id !== streamId) return message;
    return { ...message, answerDraft: { id: draft.id, base: draft.base, phase: 'withdrawn', withdrawn: withdrawalReason(data.reason) } };
  }
  const offset = typeof data.offset === 'number' && Number.isSafeInteger(data.offset) ? data.offset : -1;
  const checking = data.checking === true;
  if (offset === 0 && delta) {
    return {
      ...message,
      text: delta,
      answerDraft: { id: streamId, base: draft ? draft.base : message.text, phase: checking ? 'checking' : 'writing' },
    };
  }
  if (draft?.id !== streamId || draft.phase === 'withdrawn') return message;
  if (checking && !delta) return { ...message, answerDraft: { ...draft, phase: 'checking' } };
  if (delta && offset === message.text.length) {
    return { ...message, text: message.text + delta };
  }
  return message;
}

/** The message as it was before any live draft: what authoritative events
 *  (the terminal, a question, a failure) read and replace. */
export function withoutAnswerDraft<M extends MessageWithAnswerDraft>(message: M): M {
  const draft = message.answerDraft;
  return draft ? { ...message, text: draft.base, answerDraft: undefined } : message;
}

/** The line under a draft that says where it stands, or null while it is
 *  simply being written. A draft the reviewer sent back says so; any other
 *  withdrawal reads neutrally. */
export function answerDraftStatus(draft: LiveAnswerDraft | undefined): string | null {
  if (!draft) return null;
  if (draft.phase === 'checking') return 'Checking this answer…';
  if (draft.phase !== 'withdrawn') return null;
  return draft.withdrawn === 'review' ? 'Found issues, correcting…' : 'Still working…';
}
