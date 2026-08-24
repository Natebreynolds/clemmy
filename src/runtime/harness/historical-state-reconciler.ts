import { openEventLog } from './eventlog.js';
import {
  HISTORICAL_TERMINAL_COMPLETE_CLOSE_REASON,
  proveHistoricalTerminalCallAuthorityInTransaction,
  type HistoricalTerminalCallAuthorityProof,
} from './historical-terminal-call-authority-proof.js';
import {
  inspectHistoricalSessionExternalOwnership,
  type HistoricalSessionExternalOwnership,
} from '../../execution/historical-session-external-ownership.js';
import { readAcceptedTurnCallAuthorityInTransaction } from './accepted-turn-call-authority.js';

type HarnessDb = ReturnType<typeof openEventLog>;

export interface HistoricalRootCursor {
  openedAt: string;
  sessionId: string;
  sourceUserSeq: number;
}

export interface HistoricalSessionCursor {
  updatedAt: string;
  sessionId: string;
}

export interface HistoricalRootPageResult {
  inspected: number;
  closed: number;
  conflicted: number;
  held: number;
  heldReasons: Record<string, number>;
  casLost: number;
  nextCursor?: HistoricalRootCursor;
}

export interface HistoricalInterruptPageResult {
  inspected: number;
  cleared: number;
  held: number;
  heldReasons: Record<string, number>;
  casLost: number;
  nextCursor?: HistoricalSessionCursor;
}

export interface HistoricalHarnessReconcileResult {
  roots: Omit<HistoricalRootPageResult, 'nextCursor'>;
  interrupts: Omit<HistoricalInterruptPageResult, 'nextCursor'>;
  rootPageLimitReached: boolean;
  interruptPageLimitReached: boolean;
  nextRootCursor?: HistoricalRootCursor;
  nextInterruptCursor?: HistoricalSessionCursor;
}

interface RootRow {
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  source_event_id: string;
  source_turn: number;
  authority_digest: string;
  revision: number;
  opened_at: string;
}

interface SessionRow {
  id: string;
  updated_at: string;
  metadata_json: string;
}

type RootDisposition =
  | { status: 'close'; at: string }
  | { status: 'conflict'; at: string; code: string }
  | { status: 'hold'; code: string };

const DEFAULT_PAGE_SIZE = 128;
const MAX_PAGE_SIZE = 512;
const DEFAULT_MAX_PAGES = 8;
const MAX_PAGES = 32;

function boundedPageSize(value: number | undefined): number {
  if (!Number.isSafeInteger(value)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(value!, MAX_PAGE_SIZE));
}

function boundedPageCount(value: number | undefined): number {
  if (!Number.isSafeInteger(value)) return DEFAULT_MAX_PAGES;
  return Math.max(1, Math.min(value!, MAX_PAGES));
}

function tableExists(db: HarnessDb, name: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name));
}

function columnsOf(db: HarnessDb, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name));
}

function activeGraphLeaseExists(
  db: HarnessDb,
  sessionId: string,
  sourceUserSeq: number | undefined,
  nowMs: number,
): boolean {
  if (!tableExists(db, 'graph_node_leases')) return false;
  const sourcePrefix = sourceUserSeq === undefined
    ? `gnl2|${Buffer.byteLength(sessionId, 'utf8')}:${sessionId}|`
    : `gnl2|${Buffer.byteLength(sessionId, 'utf8')}:${sessionId}|${sourceUserSeq}|`;
  return Boolean(db.prepare(`
    SELECT 1
      FROM graph_node_leases
     WHERE substr(lease_key, 1, length(?)) = ?
       AND released = 0 AND expires_at > ?
     LIMIT 1
  `).get(sourcePrefix, sourcePrefix, nowMs));
}

