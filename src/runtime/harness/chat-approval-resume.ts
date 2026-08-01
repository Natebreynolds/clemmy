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
import {
  beginRunAttempt,
  getActiveRunAttempt,
  listEvents,
  recordRunAttemptUserInput,
  type EventRow,
  type RunAttemptRef,
} from './eventlog.js';
import { HarnessSession } from './session.js';
import { getPendingAction } from './pending-actions.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';
import { publicUserInputText } from './public-presentation.js';
import { freshExternalWriteEvidenceStatus } from './tool-evidence.js';

const logger = pino({ name: 'clementine.chat-approval-resume' });

const handledApprovalIds = new Set<string>();
const activeResumeSessions = new Set<string>();
const queuedApprovalResumes = new Map<string, {
  row: approvalRegistry.PendingApprovalRow;
  dispatch: ChatApprovalResumeDispatch;
}>();
const resumeDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RESUME_DRAIN_DELAY_MS = 25;

export interface ChatApprovalResumeSource {
  sourceUserSeq: number;
  displayMessage: string;
  /** Physical executor already bound to sourceUserSeq and restart ownership. */
  runAttemptId: string;
  /** Stable run family used by downstream beginRunAttempt idempotency. */
  runId: string;
}

export type ChatApprovalResumeDispatch = (
  sessionId: string,
  directive: string,
  source: ChatApprovalResumeSource,
) => Promise<void>;

function taggedApprovalResponse(row: approvalRegistry.PendingApprovalRow): EventRow | null {
  const matches = listEvents(row.sessionId, {
    types: ['user_input_received'],
  }).filter((event) =>
    event.data.approvalId === row.approvalId
    && event.data.decision === 'approve');
  // Multiple distinct accepted rows claiming one card make ownership
  // ambiguous. Never guess based on recency.
  return matches.length === 1 ? matches[0] : null;
}

/**
 * One approval owns one deterministic physical run family. Retrying a failed
 * callback in-process reuses its still-active attempt. A daemon boot first
 * interrupts old active rows, so a crash recovery mints a fresh physical
 * attempt under the same run id while preserving the logical user source.
 */
function approvalResumeRunId(approvalId: string): string {
  return `approval-resume:${approvalId}`;
}

function activeAttemptOwnsApprovalResume(
  attempt: RunAttemptRef,
  row: approvalRegistry.PendingApprovalRow,
): boolean {
  return attempt.runId === approvalResumeRunId(row.approvalId);
}

/** True when this logical approval-response source already has a public
 * terminal. A process crash after terminal commit but before registry consume
 * must reconcile, never execute the accepted turn again. */
function approvalSourceAlreadySettled(row: approvalRegistry.PendingApprovalRow): boolean {
  const accepted = taggedApprovalResponse(row);
  if (!accepted) return false;
  return listEvents(row.sessionId, { types: ['conversation_completed'] })
    .some((event) => {
      const presentation = event.data.presentation as {
        identity?: { sourceUserSeq?: unknown };
      } | undefined;
      return event.data.sourceUserSeq === accepted.seq
        || presentation?.identity?.sourceUserSeq === accepted.seq
        || event.data.terminalKey === `turn:${accepted.seq}`;
    });
}

/**
 * A resolved approval authorizes the intended action; it does not authorize a
 * blind replay after a provider may already have mutated external state. Only
 * no-write or exact proven-no-effect failure evidence can cross a crash.
 */
function approvalSourceIsSafeToDispatch(row: approvalRegistry.PendingApprovalRow): boolean {
  const accepted = taggedApprovalResponse(row);
  if (!accepted) return true; // first dispatch; no approval-resume source exists
  try {
    const status = freshExternalWriteEvidenceStatus(
      listEvents(row.sessionId, {
        types: [
          'external_write',
          'external_write_succeeded',
          'external_write_failed',
          'external_write_orphaned',
        ],
      }),
      accepted.seq,
    );
    return status === 'missing' || status === 'failed';
  } catch {
    return false;
  }
}

/**
 * Bind the exact approval-response source and restart marker before execution.
 * Button/notification surfaces may not have a visible chat row, so the same
 * atomic primitive mints one hidden control edge. Chat surfaces supply an
 * already-visible accepted row, which is reused without creating a sibling.
 */
