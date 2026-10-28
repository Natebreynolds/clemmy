/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/storage-decay.test.ts
 *
 * The storage decay worker sheds a retired conversation's working records
 * and the event log's old diagnostic rows on its own connection.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-storage-decay-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const log = await import('./harness/eventlog.js');
const decay = await import('./storage-decay.js');

const NOW = Date.now();
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const digest = (character: string) => character.repeat(64);

after(() => { log.closeEventLog(); rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a pass sheds a retired chat\'s provenance and outputs and the old diagnostic rows, and leaves the transcript', async () => {
  const db = log.openEventLog();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO sessions (id, kind, created_at, updated_at, status, metadata_json) VALUES ('retired', 'chat', ?, ?, 'active', '{}')`).run(daysAgo(60), daysAgo(40));
  const seq = Number(db.prepare(`INSERT INTO events (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES ('retired-source', 'retired', 1, 'user', 'user_input_received', NULL, '{"text":"hello"}', ?)`).run(daysAgo(60)).lastInsertRowid);
  db.prepare(`INSERT INTO model_request_provenance (record_id, session_id, source_user_seq, source_event_id, request_ordinal, protocol_version, boundary,
      normalized_request_digest, host_projection_digest, provenance_digest, provenance_json, payload_id, payload_binding_digest, payload_reference_json, created_at)
    VALUES ('prov-1', 'retired', ?, 'retired-source', 1, 1, 'layered', ?, ?, ?, '{}', 'authority-payload:p1', ?, '{}', ?)`).run(seq, digest('8'), digest('9'), digest('0'), digest('a'), daysAgo(60));
  db.prepare('INSERT INTO tool_outputs (session_id, call_id, output_full, content_bytes, created_at) VALUES (?, ?, ?, 4, ?)').run('retired', 'call-1', 'done', daysAgo(60));
  db.prepare(`INSERT INTO session_conversation_state (session_id, state_json, fidelity, memory_episode_id, updated_at, compacted_at)
    VALUES ('retired', '{"items":[]}', 'memory', NULL, ?, ?)`).run(daysAgo(40), daysAgo(2));
  for (let n = 0; n < 3; n++) {
    db.prepare(`INSERT INTO events (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
      VALUES (?, 'retired', 1, 'system', 'guardrail_tripped', NULL, '{}', ?)`).run(`guard-${n}`, daysAgo(45 - n));
  }
  db.prepare(`INSERT INTO events (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES ('guard-fresh', 'retired', 1, 'system', 'guardrail_tripped', NULL, '{}', ?)`).run(daysAgo(1));

  const pass = await decay.runStorageDecayPass(log.HARNESS_DB_PATH, { budgetMs: 10_000 });
  assert.equal(pass.state, 'processed', JSON.stringify(pass));
  if (pass.state !== 'processed') return;
  assert.equal(pass.decay.sessions, 1);
  assert.equal(pass.decay.provenance, 1);
  assert.equal(pass.decay.toolOutputs, 1);
  assert.deepEqual(pass.diagnostics, { removed: 3, pinned: 0, caughtUp: true });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'retired'").get() as { n: number }).n, 2, 'the transcript and the fresh diagnostic stay');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM model_request_provenance").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tool_outputs").get() as { n: number }).n, 0);
  assert.ok(db.prepare("SELECT 1 FROM retired_turn_work_records WHERE session_id = 'retired'").get(), 'the retirement is recorded');

  // The next pass finds nothing to do.
  const again = await decay.runStorageDecayPass(log.HARNESS_DB_PATH, { budgetMs: 10_000 });
  assert.equal(again.state, 'processed');
  if (again.state === 'processed') { assert.equal(again.decay.sessions, 0); assert.equal(again.diagnostics.removed, 0); }
});
