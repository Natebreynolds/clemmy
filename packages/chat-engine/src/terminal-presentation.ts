import type {
  ChatMessage, MessageStatus, RetainedOutsideChange, TerminalFacts, TerminalNotice, TerminalNoticeCode,
  TerminalRetained, TerminalReview, TurnEvidenceRef,
} from './types.js';
import { humanHarnessText, noticeReplacesReply } from './types.js';

/** Every user-visible terminal string in this module must name a NEXT EDGE —
 *  something the reader can say or do — because a stop that only reports its own
 *  failure makes the owner nudge the assistant to get anywhere. "Try again" is
 *  not an edge: it hands the work back without saying what changes on a retry.
 *  `terminal-next-edge.test.ts` locks this for every export here. A typed
 *  terminal with no words gets none of these: its status line carries the
 *  edge (terminal-status.ts). */
export const GENERIC_TURN_ERROR = 'That turn stopped before I had an answer for you. Say “continue” and I’ll pick it back up.';
export const EMPTY_COMPLETION_ERROR = 'I worked through the steps but didn’t come out with an answer worth giving you. Say “continue” and I’ll take another run at it.';

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
  if ((status === 'blocked' || status === 'failed')
    && (data.blockedReason === 'memory_consolidation_pending' || data.blockedReason === 'memory_work_unverified')
    && Number.isSafeInteger(data.sourceUserSeq) && (data.sourceUserSeq as number) > 0) {
    facts.memoryWork = { sourceUserSeq: data.sourceUserSeq as number, reason: data.blockedReason };
  }
  if (typeof presentation.kind === 'string' && PRESENTATION_KINDS.has(presentation.kind)) {
    facts.kind = presentation.kind as TerminalFacts['kind'];
  }
  if (typeof needs === 'string' && NEEDS_KINDS.has(needs)) facts.needs = needs as TerminalFacts['needs'];
  if (typeof outcome.resumable === 'boolean') facts.resumable = outcome.resumable;
  const evidenceRefs = evidenceRefsFrom(outcome.evidenceRefs);
  if (evidenceRefs.length > 0) facts.evidenceRefs = evidenceRefs;
  const review = typeof data.review === 'string' && REVIEWS.has(data.review) ? data.review as TerminalReview : undefined;
  if (review) {
    facts.review = review;
    // A finding with no ruling has no chip to sit under, so it is dropped.
    const reviewNote = boundedText(data.reviewNote, REVIEW_NOTE_MAX);
    if (reviewNote) facts.reviewNote = reviewNote;
  }
  const retained = retainedFrom(data.retained);
  if (retained) facts.retained = retained;
  const notice = noticeFrom(data.notice);
  if (notice) facts.notice = notice;
  return facts;
}

const REVIEWS: ReadonlySet<string> = new Set(['checked', 'unchecked', 'rejected', 'needs_recheck', 'checking']);
const OUTSIDE_CHANGES: ReadonlySet<string> = new Set(['went_through', 'did_not', 'mixed', 'refused', 'uncertain', 'none']);
const NOTICE_CODES: ReadonlySet<string> = new Set<TerminalNoticeCode>([
  'stopped', 'response_format_unmet', 'response_format_unqualified', 'provider_quota', 'card_decision',
  'saved_model_unavailable', 'model_unavailable_on_sign_in', 'no_model_connected', 'codex_sign_in_expired',
  'provider_out_of_credit', 'model_stalled', 'run_failed', 'steering_unavailable', 'continuation_unavailable',
]);

/** The most of a reviewer's finding the receipt carries. */
export const REVIEW_NOTE_MAX = 400;
const NOTICE_NAME_MAX = 120;
const PROVIDER_SAID_MAX = 400;

/** One line of display text, bounded; anything else is absent. */
function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Retained facts are kept only when they say something: a result kept, or
 *  an outside change with a settled state. A malformed count or state is no
 *  claim at all, never a guess. */
function retainedFrom(value: unknown): TerminalRetained | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const results = typeof record.results === 'number' && Number.isSafeInteger(record.results) && record.results > 0
    ? record.results : 0;
  const outsideChange = typeof record.outsideChange === 'string' && OUTSIDE_CHANGES.has(record.outsideChange)
    ? record.outsideChange as RetainedOutsideChange : 'none';
  if (results === 0 && outsideChange === 'none') return undefined;
  return { results, outsideChange };
}

/** A notice with a code this client does not know is ignored. */
function noticeFrom(value: unknown): TerminalNotice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || !NOTICE_CODES.has(record.code)) return undefined;
  const agentName = boundedText(record.agentName, NOTICE_NAME_MAX);
  const model = boundedText(record.model, NOTICE_NAME_MAX);
  const providerSaid = boundedText(record.providerSaid, PROVIDER_SAID_MAX);
  return {
    code: record.code as TerminalNoticeCode,
    ...(agentName ? { agentName } : {}),
    ...(model ? { model } : {}),
    ...(providerSaid ? { providerSaid } : {}),
  };
}

