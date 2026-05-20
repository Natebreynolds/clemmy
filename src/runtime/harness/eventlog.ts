import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from '../../config.js';
import { actionBus } from '../action-bus.js';

/**
 * Event log — the spine of the 0.3 harness.
 *
 * Mirrors the SQLite pattern used by src/memory/db.ts: WAL + NORMAL,
 * schema_version migrations, cached singleton handle, reset for tests.
 *
 * One file: ~/.clementine-next/state/harness.db. Holds three tables:
 *   - sessions       : one row per chat / execution / workflow / agent run
 *   - events         : append-only, monotonic seq, JSON payload
 *   - kill_switches  : session_id rows that pause the next turn_started
 *
 * The harness reads events to rebuild Session state on replay. The event
 * log is the single source of truth for run-derived state; durable user
 * artifacts (vault, secrets, profile) stay on disk in their own files.
 */

export const HARNESS_STATE_DIR = path.join(BASE_DIR, 'state');
export const HARNESS_DB_PATH = path.join(HARNESS_STATE_DIR, 'harness.db');

/**
 * Closed enum of event types. Any append with a type not in this set
 * is rejected — there is no "free-form" event. New types require a
 * code change so the replay code is forced to handle them.
 */
export const EVENT_TYPES = [
  'session_started',
  'turn_started',
  'turn_ended',
  'condenser_applied',
  'plan_drafted',
  'plan_approved',
  'plan_revised',
  'plan_rejected',
  'step_started',
  'tool_called',
  'tool_returned',
  'step_verified',
  'step_failed',
  'handoff',
  'awaiting_user_input',
  'user_input_received',
  'approval_requested',
  'approval_resolved',
  'guardrail_tripped',
  'stuck_detected',
  'heartbeat',
  'kill_requested',
  'run_paused',
  'run_resumed',
  'run_completed',
  'run_failed',
  // Multi-turn auto-continuation: emitted at the boundary between
  // two runTurn() calls inside the same runConversation(). The
  // OrchestratorDecision drives whether the loop recurses.
  'conversation_step',
  'conversation_completed',
  'conversation_limit_exceeded',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export type SessionKind = 'chat' | 'execution' | 'workflow' | 'agent';
export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface SessionRow {
  id: string;
  kind: SessionKind;
  channel: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  title: string | null;
  objective: string | null;
  tokenBudget: number | null;
  tokensUsed: number;
  currentPlanId: string | null;
  metadata: Record<string, unknown>;
}

export interface HarnessSessionSignal {
  id: string;
  kind: SessionKind;
  channel: string | null;
  userId: string | null;
  status: SessionStatus;
  title: string | null;
  objective: string | null;
  updatedAt: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface EventRow {
  seq: number;
  id: string;
  sessionId: string;
  turn: number;
  role: string;
  type: EventType;
  parentEventId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AppendEventInput {
  sessionId: string;
  turn: number;
  role: string;
  type: EventType;
  data?: Record<string, unknown>;
  parentEventId?: string;
}

export interface CreateSessionInput {
  id?: string;
  kind: SessionKind;
  channel?: string;
  userId?: string;
  title?: string;
  objective?: string;
  tokenBudget?: number;
  metadata?: Record<string, unknown>;
}

export interface ListEventsOptions {
  sinceSeq?: number;
  types?: EventType[];
  limit?: number;
}

export interface ListSessionsOptions {
  kind?: SessionKind | SessionKind[];
  status?: SessionStatus | SessionStatus[] | 'any';
  channel?: string | string[];
  updatedAfter?: string;
  limit?: number;
}

let cached: Database.Database | null = null;

function ensureStateDir(): void {
  if (!existsSync(HARNESS_STATE_DIR)) {
    mkdirSync(HARNESS_STATE_DIR, { recursive: true });
  }
}

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL CHECK (kind IN ('chat','execution','workflow','agent')),
        channel         TEXT,
        user_id         TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('active','paused','completed','failed','cancelled')),
        title           TEXT,
        objective       TEXT,
        token_budget    INTEGER,
        tokens_used     INTEGER NOT NULL DEFAULT 0,
        current_plan_id TEXT,
        metadata_json   TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel) WHERE channel IS NOT NULL;

      CREATE TABLE IF NOT EXISTS events (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        id              TEXT NOT NULL UNIQUE,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn            INTEGER NOT NULL,
        role            TEXT NOT NULL,
        type            TEXT NOT NULL,
        parent_event_id TEXT,
        data_json       TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, type);

      CREATE TABLE IF NOT EXISTS kill_switches (
        session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        requested_at TEXT NOT NULL,
        reason       TEXT
      );
    `,
  },
  {
    // Reliability pass v0.4.20:
    //   - session_locks: cross-process serialization for state mutations on
    //     a single sessionId. Used by withSessionLock (session-lock.ts) to
    //     close the TOCTOU + duplicate-write holes the audit found.
    //   - pending_approvals: addressable approval requests with per-row TTL.
    //     One row per `approval_requested` event. The reaper expires stale
    //     rows; the approval-registry resolves them by approval_id so a
    //     bare "approve" reply on a busy channel never silently routes to
    //     the wrong paused session.
    //
    // Both tables reference sessions(id) so they cascade on session delete.
    // session_locks is a small set (one row per actively-locked session,
    // typically <10 at peak); pending_approvals grows with usage but the
    // reaper keeps it bounded.
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS session_locks (
        session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        owner_pid    INTEGER NOT NULL,
        owner_token  TEXT NOT NULL,
        acquired_at  INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_approvals (
        approval_id   TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        channel       TEXT,
        channel_id    TEXT,
        requested_at  TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        subject       TEXT NOT NULL,
        tool          TEXT,
        args_json     TEXT,
        status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','resolved','expired','cancelled')),
        resolution    TEXT
                      CHECK (resolution IS NULL OR resolution IN ('approved','rejected','expired','cancelled_by_user')),
        resolver      TEXT,
        resolved_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_session_status
        ON pending_approvals(session_id, status);
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_channel_status
        ON pending_approvals(channel_id, status) WHERE channel_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_expires
        ON pending_approvals(expires_at) WHERE status = 'pending';
    `,
  },
];

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const current =
    (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0;
  const apply = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      apply.run(migration.version, new Date().toISOString());
    });
    tx();
  }
}

