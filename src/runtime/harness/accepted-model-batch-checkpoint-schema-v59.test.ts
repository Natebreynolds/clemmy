/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/accepted-model-batch-checkpoint-schema-v59.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-model-batch-v59-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

const NOW = '2026-08-23T12:00:00.000Z';
const digest = (character: string) => character.repeat(64);

function seedOpenHostRootAtV58(db: Database.Database) {
  const sessionId = 'v59-model-batch-session';
  db.prepare(`
    INSERT INTO sessions
      (id, kind, created_at, updated_at, status, metadata_json)
    VALUES (?, 'chat', ?, ?, 'active', '{}')
  `).run(sessionId, NOW, NOW);
  const inserted = db.prepare(`
    INSERT INTO events
      (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES ('v59-source', ?, 1, 'user', 'user_input_received', NULL,
            '{"text":"continue the exact task"}', ?)
  `).run(sessionId, NOW);
  const sourceUserSeq = Number(inserted.lastInsertRowid);
  const acceptedTaskId = `task:${sessionId}#${sourceUserSeq}`;
  db.prepare(`
    INSERT INTO accepted_turn_call_authorities
      (session_id, source_user_seq, accepted_task_id, authority_protocol,
       authority_kind, source_event_id, source_event_digest, source_turn,
       engine_version, surface_version, surface_digest, effect_ceiling,
       effect_bounds_json, max_logical_calls, max_parallel_calls,
       catalog_revision_digest, binding_revision_digest,
       authority_digest, state, revision, opened_at)
    VALUES (?, ?, ?, 1, 'host_v1', 'v59-source', ?, 1,
            'host_v1', 'configured_harness_capability_surface_v1', ?, 'admin',
            '["admin","compute","external_write","host_only","local_write","read"]',
            8, 4, ?, ?, ?, 'open', 0, ?)
  `).run(
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    digest('a'),
    digest('b'),
    digest('c'),
    digest('d'),
    digest('e'),
    NOW,
  );
  return { sessionId, sourceUserSeq, acceptedTaskId };
}

