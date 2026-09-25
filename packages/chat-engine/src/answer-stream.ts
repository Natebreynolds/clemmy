/**
 * The live answer draft on an assistant message: the client half of the
 * server's answer stream (src/runtime/harness/answer-stream.ts).
 *
 * A `stream_token` frame either places `delta` at `offset` of draft
 * `streamId` (offset 0 replaces the draft, a matching offset extends it, any
 * other offset is ignored), or retracts that draft (`reset`). A draft only
 * ever occupies `text` provisionally: a retraction restores what the message
 * said before, and every authoritative turn event reads and writes the message
 * without it, so a draft can never become the delivered reply.
 */
import type { LiveAnswerDraft } from './types.js';

export interface MessageWithAnswerDraft {
  text: string;
  answerDraft?: LiveAnswerDraft;
}

export function applyStreamToken<M extends MessageWithAnswerDraft>(message: M, data: Record<string, unknown>): M {
  const delta = typeof data.delta === 'string' ? data.delta : '';
  const streamId = typeof data.streamId === 'string' ? data.streamId : '';
  // A frame without a draft identity predates drafts: plain appended text.
  if (!streamId) return delta ? { ...message, text: message.text + delta } : message;
  const draft = message.answerDraft;
  if (data.reset === true) {
    return draft?.id === streamId ? { ...message, text: draft.base, answerDraft: undefined } : message;
  }
  const offset = typeof data.offset === 'number' && Number.isSafeInteger(data.offset) ? data.offset : -1;
  if (offset === 0) {
    return { ...message, text: delta, answerDraft: { id: streamId, base: draft ? draft.base : message.text } };
  }
  if (delta && draft?.id === streamId && offset === message.text.length) {
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