export function openEventLog(): Database.Database {
  if (cached) return cached;
  ensureStateDir();
  const db = new Database(HARNESS_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  cached = db;
  return db;
}

export function closeEventLog(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

/** Test-only: drop the DB file so the next open starts fresh. */
export function resetEventLog(): void {
  closeEventLog();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = HARNESS_DB_PATH + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

interface RawSessionRow {
  id: string;
  kind: SessionKind;
  channel: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
  status: SessionStatus;
  title: string | null;
  objective: string | null;
  token_budget: number | null;
  tokens_used: number;
  current_plan_id: string | null;
  metadata_json: string | null;
}

interface RawEventRow {
  seq: number;
  id: string;
  session_id: string;
  turn: number;
  role: string;
  type: string;
  parent_event_id: string | null;
  data_json: string;
  created_at: string;
}

function rowToSession(row: RawSessionRow): SessionRow {
  return {
    id: row.id,
    kind: row.kind,
    channel: row.channel,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    title: row.title,
    objective: row.objective,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    currentPlanId: row.current_plan_id,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
  };
}

function rowToEvent(row: RawEventRow): EventRow {
  return {
    seq: row.seq,
    id: row.id,
    sessionId: row.session_id,
    turn: row.turn,
    role: row.role,
    type: row.type as EventType,
    parentEventId: row.parent_event_id,
    data: JSON.parse(row.data_json),
    createdAt: row.created_at,
  };
}

const SESSION_SIGNAL_METADATA_KEYS = [
  'source',
  'channelId',
  'guildId',
  'workflowName',
  'workflowRunId',
  'stepId',
] as const;

export function summarizeSessionForSignal(session: SessionRow): HarnessSessionSignal {
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const key of SESSION_SIGNAL_METADATA_KEYS) {
    const value = session.metadata[key];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      metadata[key] = value;
    }
  }
  return {
    id: session.id,
    kind: session.kind,
    channel: session.channel,
    userId: session.userId,
    status: session.status,
    title: session.title,
    objective: session.objective,
    updatedAt: session.updatedAt,
    metadata,
  };
}

export function createSession(input: CreateSessionInput): SessionRow {
  const db = openEventLog();
  const id = input.id ?? `sess-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const now = nowIso();
  db.prepare(
    `INSERT INTO sessions
       (id, kind, channel, user_id, created_at, updated_at, status,
        title, objective, token_budget, tokens_used, current_plan_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 0, NULL, ?)`,
  ).run(
    id,
    input.kind,
    input.channel ?? null,
    input.userId ?? null,
    now,
    now,
    input.title ?? null,
    input.objective ?? null,
    input.tokenBudget ?? null,
    JSON.stringify(input.metadata ?? {}),
  );
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as RawSessionRow;
  return rowToSession(row);
}

export function getSession(sessionId: string): SessionRow | null {
  const db = openEventLog();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | RawSessionRow
    | undefined;
  return row ? rowToSession(row) : null;
}

function addListFilter(
  clauses: string[],
  params: unknown[],
  column: string,
  value: string | string[] | undefined,
): void {
  if (value === undefined) return;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return;
  clauses.push(`${column} IN (${values.map(() => '?').join(',')})`);
  params.push(...values);
}

export function listSessions(options: ListSessionsOptions = {}): SessionRow[] {
  const db = openEventLog();
  const clauses: string[] = [];
  const params: unknown[] = [];
  addListFilter(clauses, params, 'kind', options.kind);
  if (options.status !== undefined && options.status !== 'any') {
    addListFilter(clauses, params, 'status', options.status);
  }
  addListFilter(clauses, params, 'channel', options.channel);
  if (options.updatedAfter !== undefined) {
    clauses.push('updated_at >= ?');
    params.push(options.updatedAfter);
  }
  let sql = 'SELECT * FROM sessions';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY updated_at DESC';
  const rawLimit = Math.trunc(options.limit ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 100;
  sql += ' LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as RawSessionRow[];
  return rows.map(rowToSession);
}

export type SessionPatch = Partial<
  Pick<
    SessionRow,
    'status' | 'title' | 'objective' | 'tokenBudget' | 'tokensUsed' | 'currentPlanId' | 'metadata'
  >
>;

export function updateSession(sessionId: string, patch: SessionPatch): SessionRow {
  const db = openEventLog();
  const current = getSession(sessionId);
  if (!current) throw new Error(`session not found: ${sessionId}`);
  const next: SessionRow = {
    ...current,
    ...patch,
    metadata: patch.metadata ?? current.metadata,
    updatedAt: nowIso(),
  };
  db.prepare(
    `UPDATE sessions SET
       status = ?, title = ?, objective = ?, token_budget = ?, tokens_used = ?,
       current_plan_id = ?, metadata_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.status,
    next.title,
    next.objective,
    next.tokenBudget,
    next.tokensUsed,
    next.currentPlanId,
    JSON.stringify(next.metadata),
    next.updatedAt,
    sessionId,
  );
  return next;
}

