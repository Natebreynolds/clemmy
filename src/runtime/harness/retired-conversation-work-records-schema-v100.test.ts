/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/retired-conversation-work-records-schema-v100.test.ts
 *
 * v100 lets a chat retired to its memory shed the step records its turns
 * wrote; every other session keeps its append-only guards.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-retired-records-v100-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');
const log = await import('./eventlog.js');
const store = await import('./accepted-model-history-store.js');
const lifecycle = await import('./conversation-state-lifecycle.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

const NOW = '2026-10-27T12:00:00.000Z';
const DAY_MS = 86_400_000;
const digest = (character: string) => character.repeat(64);
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

after(() => { log.closeEventLog(); rmSync(TMP_HOME, { recursive: true, force: true }); });

/** One accepted turn with its authority root, one admission and one checkpoint. */
function seedTurn(db: Database.Database, sessionId: string, options: { historyJson?: string; historyObjectDigest?: string | null; historyItemCount?: number } = {}) {
  db.prepare(`INSERT OR IGNORE INTO sessions (id, kind, created_at, updated_at, status, metadata_json)
    VALUES (?, 'chat', ?, ?, 'active', '{}')`).run(sessionId, NOW, NOW);
  const inserted = db.prepare(`INSERT INTO events (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, 1, 'user', 'user_input_received', NULL, '{"text":"continue the exact task"}', ?)`)
    .run(`${sessionId}-source`, sessionId, NOW);
  const sourceUserSeq = Number(inserted.lastInsertRowid);
  const acceptedTaskId = `task:${sessionId}#${sourceUserSeq}`;
  // One authority per turn: its digest is unique across sessions.
  const authority = createHash('sha256').update(sessionId).digest('hex');
  const batchId = createHash('sha256').update(`${sessionId}:batch`).digest('hex');
  db.prepare(`INSERT INTO accepted_turn_call_authorities
      (session_id, source_user_seq, accepted_task_id, authority_protocol, authority_kind, source_event_id, source_event_digest,
       source_turn, engine_version, surface_version, surface_digest, effect_ceiling, effect_bounds_json, max_logical_calls,
       max_parallel_calls, catalog_revision_digest, binding_revision_digest, authority_digest, state, revision, opened_at)
    VALUES (?, ?, ?, 1, 'host_v1', ?, ?, 1, 'host_v1', 'configured_harness_capability_surface_v1', ?, 'admin',
            '["admin","compute","external_write","host_only","local_write","read"]', 8, 4, ?, ?, ?, 'open', 0, ?)`)
    .run(sessionId, sourceUserSeq, acceptedTaskId, `${sessionId}-source`, digest('a'), digest('b'), digest('c'), digest('d'), authority, NOW);
  db.prepare(`INSERT INTO accepted_model_batch_admissions
      (session_id, source_user_seq, accepted_task_id, batch_ordinal, batch_id, protocol_version, authority_digest, source_event_digest,
       source_turn, engine_version, graph_event_id, graph_hash, work_contract_id, previous_response_id, provider_response_id,
       accepted_response_digest, pre_history_json, pre_history_digest, pre_history_item_count, frame_history_json, frame_history_digest,
       frame_history_item_count, call_ids_json, call_count, admitted_at)
    VALUES (?, ?, ?, 1, ?, 1, ?, ?, 1, 'host_v1', NULL, NULL, NULL, NULL, 'response-1', ?,
            '[{"role":"user","content":"continue the exact task"}]', ?, 1,
            '[{"type":"function_call","callId":"call-1","name":"generic_tool","arguments":"{}"}]', ?, 1, '["call-1"]', 1, ?)`)
    .run(sessionId, sourceUserSeq, acceptedTaskId, batchId, authority, digest('a'), digest('f'), digest('1'), digest('2'), NOW);
  const historyJson = options.historyJson ?? '[{"role":"user","content":"continue the exact task"},{"type":"function_call","callId":"call-1","name":"generic_tool","arguments":"{}"},{"type":"function_call_result","callId":"call-1","name":"generic_tool","output":"done"}]';
  db.prepare(`INSERT INTO accepted_model_batch_checkpoints
      (session_id, source_user_seq, accepted_task_id, batch_ordinal, batch_id, protocol_version, authority_digest, graph_event_id,
       graph_hash, work_contract_id, disposition, history_json, history_digest, history_item_count, last_response_id, committed_at, history_object_digest)
    VALUES (?, ?, ?, 1, ?, 1, ?, NULL, NULL, NULL, 'ready', ?, ?, ?, 'response-1', ?, ?)`)
    .run(sessionId, sourceUserSeq, acceptedTaskId, batchId, authority, historyJson,
      // A reference to a stored object binds the object's own digest and item count.
      options.historyObjectDigest ?? digest('6'), options.historyItemCount ?? 3, NOW, options.historyObjectDigest ?? null);
  return { sessionId, sourceUserSeq };
}

function setConversationState(db: Database.Database, sessionId: string, fidelity: 'full' | 'compacted' | 'memory', compactedAt: string | null) {
  db.prepare(`INSERT INTO session_conversation_state (session_id, state_json, fidelity, memory_episode_id, updated_at, compacted_at)
    VALUES (?, '{"items":[]}', ?, NULL, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET fidelity = excluded.fidelity, compacted_at = excluded.compacted_at`)
    .run(sessionId, fidelity, NOW, compactedAt);
}

const count = (db: Database.Database, table: string, sessionId: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId) as { n: number }).n;

