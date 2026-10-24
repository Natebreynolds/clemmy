/** Canonical read-only compatibility display checks over one explicit snapshot.
 * These helpers never settle, retain, replay or change execution ownership. */
import type Database from 'better-sqlite3';
import type { SessionRow, EventRow, EventType, SessionStatus } from './eventlog.js';
type ReconcileDb = Database.Database;
export interface ActiveWorkSessionReader {
  database(): Database.Database;
  /** Reuse raw metadata only from the same SQLite read transaction; reread kind/status. */
  readCurrentSession?: (sessionId: string) => { kind: string; status: string; metadata_json: string } | undefined;
  listEvents: typeof import('./eventlog.js').listEvents;
  listEventsAtSequences: typeof import('./eventlog.js').listEventsAtSequences;
  workflowRunInventoryEntry: typeof import('../../execution/workflow-run-inventory.js').workflowRunInventoryEntry;
  auditAcceptedSourceSettlementTruth: typeof import('./accepted-source-settlement-audit.js').auditAcceptedSourceSettlementTruth;
}

const WORK_LIFECYCLE_EVENT_TYPES: EventType[] = [
  'turn_started',
  'awaiting_user_input',
  'approval_requested',
  'run_paused',
  'conversation_limit_exceeded',
  'conversation_completed',
  'run_completed',
  'run_failed',
  'worker_model_routed',
];

const NON_TERMINAL_COMPLETION_REASONS = new Set([
  'awaiting_user_input',
  'awaiting_continue',
  // Budget parks (2026-08-18): blocked+resumable checkpoints awaiting host
  // re-entry — the work has not finished.
  'step_budget_parked',
  'sdk_step_budget_parked',
  'budget_checkpoint_auto_resume',
]);

