/**
 * A retired turn's working records, and the record that lets them go.
 *
 * This module reads and writes the event log through whatever connection it
 * is handed and imports nothing that could open, migrate or serve the live
 * store, so the storage decay worker can run it on a connection of its own.
 */
import type Database from 'better-sqlite3';

export const CONVERSATION_COMPACT_IDLE_DAYS = 7;
export const CONVERSATION_MEMORY_ONLY_IDLE_DAYS = 30;
/** How long a retired conversation keeps its step records after retiring:
 * long enough for the retire itself to be noticed, since a resumed chat
 * reads its memory and tail, never these. */
export const RETIRED_WORK_RECORD_GRACE_DAYS = 1;

export const HELD_METADATA_KEYS = ['__interrupt_state', '__host_recovery_state', '__held_stop_publication_debt'] as const;

export type ItemRecord = Record<string, unknown>;

export function record(value: unknown): ItemRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ItemRecord : null;
}

/** Why this conversation must keep its state as it is, or null. */
export function conversationHoldReason(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare('SELECT metadata_json FROM sessions WHERE id = ?').get(sessionId) as { metadata_json: string } | undefined;
  if (!row) return 'session_missing';
  let metadata: ItemRecord | null = null;
  try { metadata = record(JSON.parse(row.metadata_json)); } catch { return 'metadata_unreadable'; }
  if (!metadata) return 'metadata_unreadable';
  if (metadata.pinned === true) return 'pinned';
  for (const key of HELD_METADATA_KEYS) if (metadata[key] !== undefined && metadata[key] !== null) return key;
  const checkpoints = record(metadata.__source_approval_checkpoints);
  if (checkpoints && Object.values(checkpoints).some((entry) => record(record(entry)?.checkpoint) !== null)) return 'approval_checkpoint';
  if (db.prepare("SELECT 1 FROM pending_approvals WHERE session_id = ? AND status = 'pending' LIMIT 1").get(sessionId)) return 'pending_approval';
  if (db.prepare('SELECT 1 FROM run_attempts WHERE session_id = ? AND finished_at IS NULL LIMIT 1').get(sessionId)) return 'unfinished_run';
  return null;
}

/** A finished turn of a long-lived session keeps its working records this
 * many days: the same bar a chat meets when it retires to its memory. */
export const RETIRED_TURN_IDLE_DAYS = CONVERSATION_MEMORY_ONLY_IDLE_DAYS;
/** A decay pass runs on the daemon's own loop, so it works this long and
 * stops; the backlog clears over the passes that follow, never in one. */
export const RETIRED_WORK_RECORD_PASS_BUDGET_MS = 250;

/** Tables whose rows are a turn's working records, keyed by session and turn. */
const TURN_WORKING_RECORD_TABLES = ['accepted_model_batch_admissions', 'durable_result_handles', 'model_request_provenance', 'logical_call_settlements'] as const;
/** The same, plus the retained outputs a conversation keys by session alone. */
const CONVERSATION_WORKING_RECORD_TABLES = [...TURN_WORKING_RECORD_TABLES, 'tool_outputs', 'tool_output_invocations'] as const;
/** Where a conversation's turns are named. */
const TURN_SOURCES = ['accepted_turn_call_authorities', ...TURN_WORKING_RECORD_TABLES, 'write_evidence_bindings', 'evidence_receipts', 'async_read_refinement_intents'] as const;
/** The result handle index covers authoritative handles only, and every
 * session-bound handle is one: a lookup says so, or it scans the table. */
const HANDLE_SCOPE = "scope_kind = 'authoritative' AND ";
const turnScope = (table: string, alias: string) => (table === 'durable_result_handles' ? `${alias}.${HANDLE_SCOPE}` : '');

export interface RetiredWorkRecordDecay {
  /** Conversations retired to memory whose working records went. */
  sessions: number;
  /** Finished turns of long-lived sessions (a watch, a workflow, a workspace) whose working records went. */
  turns: number;
  admissions: number;
  checkpoints: number;
  /** Stored histories no record references any more. */
  objects: number;
  handles: number;
  settlements: number;
  provenance: number;
  toolOutputs: number;
  /** Retired conversations and turns kept whole because something could still pick them up. */
  held: number;
  /** The same, by what holds them. */
  heldBy: Record<string, number>;
}

/** Where the last pass stopped, so each pass continues the walk instead of
 * re-examining the front of the list; a walk that reaches the end starts
 * over on the next pass. */
const walk = { conversation: '', turn: 0 };

/** The working records of a conversation retired to its memory, and of a
 * finished turn of a long-lived session: the batch admissions and checkpoints
 * (with their result receipts), the call settlements with their evidence, the
 * result handles, the request provenance, and the retained tool outputs every
 * turn wrote while it ran. A retired chat resumes from its memory and tail,
 * and a new turn starts its own records, so these are working copies once the
 * grace window after retiring has passed. A watch, a workflow or a workspace
 * never retires as a whole: it runs turn after turn, and a turn whose call
 * authority closed thirty days ago with no run still open is done. The
 * transcript in events, the calls and dispatches themselves, and the memory
 * stay. Nothing goes while the session is held (a pin, a pending approval, an
 * unfinished run); the retirement is recorded first, under the writer lock,
 * and every append-only guard reads that record. */
