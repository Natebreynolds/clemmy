/**
 * Coding runs — the durable owner of a delegated coding agent (Claude Code,
 * Codex) working in its own git worktree.
 *
 * This store replaces the guest-run JSON registry that `project_run start` was
 * disabled over (60db67d8b): that registry lived in whichever process imported
 * it, orphan-failed every run on restart, and promoted exit code 0 to success.
 * Here the run row, its lease, its stop request, and its immutable settlement
 * are the authority; the harness session `coding:<runId>` only carries the live
 * activity projection.
 *
 * Own database file, not a harness.db migration: several agents hotpatch the
 * same installed app, and two branches that each ship a different harness v82
 * would silently skip one another's tables in the live home. This file's
 * schema chain belongs to this subsystem alone.
 *
 * One writer: every mutation of these tables goes through this module, and
 * every state change is a compare-and-swap on the expected prior state.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';

export type CodingAgentId = 'claude' | 'codex';

export type CodingRunState =
  | 'admitted'
  | 'running'
  | 'detached'
  | 'resuming'
  | 'settling'
  | 'settled';

/** How far Clem carries the work once the agent is done. Set by the user's own
 *  words when the run is dispatched; unstated means a committed local branch. */
export type CodingRunFinishLine = 'local_branch' | 'pushed_branch' | 'draft_pr' | 'pr';

export type CodingRunOutcome =
  | 'completed_verified'
  | 'completed_unverified'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type CodingRunVerdict = 'pass' | 'fail' | 'unavailable';

export interface CodingRunRecord {
  runId: string;
  sessionId: string;
  originSessionId: string | null;
  originSourceUserSeq: number | null;
  originAttemptId: string | null;
  admissionKey: string | null;
  agent: CodingAgentId;
  projectName: string;
  projectPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string | null;
  baseCommit: string | null;
  objective: string;
  brief: string;
  acceptance: string[];
  testCommand: string | null;
  expectChanges: boolean;
  finishLine: CodingRunFinishLine;
  model: string | null;
  agentSessionId: string | null;
  state: CodingRunState;
  round: number;
  maxRounds: number;
  resumeCount: number;
  leaseOwner: string | null;
  leaseExpiresAtMs: number | null;
  stopRequestedAt: string | null;
  stopReason: string | null;
  deadlineAt: string;
  lastActivityAt: string | null;
  /** Cumulative tokens already written to the usage log, per model. The
   *  agent reports running totals that survive a resume, so only the growth
   *  past this snapshot is new spend. */
  usageRecorded: Record<string, CodingRunUsageTotals>;
  createdAt: string;
  updatedAt: string;
}

export interface CodingRunUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

export interface CodingRunCommit {
  sha: string;
  subject: string;
}

export interface CodingRunDiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

export interface CodingRunSettlement {
  runId: string;
  outcome: CodingRunOutcome;
  reason: string;
  headCommit: string | null;
  commits: CodingRunCommit[];
  diffStat: CodingRunDiffStat | null;
  autoCommitted: boolean;
  testCommand: string | null;
  testExitCode: number | null;
  testTail: string | null;
  finalMessage: string | null;
  verdict: CodingRunVerdict | null;
  verdictReason: string | null;
  settledAt: string;
}

export interface CodingRunReportBack {
  runId: string;
  originSessionId: string;
  createdAt: string;
  deliveredAt: string | null;
  attempts: number;
  lastError: string | null;
}

/** Hours-scale ceiling across every restart of one run (owner directive
 *  2026-07-30: CLI hand-offs legitimately run two to three hours). */
export const CODING_RUN_DEADLINE_MS = 4 * 60 * 60 * 1000;
export const CODING_RUN_DEFAULT_MAX_ROUNDS = 3;

const SCHEMA_VERSION = 1;

let handle: Database.Database | null = null;
let handlePath = '';

function nowIso(): string {
  return new Date().toISOString();
}

export function codingRunStorePath(): string {
  return path.join(BASE_DIR, 'state', 'coding-runs', getMachineId(), 'coding-runs.db');
}

function db(): Database.Database {
  const file = codingRunStorePath();
  if (handle && handlePath === file) return handle;
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const next = new Database(file);
  next.pragma('journal_mode = WAL');
  next.pragma('busy_timeout = 5000');
  next.pragma('foreign_keys = ON');
  migrate(next);
  handle = next;
  handlePath = file;
  return next;
}