function prepareApprovalResumeSource(
  row: approvalRegistry.PendingApprovalRow,
): ChatApprovalResumeSource | null {
  const runId = approvalResumeRunId(row.approvalId);
  const accepted = taggedApprovalResponse(row);
  if (!accepted) {
    const existingMatches = listEvents(row.sessionId, {
      types: ['user_input_received'],
    }).filter((event) => event.data.approvalId === row.approvalId);
    if (existingMatches.length > 0) return null;
  }
  const attempt = beginRunAttempt(row.sessionId, {
    runId,
  });
  const source = recordRunAttemptUserInput(attempt, {
    turn: accepted?.turn ?? 0,
    role: 'user',
    data: accepted?.data ?? {
      text: `Approve ${row.approvalId}.`,
      displayText: `Approve ${row.approvalId}`,
      synthetic: true,
      source: 'approval_resume',
      approvalId: row.approvalId,
      decision: 'approve',
    },
  }, {
    ...(accepted ? { existingEventSeq: accepted.seq } : {}),
    armRunInFlight: true,
  });
  return {
    sourceUserSeq: source.seq,
    displayMessage: publicUserInputText(source.data) || `Approve ${row.approvalId}`,
    runAttemptId: attempt.attemptId,
    runId,
  };
}

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
  if (activeResumeSessions.has(sessionId) || getActiveRunAttempt(sessionId) || session.runInFlightSince()) {
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
    const durableRow = queuedResumeStillActionable(row);
    if (!durableRow) return false;
    row = durableRow;
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
    if (approvalSourceAlreadySettled(row)) {
      handledApprovalIds.add(row.approvalId);
      return false;
    }
    if (!approvalSourceIsSafeToDispatch(row)) {
      logger.warn({ approvalId: row.approvalId, sessionId: row.sessionId },
        'parked approval resume withheld because the exact source has external-write risk');
      return false;
    }
    const activeAttempt = getActiveRunAttempt(row.sessionId);
    if (
      activeResumeSessions.has(row.sessionId)
      || (activeAttempt && !activeAttemptOwnsApprovalResume(activeAttempt, row))
      // A pre-attempt legacy executor can still own the coarse marker. Once an
      // attempt-backed approval resume exists, that exact owner wins instead.
      || (!activeAttempt && session.runInFlightSince() && !taggedApprovalResponse(row))
    ) {
      // The current turn may own this resolution; if so its durable consume or
      // pending-action terminal state makes the queued row inert. Otherwise
      // (for example a second exact card in one bulk approval) drain it after
      // the session is free instead of silently losing the user's decision.
      enqueueApprovalResume(row, dispatch);
      return false;
    }
    if (!activeAttempt && taggedApprovalResponse(row) && session.runInFlightSince()) {
      // Boot already retired the dead physical attempt. Replace (rather than
      // inherit) its pre-boot coarse marker so generic restart recovery cannot
      // race this approval-specific reclaim. A crash in this small clear→bind
      // interval is still durable: the approved/unconsumed registry row is the
      // next boot's scan source, and no callback has begun yet.
      session.clearRunInFlight();
      if (session.runInFlightSince()) return false;
    }
    const source = prepareApprovalResumeSource(row);
    if (!source) {
      logger.warn({ approvalId: row.approvalId, sessionId: row.sessionId },
        'parked approval resume has ambiguous accepted response ownership');
      return false;
    }
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
        source,
      );
      // Only a successful handoff consumes the in-process one-shot. If the
      // dispatcher is temporarily unavailable, retain the exact accepted
      // source and allow a later retry/manual continue to drive it.
      handledApprovalIds.add(row.approvalId);
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
let listenerRegistered = false;
let registeredDispatch: ChatApprovalResumeDispatch | null = null;
const dispatchResolvedApproval = (row: approvalRegistry.PendingApprovalRow): void => {
  const dispatch = registeredDispatch;
  if (dispatch) void handleResolvedApprovalForChatResume(row, dispatch);
};
export function startChatApprovalResume(dispatch: ChatApprovalResumeDispatch): void {
  if (started) return;
  started = true;
  registeredDispatch = dispatch;
  // Keep one stable registry callback. Tests may reset/restart the subsystem;
  // appending closure listeners would leave old dispatchers live forever.
  if (!listenerRegistered) {
    approvalRegistry.onApprovalResolved(dispatchResolvedApproval);
    listenerRegistered = true;
  }

  // Resolution hooks are necessarily live-only. Drain the durable registry at
  // registration so a decision committed before listener installation (or a
  // hard process death after source binding) cannot orphan an approved card.
  // The normal handler owns all parked/exact-linked and terminal checks, so
  // rejected, expired, live-wait, consumed, and already-settled rows stay inert.
  const durableApproved = approvalRegistry.listPending({ status: 'resolved' })
    .filter((row) => row.resolution === 'approved' && !row.consumedAt)
    .sort((left, right) =>
      (left.resolvedAt ?? left.requestedAt).localeCompare(right.resolvedAt ?? right.requestedAt)
      || left.approvalId.localeCompare(right.approvalId));
  for (const row of durableApproved) {
    // handleResolvedApprovalForChatResume runs synchronously through durable
    // source/attempt/marker binding before its first await. Do not block daemon
    // availability on model execution; the now-current marker and active
    // attempt own crash recovery while the callback runs.
    void handleResolvedApprovalForChatResume(row, dispatch);
  }
}

/** Test hook: clear the in-process one-shot memory. */
export function _resetChatApprovalResumeForTest(): void {
  handledApprovalIds.clear();
  activeResumeSessions.clear();
  queuedApprovalResumes.clear();
  for (const timer of resumeDrainTimers.values()) clearTimeout(timer);
  resumeDrainTimers.clear();
  started = false;
  registeredDispatch = null;
}
