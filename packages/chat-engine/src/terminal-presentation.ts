import type { ChatMessage, MessageStatus, TerminalFacts } from './types.js';
import { humanHarnessText } from './types.js';

export const GENERIC_TURN_ERROR = 'Something went wrong on that turn — try again. (Details are in the logs.)';
export const EMPTY_COMPLETION_ERROR = 'The run ended without a usable answer, so I haven’t marked it complete. Check the activity above or try again.';

type CanonicalTerminalStatus =
  | 'done'
  | 'needs_input'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'transferred'
  | 'uncertain';

const CANONICAL_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'needs_input',
  'blocked',
  'failed',
  'cancelled',
  'transferred',
  'uncertain',
]);

function canonicalStatusFrom(value: unknown): CanonicalTerminalStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = (value as Record<string, unknown>).status;
  return typeof status === 'string' && CANONICAL_TERMINAL_STATUSES.has(status)
    ? status as CanonicalTerminalStatus
    : null;
}

/** The typed terminal is authoritative over legacy reason strings. Both
 * projections are normally identical; a disagreement is corrupt/uncertain
 * evidence and must never turn a non-success terminal green. */
function canonicalTerminalStatus(data: Record<string, unknown>): CanonicalTerminalStatus | null {
  const presentationStatus = canonicalStatusFrom(data.presentation);
  const outcomeStatus = canonicalStatusFrom(data.turnOutcome);
  if (presentationStatus && outcomeStatus && presentationStatus !== outcomeStatus) return 'uncertain';
  return presentationStatus ?? outcomeStatus;
}

function messageStatusForCanonicalTerminal(status: CanonicalTerminalStatus): MessageStatus {
  if (status === 'done') return 'complete';
  if (status === 'needs_input') return 'awaiting-reply';
  if (status === 'cancelled' || status === 'transferred') return 'stopped';
  return 'failed';
}


const PRESENTATION_KINDS: ReadonlySet<string> = new Set(['answer', 'question', 'approval', 'continue']);
const NEEDS_KINDS: ReadonlySet<string> = new Set(['input', 'approval', 'continue']);

/** Lift the backend's typed terminal onto the message. Never invents: a field
 * the event does not carry stays absent, and a legacy event yields undefined. */
export function terminalFactsFrom(data: Record<string, unknown>): TerminalFacts | undefined {
  const status = canonicalTerminalStatus(data);
  if (!status) return undefined;
  const presentation = data.presentation && typeof data.presentation === 'object'
    ? data.presentation as Record<string, unknown> : {};
  const outcome = data.turnOutcome && typeof data.turnOutcome === 'object'
    ? data.turnOutcome as Record<string, unknown> : {};
  const needs = outcome.needs && typeof outcome.needs === 'object'
    ? (outcome.needs as Record<string, unknown>).kind : undefined;
  const facts: TerminalFacts = { status };
  if (typeof presentation.kind === 'string' && PRESENTATION_KINDS.has(presentation.kind)) {
    facts.kind = presentation.kind as TerminalFacts['kind'];
  }
  if (typeof needs === 'string' && NEEDS_KINDS.has(needs)) facts.needs = needs as TerminalFacts['needs'];
  if (typeof outcome.resumable === 'boolean') facts.resumable = outcome.resumable;
  return facts;
}

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
): Pick<ChatMessage, 'text' | 'status' | 'progress' | 'terminal'> {
  // Every branch below decides text/status the same way it always has; the
  // backend's typed terminal rides along so renderers stop re-deriving it.
  const terminal = terminalFactsFrom(data);
  const core = terminalCompletionPresentationCore(data, currentText, currentStatus);
  return terminal ? { ...core, terminal } : core;
}

function terminalCompletionPresentationCore(
  data: Record<string, unknown>,
  currentText: string,
  currentStatus?: MessageStatus,
): Pick<ChatMessage, 'text' | 'status' | 'progress'> {
  const canonicalStatus = canonicalTerminalStatus(data);
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
    const status: MessageStatus = canonicalStatus
      ? messageStatusForCanonicalTerminal(canonicalStatus)
      : awaitingUser ? 'awaiting-reply' : stopped ? 'stopped' : failed ? 'failed' : 'complete';
    return { text, status, progress: undefined };
  }
  if (canonicalStatus === 'needs_input' || awaitingUser) {
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
  if (
    canonicalStatus === 'cancelled'
    || canonicalStatus === 'transferred'
    || awaitingContinue
  ) {
    return {
      text: 'I reached this run’s current limit before I had a usable answer. Say “continue” and I’ll keep working.',
      status: 'stopped',
      progress: undefined,
    };
  }
  // Delivered-but-unrenderable (e.g. a placeholder-only reply): the server
  // vouched for the delivery — never contradict it with a failure banner.
  if (canonicalStatus === 'done' || (canonicalStatus === null && judgedDelivered && !stopped)) {
    return { text: 'Done — the full reply is in the activity above.', status: 'complete', progress: undefined };
  }
  return { text: EMPTY_COMPLETION_ERROR, status: stopped ? 'stopped' : 'failed', progress: undefined };
}