function migrate(conn: Database.Database): void {
  const current = Number(conn.pragma('user_version', { simple: true })) || 0;
  if (current >= SCHEMA_VERSION) return;
  conn.transaction(() => {
    if (current < 1) {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS coding_runs (
          run_id                 TEXT PRIMARY KEY,
          session_id             TEXT NOT NULL UNIQUE,
          origin_session_id      TEXT,
          origin_source_user_seq INTEGER,
          origin_attempt_id      TEXT,
          admission_key          TEXT UNIQUE,
          agent                  TEXT NOT NULL CHECK (agent IN ('claude','codex')),
          project_name           TEXT NOT NULL,
          project_path           TEXT NOT NULL,
          worktree_path          TEXT NOT NULL,
          branch                 TEXT NOT NULL,
          base_ref               TEXT,
          base_commit            TEXT,
          objective              TEXT NOT NULL,
          brief                  TEXT NOT NULL,
          acceptance_json        TEXT NOT NULL DEFAULT '[]',
          test_command           TEXT,
          expect_changes         INTEGER NOT NULL DEFAULT 1 CHECK (expect_changes IN (0,1)),
          finish_line            TEXT NOT NULL DEFAULT 'local_branch'
                                 CHECK (finish_line IN ('local_branch','pushed_branch','draft_pr','pr')),
          model                  TEXT,
          agent_session_id       TEXT,
          state                  TEXT NOT NULL
                                 CHECK (state IN ('admitted','running','detached','resuming','settling','settled')),
          round                  INTEGER NOT NULL DEFAULT 0,
          max_rounds             INTEGER NOT NULL DEFAULT 3,
          resume_count           INTEGER NOT NULL DEFAULT 0,
          lease_owner            TEXT,
          lease_expires_at_ms    INTEGER,
          stop_requested_at      TEXT,
          stop_reason            TEXT,
          deadline_at            TEXT NOT NULL,
          last_activity_at       TEXT,
          usage_recorded_json    TEXT NOT NULL DEFAULT '{}',
          created_at             TEXT NOT NULL,
          updated_at             TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS coding_runs_by_state ON coding_runs (state, updated_at);
        CREATE INDEX IF NOT EXISTS coding_runs_by_origin ON coding_runs (origin_session_id, created_at);

        CREATE TABLE IF NOT EXISTS coding_run_settlements (
          run_id             TEXT PRIMARY KEY REFERENCES coding_runs(run_id),
          outcome            TEXT NOT NULL
                             CHECK (outcome IN ('completed_verified','completed_unverified','failed','blocked','cancelled')),
          reason             TEXT NOT NULL,
          head_commit        TEXT,
          commits_json       TEXT NOT NULL DEFAULT '[]',
          diffstat_json      TEXT,
          auto_committed     INTEGER NOT NULL DEFAULT 0 CHECK (auto_committed IN (0,1)),
          test_command       TEXT,
          test_exit_code     INTEGER,
          test_tail          TEXT,
          final_message      TEXT,
          verdict            TEXT CHECK (verdict IN ('pass','fail','unavailable')),
          verdict_reason     TEXT,
          settled_at         TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS coding_run_settlements_immutable
          BEFORE UPDATE ON coding_run_settlements
        BEGIN
          SELECT RAISE(ABORT, 'coding_run_settlements rows are immutable');
        END;

        CREATE TABLE IF NOT EXISTS coding_run_report_backs (
          run_id            TEXT PRIMARY KEY REFERENCES coding_runs(run_id),
          origin_session_id TEXT NOT NULL,
          created_at        TEXT NOT NULL,
          delivered_at      TEXT,
          attempts          INTEGER NOT NULL DEFAULT 0,
          last_error        TEXT
        );
      `);
    }
    conn.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

/** Test seam: drop the cached handle so a test can point BASE_DIR elsewhere. */
export function _closeCodingRunStoreForTests(): void {
  try { handle?.close(); } catch { /* already closed */ }
  handle = null;
  handlePath = '';
}

interface RawRun {
  run_id: string;
  session_id: string;
  origin_session_id: string | null;
  origin_source_user_seq: number | null;
  origin_attempt_id: string | null;
  admission_key: string | null;
  agent: CodingAgentId;
  project_name: string;
  project_path: string;
  worktree_path: string;
  branch: string;
  base_ref: string | null;
  base_commit: string | null;
  objective: string;
  brief: string;
  acceptance_json: string;
  test_command: string | null;
  expect_changes: number;
  finish_line: CodingRunFinishLine;
  model: string | null;
  agent_session_id: string | null;
  state: CodingRunState;
  round: number;
  max_rounds: number;
  resume_count: number;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  stop_requested_at: string | null;
  stop_reason: string | null;
  deadline_at: string;
  last_activity_at: string | null;
  usage_recorded_json: string;
  created_at: string;
  updated_at: string;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseUsageSnapshot(raw: string): Record<string, CodingRunUsageTotals> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, CodingRunUsageTotals> = {};
    for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
      out[model] = {
        inputTokens: n(v.inputTokens),
        cachedInputTokens: n(v.cachedInputTokens),
        cacheCreationInputTokens: n(v.cacheCreationInputTokens),
        outputTokens: n(v.outputTokens),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function rowToRun(row: RawRun): CodingRunRecord {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    originSessionId: row.origin_session_id,
    originSourceUserSeq: row.origin_source_user_seq,
    originAttemptId: row.origin_attempt_id,
    admissionKey: row.admission_key,
    agent: row.agent,
    projectName: row.project_name,
    projectPath: row.project_path,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseRef: row.base_ref,
    baseCommit: row.base_commit,
    objective: row.objective,
    brief: row.brief,
    acceptance: parseStringArray(row.acceptance_json),
    testCommand: row.test_command,
    expectChanges: row.expect_changes === 1,
    finishLine: row.finish_line,
    model: row.model,
    agentSessionId: row.agent_session_id,
    state: row.state,
    round: row.round,
    maxRounds: row.max_rounds,
    resumeCount: row.resume_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    stopRequestedAt: row.stop_requested_at,
    stopReason: row.stop_reason,
    deadlineAt: row.deadline_at,
    lastActivityAt: row.last_activity_at,
    usageRecorded: parseUsageSnapshot(row.usage_recorded_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function codingSessionIdFor(runId: string): string {
  return `coding:${runId}`;
}

export function runIdFromCodingSession(sessionId: string): string | null {
  if (!sessionId.startsWith('coding:')) return null;
  const runId = sessionId.slice('coding:'.length).trim();
  return runId || null;
}

export interface AdmitCodingRunInput {
  agent: CodingAgentId;
  projectName: string;
  projectPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string | null;
  baseCommit: string | null;
  objective: string;
  brief: string;
  acceptance?: string[];
  testCommand?: string | null;
  expectChanges?: boolean;
  finishLine?: CodingRunFinishLine;
  model?: string | null;
  maxRounds?: number;
  originSessionId?: string | null;
  originSourceUserSeq?: number | null;
  originAttemptId?: string | null;
  /** Idempotency key for the admitting call. A replayed admission returns the
   *  row the first call created instead of starting a second agent. */
  admissionKey?: string | null;
  runId?: string;
  nowMs?: number;
}

export interface AdmitCodingRunResult {
  run: CodingRunRecord;
  created: boolean;
}

export function newCodingRunId(): string {
  return `code-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function admitCodingRun(input: AdmitCodingRunInput): AdmitCodingRunResult {
  const conn = db();
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const runId = input.runId ?? newCodingRunId();
  const admissionKey = input.admissionKey?.trim() || null;
  return conn.transaction((): AdmitCodingRunResult => {
    if (admissionKey) {
      const existing = conn.prepare('SELECT * FROM coding_runs WHERE admission_key = ?')
        .get(admissionKey) as RawRun | undefined;
      if (existing) return { run: rowToRun(existing), created: false };
    }
    conn.prepare(
      `INSERT INTO coding_runs (
         run_id, session_id, origin_session_id, origin_source_user_seq, origin_attempt_id,
         admission_key, agent, project_name, project_path, worktree_path, branch,
         base_ref, base_commit, objective, brief, acceptance_json, test_command,
         expect_changes, finish_line, model, state, max_rounds, deadline_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?, ?)`,
    ).run(
      runId,
      codingSessionIdFor(runId),
      input.originSessionId ?? null,
      input.originSourceUserSeq ?? null,
      input.originAttemptId ?? null,
      admissionKey,
      input.agent,
      input.projectName,
      input.projectPath,
      input.worktreePath,
      input.branch,
      input.baseRef,
      input.baseCommit,
      input.objective,
      input.brief,
      JSON.stringify(input.acceptance ?? []),
      input.testCommand?.trim() || null,
      input.expectChanges === false ? 0 : 1,
      input.finishLine ?? 'local_branch',
      input.model?.trim() || null,
      Math.max(1, Math.min(input.maxRounds ?? CODING_RUN_DEFAULT_MAX_ROUNDS, 8)),
      new Date(nowMs + CODING_RUN_DEADLINE_MS).toISOString(),
      now,
      now,
    );
    const row = conn.prepare('SELECT * FROM coding_runs WHERE run_id = ?').get(runId) as RawRun;
    return { run: rowToRun(row), created: true };
  })();
}

export function getCodingRun(runId: string): CodingRunRecord | null {
  const row = db().prepare('SELECT * FROM coding_runs WHERE run_id = ?').get(runId) as RawRun | undefined;
  return row ? rowToRun(row) : null;
}

export function listCodingRuns(options: {
  originSessionId?: string;
  states?: CodingRunState[];
  limit?: number;
} = {}): CodingRunRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.originSessionId) {
    clauses.push('origin_session_id = ?');
    params.push(options.originSessionId);
  }
  if (options.states?.length) {
    clauses.push(`state IN (${options.states.map(() => '?').join(',')})`);
    params.push(...options.states);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const rows = db().prepare(
    `SELECT * FROM coding_runs ${where} ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...params) as RawRun[];
  return rows.map(rowToRun);
}

/**
 * Claim the next run this owner should drive: a fresh admission, a run whose
 * previous owner died (lease expired), or one a restart marked for resume.
 * Detached runs belong to the user's terminal until they hand back.
 */
export function claimNextCodingRun(ownerId: string, leaseMs: number, nowMs = Date.now()): CodingRunRecord | null {
  if (!ownerId.trim() || leaseMs < 1_000) throw new Error('ownerId and a lease of at least 1s are required');
  const conn = db();
  return conn.transaction((): CodingRunRecord | null => {
    const row = conn.prepare(
      `SELECT * FROM coding_runs
        WHERE state IN ('admitted','resuming')
           OR (state IN ('running','settling') AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms < ?))
        ORDER BY created_at ASC
        LIMIT 1`,
    ).get(nowMs) as RawRun | undefined;
    if (!row) return null;
    // A run already owned by a live generation (running with a lease) never
    // reaches here; everything else restarts the agent, fresh or resumed. A
    // generation that died mid-settlement left no settlement row (it is
    // written in one transaction), so its run is simply driven again.
    const next: CodingRunState = 'running';
    const resumed = row.state !== 'admitted';
    const changed = conn.prepare(
      `UPDATE coding_runs
          SET state = ?, lease_owner = ?, lease_expires_at_ms = ?,
              resume_count = resume_count + ?, updated_at = ?
        WHERE run_id = ? AND state = ?`,
    ).run(next, ownerId, nowMs + leaseMs, resumed ? 1 : 0, new Date(nowMs).toISOString(), row.run_id, row.state);
    if (changed.changes !== 1) return null;
    return rowToRun(conn.prepare('SELECT * FROM coding_runs WHERE run_id = ?').get(row.run_id) as RawRun);
  })();
}

export function renewCodingRunLease(runId: string, ownerId: string, leaseMs: number, nowMs = Date.now()): boolean {
  const result = db().prepare(
    `UPDATE coding_runs SET lease_expires_at_ms = ?
      WHERE run_id = ? AND lease_owner = ? AND state IN ('running','settling')`,
  ).run(nowMs + leaseMs, runId, ownerId);
  return result.changes === 1;
}

/** Everything the executor learns about the agent while it holds the lease. */
export function updateCodingRunProgress(
  runId: string,
  ownerId: string,
  patch: { agentSessionId?: string; round?: number; baseCommit?: string; touchActivity?: boolean },
): boolean {
  const sets: string[] = ['updated_at = ?'];
  const now = nowIso();
  const params: unknown[] = [now];
  if (patch.agentSessionId !== undefined) { sets.push('agent_session_id = ?'); params.push(patch.agentSessionId); }
  if (patch.round !== undefined) { sets.push('round = ?'); params.push(patch.round); }
  if (patch.baseCommit !== undefined) { sets.push('base_commit = COALESCE(base_commit, ?)'); params.push(patch.baseCommit); }
  if (patch.touchActivity) { sets.push('last_activity_at = ?'); params.push(now); }
  params.push(runId, ownerId);
  const result = db().prepare(
    `UPDATE coding_runs SET ${sets.join(', ')}
      WHERE run_id = ? AND lease_owner = ? AND state IN ('running','settling')`,
  ).run(...params);
  return result.changes === 1;
}

export function recordCodingRunUsageSnapshot(
  runId: string,
  ownerId: string,
  snapshot: Record<string, CodingRunUsageTotals>,
): boolean {
  const result = db().prepare(
    `UPDATE coding_runs SET usage_recorded_json = ?, updated_at = ?
      WHERE run_id = ? AND lease_owner = ? AND state IN ('running','settling')`,
  ).run(JSON.stringify(snapshot), nowIso(), runId, ownerId);
  return result.changes === 1;
}

/** The stop switch. Reachable from any process (chat Stop, board, phone): it
 *  only writes the request; the owning executor reads it and stops the agent. */
export function requestCodingRunStop(runId: string, reason: string, nowMs = Date.now()): CodingRunRecord | null {
  const conn = db();
  const now = new Date(nowMs).toISOString();
  conn.prepare(
    `UPDATE coding_runs
        SET stop_requested_at = COALESCE(stop_requested_at, ?),
            stop_reason = COALESCE(stop_reason, ?),
            updated_at = ?
      WHERE run_id = ? AND state <> 'settled'`,
  ).run(now, reason.slice(0, 300), now, runId);
  return getCodingRun(runId);
}

/** Stop every unsettled run a conversation started (the chat Stop cascade). */
export function requestCodingRunStopsForOrigin(originSessionId: string, reason: string): CodingRunRecord[] {
  const open = listCodingRuns({
    originSessionId,
    states: ['admitted', 'running', 'detached', 'resuming', 'settling'],
    limit: 100,
  });
  return open.map((run) => requestCodingRunStop(run.runId, reason)).filter((run): run is CodingRunRecord => run !== null);
}

export function isCodingRunStopRequested(runId: string): boolean {
  const row = db().prepare('SELECT stop_requested_at FROM coding_runs WHERE run_id = ?')
    .get(runId) as { stop_requested_at: string | null } | undefined;
  return Boolean(row?.stop_requested_at);
}

/** The executor gives up ownership without settling — a restart or a daemon
 *  shutdown. The next claim resumes the agent's own session. */
export function releaseCodingRunForResume(runId: string, ownerId: string): boolean {
  const result = db().prepare(
    `UPDATE coding_runs
        SET state = 'resuming', lease_owner = NULL, lease_expires_at_ms = NULL, updated_at = ?
      WHERE run_id = ? AND lease_owner = ? AND state = 'running'`,
  ).run(nowIso(), runId, ownerId);
  return result.changes === 1;
}

export function markCodingRunSettling(runId: string, ownerId: string): boolean {
  const result = db().prepare(
    `UPDATE coding_runs SET state = 'settling', updated_at = ?
      WHERE run_id = ? AND lease_owner = ? AND state = 'running'`,
  ).run(nowIso(), runId, ownerId);
  return result.changes === 1;
}

export interface SettleCodingRunInput {
  outcome: CodingRunOutcome;
  reason: string;
  headCommit?: string | null;
  commits?: CodingRunCommit[];
  diffStat?: CodingRunDiffStat | null;
  autoCommitted?: boolean;
  testCommand?: string | null;
  testExitCode?: number | null;
  testTail?: string | null;
  finalMessage?: string | null;
  verdict?: CodingRunVerdict | null;
  verdictReason?: string | null;
}

/**
 * Write the immutable settlement and close the run in one transaction. Only
 * the lease holder settles; a stale generation that lost its lease gets
 * `null` and must not report anything. The report-back row is queued in the
 * same transaction so a crash between settle and delivery still reports.
 */
export function settleCodingRun(
  runId: string,
  ownerId: string,
  input: SettleCodingRunInput,
  nowMs = Date.now(),
): CodingRunSettlement | null {
  const conn = db();
  const now = new Date(nowMs).toISOString();
  return conn.transaction((): CodingRunSettlement | null => {
    const run = conn.prepare('SELECT * FROM coding_runs WHERE run_id = ?').get(runId) as RawRun | undefined;
    if (!run || run.lease_owner !== ownerId || (run.state !== 'running' && run.state !== 'settling')) return null;
    conn.prepare(
      `INSERT INTO coding_run_settlements (
         run_id, outcome, reason, head_commit, commits_json, diffstat_json, auto_committed,
         test_command, test_exit_code, test_tail, final_message, verdict, verdict_reason, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      input.outcome,
      input.reason.slice(0, 2_000),
      input.headCommit ?? null,
      JSON.stringify(input.commits ?? []),
      input.diffStat ? JSON.stringify(input.diffStat) : null,
      input.autoCommitted ? 1 : 0,
      input.testCommand ?? null,
      input.testExitCode ?? null,
      input.testTail?.slice(-8_000) ?? null,
      input.finalMessage?.slice(0, 16_000) ?? null,
      input.verdict ?? null,
      input.verdictReason?.slice(0, 2_000) ?? null,
      now,
    );
    conn.prepare(
      `UPDATE coding_runs
          SET state = 'settled', lease_owner = NULL, lease_expires_at_ms = NULL, updated_at = ?
        WHERE run_id = ?`,
    ).run(now, runId);
    if (run.origin_session_id) {
      conn.prepare(
        `INSERT OR IGNORE INTO coding_run_report_backs (run_id, origin_session_id, created_at)
         VALUES (?, ?, ?)`,
      ).run(runId, run.origin_session_id, now);
    }
    return getCodingRunSettlementIn(conn, runId);
  })();
}

interface RawSettlement {
  run_id: string;
  outcome: CodingRunOutcome;
  reason: string;
  head_commit: string | null;
  commits_json: string;
  diffstat_json: string | null;
  auto_committed: number;
  test_command: string | null;
  test_exit_code: number | null;
  test_tail: string | null;
  final_message: string | null;
  verdict: CodingRunVerdict | null;
  verdict_reason: string | null;
  settled_at: string;
}

function getCodingRunSettlementIn(conn: Database.Database, runId: string): CodingRunSettlement | null {
  const row = conn.prepare('SELECT * FROM coding_run_settlements WHERE run_id = ?').get(runId) as RawSettlement | undefined;
  if (!row) return null;
  let commits: CodingRunCommit[] = [];
  try {
    const parsed: unknown = JSON.parse(row.commits_json);
    if (Array.isArray(parsed)) {
      commits = parsed.filter((c): c is CodingRunCommit => Boolean(c) && typeof c === 'object'
        && typeof (c as CodingRunCommit).sha === 'string' && typeof (c as CodingRunCommit).subject === 'string');
    }
  } catch { /* commits stay empty */ }
  let diffStat: CodingRunDiffStat | null = null;
  if (row.diffstat_json) {
    try { diffStat = JSON.parse(row.diffstat_json) as CodingRunDiffStat; } catch { diffStat = null; }
  }
  return {
    runId: row.run_id,
    outcome: row.outcome,
    reason: row.reason,
    headCommit: row.head_commit,
    commits,
    diffStat,
    autoCommitted: row.auto_committed === 1,
    testCommand: row.test_command,
    testExitCode: row.test_exit_code,
    testTail: row.test_tail,
    finalMessage: row.final_message,
    verdict: row.verdict,
    verdictReason: row.verdict_reason,
    settledAt: row.settled_at,
  };
}

export function getCodingRunSettlement(runId: string): CodingRunSettlement | null {
  return getCodingRunSettlementIn(db(), runId);
}

export function listPendingCodingRunReportBacks(limit = 20): CodingRunReportBack[] {
  const rows = db().prepare(
    `SELECT * FROM coding_run_report_backs WHERE delivered_at IS NULL ORDER BY created_at ASC LIMIT ?`,
  ).all(Math.max(1, Math.min(limit, 200))) as Array<{
    run_id: string; origin_session_id: string; created_at: string;
    delivered_at: string | null; attempts: number; last_error: string | null;
  }>;
  return rows.map((row) => ({
    runId: row.run_id,
    originSessionId: row.origin_session_id,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    attempts: row.attempts,
    lastError: row.last_error,
  }));
}

/** Delivered-at only ever moves from null to a time; a second ack is a no-op. */
export function markCodingRunReportBackDelivered(runId: string, nowMs = Date.now()): boolean {
  const result = db().prepare(
    `UPDATE coding_run_report_backs SET delivered_at = ?, attempts = attempts + 1
      WHERE run_id = ? AND delivered_at IS NULL`,
  ).run(new Date(nowMs).toISOString(), runId);
  return result.changes === 1;
}

export function recordCodingRunReportBackFailure(runId: string, error: string): void {
  db().prepare(
    `UPDATE coding_run_report_backs SET attempts = attempts + 1, last_error = ?
      WHERE run_id = ? AND delivered_at IS NULL`,
  ).run(error.slice(0, 500), runId);
}
