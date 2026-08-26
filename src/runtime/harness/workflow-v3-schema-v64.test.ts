/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/workflow-v3-schema-v64.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-v3-schema-v64-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

test.after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function insertPopulatedV63Root(db: Database.Database): void {
  const now = '2026-08-25T12:00:00.000Z';
  db.prepare(`
    INSERT INTO sessions (
      id, kind, channel, user_id, created_at, updated_at, status,
      title, objective, token_budget, tokens_used, current_plan_id, metadata_json
    ) VALUES ('v64-populated', 'chat', NULL, NULL, ?, ?, 'active', NULL, NULL, NULL, 0, NULL, '{}')
  `).run(now, now);
  db.prepare(`
    INSERT INTO events (
      seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at
    ) VALUES (1, 'v64-source', 'v64-populated', 1, 'user', 'user_input_received', NULL,
              '{"text":"retain me"}', ?)
  `).run(now);
  const sourceEventDigest = schema.acceptedTurnSourceEventDigest({
    id: 'v64-source',
    sessionId: 'v64-populated',
    seq: 1,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    parentEventId: null,
    dataJson: '{"text":"retain me"}',
    createdAt: now,
  });
  const surfaceDigest = schema.acceptedTurnCallSurfaceDigest({
    authorityKind: 'host_v1_read_only',
    engineVersion: 'host_v1_read_only',
    surfaceVersion: 'schema_v64_rehearsal',
    effectCeiling: 'read_compute_host_only',
    effectBoundsJson: '["compute","host_only","read"]',
    maxLogicalCalls: 1,
    maxParallelCalls: 1,
    catalogRevisionDigest: SHA_A,
    bindingRevisionDigest: SHA_B,
    graphEventId: null,
    graphHash: null,
  });
  const authorityDigest = schema.acceptedTurnCallAuthorityDigest({
    authorityKind: 'host_v1_read_only',
    sessionId: 'v64-populated',
    sourceUserSeq: 1,
    acceptedTaskId: 'task:v64-populated#1',
    sourceEventId: 'v64-source',
    sourceEventDigest,
    sourceTurn: 1,
    engineVersion: 'host_v1_read_only',
    surfaceVersion: 'schema_v64_rehearsal',
    surfaceDigest,
    effectCeiling: 'read_compute_host_only',
    effectBoundsJson: '["compute","host_only","read"]',
    maxLogicalCalls: 1,
    maxParallelCalls: 1,
    catalogRevisionDigest: SHA_A,
    bindingRevisionDigest: SHA_B,
    graphEventId: null,
    graphHash: null,
  });
  db.prepare(`
    INSERT INTO accepted_turn_call_authorities (
      session_id, source_user_seq, accepted_task_id, authority_protocol,
      authority_kind, source_event_id, source_event_digest, source_turn,
      engine_version, surface_version, surface_digest, effect_ceiling,
      effect_bounds_json, max_logical_calls, max_parallel_calls,
      catalog_revision_digest, binding_revision_digest, graph_event_id,
      graph_hash, authority_digest, state, revision, opened_at
    ) VALUES (
      'v64-populated', 1, 'task:v64-populated#1', 1,
      'host_v1_read_only', 'v64-source', ?, 1,
      'host_v1_read_only', 'schema_v64_rehearsal', ?, 'read_compute_host_only',
      '["compute","host_only","read"]', 1, 1,
      ?, ?, NULL, NULL, ?, 'open', 0, ?
    )
  `).run(sourceEventDigest, surfaceDigest, SHA_A, SHA_B, authorityDigest, now);
  db.prepare(`
    INSERT INTO logical_tool_calls (
      session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
      tool_name, argument_digest, raw_argument_digest, state, opened_at
    ) VALUES (
      'v64-populated', 1, 'task:v64-populated#1', 'logical-v64',
      'session_history', ?, ?, 'open', ?
    )
  `).run(SHA_C, SHA_C, now);
}

function assertForgedBindingRefused(db: Database.Database): void {
  assert.throws(() => db.prepare(`
    INSERT INTO workflow_v3_call_activation_bindings (
      activation_id, session_id, authority_binding_digest,
      requirement_id, logical_capability_id, effect,
      canonical_argument_digest, source_argument_digest, obligation_digest,
      capability_id, manifest_id, manifest_digest, operation_id,
      operation_version, schema_digest, provider_version, live_fingerprint,
      account_id, invoke_port_id, argument_compiler_id,
      argument_compiler_version, activated_at
    ) VALUES (
      'forged-activation', 'v64-populated', ?, 'requirement.forged',
      'logical.forged', 'external_write', ?, ?, ?, 'capability.forged',
      'manifest.forged', ?, 'operation.forged', '1', ?, 'provider.1', ?,
      'account.forged', 'port.forged', 'compiler.forged', '1',
      '2026-08-25T12:00:00.000Z'
    )
  `).run(SHA_A, SHA_A, SHA_A, SHA_A, SHA_A, SHA_A, SHA_A),
  /clementine_workflow_v3_binding_admitted_v1|opaque activation admission|FOREIGN KEY/);
}

