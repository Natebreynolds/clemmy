import {
  appendTerminalEventOnce,
  configuredSessionRetentionDays,
  finishRunAttempt,
  listEvents,
  listEventsAtSequences,
  listSessions,
  openEventLog,
  updateSession,
  type EventRow,
  type EventType,
  type SessionRow,
  type SessionStatus,
} from './eventlog.js';
import { getRuntimeEnv } from '../../config.js';
import { listPending } from './approval-registry.js';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from '../../tools/shared.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
} from '../../execution/workflow-run-record.js';
import { workflowRunInventoryEntry } from '../../execution/workflow-run-inventory.js';
import { auditAcceptedSourceSettlementTruth } from './accepted-source-settlement-audit.js';

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
const MAX_WORKFLOW_DISPLAY_RECONCILIATION_SOURCES = 8;
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
  // The newest lifecycle sequence comes from the (session_id, type) index
  // alone; only that one row is read, never the session's history before it.
  const placeholders = WORK_LIFECYCLE_EVENT_TYPES.map(() => '?').join(',');
  const newest = openEventLog().prepare(
    `SELECT max(seq) AS seq FROM events WHERE session_id = ? AND type IN (${placeholders})`,
  ).get(sessionId, ...WORK_LIFECYCLE_EVENT_TYPES) as { seq: number | null } | undefined;
  if (!newest?.seq) return undefined;
  return listEventsAtSequences(sessionId, [newest.seq])[0];
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
  if (session.kind === 'workflow' && (!session.metadata || typeof session.metadata !== 'object'
    || Array.isArray(session.metadata))) return false;
  // Workflow steps can finish with a settled tool result rather than a legacy
  // conversation-completed event. Their exact parent is the status owner. Do
  // not turn an absent, changed or unreadable parent into an age-based guess.
  if (session.kind === 'workflow' && Object.hasOwn(session.metadata, 'workflowRunId')) {
    return isFinishedWorkflowChildForDisplay(session, options.nowMs ?? Date.now());
  }
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

