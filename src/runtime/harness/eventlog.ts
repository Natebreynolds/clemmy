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
  // Token-level streaming: emitted for each output_text_delta from the model.
  // Not persisted to SQLite — only broadcast via actionBus for real-time UI.
  'stream_token',
  // Loop intent proposal: surfaced before tools fire on multi-step requests.
  // Contains the planned objective, steps, and risks.
  'loop_intent_proposed',
  // Goal-contract validation (goal-contract Phase 3): emitted when a session's
  // parked goal is validated on self-declared completion — pass/fail, attempt.
  'goal_validation',
  'guardrail_tripped',
  'stuck_detected',
  // Emitted from the conversation loop when stuck_detected fires AND
  // the harness has retry budget remaining. The retry sends a synthetic
  // "act now" message to the same sub-agent before giving up. If the
  // retry also stalls, the original sub_agent_stalled outcome surfaces
  // as today.
  'stall_retry_attempted',
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
  // Auto-capture writeback: emitted from the harness loop whenever a
  // user message produced durable facts or a profile patch via
  // captureInteractionSignals. Lets the trace show "Clementine learned
  // X from this turn" so memory growth is observable.
  'memory_signals_captured',
  // Cross-session prefix: when a new Discord (or other channel) session
  // opens within the continuity window of a prior same-channel session,
  // the harness prepends ONE event of this type carrying the prior
  // session's last user message + agent reply. session_history then
  // returns this context so back-references like "first 10 please"
  // can be interpreted. Added 2026-05-24.
  'cross_session_prefix',
  // v0.5.19 F2 — auto-elevate emits this when the preflight gate sees
  // a 'warn' or 'block' verdict early in a `standard`-preset
  // conversation. Carries the from/to caps so the dashboard can show
  // why the budget changed mid-run.
  'budget_elevated',
  // Tool-injection scoping: emitted at agent construction so traces can
  // explain why a run saw a small external MCP surface instead of every
  // configured server tool.
  'mcp_tool_scope',
  // Per-turn memory primer: emitted when the harness runs the local
  // FTS memory lookup for the latest user message before the model call.
  // The actual hits are injected transiently through callModelInputFilter
  // so they do not bloat persisted conversation history.
  'turn_memory_primer',
  // Per-turn deterministic context packet: summarizes the memory
  // primer, likely skills/workflows, MCP health, local health, and
  // complexity classification that were injected transiently before
  // the model call.
  'agent_context_packet',
  // Planner-first gate: fresh complex requests get a read-only plan
  // proposal before the full external MCP surface is opened.
  'plan_first_started',
  'plan_first_failed',
  // Flag-only native Codex compaction proof: emitted when the harness
  // persists a Codex `compaction` item from raw model responses and
  // prunes replay history for the next continuation turn.
  'native_compaction_applied',
  // v0.5.19 F3 — preflight gate fires this for workflow/execution/
  // agent kinds when a turn projects over the context block
  // threshold. Workflows have no user to consult mid-step so they
  // proceed — but the dashboard now sees the risk and a future
  // workflow-runner extension can react (split / abort / retry).
  'workflow_step_overbudget',
  // Move 2 (confirm-first gate): emitted by the tool-boundary gate each
  // time a mutating external write is ALLOWED through. The gate counts
  // these per session+shape to detect a batch (≥ threshold same-shape
  // writes) and require an instruction-reviewed plan scope before the
  // batch proceeds. Emitted from the gate (not hooks) so worker/sub-agent
  // writes — which share the parent session via AsyncLocalStorage but may
  // not log tool_called under it — are counted reliably.
  'external_write',
  // Compensation record: the dispatch behind an external_write demonstrably
  // FAILED (e.g. composio schema rejection) — the duplicate-target gate nets
  // one matching prior per failure so corrected retries aren't "duplicates".
  'external_write_failed',
  // Always-on telemetry: a run_worker sub-agent hit its turn ceiling
  // (MaxTurnsExceeded). Worker nested runs carry no harness hooks, so this is
  // the only signal of worker turn-cap hits — used to recalibrate
  // CLEMMY_WORKER_MAX_TURNS from real data.
  'worker_capped',
  // NON-halting record that, in YOLO, an approval-shaped ask_user_question was
  // auto-resolved (standing approval) and the run proceeded instead of pausing.
  // Distinct from awaiting_user_input precisely so it does NOT halt the loop.
  'autonomy_note',
  // Per-turn dynamic reasoning effort: which effort tier (low/medium/high) was
  // selected for this turn's model call and why. gpt-5.x reasons before emitting
  // tokens, so this is the main per-turn latency lever — recorded for observability.
  'reasoning_effort',
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
  /** v0.5.19 Bug H — sort by seq DESC instead of ASC. Useful when
   *  combined with `limit` to get the MOST RECENT N events of a type.
   *  Default false (legacy ASC behavior). */
  desc?: boolean;
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
  {
    // v0.5.10 auto-compact: lossless tool-output storage keyed by call_id.
    // The event log clips tool_returned payloads to 8KB at write-time
    // (see hooks.ts:202) for readability; that loss broke the
    // recall_tool_result promise. This table stores the full output
    // (up to 200KB) so an agent that sees `[clipped: ... call
    // recall_tool_result("call_xxx")]` can retrieve the verbatim
    // original. Append-only; cascade-deleted with the session.
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_outputs (
        session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        call_id             TEXT NOT NULL,
        tool                TEXT,
        output_full         TEXT NOT NULL,
        content_bytes       INTEGER NOT NULL,
        truncated_at_write  INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (session_id, call_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_outputs_session ON tool_outputs(session_id);
    `,
  },
  {
    // v0.5.19 F6 — persist tool-guardrail recent-call queue so the
    // loop-detection thresholds survive daemon restarts. Until v0.5.19
    // tool-guardrail.ts held SessionTrackerState only in-memory, which
    // meant multi-hour workflows that crossed a restart (autonomy
    // loops, cron-scheduled runs) lost their loop-detection history.
    // Append-only blob — one row per session_id, replaced on every
    // write-through (debounced every N calls). Cascade-deleted with
    // the session.
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_guardrail_state (
        session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        recent_json TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
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

/**
 * Newest event timestamp across every session whose id starts with `prefix`
 * (e.g. 'workflow:<runId>:' spans all of a run's step sessions). Used by the
 * workflow watchdog's silent-running detection — a 'running' run whose step
 * sessions have emitted nothing for many minutes is wedged, not working.
 * Returns null when no events match.
 */
export function latestEventAtForSessionPrefix(prefix: string): string | null {
  if (!prefix) return null;
  const db = openEventLog();
  const row = db
    .prepare("SELECT MAX(created_at) AS at FROM events WHERE session_id LIKE ? ESCAPE '\\'")
    .get(`${prefix.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) as { at: string | null };
  return row?.at ?? null;
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
  const order = options.desc ? 'DESC' : 'ASC';
  let sql = `SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq ${order}`;
  if (options.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }
  const rows = db.prepare(sql).all(...params) as RawEventRow[];
  const mapped = rows.map(rowToEvent);
  // For desc + limit: the caller usually wants chronological order
  // back, so reverse the result. The caller can post-reverse if they
  // truly want newest-first.
  return options.desc ? mapped.reverse() : mapped;
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

export const TOOL_OUTPUT_MAX_BYTES = 200_000;

export interface ToolOutputRecord {
  output: string;
  contentBytes: number;
  truncatedAtWrite: boolean;
  tool: string | null;
  createdAt: string;
}

export interface WriteToolOutputInput {
  sessionId: string;
  callId: string;
  tool?: string | null;
  output: string;
}

/**
 * Persist the full tool output keyed by (session_id, call_id) so the
 * recall_tool_result tool can retrieve it after the event-log copy is
 * clipped. Hard 200KB cap with explicit truncated_at_write marker —
 * distinct from the per-turn `[clipped: ...]` stub Layer 1 emits.
 *
 * Idempotent on conflict: `(session_id, call_id)` is the primary key
 * and we INSERT OR REPLACE so a duplicate tool_returned event (e.g.
 * after a retry) cleanly overwrites the row.
 */
export function writeToolOutput(input: WriteToolOutputInput): void {
  const db = openEventLog();
  const original = input.output;
  const originalBytes = Buffer.byteLength(original, 'utf8');

  const existing = db.prepare(
    `SELECT content_bytes
       FROM tool_outputs
      WHERE session_id = ? AND call_id = ?`,
  ).get(input.sessionId, input.callId) as { content_bytes: number } | undefined;
  if (existing && existing.content_bytes > originalBytes) {
    return;
  }

  let stored = original;
  let truncated = false;
  if (originalBytes > TOOL_OUTPUT_MAX_BYTES) {
    // Tail-truncate by char count, then re-check bytes (multi-byte
    // chars can still push us over; clamp again if needed).
    stored = original.slice(0, TOOL_OUTPUT_MAX_BYTES);
    while (Buffer.byteLength(stored, 'utf8') > TOOL_OUTPUT_MAX_BYTES) {
      stored = stored.slice(0, stored.length - 1);
    }
    truncated = true;
  }
  db.prepare(
    `INSERT OR REPLACE INTO tool_outputs
       (session_id, call_id, tool, output_full, content_bytes, truncated_at_write, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId,
    input.callId,
    input.tool ?? null,
    stored,
    originalBytes,
    truncated ? 1 : 0,
    nowIso(),
  );
}

/**
 * Search a session's stored tool outputs for rows containing ANY of the
 * given terms. Powers the grounding gate's source retrieval: before an
 * irreversible external write, the gate pulls the artifacts that mention
 * the write's TARGET (recipient email/name/domain) so an independent
 * judge can verify the outgoing payload against what was actually
 * researched for that target. Newest first; caller clips content.
 */
export function searchToolOutputs(
  sessionId: string,
  terms: string[],
  opts: { limit?: number } = {},
): Array<{ callId: string; tool: string | null; output: string; createdAt: string }> {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length >= 3);
  if (cleaned.length === 0) return [];
  const db = openEventLog();
  const likes = cleaned.map(() => 'output_full LIKE ?').join(' OR ');
  const rows = db.prepare(
    `SELECT call_id, tool, output_full, created_at
       FROM tool_outputs
      WHERE session_id = ? AND (${likes})
      ORDER BY created_at DESC
      LIMIT ?`,
  ).all(sessionId, ...cleaned.map((t) => `%${t}%`), Math.max(1, Math.min(opts.limit ?? 6, 20))) as Array<{
    call_id: string; tool: string | null; output_full: string; created_at: string;
  }>;
  return rows.map((r) => ({ callId: r.call_id, tool: r.tool, output: r.output_full, createdAt: r.created_at }));
}

/**
 * Drop `tool_outputs` rows older than `maxAgeDays` (default 14). Called
 * from the daemon's hourly maintenance tick — without this, the table
 * grows unbounded (~10 MB/day at observed write rates) and the harness
 * sqlite file balloons over weeks. The 14-day window covers any
 * plausible follow-up where the agent might want to `recall_tool_result`
 * on a prior call; beyond that the conversation has almost certainly
 * compacted past the clip placeholder anyway, so the recall is moot.
 *
 * Returns the number of rows deleted. Operator-overridable via
 * `CLEMMY_TOOL_OUTPUT_TTL_DAYS` env (clamped to [1, 365]).
 */
export function reapStaleToolOutputs(maxAgeDays?: number): number {
  const env = process.env.CLEMMY_TOOL_OUTPUT_TTL_DAYS;
  const ttl = maxAgeDays ?? (env ? Math.max(1, Math.min(365, Number(env))) : 14);
  if (!Number.isFinite(ttl) || ttl <= 0) return 0;
  const db = openEventLog();
  const result = db
    .prepare(`DELETE FROM tool_outputs WHERE created_at < datetime('now', ?)`)
    .run(`-${Math.floor(ttl)} days`);
  return result.changes;
}

/**
 * Drop terminal (completed/failed/cancelled) sessions older than `maxAgeDays`
 * (default 14) and — via the `ON DELETE CASCADE` on every child table
 * (events, tool_outputs, kill switches, …) with `PRAGMA foreign_keys = ON`
 * set on the connection — all of their child rows. Active/paused sessions are
 * NEVER touched, so the user can always resume in-flight work.
 *
 * Without this the `sessions` + `events` tables append forever and harness.db
 * balloons over weeks (observed 159 MB). `reapStaleToolOutputs` already caps
 * one child table; this caps the parent (and everything under it). After the
 * delete we checkpoint the WAL (TRUNCATE) so reclaimed pages actually return
 * to the main file instead of accumulating in the -wal sidecar.
 *
 * Returns the number of sessions deleted. Operator-overridable via
 * `CLEMMY_SESSION_TTL_DAYS` env (clamped to [1, 365]).
 */
export function reapStaleSessions(maxAgeDays?: number): number {
  const env = process.env.CLEMMY_SESSION_TTL_DAYS;
  const ttl = maxAgeDays ?? (env ? Math.max(1, Math.min(365, Number(env))) : 14);
  if (!Number.isFinite(ttl) || ttl <= 0) return 0;
  const db = openEventLog();
  // Never reap a conversation the user has pinned or archived for keeping
  // — those are explicit "hold onto this" signals from the Conversations
  // UI, stored additively in metadata_json. Without this guard a pinned
  // Discord/workflow conversation would silently vanish after the TTL.
  const result = db
    .prepare(
      `DELETE FROM sessions
       WHERE status IN ('completed','failed','cancelled')
         AND updated_at < datetime('now', ?)
         AND metadata_json NOT LIKE '%"pinned":true%'
         AND metadata_json NOT LIKE '%"archived":true%'`,
    )
    .run(`-${Math.floor(ttl)} days`);
  // Best-effort WAL merge so the on-disk file actually shrinks after a reap.
  // A busy db just retries on the next tick — never let this throw.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // opportunistic; ignore
  }
  return result.changes;
}

export function getToolOutput(sessionId: string, callId: string): ToolOutputRecord | null {
  const db = openEventLog();
  const row = db
    .prepare(
      `SELECT output_full, content_bytes, truncated_at_write, tool, created_at
       FROM tool_outputs
       WHERE session_id = ? AND call_id = ?`,
    )
    .get(sessionId, callId) as
    | {
        output_full: string;
        content_bytes: number;
        truncated_at_write: number;
        tool: string | null;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    output: row.output_full,
    contentBytes: row.content_bytes,
    truncatedAtWrite: row.truncated_at_write === 1,
    tool: row.tool,
    createdAt: row.created_at,
  };
}

// ─── v0.5.19 F6 — tool-guardrail state persistence ────────────────
//
// The tool-guardrail keeps a per-session sliding window of recent
// tool calls so it can detect loops (same args repeated; mutating
// tool spamming distinct args). Before v0.5.19 this state lived only
// in-memory, so long workflows that crossed a daemon restart lost
// their loop-detection history. Persist the recent[] queue here;
// the guardrail rebuilds derived state (signature counts, distinct
// mutating-tool args) from it on rehydrate.

export function writeGuardrailState(sessionId: string, recentJson: string): void {
  const db = openEventLog();
  db.prepare(
    `INSERT INTO tool_guardrail_state (session_id, recent_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       recent_json = excluded.recent_json,
       updated_at  = excluded.updated_at`,
  ).run(sessionId, recentJson, new Date().toISOString());
}

export function readGuardrailState(sessionId: string): string | null {
  const db = openEventLog();
  const row = db
    .prepare('SELECT recent_json FROM tool_guardrail_state WHERE session_id = ?')
    .get(sessionId) as { recent_json: string } | undefined;
  return row?.recent_json ?? null;
}

export function clearGuardrailState(sessionId: string): void {
  const db = openEventLog();
  db.prepare('DELETE FROM tool_guardrail_state WHERE session_id = ?').run(sessionId);
}