const EVIDENCE_KINDS: ReadonlySet<string> = new Set([
  'tool_result', 'external_receipt', 'artifact', 'source', 'memory',
]);

/** Revalidate the harness's evidence refs at the boundary rather than trusting
 *  the shape. Same rule as the rest of this module: a field the event does not
 *  carry stays absent, and a malformed ref is dropped rather than rendered. */
function evidenceRefsFrom(value: unknown): TurnEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  const refs: TurnEvidenceRef[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const ref = raw as Record<string, unknown>;
    const kind = typeof ref.kind === 'string' ? ref.kind : '';
    const id = typeof ref.id === 'string' ? ref.id.trim() : '';
    if (!EVIDENCE_KINDS.has(kind) || !id) continue;
    const uri = typeof ref.uri === 'string' && ref.uri.trim() ? ref.uri.trim() : undefined;
    refs.push({ kind: kind as TurnEvidenceRef['kind'], id, ...(uri ? { uri } : {}) });
  }
  return refs;
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
  // The core decides status the same way it always has; the backend's typed
  // terminal rides along so renderers stop re-deriving it. Its fallback
  // sentences remain only for legacy events, where no typed status is drawn.
  const terminal = terminalFactsFrom(data);
  const core = terminalCompletionPresentationCore(data, currentText, currentStatus);
  if (!terminal) return { text: core.text, status: core.status, progress: core.progress };
  // A notice terminal for a turn no model spoke for is the app's status, not
  // a reply: its text is app wording kept for channels and history, and the
  // surfaces draw the notice as a status line instead. A format notice sits
  // beside Clem's own draft, so her words stay and the line is drawn as well.
  if (terminal.notice && noticeReplacesReply(terminal.notice.code)) {
    return { text: '', status: core.status, progress: core.progress, terminal };
  }
  // A typed terminal with no words of Clem's is drawn as its status pill, with
  // any retained facts on it. The app never writes a sentence in her place.
  // A finished turn has no pill, so its placeholder line stays.
  if (core.wordless && terminal.status !== 'done') return { text: '', status: core.status, progress: core.progress, terminal };
  return { text: core.text, status: core.status, progress: core.progress, terminal };
}

/**
 * The host's own filler for a turn that paused on an approval with no words of
 * its own ("Approval required for X. Review apr-… to continue."). The approval
 * card already says it, with its preview and buttons. Shown as prose too, it
 * reads as a second card and, typed as awaiting a reply, invites the owner to
 * type an answer. Recognized only by its exact shape around
 * the presentation's own approval id; words the model wrote are kept.
 */
function hostApprovalFiller(data: Record<string, unknown>): boolean {
  const presentation = data.presentation && typeof data.presentation === 'object' && !Array.isArray(data.presentation)
    ? data.presentation as Record<string, unknown>
    : null;
  if (!presentation || presentation.kind !== 'approval' || typeof presentation.approvalId !== 'string') return false;
  const id = presentation.approvalId;
  const text = typeof presentation.text === 'string' ? presentation.text.trim() : '';
  return (text.startsWith('Approval required for ') && text.endsWith(`. Review ${id} to continue.`))
    || (/^\d+ approvals are waiting, starting with /.test(text)
      && text.endsWith(`(${id}). Approve or reject each and I'll continue.`));
}

/** `wordless`: neither the event nor the stream carried words, so any text
 *  below was written here rather than by Clem. */
type CorePresentation = Pick<ChatMessage, 'text' | 'status' | 'progress'> & { wordless?: true };

function terminalCompletionPresentationCore(
  data: Record<string, unknown>,
  currentText: string,
  currentStatus?: MessageStatus,
): CorePresentation {
  if (hostApprovalFiller(data)) return { text: '', status: 'awaiting-approval', progress: undefined };
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
      // Reaching here means the server typed the stop as needs_input but the
      // question itself did not survive. Saying only "I need your input" makes
      // the owner guess what is wanted — name the edge that recovers it.
      text: 'I need something from you before I can continue, but my question didn’t come through — say “continue” and I’ll ask it again.',
      status: 'awaiting-reply',
      progress: undefined,
      wordless: true,
    };
  }
  if (reasonKey === 'no_structured_output') {
    return {
      text: 'That step finished but my reply didn’t come through — say “continue” and I’ll pick it right back up.',
      status: 'failed',
      progress: undefined,
      wordless: true,
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
      wordless: true,
    };
  }
  // Delivered-but-unrenderable (e.g. a placeholder-only reply): the server
  // vouched for the delivery — never contradict it with a failure banner.
  if (canonicalStatus === 'done' || (canonicalStatus === null && judgedDelivered && !stopped)) {
    return { text: 'Done — the full reply is in the activity above.', status: 'complete', progress: undefined, wordless: true };
  }
  return { text: EMPTY_COMPLETION_ERROR, status: stopped ? 'stopped' : 'failed', progress: undefined, wordless: true };
}