/** Display only: this neither closes a session nor settles/replays its calls. */
function isFinishedWorkflowChildForDisplay(session: SessionRow, nowMs: number): boolean {
  try {
    // Re-read the exact row so an earlier list snapshot cannot hide a new
    // pause/recovery owner. Workflow child metadata is bounded by the step;
    // arbitrary chat/model history never enters this path.
    const current = openEventLog().prepare(
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
    if (isExplicitlyResumableLifecycle(latestWorkLifecycleEvent(session.id))) return false;
    if (hasDurableResumeOwner(openEventLog(), session.id, current.metadata_json, nowMs)) return false;

    // Use the shared generation-aware inventory: repeated status polls do not
    // parse every run's heavy outputs or independently invent another cache.
    const record = workflowRunInventoryEntry(runId)?.record;
    if (record?.id !== runId || record.status !== 'completed') return false;
    if (typeof metadata.workflowName !== 'string' || metadata.workflowName !== record.workflow) return false;
    if (!Array.isArray(record.stepOutputKeys) || !record.stepOutputKeys.includes(metadata.stepId)) return false;
    const latest = latestSessionEvent(session.id);
    if (!latest || typeof record.finishedAt !== 'string') return false;
    const finishedAt = Date.parse(record.finishedAt);
    const latestAt = Date.parse(latest.createdAt);
    return Number.isFinite(finishedAt) && Number.isFinite(latestAt)
      && finishedAt >= latestAt && finishedAt <= nowMs
      && workflowChildReconciliationSettledForDisplay(session.id);
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
function workflowChildReconciliationSettledForDisplay(sessionId: string): boolean {
  const sources = openEventLog().prepare(`
    SELECT DISTINCT source_user_seq AS sourceUserSeq
      FROM logical_call_settlements
     WHERE session_id = ? AND requires_reconciliation = 1
     ORDER BY source_user_seq
     LIMIT ?
  `).all(sessionId, MAX_WORKFLOW_DISPLAY_RECONCILIATION_SOURCES + 1) as Array<{ sourceUserSeq: number }>;
  if (sources.length > MAX_WORKFLOW_DISPLAY_RECONCILIATION_SOURCES) return false;
  return sources.every(({ sourceUserSeq }) => Number.isSafeInteger(sourceUserSeq) && sourceUserSeq > 0
    && auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq }).status === 'clean');
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
 * durable/live owner. It CAS-marks the abandoned session failed so normal
 * terminal retention can reclaim it on a later sweep. Dispatch quarantine is
 * deliberately owned by the separate boot-wide reconciler; reusable chat
 * sessions never enter this path. */
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

// ── Accepted-input liveness (B7a, gauntlet 2026-08-26) ──────────────────────
// sess-branch-1d43… accepted user_input_received, its run attempt finished
// 'completed' 1.2s later having emitted ZERO further events, and the session
// sat status='active' for 80+ minutes: a silent no-reply. Acceptance is a
// lifecycle stamped at INTENT; nothing stamped the HAPPENING (a turn actually
// serving), and the only run-attempt reconciler ran at daemon boot. This sweep
// runs from the periodic reaper: an active session whose NEWEST event is an
// accepted user input older than the liveness bound, with no live executor
// lease, gets a DURABLE terminal — the eventlog answers the input, the session
// status stops lying 'active', and the caller (reaper) surfaces it to the user.

const DEFAULT_ACCEPTED_INPUT_LIVENESS_MS = 10 * 60_000;

export function acceptedInputLivenessBoundMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_ACCEPTED_INPUT_LIVENESS_MS', '') || '', 10);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_ACCEPTED_INPUT_LIVENESS_MS;
}

export interface SilentAcceptedInputRecord {
  sessionId: string;
  sourceUserSeq: number;
  acceptedAt: string;
  ageMs: number;
  /** True when an unfinished attempt with an expired/absent lease was closed. */
  attemptClosed: boolean;
}

export interface SilentAcceptedInputSweep {
  scanned: number;
  terminalized: number;
  ids: string[];
  records: SilentAcceptedInputRecord[];
}

export function reconcileSilentAcceptedInputSessions(
  options: { nowMs?: number; boundMs?: number; limit?: number } = {},
): SilentAcceptedInputSweep {
  const nowMs = options.nowMs ?? Date.now();
  const boundMs = options.boundMs ?? acceptedInputLivenessBoundMs();
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 50)));
  const records: SilentAcceptedInputRecord[] = [];
  let scanned = 0;

  let pendingSessionIds: Set<string>;
  try {
    pendingSessionIds = new Set(listPending({ status: 'pending' }).map((approval) => approval.sessionId));
  } catch {
    pendingSessionIds = new Set();
  }

  // Scoped to kind='chat' — the measured silent-no-reply class (sess-branch-…
  // was a chat session). Work sessions (workflow/execution/agent) have their
  // own reconcilers with owner stores this sweep does not join; widening here
  // would let a missing local harness row fabricate failure authority for them.
  const active = listSessions({ kind: ['chat'], status: ['active'], limit: 2_000, withoutConversationState: true });
  for (const session of active) {
    if (records.length >= limit) break;
    if (pendingSessionIds.has(session.id)) continue;
    const latest = latestSessionEvent(session.id);
    if (!latest || latest.type !== 'user_input_received') continue;
    scanned += 1;
    const acceptedAtMs = Date.parse(latest.createdAt);
    if (!Number.isFinite(acceptedAtMs)) continue;
    const ageMs = nowMs - acceptedAtMs;
    if (ageMs <= boundMs) continue;

    // A live executor still owns this session: an unfinished attempt whose
    // lease has not expired. An unfinished attempt with an expired or absent
    // lease is an executor that died between claim and turn — close it as part
    // of the disposition instead of letting it keep claiming the session.
    let attemptClosed = false;
    try {
      const attempt = openEventLog().prepare(
        `SELECT attempt_id, lease_expires_at
           FROM run_attempts
          WHERE session_id = ? AND finished_at IS NULL
          ORDER BY started_at DESC
          LIMIT 1`,
      ).get(session.id) as { attempt_id: string; lease_expires_at: string | null } | undefined;
      if (attempt) {
        const leaseExpiresMs = attempt.lease_expires_at ? Date.parse(attempt.lease_expires_at) : Number.NaN;
        if (Number.isFinite(leaseExpiresMs) && leaseExpiresMs > nowMs) continue; // genuinely in flight
        finishRunAttempt({ sessionId: session.id, attemptId: attempt.attempt_id }, 'interrupted');
        attemptClosed = true;
      }
    } catch {
      continue; // attempt state unreadable — never terminalize on uncertainty
    }

    try {
      const terminal = appendTerminalEventOnce({
        sessionId: session.id,
        turn: latest.turn,
        role: 'system',
        data: {
          sourceUserSeq: latest.seq,
          reason: 'accepted_input_never_started',
          status: 'failed',
          text: 'This message was accepted but no turn ever started for it. The session was closed by the liveness reaper — send the request again.',
        },
      }, `liveness:${latest.seq}`);
      // Status write ONLY AFTER the insert is confirmed OURS. If a real owner
      // already published the terminal for this exact source (inserted:false —
      // e.g. the turn finished between our staleness read and here), stamping
      // 'failed' would clobber that owner's outcome with a lost-race lie.
      if (!terminal.inserted) continue; // an owner already published a terminal for this exact source
      updateSession(session.id, { status: 'failed' });
    } catch {
      continue; // terminal publication refused (e.g. armed authority) — leave for its owner
    }

    records.push({
      sessionId: session.id,
      sourceUserSeq: latest.seq,
      acceptedAt: latest.createdAt,
      ageMs,
      attemptClosed,
    });
  }

  return {
    scanned,
    terminalized: records.length,
    ids: records.map((record) => record.sessionId),
    records,
  };
}
