/**
 * Chat approval auto-resume (2026-07-20) — the resume half of the fail-closed
 * approval park.
 *
 * The chat/worker WAIT gate (claude-agent-approval.ts) parks after its hold
 * ceiling: the turn ends honestly ("waiting on your approval") and the durable
 * exact-payload card stays pending + resumable. Without this module the user's
 * later approval would resolve the card into a void — nothing is awaiting it
 * anymore, so the approved action would silently never run (the trust break:
 * "I approved it and nothing happened").
 *
 * This listener closes the loop: when a PARKED chat approval resolves
 * APPROVED, it re-drives the session through the normal respond spine with a
 * resume directive. The model re-issues the same tool call; the gate's
 * one-shot resumable claim lets that exact payload through without re-asking.
 *
 * Safety properties:
 *  - Only fires for approvals that durably recorded an `approval_parked`
 *    event (a live wait loop — user answered in time — never parked, so the
 *    in-flight run owns the resolution and this listener stays out).
 *  - Never dispatches into a session with a run in flight (runInFlightSince):
 *    the running turn will see the resolution itself.
 *  - Approval is the ONLY resolution that re-drives. A rejection/expiry stops
 *    quietly — the reaper and the gate's deny message already tell the user —
 *    so a declined action can never come back on its own.
 *  - One-shot per approval per process; the registry's atomic consume is the
 *    durable guard across restarts.
 *
 * Started from the daemon bootstrap next to startApprovalReaper, with the
 * dispatcher injected (respondPreferHarness) — the same shape as
 * restart-recovery's auto-resume, so no import cycle into respond-bridge.
 */

import pino from 'pino';
import * as approvalRegistry from './approval-registry.js';
import { listEvents } from './eventlog.js';
import { HarnessSession } from './session.js';
import { getPendingAction } from './pending-actions.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';

const logger = pino({ name: 'clementine.chat-approval-resume' });

const handledApprovalIds = new Set<string>();
const activeResumeSessions = new Set<string>();
const queuedApprovalResumes = new Map<string, {
  row: approvalRegistry.PendingApprovalRow;
  dispatch: ChatApprovalResumeDispatch;
}>();
const resumeDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RESUME_DRAIN_DELAY_MS = 25;

export type ChatApprovalResumeDispatch = (sessionId: string, directive: string) => Promise<void>;

function scheduleResumeDrain(sessionId: string): void {
  if (resumeDrainTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    resumeDrainTimers.delete(sessionId);
    void drainQueuedApprovalResumes(sessionId);
  }, RESUME_DRAIN_DELAY_MS);
  timer.unref?.();
  resumeDrainTimers.set(sessionId, timer);
}

function enqueueApprovalResume(
  row: approvalRegistry.PendingApprovalRow,
  dispatch: ChatApprovalResumeDispatch,
): void {
  queuedApprovalResumes.set(row.approvalId, { row, dispatch });
  scheduleResumeDrain(row.sessionId);
}

function queuedResumeStillActionable(row: approvalRegistry.PendingApprovalRow): approvalRegistry.PendingApprovalRow | null {
  const current = approvalRegistry.get(row.approvalId);
  if (
    !current
    || current.status !== 'resolved'
    || current.resolution !== 'approved'
    || current.consumedAt
  ) return null;
  const pendingActionId = pendingActionIdFromArgs(current.args) ?? undefined;
  if (!pendingActionId) return current;
  const pendingAction = getPendingAction(pendingActionId);
  return pendingAction
    && pendingAction.sessionId === current.sessionId
    && pendingAction.approvalId === current.approvalId
    && pendingAction.status === 'approved'
    && pendingAction.approvedBy === 'human'
    ? current
    : null;
}

async function drainQueuedApprovalResumes(sessionId: string): Promise<void> {
  const session = HarnessSession.load(sessionId);
  if (!session || session.kind !== 'chat') {
    for (const [approvalId, queued] of queuedApprovalResumes) {
      if (queued.row.sessionId === sessionId) queuedApprovalResumes.delete(approvalId);
    }
    return;
  }
  if (activeResumeSessions.has(sessionId) || session.runInFlightSince()) {
    scheduleResumeDrain(sessionId);
    return;
  }
  const next = [...queuedApprovalResumes.values()]
    .filter((queued) => queued.row.sessionId === sessionId)
    .sort((left, right) =>
      left.row.requestedAt.localeCompare(right.row.requestedAt)
      || left.row.approvalId.localeCompare(right.row.approvalId))[0];
  if (!next) return;
  queuedApprovalResumes.delete(next.row.approvalId);
  const current = queuedResumeStillActionable(next.row);
  if (current) await handleResolvedApprovalForChatResume(current, next.dispatch);
  if ([...queuedApprovalResumes.values()].some((queued) => queued.row.sessionId === sessionId)) {
    scheduleResumeDrain(sessionId);
  }
}