function pendingContinuityExists(
  db: HarnessDb,
  sessionId: string,
  sourceUserSeq?: number,
): boolean | 'unknown' {
  if (!tableExists(db, 'task_continuity_packets')) return false;
  const columns = columnsOf(db, 'task_continuity_packets');
  const required = [
    'session_id',
    'originating_source_user_seq',
    'consumed_at',
    'superseded_at',
    'expired_at',
    'dismissed_at',
  ];
  if (required.some((column) => !columns.has(column))) return 'unknown';
  const sourceClause = sourceUserSeq === undefined ? '' : 'AND originating_source_user_seq = ?';
  return Boolean(db.prepare(`
    SELECT 1
      FROM task_continuity_packets
     WHERE session_id = ? ${sourceClause}
       AND consumed_at IS NULL AND superseded_at IS NULL
       AND expired_at IS NULL AND dismissed_at IS NULL
     LIMIT 1
  `).get(...(sourceUserSeq === undefined ? [sessionId] : [sessionId, sourceUserSeq])));
}

function activeRootOwner(
  db: HarnessDb,
  row: RootRow,
  nowMs: number,
): RootDisposition | null {
  if (tableExists(db, 'run_attempts')) {
    const columns = columnsOf(db, 'run_attempts');
    if (!columns.has('source_user_seq')) return { status: 'hold', code: 'attempt_source_unavailable' };
    if (db.prepare(`
      SELECT 1 FROM run_attempts
       WHERE session_id = ? AND source_user_seq = ? AND finished_at IS NULL
       LIMIT 1
    `).get(row.session_id, row.source_user_seq)) return { status: 'hold', code: 'active_attempt' };
  }
  if (tableExists(db, 'run_dispatch_leases')) {
    const columns = columnsOf(db, 'run_dispatch_leases');
    if (!columns.has('source_user_seq')) return { status: 'hold', code: 'dispatch_lease_source_unavailable' };
    if (db.prepare(`
      SELECT 1 FROM run_dispatch_leases
       WHERE session_id = ? AND source_user_seq = ? AND revoked_at IS NULL
       LIMIT 1
    `).get(row.session_id, row.source_user_seq)) return { status: 'hold', code: 'active_dispatch_lease' };
  }
  if (activeGraphLeaseExists(db, row.session_id, row.source_user_seq, nowMs)) {
    return { status: 'hold', code: 'active_graph_lease' };
  }
  if (tableExists(db, 'accepted_task_authority')) {
    const columns = columnsOf(db, 'accepted_task_authority');
    if (!columns.has('work_contract_id')) return { status: 'hold', code: 'task_preparation_unavailable' };
    const task = db.prepare(`
      SELECT accepted_task_id, state, work_contract_id
        FROM accepted_task_authority
       WHERE session_id = ? AND source_user_seq = ?
    `).get(row.session_id, row.source_user_seq) as {
      accepted_task_id: string;
      state: string;
      work_contract_id: string | null;
    } | undefined;
    if (task?.state === 'manifested_verifying' || (
      task?.state === 'armed' && task.work_contract_id !== null
    )) return { status: 'hold', code: 'pending_task_preparation' };
    if (task && !['armed', 'terminal', 'conflict'].includes(task.state)) {
      return { status: 'hold', code: 'unknown_task_preparation' };
    }
  }
  return null;
}

