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

const logger = pino({ name: 'clementine.chat-approval-resume' });

const handledApprovalIds = new Set<string>();

export type ChatApprovalResumeDispatch = (sessionId: string, directive: string) => Promise<void>;

export function chatApprovalResumeDirective(subject: string, tool: string): string {
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
    const parked = listEvents(row.sessionId, { types: ['approval_parked'] })
      .some((ev) => (ev.data as { approvalId?: string } | undefined)?.approvalId === row.approvalId);
    if (!parked) return false;
    const session = HarnessSession.load(row.sessionId);
    if (!session || session.kind !== 'chat') return false;
    if (session.runInFlightSince()) return false; // the live run owns this resolution
    handledApprovalIds.add(row.approvalId);
    logger.info({ approvalId: row.approvalId, sessionId: row.sessionId, subject: row.subject },
      'parked approval approved — resuming the chat session');
    await dispatch(row.sessionId, chatApprovalResumeDirective(row.subject, row.tool ?? 'the approved tool'));
    return true;
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
  started = false;
}