export function chatApprovalResumeDirective(
  subject: string,
  tool: string,
  pendingActionId?: string,
  pendingActionToolName?: string,
): string {
  if (pendingActionId) {
    if (pendingActionToolName === 'run_batch') {
      return (
        `[approval-resume] The user just APPROVED the exact queued batch "${subject}" (${pendingActionId}). `
        + `Call run_batch once with action="execute" and pending_action_id="${pendingActionId}". `
        + 'It consumes the stored certified plan and records the per-item ledger. '
        + 'Do not re-propose it, reconstruct any item, or request another approval. Then report the authoritative ledger.'
      );
    }
    return (
      `[approval-resume] The user just APPROVED the exact queued action "${subject}" (${pendingActionId}). `
      + `Call pending_action_execute once with id "${pendingActionId}". It dispatches the byte-identical stored payload and records the provider result. `
      + 'Do not re-queue it, reconstruct the underlying call, or request another approval. Then report what landed.'
    );
  }
  return (
    `[approval-resume] The user just APPROVED the pending action "${subject}" (${tool}). `
    + 'Resume the parked task now: re-run the approved tool call with the exact same arguments — '
    + 'the approval gate will let that exact payload through without asking again. '
    + 'Then finish any remaining work from the original request and report what landed.'
  );
}

/** Decide + dispatch for one resolved approval. Exported for tests.
 *  Returns true when a resume was dispatched. */
export async function handleResolvedApprovalForChatResume(
  row: approvalRegistry.PendingApprovalRow,
  dispatch: ChatApprovalResumeDispatch,
): Promise<boolean> {
  try {
    if (row.resolution !== 'approved') return false;
    if (handledApprovalIds.has(row.approvalId)) return false;
    const pendingActionId = pendingActionIdFromArgs(row.args) ?? undefined;
    const pendingAction = pendingActionId ? getPendingAction(pendingActionId) : null;
    // An exact linked pending-action card is intrinsically resumable. This is
    // the crash-recovery twin of approval_parked: if the daemon died after
    // linking the row but before appending that event, approval still executes
    // only the stored payload instead of resolving into a void.
    const exactLinkedPendingAction = Boolean(
      pendingAction
      && pendingAction.sessionId === row.sessionId
      && pendingAction.approvalId === row.approvalId
      && pendingAction.status === 'approved'
      && pendingAction.approvedBy === 'human',
    );
    const parked = listEvents(row.sessionId, { types: ['approval_parked'] })
      .some((ev) => (ev.data as { approvalId?: string } | undefined)?.approvalId === row.approvalId);
    if (!parked && !exactLinkedPendingAction) return false;
    const session = HarnessSession.load(row.sessionId);
    if (!session || session.kind !== 'chat') return false;
    if (activeResumeSessions.has(row.sessionId) || session.runInFlightSince()) {
      // The current turn may own this resolution; if so its durable consume or
      // pending-action terminal state makes the queued row inert. Otherwise
      // (for example a second exact card in one bulk approval) drain it after
      // the session is free instead of silently losing the user's decision.
      enqueueApprovalResume(row, dispatch);
      return false;
    }
    handledApprovalIds.add(row.approvalId);
    activeResumeSessions.add(row.sessionId);
    logger.info({ approvalId: row.approvalId, sessionId: row.sessionId, subject: row.subject },
      'parked approval approved — resuming the chat session');
    try {
      await dispatch(
        row.sessionId,
        chatApprovalResumeDirective(
          row.subject,
          row.tool ?? 'the approved tool',
          pendingActionId,
          pendingAction?.toolName,
        ),
      );
      return true;
    } finally {
      activeResumeSessions.delete(row.sessionId);
      if ([...queuedApprovalResumes.values()].some((queued) => queued.row.sessionId === row.sessionId)) {
        scheduleResumeDrain(row.sessionId);
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), approvalId: row.approvalId },
      'chat approval resume failed — the approval stays consumable; the user can say "continue"');
    return false;
  }
}

/** Wire the registry's resolution hook to the injected dispatcher. Idempotent
 *  per process (the registry appends listeners; guard our own double-start). */
let started = false;
export function startChatApprovalResume(dispatch: ChatApprovalResumeDispatch): void {
  if (started) return;
  started = true;
  approvalRegistry.onApprovalResolved((row) => {
    void handleResolvedApprovalForChatResume(row, dispatch);
  });
}

/** Test hook: clear the in-process one-shot memory. */
export function _resetChatApprovalResumeForTest(): void {
  handledApprovalIds.clear();
  activeResumeSessions.clear();
  queuedApprovalResumes.clear();
  for (const timer of resumeDrainTimers.values()) clearTimeout(timer);
  resumeDrainTimers.clear();
  started = false;
}
