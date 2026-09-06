/**
 * What a notification IS — the owner's rule, made decidable.
 *
 * Owner directive 2026-09-06, verbatim in substance: Clem should notify
 *   (1) when she needs the user to respond to a message to continue, and
 *   (2) when she finishes work.
 * Everything else is a log line. Not a badge, not a banner, not a buzz.
 *
 * THE DEFECT THIS EXISTS TO FIX. There was no such classifier. One predicate,
 * `isNeedsAttentionNotification`, answered three different questions — what the
 * phone's badge counts, what the push copy says, and where the tap lands — and
 * it ended in a REGEX OVER THE TITLE (`/\bblocked\b|needs attention|needs
 * input|couldn't finish|action required/i`). Measured on the owner's live
 * store: 200 of 200 notifications unread, a "Needs you" badge of 86 against
 * ZERO pending approvals, and 26 of those 86 minted by the title regex alone.
 *
 * A title regex cannot be right, because a title cannot settle. "Chat run
 * blocked: …" is a PAST-TENSE REPORT of something that already stopped; nothing
 * will ever edit that word out, so the item is permanently pending by
 * construction. Clem is not waiting on you there — she already gave up.
 *
 * TERMINAL STATUS OUTRANKS THE FLAG, and this is the rule that matters most.
 * The live store carries `execution status=done` rows stamped
 * `needsAttention: true`, and the same for `failed` and `cancelled` — the flag
 * is written when the notification is created and nothing re-evaluates it when
 * the work ends. A boolean stamped in the past cannot outrank the outcome it
 * was guessing about, so a terminal status is read first and wins.
 *
 * AWAITING MEANS THERE IS SOMETHING TO ANSWER. Not a mood, not a severity — a
 * referent that can be resolved: an open question, an open check-in, an
 * unsettled capability gate, or a proposal that is STILL PENDING. The caller
 * owns the pending sets (only it can know what is live right now), so it passes
 * them in; absent that knowledge this file will not guess a decision into
 * existence.
 */

/** The only three things a notification can be. */
export type NotificationIntent =
  /** Clem stopped and cannot continue until the user answers. Badge this. */
  | 'awaiting_you'
  /** Clem finished — well, badly, or not at all. Tell the user once; never badge. */
  | 'finished'
  /** A log line. It reaches the activity record and nothing else. */
  | 'neither';

