import {
  configuredSessionRetentionDays,
  listEvents,
  listSessions,
  openEventLog,
  updateSession,
  type EventRow,
  type EventType,
  type SessionRow,
  type SessionStatus,
} from './eventlog.js';
import { listPending } from './approval-registry.js';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from '../../tools/shared.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
} from '../../execution/workflow-run-record.js';

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
const DAY_MS = 24 * 60 * 60_000;
const SESSION_SCAN_PAGE_SIZE = 500;
const TERMINAL_WORKFLOW_RUN_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'blocked',
  'error',
  'failed',
  'cancelled',
]);

function cleanReason(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function latestSessionEvent(sessionId: string): EventRow | undefined {
  const events = listEvents(sessionId, { desc: true, limit: 1 });
  return events[events.length - 1];
}

export function latestWorkLifecycleEvent(sessionId: string): EventRow | undefined {
  const events = listEvents(sessionId, {
    types: WORK_LIFECYCLE_EVENT_TYPES,
    desc: true,
    limit: 1,
  });
  return events[events.length - 1];
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

export function isDormantTerminalWorkSession(
  session: SessionRow,
  options: { pendingSessionIds?: Set<string> } = {},
): boolean {
  if (session.kind === 'chat') return false;
  if (options.pendingSessionIds?.has(session.id)) return false;
  return terminalStatusForWorkLifecycleEvent(latestWorkLifecycleEvent(session.id)) !== null;
}

export function isIgnorableActiveWorkSession(
  session: SessionRow,
  options: {
    pendingSessionIds?: Set<string>;
    nowMs?: number;
    staleMs?: number;
  } = {},
): boolean {
  if (session.kind === 'chat') return false;
  if (options.pendingSessionIds?.has(session.id)) return false;
  if (isDormantTerminalWorkSession(session, { pendingSessionIds: options.pendingSessionIds })) return true;

  const latest = latestSessionEvent(session.id);
  if (!latest) return true;
  if (latest.type === 'session_started') return true;

  const ts = Date.parse(latest.createdAt);
  const staleMs = options.staleMs ?? DEFAULT_ACTIVE_WORK_STALE_MS;
  if (Number.isFinite(ts) && Math.max(0, (options.nowMs ?? Date.now()) - ts) > staleMs) {
    return true;
  }
  return false;
}

function normalizeSessionScanLimit(limit: number): number {
  const raw = Math.trunc(limit);
  if (!Number.isFinite(raw)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, raw);
}

function listReconciliationCandidates(limit: number): SessionRow[] {
  const maxCandidates = normalizeSessionScanLimit(limit);
  const candidates: SessionRow[] = [];
  for (let offset = 0; candidates.length < maxCandidates; offset += SESSION_SCAN_PAGE_SIZE) {
    const pageLimit = Math.min(SESSION_SCAN_PAGE_SIZE, maxCandidates - candidates.length);
    const page = listSessions({
      kind: ['workflow', 'execution', 'agent'],
      status: ['active', 'paused'],
      limit: pageLimit,
      offset,
    });
    candidates.push(...page);
    if (page.length < pageLimit) break;
  }
  return candidates;
}

function isExplicitlyResumableLifecycle(
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

type ReconcileDb = ReturnType<typeof openEventLog>;

function reconcileTableExists(db: ReconcileDb, name: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name));
}

/** A finished run attempt invalidates its exact dispatch generation (the same
 * condition enforced by `isDispatchLeaseCurrent`). Closing only those proven
 * generations prevents a historical lease row from masquerading as a live
 * resume owner; missing/unbound/active-attempt leases remain fail-closed. */
function revokeFinishedAttemptDispatchLeases(
  db: ReconcileDb,
  sessionId: string,
  revokedAt: string,
): void {
  if (
    !reconcileTableExists(db, 'run_dispatch_leases')
    || !reconcileTableExists(db, 'run_attempts')
  ) return;
  db.prepare(`
    UPDATE run_dispatch_leases
       SET revoked_at = COALESCE(revoked_at, ?)
     WHERE session_id = ?
       AND revoked_at IS NULL
       AND run_attempt_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM run_attempts attempt
          WHERE attempt.attempt_id = run_dispatch_leases.run_attempt_id
            AND attempt.session_id = run_dispatch_leases.session_id
            AND attempt.finished_at IS NOT NULL
       )
  `).run(revokedAt, sessionId);
}

function hasDurableResumeOwner(
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

  // A lease is live/ambiguous unless it is bound to a matching FINISHED
  // attempt. Those exact invalid generations were revoked immediately above.
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
  if (reconcileTableExists(db, 'graph_node_leases') && exists(
    `SELECT 1 FROM graph_node_leases
      WHERE substr(lease_key, 1, length(?)) = ?
        AND released = 0 AND expires_at > ?
      LIMIT 1`,
    graphPrefix,
    graphPrefix,
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

function workflowRunRecordMayStillOwnSession(
  record: Record<string, unknown> | null,
  workflowRunId: string,
): boolean {
  if (!record) return false;
  if (record.id !== workflowRunId || typeof record.status !== 'string') return true;
  if (TERMINAL_WORKFLOW_RUN_STATUSES.has(record.status)) return false;
  if (
    (record.status === 'dry_run' || record.status === 'creation_test')
    && typeof record.finishedAt === 'string'
  ) return false;
  return true;
}

/** Retention-age alone never proves failure. This path is restricted to
 * non-chat work with no terminal event, no explicit resume lifecycle, and no
 * durable/live owner. It closes only already-invalid finished-attempt leases,
 * then CAS-marks the abandoned session failed so normal terminal retention can
 * reclaim it on a later sweep. Reusable chat sessions never enter this path. */
function reconcileRetentionAgedWorkOrphan(
  session: SessionRow,
  options: { nowMs: number; staleMs: number },
): boolean {
  // Execution/agent sessions have owners in stores this bounded reconciler
  // does not yet join. Keep them report-only rather than turning missing local
  // harness rows into false failure authority. Workflow sessions carry one
  // exact run id, whose canonical record can be locked and checked below.
  if (session.kind !== 'workflow' || session.status !== 'active') return false;
  const updatedAtMs = Date.parse(session.updatedAt);
  if (!Number.isFinite(updatedAtMs) || options.nowMs - updatedAtMs <= options.staleMs) return false;

  const workflowRunId = typeof session.metadata.workflowRunId === 'string'
    ? session.metadata.workflowRunId.trim()
    : '';
  if (!workflowRunId || !/^[A-Za-z0-9._:-]+$/.test(workflowRunId)) return false;
  const workflowRunFile = path.join(WORKFLOW_RUNS_DIR, `${workflowRunId}.json`);

  const db = openEventLog();
  const apply = db.transaction(() => {
    const current = db.prepare(`
      SELECT kind, status, updated_at, metadata_json
        FROM sessions WHERE id = ?
    `).get(session.id) as {
      kind: SessionRow['kind'];
      status: SessionStatus;
      updated_at: string;
      metadata_json: string;
    } | undefined;
    if (!current || current.kind === 'chat' || current.status !== 'active') return false;
    const currentUpdatedAtMs = Date.parse(current.updated_at);
    if (
      !Number.isFinite(currentUpdatedAtMs)
      || options.nowMs - currentUpdatedAtMs <= options.staleMs
    ) return false;

    const rawLifecycle = db.prepare(`
      SELECT type, data_json
        FROM events
       WHERE session_id = ?
         AND type IN (
           'turn_started','awaiting_user_input','approval_requested','run_paused',
           'conversation_limit_exceeded','conversation_completed','run_completed',
           'run_failed','worker_model_routed'
         )
       ORDER BY seq DESC LIMIT 1
    `).get(session.id) as { type: EventType; data_json: string } | undefined;
    let lifecycle: Pick<EventRow, 'type' | 'data'> | undefined;
    if (rawLifecycle) {
      try {
        lifecycle = { type: rawLifecycle.type, data: JSON.parse(rawLifecycle.data_json) as Record<string, unknown> };
      } catch {
        return false;
      }
    }
    if (terminalStatusForWorkLifecycleEvent(lifecycle) !== null) return false;
    if (isExplicitlyResumableLifecycle(lifecycle)) return false;

    const now = new Date(options.nowMs).toISOString();
    revokeFinishedAttemptDispatchLeases(db, session.id, now);
    if (hasDurableResumeOwner(db, session.id, current.metadata_json, options.nowMs)) return false;
    const result = db.prepare(`
      UPDATE sessions
         SET status = 'failed',
             metadata_json = json_remove(
               metadata_json,
               '$.__run_in_flight',
               '$.__run_in_flight_owner'
             ),
             updated_at = ?
       WHERE id = ? AND status = 'active' AND updated_at = ?
    `).run(now, session.id, current.updated_at);
    return result.changes === 1;
  });
  try {
    // Serialize the orphan decision with the canonical workflow owner. If a
    // queued/running/parked record exists, it wins even when the harness-side
    // attempt was interrupted long ago. Locking the exact absent path also
    // closes the create-between-check-and-CAS race.
    return withWorkflowRunRecordLock(workflowRunFile, () => {
      let record: Record<string, unknown> | null;
      try {
        record = readWorkflowRunRecordUnlocked<Record<string, unknown>>(workflowRunFile);
      } catch {
        return false;
      }
      if (workflowRunRecordMayStillOwnSession(record, workflowRunId)) return false;
      return apply.immediate();
    }, { timeoutMs: 0 });
  } catch {
    // Best-effort boot hygiene. Any ambiguity retains the active row.
    return false;
  }
}

export function reconcileDormantTerminalWorkSessions(
  limit = Number.POSITIVE_INFINITY,
  options: { nowMs?: number; staleMs?: number } = {},
): {
  scanned: number;
  reconciled: number;
  completed: number;
  failed: number;
  ids: string[];
} {
  const pendingSessionIds = new Set(listPending({ status: 'pending' }).map((approval) => approval.sessionId));
  const candidates = listReconciliationCandidates(limit);
  const ids: string[] = [];
  let completed = 0;
  let failed = 0;

  for (const session of candidates) {
    if (pendingSessionIds.has(session.id)) continue;
    const status = terminalStatusForWorkLifecycleEvent(latestWorkLifecycleEvent(session.id));
    if (!status) continue;
    try {
      updateSession(session.id, { status });
      ids.push(session.id);
      if (status === 'failed') failed += 1;
      else completed += 1;
    } catch {
      // Best-effort reconciliation. A bad row must not block daemon boot.
    }
  }

  const nowMs = options.nowMs ?? Date.now();
  const staleMs = options.staleMs ?? configuredSessionRetentionDays() * DAY_MS;
  for (const session of candidates) {
    if (ids.includes(session.id)) continue;
    if (!reconcileRetentionAgedWorkOrphan(session, { nowMs, staleMs })) continue;
    ids.push(session.id);
    failed += 1;
  }

  return {
    scanned: candidates.length,
    reconciled: ids.length,
    completed,
    failed,
    ids,
  };
}