function terminalTaskAuthorityConflict(
  db: HarnessDb,
  row: RootRow,
  nowMs: number,
): RootDisposition | null {
  if (!tableExists(db, 'accepted_task_authority')) return null;
  const task = db.prepare(`
    SELECT accepted_task_id, state
      FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(row.session_id, row.source_user_seq) as {
    accepted_task_id: string;
    state: string;
  } | undefined;
  if (task && task.accepted_task_id !== row.accepted_task_id) {
    return { status: 'conflict', at: new Date(nowMs).toISOString(), code: 'task_identity' };
  }
  if (task?.state === 'conflict') {
    return { status: 'conflict', at: new Date(nowMs).toISOString(), code: 'task_conflict' };
  }
  return null;
}

function pendingTerminalOwner(
  db: HarnessDb,
  row: RootRow,
  proof: Extract<HistoricalTerminalCallAuthorityProof, { status: 'complete' }>,
): RootDisposition | null {
  if (proof.presentation.status !== 'needs_input') return null;
  if (proof.presentation.needs?.kind === 'approval') {
    if (!tableExists(db, 'pending_approvals')) return { status: 'hold', code: 'approval_store_unavailable' };
    const pending = db.prepare(`
      SELECT COUNT(*) AS count
        FROM pending_approvals
       WHERE approval_id = ? AND session_id = ? AND status = 'pending'
    `).get(proof.presentation.approvalId, row.session_id) as { count: number };
    return pending.count > 0 ? { status: 'hold', code: 'pending_approval' } : null;
  }
  const continuity = pendingContinuityExists(db, row.session_id, row.source_user_seq);
  return continuity === true
    ? { status: 'hold', code: 'pending_continuity' }
    : continuity === 'unknown' ? { status: 'hold', code: 'continuity_store_unavailable' } : null;
}

function conflictCode(reason: string): string {
  const code = reason.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (code || 'contradiction').slice(0, 96);
}

function incrementReason(reasons: Record<string, number>, code: string): void {
  reasons[code] = (reasons[code] ?? 0) + 1;
}

function classifyRoot(db: HarnessDb, row: RootRow, nowMs: number): RootDisposition {
  const owner = activeRootOwner(db, row, nowMs);
  if (owner) return owner;
  const proof = proveHistoricalTerminalCallAuthorityInTransaction(db, {
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    acceptedTaskId: row.accepted_task_id,
    sourceEventId: row.source_event_id,
    sourceTurn: row.source_turn,
  });
  if (proof.status === 'hold') return { status: 'hold', code: `proof_${conflictCode(proof.reason)}` };
  if (proof.status === 'conflict') {
    // A contradiction in the root/source row alone is not terminal evidence.
    // Keep it held unless one bounded terminal claimant actually exists.
    if (!proof.terminalEventId) return { status: 'hold', code: 'terminal_not_proven' };
    return {
      status: 'conflict',
      at: proof.terminalAt ?? new Date(nowMs).toISOString(),
      code: conflictCode(proof.reason),
    };
  }
  const verified = readAcceptedTurnCallAuthorityInTransaction(
    db,
    row.session_id,
    row.source_user_seq,
  );
  if (verified.status === 'missing' || verified.status === 'storage_error') {
    return { status: 'hold', code: 'root_authority_unavailable' };
  }
  if (verified.status === 'conflict') {
    return {
      status: 'conflict',
      at: proof.terminalAt,
      code: 'root_authority_mismatch',
    };
  }
  const taskConflict = terminalTaskAuthorityConflict(db, row, nowMs);
  if (taskConflict) return taskConflict;
  const pending = pendingTerminalOwner(db, row, proof);
  if (pending) return pending;
  return { status: 'close', at: proof.terminalAt };
}

export function reconcileHistoricalCallAuthorityRootPage(
  options: {
    db?: HarnessDb;
    cursor?: HistoricalRootCursor;
    pageSize?: number;
    nowMs?: number;
  } = {},
): HistoricalRootPageResult {
  const db = options.db ?? openEventLog();
  const pageSize = boundedPageSize(options.pageSize);
  const nowMs = options.nowMs ?? Date.now();
  if (!tableExists(db, 'accepted_turn_call_authorities')) {
    return {
      inspected: 0,
      closed: 0,
      conflicted: 0,
      held: 0,
      heldReasons: {},
      casLost: 0,
    };
  }
  const cursorClause = options.cursor ? `AND (
    opened_at > @openedAt
    OR (opened_at = @openedAt AND session_id > @cursorSessionId)
    OR (opened_at = @openedAt AND session_id = @cursorSessionId
      AND source_user_seq > @cursorSourceUserSeq)
  )` : '';
  const rows = db.prepare(`
    SELECT session_id, source_user_seq, accepted_task_id, source_event_id,
           source_turn, authority_digest, revision, opened_at
      FROM accepted_turn_call_authorities
     WHERE authority_kind = 'turn_graph' AND state = 'open'
       ${cursorClause}
     ORDER BY opened_at, session_id, source_user_seq
     LIMIT @limit
  `).all({
    openedAt: options.cursor?.openedAt ?? '',
    cursorSessionId: options.cursor?.sessionId ?? '',
    cursorSourceUserSeq: options.cursor?.sourceUserSeq ?? 0,
    limit: pageSize + 1,
  }) as RootRow[];
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const result: HistoricalRootPageResult = {
    inspected: page.length,
    closed: 0,
    conflicted: 0,
    held: 0,
    heldReasons: {},
    casLost: 0,
  };
  for (const row of page) {
    const applied = db.transaction(():
      | { status: 'closed' | 'conflicted' | 'cas_lost' }
      | { status: 'held'; code: string } => {
      const current = db.prepare(`
        SELECT session_id, source_user_seq, accepted_task_id, source_event_id,
               source_turn, authority_digest, revision, opened_at
          FROM accepted_turn_call_authorities
         WHERE session_id = ? AND source_user_seq = ?
           AND authority_kind = 'turn_graph' AND state = 'open'
           AND revision = ? AND authority_digest = ?
      `).get(
        row.session_id,
        row.source_user_seq,
        row.revision,
        row.authority_digest,
      ) as RootRow | undefined;
      if (!current) return { status: 'cas_lost' };
      const disposition = classifyRoot(db, current, nowMs);
      if (disposition.status === 'hold') return { status: 'held', code: disposition.code };
      const state = disposition.status === 'close' ? 'closed' : 'conflict';
      const reason = disposition.status === 'close'
        ? HISTORICAL_TERMINAL_COMPLETE_CLOSE_REASON
        : `historical_terminal_conflict:${disposition.code}`.slice(0, 160);
      const updated = db.prepare(`
        UPDATE accepted_turn_call_authorities
           SET state = ?, revision = revision + 1, closed_at = ?, close_reason = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND authority_kind = 'turn_graph' AND state = 'open'
           AND revision = ? AND authority_digest = ?
      `).run(
        state,
        disposition.at,
        reason,
        current.session_id,
        current.source_user_seq,
        current.revision,
        current.authority_digest,
      );
      if (updated.changes !== 1) return { status: 'cas_lost' };
      return { status: state === 'closed' ? 'closed' : 'conflicted' };
    }).immediate();
    if (applied.status === 'closed') result.closed += 1;
    else if (applied.status === 'conflicted') result.conflicted += 1;
    else if (applied.status === 'held') {
      result.held += 1;
      incrementReason(result.heldReasons, applied.code);
    }
    else result.casLost += 1;
  }
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]!;
    result.nextCursor = {
      openedAt: last.opened_at,
      sessionId: last.session_id,
      sourceUserSeq: last.source_user_seq,
    };
  }
  return result;
}

function exactTerminalAndChildrenCompleteForSource(
  db: HarnessDb,
  sessionId: string,
  sourceUserSeq: number,
  sourceEventId: string,
  sourceTurn: number,
): boolean {
  const proof = proveHistoricalTerminalCallAuthorityInTransaction(db, {
    sessionId,
    sourceUserSeq,
    acceptedTaskId: `task:${sessionId}#${sourceUserSeq}`,
    sourceEventId,
    sourceTurn,
  });
  return proof.status === 'complete';
}