const DEFAULT_ACTIVE_WORK_STALE_MS = 12 * 60 * 60_000;
const MAX_WORKFLOW_DISPLAY_RECONCILIATION_SOURCES = 8;
function cleanReason(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function latestSessionEventRead(sessionId: string, reader: ActiveWorkSessionReader): EventRow | undefined {
  const events = reader.listEvents(sessionId, { desc: true, limit: 1 });
  return events[events.length - 1];
}

export function latestWorkLifecycleEventRead(sessionId: string, reader: ActiveWorkSessionReader): EventRow | undefined {
  // The newest lifecycle sequence comes from the (session_id, type) index
  // alone; only that one row is read, never the session's history before it.
  const placeholders = WORK_LIFECYCLE_EVENT_TYPES.map(() => '?').join(',');
  const newest = reader.database().prepare(
    `SELECT max(seq) AS seq FROM events WHERE session_id = ? AND type IN (${placeholders})`,
  ).get(sessionId, ...WORK_LIFECYCLE_EVENT_TYPES) as { seq: number | null } | undefined;
  if (!newest?.seq) return undefined;
  return reader.listEventsAtSequences(sessionId, [newest.seq])[0];
}

export function terminalStatusForWorkLifecycleEvent(
  event: Pick<EventRow, 'type' | 'data'> | undefined,
): Extract<SessionStatus, 'completed' | 'failed'> | null {
  if (!event) return null;
  if (event.type === 'run_failed') return 'failed';
  if (event.type === 'run_completed') return 'completed';
  if (
    event.type === 'worker_model_routed'
    && event.data?.transport === 'claude_agent_sdk_workflow_step'
  ) {
    return 'completed';
  }
  if (event.type === 'conversation_completed') {
    const reason = cleanReason(event.data?.reason);
    if (NON_TERMINAL_COMPLETION_REASONS.has(reason)) return null;
    return 'completed';
  }
  return null;
}

export function isDormantTerminalWorkSessionRead(
  session: SessionRow,
  options: { pendingSessionIds?: Set<string> },
  reader: ActiveWorkSessionReader,
): boolean {
  if (session.kind === 'chat') return false;
  if (options.pendingSessionIds?.has(session.id)) return false;
  return terminalStatusForWorkLifecycleEvent(latestWorkLifecycleEventRead(session.id, reader)) !== null;
}

export function isIgnorableActiveWorkSessionRead(
  session: SessionRow,
  options: {
    pendingSessionIds?: Set<string>;
    nowMs?: number;
    staleMs?: number;
  },
  reader: ActiveWorkSessionReader,
): boolean {
  if (session.kind === 'chat') return false;
  if (options.pendingSessionIds?.has(session.id)) return false;
  if (session.kind === 'workflow' && (!session.metadata || typeof session.metadata !== 'object'
    || Array.isArray(session.metadata))) return false;
  // Workflow steps can finish with a settled tool result rather than a legacy
  // conversation-completed event. Their exact parent is the status owner. Do
  // not turn an absent, changed or unreadable parent into an age-based guess.
  if (session.kind === 'workflow' && Object.hasOwn(session.metadata, 'workflowRunId')) {
    return isFinishedWorkflowChildForDisplay(session, options.nowMs ?? Date.now(), reader);
  }
  if (isDormantTerminalWorkSessionRead(session, { pendingSessionIds: options.pendingSessionIds }, reader)) return true;

  const latest = latestSessionEventRead(session.id, reader);
  if (!latest) return true;
  if (latest.type === 'session_started') return true;

  const ts = Date.parse(latest.createdAt);
  const staleMs = options.staleMs ?? DEFAULT_ACTIVE_WORK_STALE_MS;
  if (Number.isFinite(ts) && Math.max(0, (options.nowMs ?? Date.now()) - ts) > staleMs) {
    return true;
  }
  return false;
}

/** Display only: this neither closes a session nor settles/replays its calls. */
function isFinishedWorkflowChildForDisplay(session: SessionRow, nowMs: number, reader: ActiveWorkSessionReader): boolean {
  try {
    // Re-read the exact row so an earlier list snapshot cannot hide a new
    // pause/recovery owner. Workflow child metadata is bounded by the step;
    // arbitrary chat/model history never enters this path.
    const current = reader.readCurrentSession ? reader.readCurrentSession(session.id) : reader.database().prepare(
      'SELECT kind, status, metadata_json FROM sessions WHERE id = ?',
    ).get(session.id) as { kind: string; status: string; metadata_json: string } | undefined;
    if (!current || current.kind !== 'workflow' || current.status !== 'active') return false;
    const metadata = JSON.parse(current.metadata_json) as Record<string, unknown> | null;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
    const runId = metadata.workflowRunId;
    if (typeof runId !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(runId)
      || runId !== session.metadata.workflowRunId) return false;
    if (typeof metadata.stepId !== 'string' || !metadata.stepId.trim()) return false;
    for (const key of [
      '__run_in_flight', '__run_in_flight_owner', '__host_recovery_state',
      '__interrupt_state', '__source_approval_checkpoints', '__host_recovery_mcp_scope',
      '__continuation_owner', '__host_recovery_owner',
    ]) {
      if (metadata[key] !== undefined && metadata[key] !== null) return false;
    }
    if (isExplicitlyResumableLifecycle(latestWorkLifecycleEventRead(session.id, reader))) return false;
    if (hasDurableResumeOwner(reader.database(), session.id, current.metadata_json, nowMs)) return false;

    // Use the shared generation-aware inventory: repeated status polls do not
    // parse every run's heavy outputs or independently invent another cache.
    const record = reader.workflowRunInventoryEntry(runId)?.record;
    if (record?.id !== runId || record.status !== 'completed') return false;
    if (typeof metadata.workflowName !== 'string' || metadata.workflowName !== record.workflow) return false;
    if (!Array.isArray(record.stepOutputKeys) || !record.stepOutputKeys.includes(metadata.stepId)) return false;
    const latest = latestSessionEventRead(session.id, reader);
    if (!latest || typeof record.finishedAt !== 'string') return false;
    const finishedAt = Date.parse(record.finishedAt);
    const latestAt = Date.parse(latest.createdAt);
    return Number.isFinite(finishedAt) && Number.isFinite(latestAt)
      && finishedAt >= latestAt && finishedAt <= nowMs
      && workflowChildReconciliationSettledForDisplay(session.id, reader);
  } catch {
    // An unknown record/owner stays visible. This projection grants no recovery
    // or execution authority and never rewrites retained user history.
    return false;
  }
}

/** Immutable uncertainty flags are history, not live owners. Reuse the exact
 * source audit only for this completed-parent display projection; retention
 * and execution policy remain independent. Unknown/oversized history stays
 * visible instead of inventing a reconciliation decision. */
function workflowChildReconciliationSettledForDisplay(sessionId: string, reader: ActiveWorkSessionReader): boolean {
  const sources = reader.database().prepare(`
    SELECT DISTINCT source_user_seq AS sourceUserSeq
      FROM logical_call_settlements
     WHERE session_id = ? AND requires_reconciliation = 1
     ORDER BY source_user_seq
     LIMIT ?
  `).all(sessionId, MAX_WORKFLOW_DISPLAY_RECONCILIATION_SOURCES + 1) as Array<{ sourceUserSeq: number }>;
  if (sources.length > MAX_WORKFLOW_DISPLAY_RECONCILIATION_SOURCES) return false;
  return sources.every(({ sourceUserSeq }) => Number.isSafeInteger(sourceUserSeq) && sourceUserSeq > 0
    && reader.auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq }).status === 'clean');
}