export function appendEvent(input: AppendEventInput): EventRow {
  if (!EVENT_TYPE_SET.has(input.type)) {
    throw new Error(`unknown event type: ${input.type}`);
  }
  const db = openEventLog();
  const id = randomUUID();
  const now = nowIso();
  const data = JSON.stringify(input.data ?? {});
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO events
         (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.sessionId,
      input.turn,
      input.role,
      input.type,
      input.parentEventId ?? null,
      data,
      now,
    );
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId);
  });
  tx();
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RawEventRow;
  const event = rowToEvent(row);
  const session = getSession(event.sessionId);
  // Fan out for live SSE subscribers. Best-effort — emit errors are
  // swallowed inside actionBus so a flaky listener can never block
  // an event write.
  actionBus.emit({
    kind: 'harness.event',
    sessionId: event.sessionId,
    event,
    session: session ? summarizeSessionForSignal(session) : undefined,
  });
  return event;
}

export function listEvents(sessionId: string, options: ListEventsOptions = {}): EventRow[] {
  const db = openEventLog();
  const clauses: string[] = ['session_id = ?'];
  const params: unknown[] = [sessionId];
  if (options.sinceSeq !== undefined) {
    clauses.push('seq > ?');
    params.push(options.sinceSeq);
  }
  if (options.types && options.types.length > 0) {
    const placeholders = options.types.map(() => '?').join(',');
    clauses.push(`type IN (${placeholders})`);
    params.push(...options.types);
  }
  let sql = `SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq ASC`;
  if (options.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }
  const rows = db.prepare(sql).all(...params) as RawEventRow[];
  return rows.map(rowToEvent);
}

export function getLatestEventSeq(sessionId: string): number {
  const db = openEventLog();
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?')
    .get(sessionId) as { seq: number } | undefined;
  return Number.isFinite(row?.seq) ? row!.seq : 0;
}

export function getEvent(eventId: string): EventRow | null {
  const db = openEventLog();
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as
    | RawEventRow
    | undefined;
  return row ? rowToEvent(row) : null;
}

export function requestKill(sessionId: string, reason?: string): void {
  const db = openEventLog();
  db.prepare(
    `INSERT OR REPLACE INTO kill_switches (session_id, requested_at, reason)
     VALUES (?, ?, ?)`,
  ).run(sessionId, nowIso(), reason ?? null);
}

export function isKillRequested(sessionId: string): boolean {
  const db = openEventLog();
  const row = db
    .prepare('SELECT 1 AS x FROM kill_switches WHERE session_id = ?')
    .get(sessionId);
  return !!row;
}

export function clearKill(sessionId: string): void {
  const db = openEventLog();
  db.prepare('DELETE FROM kill_switches WHERE session_id = ?').run(sessionId);
}