function sessionPendingDatabaseOwnerReason(
  db: HarnessDb,
  sessionId: string,
  metadataJson: string,
  nowMs: number,
): string | null {
  let metadata: Record<string, unknown>;
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'metadata_unreadable';
    metadata = parsed as Record<string, unknown>;
  } catch {
    return 'metadata_unreadable';
  }
  if (
    Object.prototype.hasOwnProperty.call(metadata, '__run_in_flight')
    || Object.prototype.hasOwnProperty.call(metadata, '__run_in_flight_owner')
  ) return 'run_in_flight_marker';
  if (tableExists(db, 'run_attempts') && db.prepare(`
    SELECT 1 FROM run_attempts WHERE session_id = ? AND finished_at IS NULL LIMIT 1
  `).get(sessionId)) return 'active_attempt';
  if (tableExists(db, 'pending_approvals') && db.prepare(`
    SELECT 1 FROM pending_approvals WHERE session_id = ? AND status = 'pending' LIMIT 1
  `).get(sessionId)) return 'pending_approval';
  const continuity = pendingContinuityExists(db, sessionId);
  if (continuity === true) return 'pending_continuity';
  if (continuity === 'unknown') return 'continuity_store_unavailable';
  if (tableExists(db, 'run_dispatch_leases') && db.prepare(`
    SELECT 1 FROM run_dispatch_leases WHERE session_id = ? AND revoked_at IS NULL LIMIT 1
  `).get(sessionId)) return 'active_dispatch_lease';
  if (activeGraphLeaseExists(db, sessionId, undefined, nowMs)) return 'active_graph_lease';
  if (tableExists(db, 'accepted_turn_call_authorities') && db.prepare(`
    SELECT 1 FROM accepted_turn_call_authorities
     WHERE session_id = ? AND state = 'open' LIMIT 1
  `).get(sessionId)) return 'open_call_authority';
  if (tableExists(db, 'logical_tool_calls') && db.prepare(`
    SELECT 1 FROM logical_tool_calls WHERE session_id = ? AND state = 'open' LIMIT 1
  `).get(sessionId)) return 'nonterminal_logical_child';
  if (tableExists(db, 'physical_dispatches') && db.prepare(`
    SELECT 1 FROM physical_dispatches WHERE session_id = ? AND state = 'started' LIMIT 1
  `).get(sessionId)) return 'nonterminal_physical_crossing';

  if (tableExists(db, 'accepted_task_authority')) {
    const columns = columnsOf(db, 'accepted_task_authority');
    if (!columns.has('work_contract_id')) return 'task_preparation_unavailable';
    const tasks = db.prepare(`
      SELECT a.source_user_seq, a.state, a.work_contract_id,
             e.id AS source_event_id, e.turn AS source_turn,
             c.state AS call_state
        FROM accepted_task_authority a
        LEFT JOIN events e
          ON e.session_id = a.session_id AND e.seq = a.source_user_seq
        LEFT JOIN accepted_turn_call_authorities c
          ON c.session_id = a.session_id AND c.source_user_seq = a.source_user_seq
       WHERE a.session_id = ? AND a.state NOT IN ('terminal','conflict')
       ORDER BY a.source_user_seq
       LIMIT 65
    `).all(sessionId) as Array<{
      source_user_seq: number;
      state: string;
      work_contract_id: string | null;
      source_event_id: string | null;
      source_turn: number | null;
      call_state: string | null;
    }>;
    if (tasks.length > 64) return 'task_preparation_inventory_over_bound';
    for (const task of tasks) {
      // Only an unstaged bare `armed` row may be historical residue. Anything
      // manifested or contract-bound still owns preparatory work.
      if (
        task.state !== 'armed'
        || task.work_contract_id !== null
        || !task.source_event_id
        || task.source_turn === null
        || (task.call_state !== 'closed' && task.call_state !== 'conflict')
        || !exactTerminalAndChildrenCompleteForSource(
          db,
          sessionId,
          task.source_user_seq,
          task.source_event_id,
          task.source_turn,
        )
      ) return 'pending_task_preparation';
    }
  }
  const latestSource = db.prepare(`
    SELECT id, seq, turn
      FROM events
     WHERE session_id = ? AND role = 'user' AND type = 'user_input_received'
     ORDER BY seq DESC LIMIT 1
  `).get(sessionId) as { id: string; seq: number; turn: number } | undefined;
  return !latestSource || !exactTerminalAndChildrenCompleteForSource(
    db,
    sessionId,
    latestSource.seq,
    latestSource.id,
    latestSource.turn,
  ) ? 'latest_terminal_not_proven' : null;
}

