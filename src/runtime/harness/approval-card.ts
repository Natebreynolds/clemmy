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
import {
  appendEvent,
  getEvent,
  openEventLog,
  type EventRow,
} from './eventlog.js';
import * as approvalRegistry from './approval-registry.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';

export interface AtomicResumableApprovalCardInput
  extends approvalRegistry.RegisterApprovalInput {
  resumeKey: string;
  turn?: number;
  role?: string;
  extra?: Record<string, unknown>;
}

export interface AtomicResumableApprovalCardResult {
  row: approvalRegistry.PendingApprovalRow;
  approvalCreated: boolean;
  event: EventRow;
  eventCreated: boolean;
}

/**
 * Register a formal resumable approval and its visible card in one SQLite
 * writer transaction. This is intentionally for registry-owned approvals,
 * not file-backed PendingActions: those have a separate reconciliation state
 * machine and cannot be made atomic with a filesystem row by pretending the
 * file is part of SQLite.
 *
 * Re-entry repairs a historical row-without-event split and otherwise returns
 * the exact first event. Reserved card identity always comes from the registry
 * row; `extra` can add context but cannot override it.
 */
export function registerResumableApprovalCardAtomically(
  input: AtomicResumableApprovalCardInput,
): AtomicResumableApprovalCardResult {
  if (pendingActionIdFromArgs(input.args ?? null)) {
    throw new Error('atomic approval card does not own file-backed PendingAction linkage');
  }
  if (input.presentation) {
    throw new Error('atomic approval card currently owns formal cards only');
  }
  const resumeKey = input.resumeKey.trim();
  if (!resumeKey) throw new Error('atomic approval card requires an exact resume key');
  const db = openEventLog();
  const transaction = db.transaction((): AtomicResumableApprovalCardResult => {
    const registered = approvalRegistry.registerResumable({ ...input, resumeKey });
    const prior = db.prepare(`
      SELECT id
        FROM events
       WHERE session_id = ?
         AND type = 'approval_requested'
         AND json_extract(data_json, '$.approvalId') = ?
       ORDER BY seq ASC
       LIMIT 1
    `).get(input.sessionId, registered.row.approvalId) as { id: string } | undefined;
    if (prior) {
      const event = getEvent(prior.id);
      if (!event) throw new Error('atomic approval card event disappeared during replay');
      return {
        row: registered.row,
        approvalCreated: registered.created,
        event,
        eventCreated: false,
      };
    }
    const event = appendEvent({
      sessionId: input.sessionId,
      turn: input.turn ?? 0,
      role: input.role ?? 'Clem',
      type: 'approval_requested',
      data: {
        ...(input.extra ?? {}),
        tool: registered.row.tool ?? 'approval',
        subject: registered.row.subject,
        approvalId: registered.row.approvalId,
        pendingActionId: null,
        resumeKey,
      },
    });
    return {
      row: registered.row,
      approvalCreated: registered.created,
      event,
      eventCreated: true,
    };
  });
  return transaction.immediate();
}

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
