/**
 * A2 (v2.3.0) — the actionable approval CARD, delivered to a chat session.
 *
 * Every chat surface folds `approval_requested` events into the
 * approve/execute card. Runs that park OUTSIDE the origin chat's own loop
 * (workflow runner, background tasks) historically delivered only prose
 * ("reply approve apr-x") to the origin session, leaving the user to hunt the
 * approval down on the board (live 2026-07-23). This is the one shared way to
 * put the real card in the conversation that asked for the work.
 *
 * Same stable data shape as the loop's canonical in-session emit; the chat
 * patches one assistant turn per approvalId, so re-parks dedupe naturally.
 * Best-effort by contract: callers keep their prose turn as the baseline.
 */
import { appendEvent } from './eventlog.js';
import * as approvalRegistry from './approval-registry.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';

export function emitApprovalRequestedCard(input: {
  sessionId: string;
  approvalId: string | undefined;
  /** Extra card context (workflowName, runId, taskId, …) merged into data. */
  extra?: Record<string, unknown>;
}): boolean {
  try {
    const row = input.approvalId ? approvalRegistry.get(input.approvalId) : undefined;
    if (!row) return false;
    // SLIM by design: ids only, never the args tree or the pending-action
    // payload (a 30-item batch plan would be duplicated per origin session
    // otherwise — the registry + pending-action store remain the single
    // copies). Readers hydrate the rich view at read time: the session-detail
    // reopen path rebuilds it from the registry row, and a live card can
    // fetch GET /api/console/pending-actions/:id.
    appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'Clem',
      type: 'approval_requested',
      data: {
        tool: row.tool ?? 'approval',
        subject: row.subject,
        approvalId: row.approvalId,
        pendingActionId: pendingActionIdFromArgs(row.args ?? null),
        ...(input.extra ?? {}),
      },
    });
    return true;
  } catch {
    return false;
  }
}
