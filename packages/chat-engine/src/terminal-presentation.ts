import type { ChatMessage, MessageStatus } from './types.js';
import { humanHarnessText } from './types.js';

export const GENERIC_TURN_ERROR = 'Something went wrong on that turn — try again. (Details are in the logs.)';
export const EMPTY_COMPLETION_ERROR = 'The run ended without a usable answer, so I haven’t marked it complete. Check the activity above or try again.';

export function meaningfulCompletionText(value: unknown): string {
  const text = humanHarnessText(value, '');
  // A bare terminal placeholder is not work-product. Treating it as evidence
  // made an empty/reasoning-only provider turn look successfully completed.
  return /^(?:\(?done[.!]?\)?|complete[.!]?)$/i.test(text) ? '' : text;
}

/** Project a terminal event into user-visible truth. A completion event proves
 * that the stream ended; it does not, by itself, prove that the user received
 * an answer. Only explicit/streamed human output earns the success state. */
export function terminalCompletionPresentation(
  data: Record<string, unknown>,
  currentText: string,
  currentStatus?: MessageStatus,
): Pick<ChatMessage, 'text' | 'status' | 'progress'> {
  const reason = typeof data.reason === 'string' ? data.reason : '';
  const reasonKey = reason
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
  const eventText = meaningfulCompletionText(data);
  const streamedText = meaningfulCompletionText(currentText);
  const text = eventText || streamedText;
  const awaitingContinue = reasonKey === 'awaiting_continue' || reasonKey === 'limit_exceeded';
  const awaitingUser = currentStatus === 'awaiting-reply'
    || /awaiting_(?:user(?:_(?:input|reply))?|input|reply)|needs_user_(?:input|reply)/.test(reasonKey);
  const stopped = awaitingContinue || /cancelled|canceled|aborted|stopped/.test(reasonKey);
  // `delivered: true` is the server's authoritative success flag. A rescue
  // path like reason 'stall_judge_delivered' is a SUCCESS with provenance —
  // the substring 'stall' must never brand a judged-good reply as failed.
  const judgedDelivered = data.delivered === true || /delivered/.test(reasonKey);
  const failed = !judgedDelivered
    && /fail|error|abandon|stall|exhaust|invalid|blocked|unavailable|timed?_?out|no_structured/.test(reasonKey);

  if (text) {
    const status: MessageStatus = awaitingUser ? 'awaiting-reply' : stopped ? 'stopped' : failed ? 'failed' : 'complete';
    return { text, status, progress: undefined };
  }
  if (awaitingUser) {
    return {
      text: 'I need your input before I can continue.',
      status: 'awaiting-reply',
      progress: undefined,
    };
  }
  if (reasonKey === 'no_structured_output') {
    return {
      text: 'That step finished but my reply didn’t come through — say “continue” and I’ll pick it right back up.',
      status: 'failed',
      progress: undefined,
    };
  }
  if (awaitingContinue) {
    return {
      text: 'I reached this run’s current limit before I had a usable answer. Say “continue” and I’ll keep working.',
      status: 'stopped',
      progress: undefined,
    };
  }
  // Delivered-but-unrenderable (e.g. a placeholder-only reply): the server
  // vouched for the delivery — never contradict it with a failure banner.
  if (judgedDelivered && !stopped) {
    return { text: 'Done — the full reply is in the activity above.', status: 'complete', progress: undefined };
  }
  return { text: EMPTY_COMPLETION_ERROR, status: stopped ? 'stopped' : 'failed', progress: undefined };
}
