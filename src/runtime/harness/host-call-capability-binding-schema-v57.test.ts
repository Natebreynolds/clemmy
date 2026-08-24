/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-call-capability-binding-schema-v57.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-binding-v57-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

function schemaRows(db: Database.Database): unknown[] {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_master
     WHERE name = 'host_call_capability_bindings'
        OR name LIKE 'trg_host_call_capability_binding_%'
        OR name = 'idx_host_call_capability_provider'
        OR name = 'trg_plan_task_activation_receipt_exact_insert'
     ORDER BY type, name
  `).all();
}

test('v56 to v57 adds an empty exact host binding wall, refreshes recovery, and is idempotent', () => {
  const db = new Database(path.join(TMP_HOME, 'v56-to-v57.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 56);
    assert.equal((db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as {
      version: number;
    }).version, 56);
    assert.equal(db.prepare(`
      SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name = 'host_call_capability_bindings'
    `).get(), undefined, 'v56 contains no authority the old runtime never persisted');

    const now = '2026-08-23T12:00:00.000Z';
    db.prepare(`
      INSERT INTO sessions
        (id, kind, created_at, updated_at, status, metadata_json)
      VALUES ('historical-v56', 'chat', ?, ?, 'completed', '{"frozen":true}')
    `).run(now, now);
    db.prepare(`
      INSERT INTO events
        (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
      VALUES ('historical-v56-source', 'historical-v56', 1, 'user',
              'user_input_received', NULL, '{"text":"historical"}', ?)
    `).run(now);
    const historicalBefore = {
      sessions: db.prepare(`SELECT * FROM sessions WHERE id = 'historical-v56'`).all(),
      events: db.prepare(`SELECT * FROM events WHERE session_id = 'historical-v56'`).all(),
    };

    schema.applyHarnessMigrations(db);

    assert.deepEqual({
      sessions: db.prepare(`SELECT * FROM sessions WHERE id = 'historical-v56'`).all(),
      events: db.prepare(`SELECT * FROM events WHERE session_id = 'historical-v56'`).all(),
    }, historicalBefore, 'v57 does not reinterpret or rewrite historical bytes');
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM host_call_capability_bindings`).get() as {
      count: number;
    }).count, 0, 'migration never manufactures a binding for historical calls');

    const columns = (db.prepare(`PRAGMA table_info(host_call_capability_bindings)`).all() as Array<{
      name: string;
    }>).map((column) => column.name);
    assert.deepEqual(columns, [
      'protocol_version', 'root_authority_kind', 'root_graph_event_id',
      'root_graph_hash', 'session_id', 'source_user_seq', 'accepted_task_id',
      'source_event_id', 'source_event_digest', 'logical_tool_call_id', 'tool_name',
      'attested_argument_digest', 'logical_raw_argument_digest',
      'bound_effective_argument_digest', 'effect', 'binding_kind', 'capability_id',
      'provider_input_schema_digest', 'schema_fingerprint', 'account_id',
      'invoke_port_id', 'operation_id', 'manifest_id', 'manifest_digest',
      'host_binding_digest', 'engine_version', 'surface_version', 'authority_digest',
      'authority_revision', 'surface_digest', 'catalog_revision_digest',
      'binding_revision_digest', 'durable_binding_digest', 'bound_at',
    ]);
    const parents = new Set((db.prepare(`PRAGMA foreign_key_list(host_call_capability_bindings)`).all() as Array<{
      table: string;
    }>).map((row) => row.table));
    assert.deepEqual([...parents].sort(), [
      'accepted_turn_call_authorities',
      'events',
      'logical_tool_calls',
    ]);
    const rootTrigger = db.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'trg_host_call_capability_binding_root_exact'
    `).get() as { sql: string };
    const tableSql = db.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = 'host_call_capability_bindings'
    `).get() as { sql: string };
    assert.match(tableSql.sql, /root_authority_kind\s+TEXT NOT NULL CHECK \(root_authority_kind = 'host_v1'\)/);
    assert.match(tableSql.sql, /root_graph_event_id IS NULL AND root_graph_hash IS NULL/);
    assert.match(rootTrigger.sql, /root\.authority_kind = 'host_v1'/);
    assert.match(rootTrigger.sql, /NEW\.root_authority_kind = 'host_v1'/);
    assert.match(rootTrigger.sql, /root\.graph_event_id IS NEW\.root_graph_event_id/);
    assert.match(rootTrigger.sql, /root\.graph_hash IS NEW\.root_graph_hash/);
    const trigger = db.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'trg_plan_task_activation_receipt_exact_insert'
    `).get() as { sql: string };
    assert.match(trigger.sql, /call\.state = 'settled'/,
      'v57 refreshes the send-before-receipt crash-recovery branch');
    assert.match(trigger.sql, /call\.state = 'open'/,
      'v57 preserves the ordinary live delivery branch');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    assert.equal((db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as {
      version: number;
    }).version, HARNESS_SCHEMA_VERSION);

    const frozenSchema = schemaRows(db);
    const frozenVersions = db.prepare(`SELECT version, applied_at FROM schema_version ORDER BY version`).all();
    schema.applyHarnessMigrations(db);
    assert.deepEqual(schemaRows(db), frozenSchema, 'reopening current v57 does not rewrite its walls');
    assert.deepEqual(
      db.prepare(`SELECT version, applied_at FROM schema_version ORDER BY version`).all(),
      frozenVersions,
      'reopening current v57 appends no migration receipt',
    );
  } finally {
    db.close();
  }
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
