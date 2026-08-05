/**
 * The cross-process transactional handoff store.
 *
 * The foreground → background handoff decides which of two live executors OWNS
 * an accepted user turn, so its state machine is the exactly-once boundary for
 * the whole continuation. A rename-based JSON record cannot enforce that:
 * rename is atomic for the FILE, but read-modify-write across two processes is
 * not atomic for the TRANSITION — both can read revision N, both can decide
 * they hold it, and both can rename a revision N+1 over each other. The
 * compare-and-swap was therefore a check-then-write, which is exactly the shape
 * that produces two owners.
 *
 * Here the ladder check, the revision CAS, and the write are ONE immediate
 * SQLite transaction. SQLite serializes writers across processes, so a loser
 * observes the winner's revision instead of overwriting it, and a crash between
 * any two instructions leaves the previous rung intact rather than a torn one.
 *
 * The state ladder is the ORDER the detach path actually performs, not a
 * plausible-sounding order: durable transfer intent is recorded and the capsule
 * checkpointed BEFORE the foreground is fenced, because a fence with no durable
 * intent is work with no owner at all.
 *
 * The ladder models ONE track — the foreground's transfer of ownership — and
 * every forward step is EXACTLY ONE rung with the caller's observed revision
 * pinned. Worker ownership is deliberately not a rung: the worker starting and
 * the foreground committing its terminal are independent events with no
 * guaranteed order, so folding them into one line would force a legal
 * production interleaving to be refused. Worker ownership is a separate durable
 * fact on the same row, set idempotently at the worker-start boundary.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';

export type HandoffState =
  | 'requested'
  | 'capsule_checkpointed'
  | 'background_admitted'
  | 'foreground_commit_fenced'
  | 'foreground_released'
  | 'terminal';

/** The ladder: ownership moves forward one rung at a time. 'terminal' is the
 *  abort target rather than a rung — it means "this handoff will never produce
 *  a background owner", and a boot reconciler must be able to reach it from
 *  wherever a crash left the row so it stops resurrecting an abandoned
 *  transfer. Every OTHER step is strictly adjacent. */
export const HANDOFF_ORDER: readonly HandoffState[] = [
  'requested',
  'capsule_checkpointed',
  'background_admitted',
  'foreground_commit_fenced',
  'foreground_released',
  'terminal',
];

export function handoffRank(state: HandoffState): number {
  return HANDOFF_ORDER.indexOf(state);
}

/**
 * The background task id this handoff will admit, decided BEFORE any task
 * exists and derived only from the accepted attempt. Two processes racing to
 * admit the same transfer therefore compute the SAME id and contend for one
 * task file, instead of each minting a random id and creating a runnable
 * duplicate that both report back.
 */
export function reservedBackgroundTaskId(acceptedAttemptId: string): string {
  const digest = createHash('sha256').update(acceptedAttemptId, 'utf-8').digest('hex').slice(0, 12);
  return `bg-h${digest}`;
}

export interface HandoffRecord {
  version: 1;
  logicalTaskId: string;
  /** The exact accepted attempt — also the idempotency key: a double-click,
   *  lost response, or restart REJOINS this task instead of forking one. */
  acceptedAttemptId: string;
  sessionId: string;
  sourceUserSeq: number;
  capsuleId?: string;
  backgroundTaskId?: string;
  state: HandoffState;
  /** When the admitted worker actually took the run. Not a rung: it races the
   *  foreground's own terminal and neither order is wrong. */
  ownerActiveAt?: string;
  /** Why this handoff reached a rung that ends it. Only meaningful for
   *  'terminal'; carried so reconciliation reports a cause instead of a state. */
  reason?: string;
  /** Monotonic, opaque to callers. A writer that does not hold the current
   *  revision is a writer working from a stale view of who owns this task. */
  revision: number;
  updatedAt: string;
}

export type HandoffIdentity = Pick<
  HandoffRecord,
  'logicalTaskId' | 'acceptedAttemptId' | 'sessionId' | 'sourceUserSeq'