export function decayRetiredTurnWorkRecords(db: Database.Database, input: {
  nowMs?: number;
  graceDays?: number;
  limit?: number;
  turnLimit?: number;
  /** Wall-clock work per pass; what is left waits for the next pass. */
  budgetMs?: number;
} = {}): RetiredWorkRecordDecay {
  const nowMs = input.nowMs ?? Date.now();
  const graceDays = input.graceDays ?? RETIRED_WORK_RECORD_GRACE_DAYS;
  const budgetMs = input.budgetMs ?? RETIRED_WORK_RECORD_PASS_BUDGET_MS;
  const started = performance.now();
  // Conversations take the first half of the budget, turns the rest.
  let deadline = started + budgetMs / 2;
  const outOfTime = () => performance.now() > deadline;
  const retiredBefore = new Date(nowMs - graceDays * 86_400_000).toISOString();
  const turnsOpenedBefore = new Date(nowMs - (RETIRED_TURN_IDLE_DAYS + graceDays) * 86_400_000).toISOString();
  const result: RetiredWorkRecordDecay = { sessions: 0, turns: 0, admissions: 0, checkpoints: 0, objects: 0, handles: 0, settlements: 0, provenance: 0, toolOutputs: 0, held: 0, heldBy: {} };
  const hold = (sessionId: string): boolean => {
    const reason = conversationHoldReason(db, sessionId);
    if (reason === null) return false;
    result.held += 1;
    result.heldBy[reason] = (result.heldBy[reason] ?? 0) + 1;
    return true;
  };
  const shed = turnWorkRecordShedder(db, new Date(nowMs).toISOString(), result);

  const limit = Math.max(1, input.limit ?? 300);
  const conversations = db.prepare(`
    SELECT state.session_id AS sessionId
      FROM session_conversation_state state
     WHERE state.fidelity = 'memory'
       AND state.compacted_at IS NOT NULL
       AND state.compacted_at < ?
       AND state.session_id > ?
       AND (${CONVERSATION_WORKING_RECORD_TABLES.map((table) => `EXISTS (SELECT 1 FROM ${table} w WHERE ${turnScope(table, 'w')}w.session_id = state.session_id)`).join(' OR ')})
     ORDER BY state.session_id
     LIMIT ?
  `).all(retiredBefore, walk.conversation, limit) as Array<{ sessionId: string }>;
  walk.conversation = conversations.length < limit ? '' : conversations[conversations.length - 1]!.sessionId;
  const fidelityOf = db.prepare('SELECT fidelity FROM session_conversation_state WHERE session_id = ?');
  const turnsOf = db.prepare(`SELECT DISTINCT source_user_seq AS seq FROM (${TURN_SOURCES.map((table) => `SELECT source_user_seq FROM ${table} WHERE ${turnScope(table, table)}session_id = ? AND source_user_seq IS NOT NULL`).join(' UNION ALL ')}) ORDER BY seq`);
  const deleteConversationOutputs = ['tool_outputs', 'tool_output_invocations'].map((table) => db.prepare(`DELETE FROM ${table} WHERE session_id = ?`));
  // Each turn goes in its own transaction, the fidelity rechecked under the
  // writer lock every time; a pass that runs out of time leaves the rest of a
  // conversation for the next one, which finds it still a candidate.
  const stillRetired = () => (fidelityOf.get(sessionId) as { fidelity?: string } | undefined)?.fidelity === 'memory';
  let sessionId = '';
  conversations: for (const candidate of conversations) {
    sessionId = candidate.sessionId;
    if (outOfTime()) { walk.conversation = sessionId; break; }
    if (hold(sessionId)) continue;
    for (const { seq } of turnsOf.all(...TURN_SOURCES.map(() => sessionId)) as Array<{ seq: number }>) {
      if (outOfTime()) { walk.conversation = sessionId; break conversations; }
      db.transaction(() => { if (stillRetired()) shed(sessionId, seq); }).immediate();
    }
    db.transaction(() => {
      if (!stillRetired()) return;
      // An output whose call left no record goes with its conversation.
      for (const statement of deleteConversationOutputs) result.toolOutputs += statement.run(sessionId).changes;
      result.sessions += 1;
    }).immediate();
  }

  deadline = started + budgetMs;
  const turnLimit = Math.max(1, input.turnLimit ?? 300);
  const turns = db.prepare(`
    SELECT a.rowid AS row, a.session_id AS sessionId, a.source_user_seq AS seq
      FROM accepted_turn_call_authorities a
     WHERE a.rowid > ?
       AND a.state IN ('closed', 'conflict')
       AND a.opened_at < ?
       AND NOT EXISTS (SELECT 1 FROM session_conversation_state c WHERE c.session_id = a.session_id)
       AND NOT EXISTS (SELECT 1 FROM retired_turn_work_records r WHERE r.session_id = a.session_id AND r.source_user_seq = a.source_user_seq)
       AND NOT EXISTS (SELECT 1 FROM run_attempts ra WHERE ra.session_id = a.session_id AND ra.source_user_seq = a.source_user_seq AND ra.finished_at IS NULL)
       AND (${TURN_WORKING_RECORD_TABLES.map((table) => `EXISTS (SELECT 1 FROM ${table} w WHERE ${turnScope(table, 'w')}w.session_id = a.session_id AND w.source_user_seq = a.source_user_seq)`).join(' OR ')})
     ORDER BY a.rowid
     LIMIT ?
  `).all(walk.turn, turnsOpenedBefore, turnLimit) as Array<{ row: number; sessionId: string; seq: number }>;
  walk.turn = turns.length < turnLimit ? 0 : turns[turns.length - 1]!.row;
  const openRun = db.prepare('SELECT 1 FROM run_attempts WHERE session_id = ? AND source_user_seq = ? AND finished_at IS NULL LIMIT 1');
  const heldSessions = new Set<string>();
  for (const turn of turns) {
    if (outOfTime()) { walk.turn = turn.row - 1; break; }
    if (heldSessions.has(turn.sessionId)) { result.held += 1; continue; }
    if (hold(turn.sessionId)) { heldSessions.add(turn.sessionId); continue; }
    db.transaction(() => {
      // Rechecked under the writer lock: a run may have started since.
      if (openRun.get(turn.sessionId, turn.seq)) return;
      shed(turn.sessionId, turn.seq);
      result.turns += 1;
    }).immediate();
  }

  if (result.sessions > 0 || result.turns > 0) {
    result.objects = db.prepare(`
      DELETE FROM accepted_model_history_objects_v1
       WHERE NOT EXISTS (SELECT 1 FROM accepted_model_batch_checkpoints c WHERE c.history_object_digest = accepted_model_history_objects_v1.digest)
         AND NOT EXISTS (SELECT 1 FROM accepted_model_batch_admissions a WHERE a.pre_history_object_digest = accepted_model_history_objects_v1.digest)
         AND NOT EXISTS (SELECT 1 FROM accepted_model_batch_admissions a WHERE a.frame_history_object_digest = accepted_model_history_objects_v1.digest)
    `).run().changes;
  }
  return result;
}