/** The fields this decision reads. Structural so both stores satisfy it. */
export interface IntentInput {
  kind?: string;
  title?: string;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * What the caller knows about the world right now. Every predicate defaults to
 * "not live", so an uninformed caller gets `neither` rather than a decision
 * conjured from a flag — the failure this module exists to end.
 */
export interface LiveReferents {
  approvalPending?: (id: string) => boolean;
  planPending?: (id: string) => boolean;
  trustPending?: (id: string) => boolean;
  questionOpen?: (id: string) => boolean;
}

/**
 * Statuses that mean the work ENDED. `cancelled` and `failed` are endings too:
 * a run that failed is not waiting for the user, it is over, and telling the
 * user about it is exactly rule (2).
 */
const TERMINAL_STATUSES = new Set([
  'done', 'completed', 'complete', 'settled', 'finished',
  'failed', 'error', 'cancelled', 'canceled', 'stopped', 'timed_out',
]);

/**
 * Statuses that mean Clem is STOPPED AND ASKING. `needs_input` is the plain
 * case. The two `blocked_*` gates qualify only when their own settle-marker is
 * absent — they carry one precisely so they can stop counting.
 *
 * Bare `blocked` is deliberately NOT here. On the live store it is the single
 * largest "needs attention" source (33 execution + 23 approval rows) and it
 * means "this stopped", with no referent to answer — no approvalId, and zero
 * pending approvals on the machine. That is a report, and it is rule (2) at
 * most.
 */
const AWAITING_STATUSES = new Set(['needs_input', 'awaiting_input', 'awaiting_approval']);

function str(meta: Record<string, unknown> | undefined, key: string): string {
  const value = meta?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function statusOf(meta: Record<string, unknown> | undefined): string {
  return str(meta, 'status').toLowerCase();
}

/** An open check-in is one that has neither been answered nor closed. */
function hasOpenCheckIn(meta: Record<string, unknown> | undefined): boolean {
  if (!str(meta, 'checkInId')) return false;
  const status = statusOf(meta);
  return status !== 'answered' && status !== 'closed';
}

/** A capability gate that proved it dispatched nothing and has not settled. */
function hasUnsettledCapabilityGate(meta: Record<string, unknown> | undefined): boolean {
  return statusOf(meta) === 'blocked_capability'
    && meta?.provenNoDispatch === true
    && meta?.needsAttention !== false
    && typeof meta?.capabilitySettledAt !== 'string';
}

/** A workflow question still holding its run open. */
function hasUnresolvedQuestion(
  meta: Record<string, unknown> | undefined,
  live: LiveReferents,
): boolean {
  const questionId = str(meta, 'questionId');
  if (!questionId) return false;
  if (typeof meta?.questionResolvedAt === 'string') return false;
  if (meta?.needsAttention === false) return false;
  // If the caller can tell us, believe it over the record.
  if (live.questionOpen) return live.questionOpen(questionId);
  // Otherwise the questionId IS the referent, and its absence from a live table
  // is far more likely a lookup gap than an answer. Requiring a matching status
  // as well would drop a real ask because a second store had not caught up —
  // under-counting a question is the one direction that loses work, and it is
  // pinned by mobile-routes.test.ts ("an orphaned question id alone must not
  // suppress attention"). This does not reopen the badge problem: none of the
  // records that inflated it carried a questionId at all.
  return true;
}

/** A proposal is a decision only while it is actually pending. */
function hasPendingProposal(
  meta: Record<string, unknown> | undefined,
  live: LiveReferents,
): boolean {
  const approvalId = str(meta, 'approvalId');
  if (approvalId && live.approvalPending?.(approvalId)) return true;
  const planId = str(meta, 'planProposalId');
  if (planId && live.planPending?.(planId)) return true;
  const trustId = str(meta, 'trustProposalId');
  if (trustId && live.trustPending?.(trustId)) return true;
  return false;
}

/**
 * Classify one notification.
 *
 * Order is the contract: an ENDING is checked before a REQUEST, because the
 * record's `needsAttention` flag was stamped before the work ended and would
 * otherwise keep a finished run in the badge forever.
 */
export function classifyNotification(
  notification: IntentInput,
  live: LiveReferents = {},
): NotificationIntent {
  const meta = notification.metadata;
  const status = statusOf(meta);

  // (2) Clem finished. Terminal beats every flag.
  if (TERMINAL_STATUSES.has(status)) return 'finished';

  // A SETTLE MARKER ENDS IT, whatever the status still says. The same lesson as
  // terminal-beats-flag, one level down: `status` is stamped when the record is
  // written and is not rewritten when the question is answered, so a resolved
  // question still reads `needs_input` forever. The marker is the later fact.
  if (
    typeof meta?.questionResolvedAt === 'string'
    || typeof meta?.capabilitySettledAt === 'string'
    || meta?.needsAttention === false
  ) {
    return 'neither';
  }

  // (1) Clem is stopped and needs an answer — and there is something to answer.
  if (
    hasPendingProposal(meta, live)
    || hasOpenCheckIn(meta)
    || hasUnsettledCapabilityGate(meta)
    || hasUnresolvedQuestion(meta, live)
    || (AWAITING_STATUSES.has(status) && meta?.needsAttention !== false)
    || statusOf(meta) === 'blocked_readiness'
  ) {
    return 'awaiting_you';
  }

  // A finished-shaped record with no status, recognised by its own terminal
  // marker rather than by prose.
  if (typeof meta?.completedAt === 'string' || typeof meta?.settledAt === 'string') {
    return 'finished';
  }

  return 'neither';
}

/** Rule (1): the badge, and only the badge. */
export function isAwaitingUser(notification: IntentInput, live: LiveReferents = {}): boolean {
  return classifyNotification(notification, live) === 'awaiting_you';
}

/**
 * Rules (1) and (2) together: the two things worth interrupting someone for.
 * Everything else must never reach a banner, a buzz, or a lock screen.
 */
export function isWorthNotifying(notification: IntentInput, live: LiveReferents = {}): boolean {
  return classifyNotification(notification, live) !== 'neither';
}