>;

export type HandoffProposal = HandoffIdentity & {
  state: HandoffState;
  capsuleId?: string;
  backgroundTaskId?: string;
  reason?: string;
};

export type HandoffWrite =
  | { ok: true; record: HandoffRecord }
  | { ok: false; reason: string; current: HandoffRecord | undefined };

interface HandoffRow {
  accepted_attempt_id: string;
  logical_task_id: string;
  session_id: string;
  source_user_seq: number;
  capsule_id: string | null;
  background_task_id: string | null;
  state: HandoffState;
  owner_active_at: string | null;
  reason: string | null;
  revision: number;
  updated_at: string;
}

let handle: Database.Database | null = null;
let handlePath = '';

function db(): Database.Database {
  const dir = path.join(BASE_DIR, 'state', 'handoffs', getMachineId());
  const file = path.join(dir, 'handoffs.db');
  if (handle && handlePath === file) return handle;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  handle = new Database(file);
  handlePath = file;
  handle.pragma('journal_mode = WAL');
  // A second process holding the write lock is normal contention here, not an
  // error: the whole point of this store is that concurrent claimants queue.
  handle.pragma('busy_timeout = 10000');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      accepted_attempt_id TEXT PRIMARY KEY,
      logical_task_id     TEXT NOT NULL,
      session_id          TEXT NOT NULL,
      source_user_seq     INTEGER NOT NULL,
      capsule_id          TEXT,
      background_task_id  TEXT,
      state               TEXT NOT NULL CHECK(state IN (
        'requested','capsule_checkpointed','background_admitted',
        'foreground_commit_fenced','foreground_released','terminal'
      )),
      owner_active_at     TEXT,
      reason              TEXT,
      revision            INTEGER NOT NULL,
      updated_at          TEXT NOT NULL
    );
  `);
  return handle;
}

/** Test hook: close the handle so a fresh CLEMENTINE_HOME re-opens cleanly. */
export function closeHandoffStoreForTests(): void {
  handle?.close();
  handle = null;
  handlePath = '';
}

function toRecord(row: HandoffRow): HandoffRecord {
  return {
    version: 1,
    logicalTaskId: row.logical_task_id,
    acceptedAttemptId: row.accepted_attempt_id,
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    ...(row.capsule_id ? { capsuleId: row.capsule_id } : {}),
    ...(row.background_task_id ? { backgroundTaskId: row.background_task_id } : {}),
    state: row.state,
    ...(row.owner_active_at ? { ownerActiveAt: row.owner_active_at } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function readRow(database: Database.Database, acceptedAttemptId: string): HandoffRecord | undefined {
  const row = database
    .prepare('SELECT * FROM handoffs WHERE accepted_attempt_id = ?')
    .get(acceptedAttemptId) as HandoffRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function loadHandoffRecord(acceptedAttemptId: string): HandoffRecord | undefined {
  if (!acceptedAttemptId) return undefined;
  try {
    return readRow(db(), acceptedAttemptId);
  } catch {
    return undefined;
  }
}

/** Every handoff that has not reached the rung where nothing more can happen.
 *  Boot reconciliation converges exactly these to one owner. */
export function listUnsettledHandoffRecords(): HandoffRecord[] {
  try {
    const rows = db()
      .prepare("SELECT * FROM handoffs WHERE state != 'terminal' ORDER BY updated_at ASC")
      .all() as HandoffRow[];
    return rows.map(toRecord);
  } catch {
    return [];
  }
}

export function listHandoffRecords(): HandoffRecord[] {
  try {
    return (db().prepare('SELECT * FROM handoffs ORDER BY updated_at ASC').all() as HandoffRow[])
      .map(toRecord);
  } catch {
    return [];
  }
}

/**
 * The ONE transition. Three rules, and each exists because its absence is how a
 * task ends up with two live owners:
 *
 *   ADMISSION — a handoff only comes into existence as 'requested'. A writer
 *   that invents a row already halfway up the ladder is asserting durable state
 *   nothing produced.
 *
 *   MONOTONIC — the state may only move forward. A late writer replaying
 *   'requested' over 'background_owner_active' would hand the foreground back a
 *   task the background is already running.
 *
 *   CAS — the caller may pin the revision it read, and the check and the write
 *   happen inside one immediate transaction. Two activations racing to claim the
 *   same attempt cannot both win, in this process or across processes.
 *
 * Identity is immutable: logical task, session, and source event are what the
 * handoff IS. Capsule and background-task ids are additive — an advance that
 * omits them keeps the ones already durable rather than erasing an owner.
 */
export function advanceHandoff(
  proposal: HandoffProposal,
  options: { expectedRevision: number; now?: string },
): HandoffWrite {
  const database = db();
  const now = options?.now ?? new Date().toISOString();
  const expectedRevision = options?.expectedRevision;
  // A caller that cannot name the revision it read cannot know whether it is
  // racing another owner. Refusing the write is the whole mechanism; making the
  // pin optional would quietly restore last-writer-wins for the one decision
  // this store exists to serialize.
  if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0) {
    return {
      ok: false,
      reason: 'every handoff transition must pin the revision it observed',
      current: readRow(database, proposal.acceptedAttemptId),
    };
  }
  const tx = database.transaction((): HandoffWrite => {
    const current = readRow(database, proposal.acceptedAttemptId);
    if (!current) {
      if (proposal.state !== 'requested') {
        return {
          ok: false,
          reason: `no handoff exists for ${proposal.acceptedAttemptId}; it may only be admitted as 'requested'`,
          current: undefined,
        };
      }
      if (expectedRevision !== 0) {
        return { ok: false, reason: `expected revision ${expectedRevision}, found none`, current: undefined };
      }
      database.prepare(
        `INSERT INTO handoffs
           (accepted_attempt_id, logical_task_id, session_id, source_user_seq,
            capsule_id, background_task_id, state, owner_active_at, reason, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?)`,
      ).run(
        proposal.acceptedAttemptId,
        proposal.logicalTaskId,
        proposal.sessionId,
        proposal.sourceUserSeq,
        proposal.capsuleId ?? null,
        proposal.backgroundTaskId ?? null,
        proposal.state,
        proposal.reason ?? null,
        now,
      );
      return { ok: true, record: readRow(database, proposal.acceptedAttemptId)! };
    }
    if (expectedRevision !== current.revision) {
      return { ok: false, reason: `expected revision ${expectedRevision}, found ${current.revision}`, current };
    }
    if (current.logicalTaskId !== proposal.logicalTaskId || current.sessionId !== proposal.sessionId) {
      return {
        ok: false,
        reason: `handoff identity mismatch: ${current.sessionId}/${current.logicalTaskId} owns this accepted attempt`,
        current,
      };
    }
    // EXACTLY ONE RUNG. A skip asserts durable state for a step nothing
    // performed; a same-rung rewrite lets two callers each believe they hold
    // the rung and is last-writer-wins by another name. 'terminal' is the one
    // abort edge and is reachable from anywhere, because a crash has to be
    // able to end a transfer from wherever it left the row.
    const forward = handoffRank(proposal.state) - handoffRank(current.state);
    if (proposal.state !== 'terminal' && forward !== 1) {
      return {
        ok: false,
        reason: forward <= 0
          ? `handoff cannot regress or restate ${current.state} as ${proposal.state}; transitions are adjacent`
          : `handoff cannot skip from ${current.state} to ${proposal.state}; transitions are adjacent`,
        current,
      };
    }
    const changed = database.prepare(
      `UPDATE handoffs
          SET state = ?, capsule_id = ?, background_task_id = ?, reason = ?,
              revision = revision + 1, updated_at = ?
        WHERE accepted_attempt_id = ? AND revision = ?`,
    ).run(
      proposal.state,
      proposal.capsuleId ?? current.capsuleId ?? null,
      proposal.backgroundTaskId ?? current.backgroundTaskId ?? null,
      proposal.reason ?? current.reason ?? null,
      now,
      proposal.acceptedAttemptId,
      current.revision,
    ).changes;
    if (changed !== 1) {
      return {
        ok: false,
        reason: `handoff revision ${current.revision} was already spent`,
        current: readRow(database, proposal.acceptedAttemptId),
      };
    }
    return { ok: true, record: readRow(database, proposal.acceptedAttemptId)! };
  });
  // IMMEDIATE, not deferred: a deferred transaction takes its read lock first
  // and can only discover a competing writer when it tries to upgrade, which
  // is the check-then-write race in a different costume.
  return tx.immediate();
}

/**
 * Record that the admitted worker actually took the run. Idempotent and
 * revision-free on purpose: this is an observation of a boundary that already
 * happened, not a claim of ownership, and it races the foreground's own
 * terminal with no correct order between them. The first writer wins; a later
 * worker restart does not rewrite when the run was first taken.
 */
export function markHandoffOwnerActive(acceptedAttemptId: string, now = new Date().toISOString()): boolean {
  try {
    return db().prepare(
      'UPDATE handoffs SET owner_active_at = ? WHERE accepted_attempt_id = ? AND owner_active_at IS NULL',
    ).run(now, acceptedAttemptId).changes === 1;
  } catch {
    return false;
  }
}

/**
 * Name the owner on a handoff that already passed admission. Write-once: the
 * task id is identity, not state, so binding it is not a rung and may never
 * REPLACE an owner already named — that would be a silent change of who is
 * running the work.
 */
export function bindHandoffBackgroundTask(acceptedAttemptId: string, backgroundTaskId: string): boolean {
  try {
    return db().prepare(
      `UPDATE handoffs SET background_task_id = ?, revision = revision + 1, updated_at = ?
        WHERE accepted_attempt_id = ? AND background_task_id IS NULL`,
    ).run(backgroundTaskId, new Date().toISOString(), acceptedAttemptId).changes === 1;
  } catch {
    return false;
  }
}

/** A handoff whose admitted worker is live. Derived rather than stored as a
 *  rung so it can be true at any point after admission. */
export function isBackgroundOwnerActive(record: HandoffRecord | undefined): boolean {
  return Boolean(record?.ownerActiveAt) && record?.state !== 'terminal';
}

/**
 * Import a handoff written by an older build's JSON record. This is the only
 * path that may admit a row above 'requested', because the state it carries is
 * durable history rather than an assertion. Idempotent: an attempt that already
 * has a row keeps it — the live row is never overwritten by a stale file.
 */
export function importLegacyHandoffRecord(record: HandoffRecord): boolean {
  const database = db();
  const tx = database.transaction((): boolean => {
    if (readRow(database, record.acceptedAttemptId)) return false;
    database.prepare(
      `INSERT INTO handoffs
         (accepted_attempt_id, logical_task_id, session_id, source_user_seq,
          capsule_id, background_task_id, state, owner_active_at, reason, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.acceptedAttemptId,
      record.logicalTaskId,
      record.sessionId,
      record.sourceUserSeq,
      record.capsuleId ?? null,
      record.backgroundTaskId ?? null,
      // A rung this build no longer has is mapped to the nearest rung that
      // means the same thing about OWNERSHIP. Dropping the row instead would
      // strand an in-flight transfer across the upgrade.
      record.state === ('background_owner_active' as HandoffState) ? 'background_admitted' : record.state,
      record.state === ('background_owner_active' as HandoffState) ? (record.updatedAt || null) : null,
      record.reason ?? null,
      Number.isInteger(record.revision) && record.revision > 0 ? record.revision : 1,
      record.updatedAt || new Date().toISOString(),
    );
    return true;
  });
  return tx.immediate();
}