test('v99 to v100 rewrites only the four delete guards and leaves every durable row as it was', () => {
  const db = new Database(path.join(TMP_HOME, 'v99-to-v100.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 99);
    const live = seedTurn(db, 'live-chat');
    setConversationState(db, 'live-chat', 'full', null);
    const tables = ['sessions', 'events', 'accepted_turn_call_authorities', 'accepted_model_batch_admissions', 'accepted_model_batch_checkpoints', 'session_conversation_state'];
    const rows = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const priorVersions = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    const otherObjects = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '%_delete_immutable' ORDER BY type, name`).all();

    schema.applyHarnessMigrationsThroughVersionForTests(db, 100);

    assert.ok(HARNESS_SCHEMA_VERSION >= 100);
    assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), rows);
    assert.deepEqual(db.prepare('SELECT * FROM schema_version WHERE version <= 99 ORDER BY version').all(), priorVersions);
    assert.deepEqual(db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '%_delete_immutable' ORDER BY type, name`).all(), otherObjects);
    for (const trigger of ['trg_accepted_model_batch_admission_delete_immutable', 'trg_accepted_model_batch_checkpoint_delete_immutable',
      'trg_host_model_result_receipt_delete_immutable', 'trg_logical_model_result_projection_delete_immutable']) {
      const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(trigger) as { sql: string } | undefined;
      assert.ok(row?.sql.includes("retired.fidelity = 'memory'"), `${trigger} names the retired clause`);
    }

    // A conversation still in use keeps its records: both guards still refuse.
    assert.throws(() => db.prepare('DELETE FROM accepted_model_batch_checkpoints WHERE session_id = ?').run('live-chat'), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM accepted_model_batch_admissions WHERE session_id = ?').run('live-chat'), /append-only/);
    setConversationState(db, 'live-chat', 'compacted', NOW);
    assert.throws(() => db.prepare('DELETE FROM accepted_model_batch_admissions WHERE session_id = ?').run('live-chat'), /append-only/);
    assert.equal(count(db, 'accepted_model_batch_checkpoints', 'live-chat'), 1);

    // Retired to memory: the admission goes and takes its checkpoint with it.
    setConversationState(db, 'live-chat', 'memory', NOW);
    assert.equal(db.prepare('DELETE FROM accepted_model_batch_admissions WHERE session_id = ?').run('live-chat').changes, 1);
    assert.equal(count(db, 'accepted_model_batch_checkpoints', 'live-chat'), 0);
    assert.equal(count(db, 'events', 'live-chat'), 1, 'the transcript stays');
    assert.equal(live.sourceUserSeq > 0, true);
  } finally { db.close(); }
});

test('a day after retiring, a chat sheds its step records; held, younger and live chats keep theirs', () => {
  const db = log.openEventLog();
  db.pragma('foreign_keys = ON');
  const bigHistory = JSON.stringify([{ role: 'user', content: 'keep the exact task '.repeat(2_000) }]);
  const stored = store.storeAcceptedModelHistory(db, bigHistory);
  assert.ok(stored.objectDigest, 'a history above the floor is stored as an object');

  seedTurn(db, 'retired-old', { historyJson: stored.inlineJson, historyObjectDigest: stored.objectDigest, historyItemCount: 1 });
  setConversationState(db, 'retired-old', 'memory', daysAgo(2));
  seedTurn(db, 'retired-young');
  setConversationState(db, 'retired-young', 'memory', daysAgo(0.5));
  seedTurn(db, 'retired-held');
  setConversationState(db, 'retired-held', 'memory', daysAgo(20));
  db.prepare(`INSERT INTO run_attempts (attempt_id, session_id, run_id, started_at, status, source_user_seq)
    VALUES ('held-attempt', 'retired-held', 'held-run', ?, 'active', 1)`).run(NOW);
  seedTurn(db, 'still-full');
  setConversationState(db, 'still-full', 'full', null);
  seedTurn(db, 'compacted-only');
  setConversationState(db, 'compacted-only', 'compacted', daysAgo(40));

  const decayed = lifecycle.decayRetiredConversationWorkRecords({ nowMs: Date.parse(NOW), budgetMs: 60_000 });
  assert.deepEqual(decayed, { sessions: 1, turns: 0, admissions: 1, checkpoints: 1, objects: 1, handles: 0, settlements: 0, provenance: 0, toolOutputs: 0, held: 1 });
  assert.equal(count(db, 'accepted_model_batch_admissions', 'retired-old'), 0);
  assert.equal(count(db, 'accepted_model_batch_checkpoints', 'retired-old'), 0);
  assert.equal(count(db, 'events', 'retired-old'), 1, 'the transcript stays');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM accepted_model_history_objects_v1 WHERE digest = ?').get(stored.objectDigest) as { n: number }).n, 0, 'the orphaned history object is reclaimed');
  for (const kept of ['retired-young', 'retired-held', 'still-full', 'compacted-only']) {
    assert.equal(count(db, 'accepted_model_batch_admissions', kept), 1, `${kept} keeps its admission`);
    assert.equal(count(db, 'accepted_model_batch_checkpoints', kept), 1, `${kept} keeps its checkpoint`);
  }
  assert.ok(db.prepare("SELECT 1 FROM session_conversation_state WHERE session_id = 'retired-old' AND fidelity = 'memory'").get(), 'the retired state itself stays');

  // The same pass again finds nothing to do.
  assert.deepEqual(lifecycle.decayRetiredConversationWorkRecords({ nowMs: Date.parse(NOW), budgetMs: 60_000 }), { sessions: 0, turns: 0, admissions: 0, checkpoints: 0, objects: 0, handles: 0, settlements: 0, provenance: 0, toolOutputs: 0, held: 1 });
});