function insertAdmission(db: Database.Database, input: ReturnType<typeof seedOpenHostRootAtV58>, options: {
  ordinal?: number;
  batchId?: string;
  authorityDigest?: string;
  preHistoryDigest?: string;
  previousResponseId?: string | null;
} = {}): void {
  const ordinal = options.ordinal ?? 1;
  db.prepare(`
    INSERT INTO accepted_model_batch_admissions
      (session_id, source_user_seq, accepted_task_id, batch_ordinal,
       batch_id, protocol_version, authority_digest, source_event_digest,
       source_turn, engine_version, graph_event_id, graph_hash,
       work_contract_id, previous_response_id, provider_response_id,
       accepted_response_digest, pre_history_json, pre_history_digest,
       pre_history_item_count, frame_history_json, frame_history_digest,
       frame_history_item_count, call_ids_json, call_count, admitted_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, 'host_v1', NULL, NULL, NULL,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    input.sessionId,
    input.sourceUserSeq,
    input.acceptedTaskId,
    ordinal,
    options.batchId ?? digest(String(ordinal)),
    options.authorityDigest ?? digest('e'),
    digest('a'),
    options.previousResponseId ?? null,
    `response-${ordinal}`,
    digest('f'),
    ordinal === 1 ? '[{"role":"user","content":"continue the exact task"}]' : '[{"role":"user","content":"continued"}]',
    options.preHistoryDigest ?? (ordinal === 1 ? digest('1') : digest('6')),
    1,
    `[{"type":"function_call","callId":"call-${ordinal}","name":"generic_tool","arguments":"{}"}]`,
    digest('2'),
    1,
    `["call-${ordinal}"]`,
    NOW,
  );
}

function insertCheckpoint(
  db: Database.Database,
  input: ReturnType<typeof seedOpenHostRootAtV58>,
  ordinal = 1,
): void {
  db.prepare(`
    INSERT INTO accepted_model_batch_checkpoints
      (session_id, source_user_seq, accepted_task_id, batch_ordinal,
       batch_id, protocol_version, authority_digest, graph_event_id,
       graph_hash, work_contract_id, disposition, history_json,
       history_digest, history_item_count, last_response_id, committed_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL, 'ready', ?, ?, 3, ?, ?)
  `).run(
    input.sessionId,
    input.sourceUserSeq,
    input.acceptedTaskId,
    ordinal,
    digest(String(ordinal)),
    digest('e'),
    '[{"role":"user","content":"continue the exact task"},{"type":"function_call","callId":"call-1","name":"generic_tool","arguments":"{}"},{"type":"function_call_result","callId":"call-1","name":"generic_tool","status":"completed","output":{"type":"text","text":"ok"}}]',
    digest('6'),
    `response-${ordinal}`,
    NOW,
  );
}

test('v58 to v59 adds append-only exact batch admissions/checkpoints without rewriting durable rows', () => {
  const db = new Database(path.join(TMP_HOME, 'v58-to-v59.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 58);
    const root = seedOpenHostRootAtV58(db);
    const before = {
      sessions: db.prepare(`SELECT * FROM sessions WHERE id = ?`).all(root.sessionId),
      events: db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY seq`).all(root.sessionId),
      roots: db.prepare(`SELECT * FROM accepted_turn_call_authorities WHERE session_id = ?`).all(root.sessionId),
    };

    schema.applyHarnessMigrations(db);

    assert.deepEqual({
      sessions: db.prepare(`SELECT * FROM sessions WHERE id = ?`).all(root.sessionId),
      events: db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY seq`).all(root.sessionId),
      roots: db.prepare(`SELECT * FROM accepted_turn_call_authorities WHERE session_id = ?`).all(root.sessionId),
    }, before);
    assert.equal((db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as {
      version: number;
    }).version, HARNESS_SCHEMA_VERSION);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM accepted_model_batch_admissions`).get() as { n: number }).n, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM accepted_model_batch_checkpoints`).get() as { n: number }).n, 0);

    insertAdmission(db, root);
    assert.throws(
      () => insertAdmission(db, root, {
        ordinal: 2,
        batchId: digest('2'),
        preHistoryDigest: digest('6'),
        previousResponseId: 'response-1',
      }),
      /exact prior balanced checkpoint/,
      'a later model response cannot pass an uncheckpointed batch',
    );
    insertCheckpoint(db, root);
    insertAdmission(db, root, {
      ordinal: 2,
      batchId: digest('2'),
      preHistoryDigest: digest('6'),
      previousResponseId: 'response-1',
    });
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM accepted_model_batch_admissions`).get() as { n: number }).n, 2);
    insertCheckpoint(db, root, 2);

    assert.throws(
      () => insertAdmission(db, root, {
        ordinal: 3,
        batchId: digest('3'),
        authorityDigest: digest('9'),
        preHistoryDigest: digest('6'),
        previousResponseId: 'response-2',
      }),
      /exact (open host call root|prior balanced checkpoint)/,
    );
    assert.throws(
      () => db.prepare(`UPDATE accepted_model_batch_admissions SET admitted_at = ? WHERE batch_ordinal = 1`).run(NOW),
      /append-only/,
    );
    assert.throws(
      () => db.prepare(`DELETE FROM accepted_model_batch_checkpoints WHERE batch_ordinal = 1`).run(),
      /append-only/,
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);

    const frozenSchema = db.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name LIKE 'accepted_model_batch_%'
          OR name LIKE 'trg_accepted_model_batch_%'
       ORDER BY type, name
    `).all();
    const frozenVersions = db.prepare(`SELECT * FROM schema_version ORDER BY version`).all();
    schema.applyHarnessMigrations(db);
    assert.deepEqual(db.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name LIKE 'accepted_model_batch_%'
          OR name LIKE 'trg_accepted_model_batch_%'
       ORDER BY type, name
    `).all(), frozenSchema);
    assert.deepEqual(db.prepare(`SELECT * FROM schema_version ORDER BY version`).all(), frozenVersions);
  } finally {
    db.close();
  }
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