test('populated v63 upgrades to v64 without rewriting roots/children/FKs and retires partial lookalikes', () => {
  const db = new Database(path.join(TEST_HOME, 'populated-v63.db'));
  db.pragma('foreign_keys = ON');
  schema.applyHarnessMigrationsThroughVersionForTests(db, 63);
  insertPopulatedV63Root(db);
  const rootBefore = JSON.stringify(db.prepare(`
    SELECT * FROM accepted_turn_call_authorities ORDER BY session_id, source_user_seq
  `).all());
  const logicalBefore = JSON.stringify(db.prepare(`
    SELECT * FROM logical_tool_calls ORDER BY session_id, source_user_seq, logical_tool_call_id
  `).all());
  const logicalFksBefore = JSON.stringify(db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all());

  // v63 had no sanctioned object by this name. A partial local experiment is
  // deliberately retired, never promoted by the migration.
  db.exec(`
    CREATE TABLE workflow_v3_call_activation_bindings (activation_id TEXT PRIMARY KEY, payload TEXT);
    INSERT INTO workflow_v3_call_activation_bindings VALUES ('partial-forged', '{"copyable":true}');
  `);

  schema.applyHarnessMigrations(db);
  assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, HARNESS_SCHEMA_VERSION);
  assert.equal(JSON.stringify(db.prepare(`
    SELECT * FROM accepted_turn_call_authorities ORDER BY session_id, source_user_seq
  `).all()), rootBefore);
  assert.equal(JSON.stringify(db.prepare(`
    SELECT * FROM logical_tool_calls ORDER BY session_id, source_user_seq, logical_tool_call_id
  `).all()), logicalBefore);
  assert.equal(JSON.stringify(db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all()), logicalFksBefore);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workflow_v3_call_activation_bindings').get() as { n: number }).n, 0);
  assert.equal(db.pragma('foreign_key_check').length, 0);
  assert.match((db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accepted_turn_call_authorities'
  `).get() as { sql: string }).sql, /workflow_v3_call/);
  assertForgedBindingRefused(db);
  db.close();
});

test('fresh v64 installs the exact immutable binding/root schema and refuses partial SQL authority', () => {
  const db = new Database(path.join(TEST_HOME, 'fresh-v64.db'));
  db.pragma('foreign_keys = ON');
  schema.applyHarnessMigrations(db);
  const columns = (db.prepare('PRAGMA table_info(workflow_v3_call_activation_bindings)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  assert.deepEqual(columns, [
    'activation_id', 'session_id', 'authority_binding_digest',
    'requirement_id', 'logical_capability_id', 'effect',
    'canonical_argument_digest', 'source_argument_digest', 'obligation_digest',
    'capability_id', 'manifest_id', 'manifest_digest', 'operation_id',
    'operation_version', 'schema_digest', 'provider_version', 'live_fingerprint',
    'account_id', 'invoke_port_id', 'argument_compiler_id',
    'argument_compiler_version', 'activated_at',
  ]);
  const triggers = (db.prepare(`
    SELECT name, sql FROM sqlite_master
     WHERE type = 'trigger' AND tbl_name = 'workflow_v3_call_activation_bindings'
     ORDER BY name
  `).all() as Array<{ name: string; sql: string }>);
  assert.deepEqual(triggers.map((entry) => entry.name), [
    'trg_workflow_v3_call_binding_delete_immutable',
    'trg_workflow_v3_call_binding_exact_activation',
    'trg_workflow_v3_call_binding_immutable',
  ]);
  assert.match(triggers.find((entry) => entry.name.endsWith('exact_activation'))!.sql,
    /clementine_workflow_v3_binding_admitted_v1/);
  db.prepare(`
    INSERT INTO sessions (
      id, kind, created_at, updated_at, status, tokens_used, metadata_json
    ) VALUES ('v64-populated', 'workflow', '2026-08-25T12:00:00.000Z',
              '2026-08-25T12:00:00.000Z', 'active', 0, '{}')
  `).run();
  assertForgedBindingRefused(db);
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
});