export function reconcileHistoricalInterruptPage(
  options: {
    db?: HarnessDb;
    cursor?: HistoricalSessionCursor;
    pageSize?: number;
    nowMs?: number;
    inspectExternalOwnership?: (sessionId: string) => HistoricalSessionExternalOwnership;
  } = {},
): HistoricalInterruptPageResult {
  const db = options.db ?? openEventLog();
  const pageSize = boundedPageSize(options.pageSize);
  const nowMs = options.nowMs ?? Date.now();
  if (!tableExists(db, 'sessions')) {
    return { inspected: 0, cleared: 0, held: 0, heldReasons: {}, casLost: 0 };
  }
  const cursorClause = options.cursor ? `AND (
    updated_at > @updatedAt OR (updated_at = @updatedAt AND id > @cursorSessionId)
  )` : '';
  const rows = db.prepare(`
    SELECT id, updated_at, metadata_json
      FROM sessions
     WHERE status IN ('completed','failed','cancelled')
       AND json_valid(metadata_json) = 1
       AND (
         json_type(metadata_json, '$.__interrupt_state') IS NOT NULL
         OR json_type(metadata_json, '$.__interrupt_mcp_scope') IS NOT NULL
       )
       ${cursorClause}
     ORDER BY updated_at, id
     LIMIT @limit
  `).all({
    updatedAt: options.cursor?.updatedAt ?? '',
    cursorSessionId: options.cursor?.sessionId ?? '',
    limit: pageSize + 1,
  }) as SessionRow[];
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const result: HistoricalInterruptPageResult = {
    inspected: page.length,
    cleared: 0,
    held: 0,
    heldReasons: {},
    casLost: 0,
  };
  const inspectExternal = options.inspectExternalOwnership
    ?? inspectHistoricalSessionExternalOwnership;
  for (const row of page) {
    const external = inspectExternal(row.id);
    if (external.status !== 'clear') {
      result.held += 1;
      incrementReason(
        result.heldReasons,
        external.status === 'owned' ? `external_${external.ownerKind}` : 'external_owner_unavailable',
      );
      continue;
    }
    const applied = db.transaction(():
      | { status: 'cleared' | 'cas_lost' }
      | { status: 'held'; code: string } => {
      const current = db.prepare(`
        SELECT metadata_json
          FROM sessions
         WHERE id = ? AND status IN ('completed','failed','cancelled')
           AND metadata_json = ?
           AND (
             json_type(metadata_json, '$.__interrupt_state') IS NOT NULL
             OR json_type(metadata_json, '$.__interrupt_mcp_scope') IS NOT NULL
           )
      `).get(row.id, row.metadata_json) as { metadata_json: string } | undefined;
      if (!current) return { status: 'cas_lost' };
      const heldReason = sessionPendingDatabaseOwnerReason(
        db,
        row.id,
        current.metadata_json,
        nowMs,
      );
      if (heldReason) {
        return { status: 'held', code: heldReason };
      }
      const updated = db.prepare(`
        UPDATE sessions
           SET metadata_json = json_remove(
                 metadata_json,
                 '$.__interrupt_state',
                 '$.__interrupt_mcp_scope'
               ),
               updated_at = ?
         WHERE id = ? AND status IN ('completed','failed','cancelled')
           AND metadata_json = ?
      `).run(new Date(nowMs).toISOString(), row.id, current.metadata_json);
      return { status: updated.changes === 1 ? 'cleared' : 'cas_lost' };
    }).immediate();
    if (applied.status === 'cleared') result.cleared += 1;
    else if (applied.status === 'held') {
      result.held += 1;
      incrementReason(result.heldReasons, applied.code);
    }
    else result.casLost += 1;
  }
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]!;
    result.nextCursor = { updatedAt: last.updated_at, sessionId: last.id };
  }
  return result;
}