export function isExplicitlyResumableLifecycle(
  event: Pick<EventRow, 'type' | 'data'> | undefined,
): boolean {
  if (!event) return false;
  if (
    event.type === 'awaiting_user_input'
    || event.type === 'approval_requested'
    || event.type === 'run_paused'
    || event.type === 'conversation_limit_exceeded'
  ) return true;
  return event.type === 'conversation_completed'
    && terminalStatusForWorkLifecycleEvent(event) === null;
}

function reconcileTableExists(db: ReconcileDb, name: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name));
}

export function hasDurableResumeOwner(
  db: ReconcileDb,
  sessionId: string,
  metadataJson: string,
  nowMs: number,
): boolean {
  let metadata: Record<string, unknown>;
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    metadata = parsed as Record<string, unknown>;
  } catch {
    return true;
  }
  if (
    metadata.pinned === true
    || metadata.archived === true
  ) return true;

  const exists = (sql: string, ...params: unknown[]): boolean => Boolean(db.prepare(sql).get(...params));
  if (reconcileTableExists(db, 'run_attempts') && exists(
    `SELECT 1 FROM run_attempts
      WHERE session_id = ? AND finished_at IS NULL LIMIT 1`,
    sessionId,
  )) return true;
  if (reconcileTableExists(db, 'pending_approvals') && exists(
    `SELECT 1 FROM pending_approvals
      WHERE session_id = ? AND status = 'pending' LIMIT 1`,
    sessionId,
  )) return true;
  if (reconcileTableExists(db, 'task_continuity_packets') && exists(
    `SELECT 1 FROM task_continuity_packets
      WHERE session_id = ?
        AND consumed_at IS NULL AND superseded_at IS NULL
        AND expired_at IS NULL AND dismissed_at IS NULL
      LIMIT 1`,
    sessionId,
  )) return true;

  // A lease is live/ambiguous unless it is bound to a matching finished
  // attempt. The daemon's boot-wide dispatch quarantine owns revocation; this
  // retention query only decides whether a durable resume owner still exists.
  if (reconcileTableExists(db, 'run_dispatch_leases') && exists(
    `SELECT 1
       FROM run_dispatch_leases lease
       LEFT JOIN run_attempts attempt
         ON attempt.attempt_id = lease.run_attempt_id
        AND attempt.session_id = lease.session_id
      WHERE lease.session_id = ? AND lease.revoked_at IS NULL
        AND (
          lease.run_attempt_id IS NULL
          OR attempt.attempt_id IS NULL
          OR attempt.finished_at IS NULL
        )
      LIMIT 1`,
    sessionId,
  )) return true;

  const graphPrefix = `gnl2|${Buffer.byteLength(sessionId, 'utf8')}:${sessionId}|`;
  // The prefix ends in ASCII '|'; its immediate successor '}' bounds exactly
  // this prefix while allowing SQLite to use the lease-key index.
  const graphPrefixEnd = `${graphPrefix.slice(0, -1)}}`;
  if (reconcileTableExists(db, 'graph_node_leases') && exists(
    `SELECT 1 FROM graph_node_leases
      WHERE lease_key >= ? AND lease_key < ?
        AND released = 0 AND expires_at > ?
      LIMIT 1`,
    graphPrefix,
    graphPrefixEnd,
    nowMs,
  )) return true;
  if (reconcileTableExists(db, 'accepted_turn_call_authorities') && exists(
    `SELECT 1 FROM accepted_turn_call_authorities
      WHERE session_id = ? AND state = 'open' LIMIT 1`,
    sessionId,
  )) return true;
  if (reconcileTableExists(db, 'logical_tool_calls') && exists(
    `SELECT 1 FROM logical_tool_calls
      WHERE session_id = ? AND state = 'open' LIMIT 1`,
    sessionId,
  )) return true;
  if (reconcileTableExists(db, 'physical_dispatches') && exists(
    `SELECT 1 FROM physical_dispatches
      WHERE session_id = ? AND state = 'started' LIMIT 1`,
    sessionId,
  )) return true;
  if (reconcileTableExists(db, 'accepted_task_authority') && exists(
    `SELECT 1 FROM accepted_task_authority
      WHERE session_id = ? AND state NOT IN ('terminal','conflict') LIMIT 1`,
    sessionId,
  )) return true;
  return false;
}
