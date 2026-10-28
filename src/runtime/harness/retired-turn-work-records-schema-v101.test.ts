/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/retired-turn-work-records-schema-v101.test.ts
 *
 * v101 records a retired turn before its working records go, and every
 * append-only delete guard reads that record: a chat retired to its memory
 * sheds every turn's call records, result handles, request provenance and
 * retained outputs; a long-lived session sheds a finished turn's after thirty
 * days; everything else keeps its guards.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-retired-turns-v101-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');
const log = await import('./eventlog.js');
const lifecycle = await import('./conversation-state-lifecycle.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

const NOW = '2026-10-28T12:00:00.000Z';
const DAY_MS = 86_400_000;
const digest = (character: string) => character.repeat(64);
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

const GUARDS = [
  'trg_accepted_model_batch_admission_delete_immutable', 'trg_accepted_model_batch_checkpoint_delete_immutable',
  'trg_host_model_result_receipt_delete_immutable', 'trg_logical_model_result_projection_delete_immutable',
  'trg_logical_call_settlement_delete_immutable', 'trg_logical_settlement_crossing_delete_immutable',
  'trg_model_request_provenance_delete_immutable', 'trg_write_evidence_bindings_delete_immutable',
  'trg_write_evidence_reservations_delete_immutable', 'trg_write_evidence_outcomes_delete_immutable',
  'trg_write_evidence_readbacks_delete_immutable', 'trg_write_evidence_derivations_delete_immutable',
  'trg_write_evidence_derivation_sources_delete_immutable', 'trg_write_evidence_execution_snapshots_delete_immutable',
  'trg_write_evidence_proofs_delete_immutable', 'trg_async_read_refinement_intent_delete_immutable',
  'trg_async_read_refinement_start_receipt_delete_immutable', 'trg_async_read_refinement_completion_receipt_delete_immutable',
  'trg_async_read_refinement_terminal_receipt_delete_immutable',
];

after(() => { log.closeEventLog(); rmSync(TMP_HOME, { recursive: true, force: true }); });

/** One turn of a session with everything a turn writes: its accepted source,
 * call authority, batch admission and checkpoint, one logical call with its
 * returned dispatch, result handle and settlement, the request's provenance
 * and the call's retained outputs. */
function seedTurn(db: Database.Database, sessionId: string, turn: number, options: {
  kind?: string; authorityState?: 'open' | 'closed' | 'conflict'; openedAt?: string; metadata?: string;
} = {}) {
  const at = options.openedAt ?? NOW;
  const state = options.authorityState ?? 'open';
  db.prepare(`INSERT OR IGNORE INTO sessions (id, kind, created_at, updated_at, status, metadata_json)
    VALUES (?, ?, ?, ?, 'active', ?)`).run(sessionId, options.kind ?? 'chat', at, at, options.metadata ?? '{}');
  const id = (part: string) => `${sessionId}-${turn}-${part}`;
  const inserted = db.prepare(`INSERT INTO events (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, ?, 'user', 'user_input_received', NULL, '{"text":"continue the exact task"}', ?)`).run(id('source'), sessionId, turn, at);
  const seq = Number(inserted.lastInsertRowid);
  for (const part of ['start', 'settle']) {
    db.prepare(`INSERT INTO events (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
      VALUES (?, ?, ?, 'system', 'tool_call', NULL, '{}', ?)`).run(id(part), sessionId, turn, at);
  }
  const task = `task:${sessionId}#${seq}`;
  const authority = createHash('sha256').update(id('authority')).digest('hex');
  const batchId = createHash('sha256').update(id('batch')).digest('hex');
  const call = id('call');
  const handle = `rh_${id('result')}`;
  db.prepare(`INSERT INTO accepted_turn_call_authorities
      (session_id, source_user_seq, accepted_task_id, authority_protocol, authority_kind, source_event_id, source_event_digest,
       source_turn, engine_version, surface_version, surface_digest, effect_ceiling, effect_bounds_json, max_logical_calls,
       max_parallel_calls, catalog_revision_digest, binding_revision_digest, authority_digest, state, revision, opened_at, closed_at, close_reason)
    VALUES (?, ?, ?, 1, 'host_v1', ?, ?, ?, 'host_v1', 'configured_harness_capability_surface_v1', ?, 'admin',
            '["admin","compute","external_write","host_only","local_write","read"]', 8, 4, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .run(sessionId, seq, task, id('source'), digest('a'), turn, digest('b'), digest('c'), digest('d'), authority, 'open', at, null, null);
  db.prepare(`INSERT INTO accepted_model_batch_admissions
      (session_id, source_user_seq, accepted_task_id, batch_ordinal, batch_id, protocol_version, authority_digest, source_event_digest,
       source_turn, engine_version, graph_event_id, graph_hash, work_contract_id, previous_response_id, provider_response_id,
       accepted_response_digest, pre_history_json, pre_history_digest, pre_history_item_count, frame_history_json, frame_history_digest,
       frame_history_item_count, call_ids_json, call_count, admitted_at)
    VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?, 'host_v1', NULL, NULL, NULL, NULL, 'response-1', ?,
            '[{"role":"user","content":"continue the exact task"}]', ?, 1,
            '[{"type":"function_call","callId":"call-1","name":"generic_tool","arguments":"{}"}]', ?, 1, '["call-1"]', 1, ?)`)
    .run(sessionId, seq, task, batchId, authority, digest('a'), turn, digest('f'), digest('1'), digest('2'), at);
  db.prepare(`INSERT INTO accepted_model_batch_checkpoints
      (session_id, source_user_seq, accepted_task_id, batch_ordinal, batch_id, protocol_version, authority_digest, graph_event_id,
       graph_hash, work_contract_id, disposition, history_json, history_digest, history_item_count, last_response_id, committed_at, history_object_digest)
    VALUES (?, ?, ?, 1, ?, 1, ?, NULL, NULL, NULL, 'ready',
            '[{"role":"user","content":"continue the exact task"},{"type":"function_call","callId":"call-1","name":"generic_tool","arguments":"{}"},{"type":"function_call_result","callId":"call-1","name":"generic_tool","output":"done"}]',
            ?, 3, 'response-1', ?, NULL)`)
    .run(sessionId, seq, task, batchId, authority, digest('6'), at);
  db.prepare(`INSERT INTO logical_tool_calls (session_id, source_user_seq, accepted_task_id, logical_tool_call_id, tool_name, argument_digest, state, opened_at, raw_argument_digest)
    VALUES (?, ?, ?, ?, 'generic_tool', ?, 'open', ?, ?)`).run(sessionId, seq, task, call, digest('3'), at, digest('3'));
  db.prepare(`INSERT INTO physical_dispatches (session_id, source_user_seq, accepted_task_id, logical_tool_call_id, physical_dispatch_id, ordinal, relation,
      tool_name, argument_digest, state, started_at, start_event_id, execution_site)
    VALUES (?, ?, ?, ?, ?, 1, 'primary', 'generic_tool', ?, 'returned', ?, ?, 'host')`).run(sessionId, seq, task, call, id('dispatch'), digest('3'), at, id('start'));
  db.prepare(`INSERT INTO durable_result_handles (handle_id, scope_kind, session_id, source_user_seq, accepted_task_id, logical_tool_call_id, physical_dispatch_id,
      continuation_chain_id, tool_name, argument_digest, base_argument_digest, raw_payload_json, raw_location, raw_payload_sha256, raw_byte_count, success,
      record_count, completeness, projected_records_json, created_at)
    VALUES (?, 'authoritative', ?, ?, ?, ?, ?, ?, 'generic_tool', ?, ?, '"done"', ?, ?, 6, 1, 1, 'complete', '[]', ?)`)
    .run(handle, sessionId, seq, task, call, id('dispatch'), call, digest('3'), digest('3'), id('raw'), digest('5'), at);
  db.prepare(`INSERT INTO logical_call_settlements (session_id, source_user_seq, logical_tool_call_id, protocol_version, semantic_digest, execution_kind, outcome_kind,
      outcome_evidence, business_call, mutating, continues_requirement, recovery_action, retry_same_candidate, eliminates_candidate, discovery_epoch_requested,
      requires_reconciliation, progress_claimed, physical_crossing_count, physical_crossings_digest, observer_lane, settlement_event_id, settled_at, result_handle_id,
      host_crossing_count, crossing_authority_version)
    VALUES (?, ?, ?, 1, ?, 'provider_execution', 'succeeded', 'structured', 0, 0, 0, 'settle', 0, 0, 0, 0, 0, 1, ?, 'native_mcp', ?, ?, ?, 1, 2)`)
    .run(sessionId, seq, call, digest('e'), digest('7'), id('settle'), at, handle);
  db.prepare(`INSERT INTO model_request_provenance (record_id, session_id, source_user_seq, source_event_id, request_ordinal, protocol_version, boundary,
      normalized_request_digest, host_projection_digest, provenance_digest, provenance_json, payload_id, payload_binding_digest, payload_reference_json, created_at)
    VALUES (?, ?, ?, ?, 1, 1, 'layered', ?, ?, ?, '{}', ?, ?, '{}', ?)`)
    .run(id('provenance'), sessionId, seq, id('source'), digest('8'), digest('9'), digest('0'), `authority-payload:${id('payload')}`, digest('a'), at);
  db.prepare('INSERT INTO tool_outputs (session_id, call_id, output_full, content_bytes, created_at) VALUES (?, ?, ?, 4, ?)').run(sessionId, call, 'done', at);
  db.prepare('INSERT INTO tool_output_invocations (session_id, call_id, invocation_nonce, output_full, content_bytes, created_at) VALUES (?, ?, ?, ?, 4, ?)')
    .run(sessionId, call, id('nonce'), 'done', at);
  // Every record above is written under an open authority; the turn closes last.
  if (state !== 'open') {
    db.prepare(`UPDATE accepted_turn_call_authorities SET state = ?, closed_at = ?, close_reason = 'turn_completed', revision = revision + 1
      WHERE session_id = ? AND source_user_seq = ?`).run(state, at, sessionId, seq);
  }
  return { sessionId, seq, call, handle };
}

function setConversationState(db: Database.Database, sessionId: string, fidelity: 'full' | 'compacted' | 'memory', compactedAt: string | null) {
  db.prepare(`INSERT INTO session_conversation_state (session_id, state_json, fidelity, memory_episode_id, updated_at, compacted_at)
    VALUES (?, '{"items":[]}', ?, NULL, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET fidelity = excluded.fidelity, compacted_at = excluded.compacted_at`)
    .run(sessionId, fidelity, NOW, compactedAt);
}

const WORKING = ['accepted_model_batch_admissions', 'accepted_model_batch_checkpoints', 'logical_call_settlements', 'durable_result_handles',
  'model_request_provenance', 'tool_outputs', 'tool_output_invocations'];
const KEPT = ['events', 'accepted_turn_call_authorities', 'logical_tool_calls', 'physical_dispatches'];
const count = (db: Database.Database, table: string, sessionId: string, seq?: number) => (db.prepare(
  `SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?${seq === undefined || table.startsWith('tool_output') || table === 'events' ? '' : ' AND source_user_seq = ?'}`,
).get(...(seq === undefined || table.startsWith('tool_output') || table === 'events' ? [sessionId] : [sessionId, seq])) as { n: number }).n;
const counts = (db: Database.Database, tables: readonly string[], sessionId: string, seq?: number) =>
  Object.fromEntries(tables.map((table) => [table, count(db, table, sessionId, seq)]));

test('v100 to v101 records retirements, indexes every child key a delete looks up, and rewrites the guards to read the record', () => {
  const db = new Database(path.join(TMP_HOME, 'v100-to-v101.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 100);
    const live = seedTurn(db, 'live-chat', 1);
    setConversationState(db, 'live-chat', 'full', null);
    const tables = ['sessions', 'events', 'session_conversation_state', ...KEPT, ...WORKING];
    const rows = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const priorVersions = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    const unrelated = `sql IS NOT NULL AND name NOT LIKE '%_delete_immutable' AND name NOT LIKE 'retired_turn_work_records%'
      AND name NOT LIKE 'idx_%_result_handle' AND name NOT LIKE 'idx_%_settlement' AND name NOT LIKE 'idx_%_handle'`;
    const otherObjects = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE ${unrelated} ORDER BY type, name`).all();

    schema.applyHarnessMigrationsThroughVersionForTests(db, 101);

    assert.ok(HARNESS_SCHEMA_VERSION >= 101);
    assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), rows);
    assert.deepEqual(db.prepare('SELECT * FROM schema_version WHERE version <= 100 ORDER BY version').all(), priorVersions);
    assert.deepEqual(db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE ${unrelated} ORDER BY type, name`).all(), otherObjects);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'retired_turn_work_records'").get());
    for (const trigger of GUARDS) {
      const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(trigger) as { sql: string } | undefined;
      assert.ok(row?.sql.includes('retired_turn_work_records'), `${trigger} reads the retirement record`);
      assert.ok(!row?.sql.includes("fidelity = 'memory'"), `${trigger} reads nothing else`);
    }
    for (const [table, column] of [['evidence_receipts', 'result_handle_id'], ['workflow_paginated_read_pages', 'result_handle_id'],
      ['write_evidence_dispatch_outcomes', 'result_handle_id'], ['async_read_refinement_intents', 'source_result_handle_id']]) {
      const indexed = (db.prepare(`SELECT i.name FROM pragma_index_list(?) i JOIN pragma_index_info(i.name) c WHERE c.name = ?`).all(table, column) as unknown[]).length;
      assert.ok(indexed > 0, `${table}.${column} is indexed`);
    }

    // Without a retirement record every guard still refuses, and a handle a
    // settlement still names cannot go.
    assert.throws(() => db.prepare('DELETE FROM logical_call_settlements WHERE session_id = ?').run('live-chat'), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM model_request_provenance WHERE session_id = ?').run('live-chat'), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM accepted_model_batch_admissions WHERE session_id = ?').run('live-chat'), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM durable_result_handles WHERE session_id = ?').run('live-chat'), /FOREIGN KEY/);
    // Retiring to memory alone no longer opens anything: the record does.
    setConversationState(db, 'live-chat', 'memory', NOW);
    assert.throws(() => db.prepare('DELETE FROM logical_call_settlements WHERE session_id = ?').run('live-chat'), /immutable/);
    assert.throws(() => db.prepare("INSERT INTO retired_turn_work_records VALUES ('no-such-session', 1, ?)").run(NOW), /FOREIGN KEY/);
    db.prepare('INSERT INTO retired_turn_work_records VALUES (?, ?, ?)').run('live-chat', live.seq, NOW);
    assert.equal(db.prepare('DELETE FROM logical_call_settlements WHERE session_id = ?').run('live-chat').changes, 1);
    assert.equal(db.prepare('DELETE FROM durable_result_handles WHERE session_id = ?').run('live-chat').changes, 1);
    assert.equal(db.prepare('DELETE FROM model_request_provenance WHERE session_id = ?').run('live-chat').changes, 1);
    assert.equal(db.prepare('DELETE FROM accepted_model_batch_admissions WHERE session_id = ?').run('live-chat').changes, 1);
    assert.equal(count(db, 'accepted_model_batch_checkpoints', 'live-chat'), 0);
    assert.deepEqual(counts(db, KEPT, 'live-chat'), { events: 3, accepted_turn_call_authorities: 1, logical_tool_calls: 1, physical_dispatches: 1 });
  } finally { db.close(); }
});

test('a retired chat sheds every turn; a long-lived session sheds a finished turn after thirty days; held, young and live turns keep theirs', () => {
  const db = log.openEventLog();
  db.pragma('foreign_keys = ON');
  const nowMs = Date.parse(NOW);

  // A chat retired to memory two days ago, with two turns.
  seedTurn(db, 'retired-chat', 1, { openedAt: daysAgo(60) });
  seedTurn(db, 'retired-chat', 2, { openedAt: daysAgo(45) });
  setConversationState(db, 'retired-chat', 'memory', daysAgo(2));
  // Retired this morning: inside the grace window.
  seedTurn(db, 'retired-young', 1);
  setConversationState(db, 'retired-young', 'memory', daysAgo(0.5));
  // In use.
  seedTurn(db, 'still-full', 1);
  setConversationState(db, 'still-full', 'full', null);
  // A watch: no conversation state, a closed turn from six weeks ago and one from last week.
  const old = seedTurn(db, 'watch:inbox', 1, { kind: 'workflow', authorityState: 'closed', openedAt: daysAgo(42) });
  const recent = seedTurn(db, 'watch:inbox', 2, { kind: 'workflow', authorityState: 'closed', openedAt: daysAgo(7) });
  // A workflow turn closed long ago whose run is still open: not a candidate.
  const running = seedTurn(db, 'workflow:nightly', 1, { kind: 'workflow', authorityState: 'closed', openedAt: daysAgo(42) });
  db.prepare(`INSERT INTO run_attempts (attempt_id, session_id, run_id, started_at, status, source_user_seq)
    VALUES ('nightly-attempt', 'workflow:nightly', 'nightly-run', ?, 'active', ?)`).run(NOW, running.seq);
  // A pinned workspace: held whole.
  seedTurn(db, 'workspace:pinned', 1, { kind: 'workflow', authorityState: 'closed', openedAt: daysAgo(42), metadata: '{"pinned":true}' });
  // A turn still open: never a candidate.
  seedTurn(db, 'workflow:open', 1, { kind: 'workflow', authorityState: 'open', openedAt: daysAgo(42) });

  const decayed = lifecycle.decayRetiredConversationWorkRecords({ nowMs, budgetMs: 60_000 });
  assert.deepEqual(decayed, { sessions: 1, turns: 1, admissions: 3, checkpoints: 3, objects: 0, handles: 3, settlements: 3, provenance: 3, toolOutputs: 6, held: 1, heldBy: { pinned: 1 } });

  for (const table of WORKING) assert.equal(count(db, table, 'retired-chat'), 0, `retired-chat sheds ${table}`);
  assert.deepEqual(counts(db, KEPT, 'retired-chat'), { events: 6, accepted_turn_call_authorities: 2, logical_tool_calls: 2, physical_dispatches: 2 });
  assert.ok(db.prepare("SELECT 1 FROM session_conversation_state WHERE session_id = 'retired-chat' AND fidelity = 'memory'").get(), 'the retired state itself stays');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM retired_turn_work_records WHERE session_id = 'retired-chat'").get() as { n: number }).n, 2, 'both turns are recorded retired');
  for (const table of WORKING.filter((name) => !name.startsWith('tool_output'))) {
    assert.equal(count(db, table, 'watch:inbox', old.seq), 0, `the old watch turn sheds ${table}`);
    assert.equal(count(db, table, 'watch:inbox', recent.seq), 1, `the recent watch turn keeps ${table}`);
  }
  assert.equal(count(db, 'tool_outputs', 'watch:inbox'), 1, 'only the old turn\'s output went');
  assert.equal((db.prepare('SELECT call_id FROM tool_outputs WHERE session_id = ?').get('watch:inbox') as { call_id: string }).call_id, recent.call);
  assert.deepEqual(counts(db, KEPT, 'watch:inbox'), { events: 6, accepted_turn_call_authorities: 2, logical_tool_calls: 2, physical_dispatches: 2 });
  for (const kept of ['retired-young', 'still-full', 'workflow:nightly', 'workspace:pinned', 'workflow:open']) {
    for (const table of WORKING) assert.equal(count(db, table, kept), 1, `${kept} keeps ${table}`);
  }
  assert.equal(count(db, 'durable_result_handles', 'workflow:nightly', running.seq), 1);

  // The same pass again finds nothing to do.
  assert.deepEqual(lifecycle.decayRetiredConversationWorkRecords({ nowMs, budgetMs: 60_000 }), { sessions: 0, turns: 0, admissions: 0, checkpoints: 0, objects: 0, handles: 0, settlements: 0, provenance: 0, toolOutputs: 0, held: 1, heldBy: { pinned: 1 } });
});