function addRootResult(
  aggregate: Omit<HistoricalRootPageResult, 'nextCursor'>,
  page: HistoricalRootPageResult,
): void {
  aggregate.inspected += page.inspected;
  aggregate.closed += page.closed;
  aggregate.conflicted += page.conflicted;
  aggregate.held += page.held;
  for (const [code, count] of Object.entries(page.heldReasons)) {
    aggregate.heldReasons[code] = (aggregate.heldReasons[code] ?? 0) + count;
  }
  aggregate.casLost += page.casLost;
}

function addInterruptResult(
  aggregate: Omit<HistoricalInterruptPageResult, 'nextCursor'>,
  page: HistoricalInterruptPageResult,
): void {
  aggregate.inspected += page.inspected;
  aggregate.cleared += page.cleared;
  aggregate.held += page.held;
  for (const [code, count] of Object.entries(page.heldReasons)) {
    aggregate.heldReasons[code] = (aggregate.heldReasons[code] ?? 0) + count;
  }
  aggregate.casLost += page.casLost;
}

/**
 * Bounded boot pass. Roots are projected first so a terminal session cannot
 * discard its stale interrupt blob while a historical root still looks open.
 */
export function reconcileHistoricalHarnessStateOnBoot(
  options: {
    db?: HarnessDb;
    pageSize?: number;
    maxRootPages?: number;
    maxInterruptPages?: number;
    nowMs?: number;
    inspectExternalOwnership?: (sessionId: string) => HistoricalSessionExternalOwnership;
  } = {},
): HistoricalHarnessReconcileResult {
  const db = options.db ?? openEventLog();
  const maxRootPages = boundedPageCount(options.maxRootPages);
  const maxInterruptPages = boundedPageCount(options.maxInterruptPages);
  const roots = {
    inspected: 0,
    closed: 0,
    conflicted: 0,
    held: 0,
    heldReasons: {},
    casLost: 0,
  };
  let rootCursor: HistoricalRootCursor | undefined;
  for (let pageNumber = 0; pageNumber < maxRootPages; pageNumber += 1) {
    const page = reconcileHistoricalCallAuthorityRootPage({
      db,
      ...(rootCursor ? { cursor: rootCursor } : {}),
      pageSize: options.pageSize,
      nowMs: options.nowMs,
    });
    addRootResult(roots, page);
    rootCursor = page.nextCursor;
    if (!rootCursor) break;
  }

  const interrupts = { inspected: 0, cleared: 0, held: 0, heldReasons: {}, casLost: 0 };
  let interruptCursor: HistoricalSessionCursor | undefined;
  for (let pageNumber = 0; pageNumber < maxInterruptPages; pageNumber += 1) {
    const page = reconcileHistoricalInterruptPage({
      db,
      ...(interruptCursor ? { cursor: interruptCursor } : {}),
      pageSize: options.pageSize,
      nowMs: options.nowMs,
      inspectExternalOwnership: options.inspectExternalOwnership,
    });
    addInterruptResult(interrupts, page);
    interruptCursor = page.nextCursor;
    if (!interruptCursor) break;
  }
  return {
    roots,
    interrupts,
    rootPageLimitReached: rootCursor !== undefined,
    interruptPageLimitReached: interruptCursor !== undefined,
    ...(rootCursor ? { nextRootCursor: rootCursor } : {}),
    ...(interruptCursor ? { nextInterruptCursor: interruptCursor } : {}),
  };
}