/** Deletes one turn's working records, children before the rows they
 * reference, after recording the turn as retired. */
function turnWorkRecordShedder(db: Database.Database, retiredAt: string, counts: RetiredWorkRecordDecay): (sessionId: string, seq: number) => void {
  const record = db.prepare('INSERT OR IGNORE INTO retired_turn_work_records (session_id, source_user_seq, retired_at) VALUES (?, ?, ?)');
  const evidence = [
    'DELETE FROM write_evidence_proofs WHERE session_id = ? AND source_user_seq = ?',
    'DELETE FROM write_evidence_bindings WHERE session_id = ? AND source_user_seq = ?',
    'DELETE FROM evidence_receipts WHERE session_id = ? AND source_user_seq = ?',
    'DELETE FROM async_read_refinement_intents WHERE session_id = ? AND source_user_seq = ?',
    `DELETE FROM workflow_paginated_read_pages WHERE result_handle_id IN (SELECT handle_id FROM durable_result_handles WHERE ${HANDLE_SCOPE}session_id = ? AND source_user_seq = ?)`,
  ].map((sql) => db.prepare(sql));
  const settlements = db.prepare('DELETE FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ?');
  const handles = db.prepare(`DELETE FROM durable_result_handles WHERE ${HANDLE_SCOPE}session_id = ? AND source_user_seq = ?`);
  const provenance = db.prepare('DELETE FROM model_request_provenance WHERE session_id = ? AND source_user_seq = ?');
  const outputs = ['tool_outputs', 'tool_output_invocations'].map((table) => db.prepare(
    `DELETE FROM ${table} WHERE session_id = ? AND call_id IN (SELECT logical_tool_call_id FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?)`));
  const checkpoints = db.prepare('SELECT COUNT(*) AS n FROM accepted_model_batch_checkpoints WHERE session_id = ? AND source_user_seq = ?');
  const admissions = db.prepare('DELETE FROM accepted_model_batch_admissions WHERE session_id = ? AND source_user_seq = ?');
  return (sessionId, seq) => {
    record.run(sessionId, seq, retiredAt);
    for (const statement of evidence) statement.run(sessionId, seq);
    counts.settlements += settlements.run(sessionId, seq).changes;
    counts.handles += handles.run(sessionId, seq).changes;
    counts.provenance += provenance.run(sessionId, seq).changes;
    for (const statement of outputs) counts.toolOutputs += statement.run(sessionId, sessionId, seq).changes;
    counts.checkpoints += (checkpoints.get(sessionId, seq) as { n: number }).n;
    counts.admissions += admissions.run(sessionId, seq).changes;
  };
}
