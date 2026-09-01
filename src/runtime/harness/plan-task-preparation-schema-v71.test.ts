/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/plan-task-preparation-schema-v71.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-checkpoint-v71-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');
const coexistence = await import('./host-planned-resolution-coexistence.js');
const settlement = await import('./plan-task-post-settlement.js');
const eventlog = await import('./eventlog.js');

const NOW = '2026-08-30T12:00:00.000Z';
const digest = (character: string): string => character.repeat(64);
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

interface PreparedFixture {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  graphEventId: string;
  graphId: string;
  graphHash: string;
  contractId: string;
  logicalCallIds: string[];
  argumentDigest: string;
  preambleEventId: string;
  preambleEventDigest: string;
  deliveryKey: string;
}

function seedPreparedV70(
  db: Database.Database,
  label: string,
  logicalCallCount: 1 | 2,
): PreparedFixture {
  const sessionId = `v71-${label}`;
  db.prepare(`
    INSERT INTO sessions (id, kind, created_at, updated_at, status, metadata_json)
    VALUES (?, 'chat', ?, ?, 'active', '{}')
  `).run(sessionId, NOW, NOW);
  const sourceEventId = `${label}-source`;
  const sourceInsert = db.prepare(`
    INSERT INTO events
      (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, 1, 'user', 'user_input_received', NULL, ?, ?)
  `).run(sourceEventId, sessionId, JSON.stringify({ text: 'Create the exact workspace.' }), NOW);
  const sourceUserSeq = Number(sourceInsert.lastInsertRowid);
  const acceptedTaskId = `task:${sessionId}#${sourceUserSeq}`;
  const graphEventId = `${label}-graph-event`;
  const graphId = `${label}-graph`;
  const graphHash = sha256(`${label}:graph`);
  db.prepare(`
    INSERT INTO events
      (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, 1, 'system', 'turn_graph_compiled', ?, ?, ?)
  `).run(graphEventId, sessionId, sourceEventId, JSON.stringify({
    route: 'act',
    sourceUserSeq,
    graphId,
    graphHash,
  }), '2026-08-30T12:00:00.500Z');
  const preambleEventId = `${label}-preamble`;
  const preambleData = {
    version: 1,
    kind: 'pre_execution',
    sourceUserSeq,
    text: 'I’ll create the exact workspace now.',
  };
  const preambleInsert = db.prepare(`
    INSERT INTO events
      (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, 1, 'Clem', 'conversation_preamble', ?, ?, ?)
  `).run(
    preambleEventId,
    sessionId,
    sourceEventId,
    JSON.stringify(preambleData),
    '2026-08-30T12:00:01.000Z',
  );
  const preambleSeq = Number(preambleInsert.lastInsertRowid);
  const preambleEventDigest = sha256(JSON.stringify({
    version: 1,
    seq: preambleSeq,
    id: preambleEventId,
    sessionId,
    turn: 1,
    role: 'Clem',
    type: 'conversation_preamble',
    parentEventId: sourceEventId,
    data: preambleData,
    createdAt: '2026-08-30T12:00:01.000Z',
  }));
  const deliveryKey = `preamble-delivery:v1:${sha256(JSON.stringify({
    version: 1,
    eventId: preambleEventId,
    eventDigest: preambleEventDigest,
  }))}`;

  db.prepare(`
    INSERT INTO accepted_turn_call_authorities
      (session_id, source_user_seq, accepted_task_id, authority_protocol,
       authority_kind, source_event_id, source_event_digest, source_turn,
       engine_version, surface_version, surface_digest, effect_ceiling,
       effect_bounds_json, max_logical_calls, max_parallel_calls,
       catalog_revision_digest, binding_revision_digest, authority_digest,
       state, revision, opened_at)
    VALUES (?, ?, ?, 1, 'host_v1', ?, ?, 1, 'host_v1',
            'configured_harness_capability_surface_v1', ?, 'admin',
            '["admin","compute","external_write","host_only","local_write","read"]',
            8, 4, ?, ?, ?, 'open', 0, ?)
  `).run(
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    sourceEventId,
    sha256(`${label}:source`),
    sha256(`${label}:surface`),
    sha256(`${label}:catalog`),
    sha256(`${label}:bindings`),
    sha256(`${label}:authority`),
    NOW,
  );
  db.prepare(`
    INSERT INTO accepted_task_authority
      (session_id, source_user_seq, accepted_task_id, authority_protocol,
       graph_event_id, graph_id, graph_hash, state, armed_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, 'armed', ?, ?)
  `).run(
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    graphEventId,
    graphId,
    graphHash,
    NOW,
    NOW,
  );
  const contractId = `expected-work:v1:${sha256(`${label}:contract`)}`;
  db.prepare(`
    INSERT INTO accepted_task_work_contracts
      (session_id, source_user_seq, accepted_task_id, contract_version,
       contract_id, graph_event_id, graph_id, graph_hash, planner_source,
       contract_json, operation_count, universe_count, fixed_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'structured_model', '{}', 0, 0, ?)
  `).run(
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    contractId,
    graphEventId,
    graphId,
    graphHash,
    NOW,
  );
  db.prepare(`
    UPDATE accepted_task_authority SET work_contract_id = ?
     WHERE session_id = ? AND source_user_seq = ?
  `).run(contractId, sessionId, sourceUserSeq);

  const argumentDigest = sha256(`${label}:plan-args`);
  const logicalCallIds = Array.from({ length: logicalCallCount }, (_, index) => `${label}-plan-${index + 1}`);
  for (const logicalCallId of logicalCallIds) {
    db.prepare(`
      INSERT INTO logical_tool_calls
        (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
         tool_name, argument_digest, state, opened_at, raw_argument_digest)
      VALUES (?, ?, ?, ?, 'plan_task', ?, 'open', ?, ?)
    `).run(
      sessionId,
      sourceUserSeq,
      acceptedTaskId,
      logicalCallId,
      argumentDigest,
      NOW,
      argumentDigest,
    );
  }
  return {
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    graphEventId,
    graphId,
    graphHash,
    contractId,
    logicalCallIds,
    argumentDigest,
    preambleEventId,
    preambleEventDigest,
    deliveryKey,
  };
}

function insertV70DeliveryReceipt(db: Database.Database, fixture: PreparedFixture): void {
  const deliveryEventId = `${fixture.sessionId}-delivery`;
  const transportReceipt = {
    version: 1,
    deliveryKey: fixture.deliveryKey,
    eventId: fixture.preambleEventId,
    eventDigest: fixture.preambleEventDigest,
    surface: 'channel_message',
    target: 'durable_conversation',
  };
  const transportReceiptDigest = sha256(JSON.stringify(transportReceipt));
  const deliveryData = {
    version: 1,
    sourceUserSeq: fixture.sourceUserSeq,
    acceptedTaskId: fixture.acceptedTaskId,
    logicalToolCallId: fixture.logicalCallIds[0],
    planArgumentDigest: fixture.argumentDigest,
    preambleEventId: fixture.preambleEventId,
    preambleEventDigest: fixture.preambleEventDigest,
    deliveryKey: fixture.deliveryKey,
    deliveryStatus: 'delivered',
    transportReceipt,
    transportReceiptDigest,
  };
  db.prepare(`
    INSERT INTO events
      (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, 1, 'system', 'conversation_preamble_delivered', ?, ?, ?)
  `).run(
    deliveryEventId,
    fixture.sessionId,
    fixture.preambleEventId,
    JSON.stringify(deliveryData),
    '2026-08-30T12:00:02.000Z',
  );
  db.prepare(`
    INSERT INTO ${coexistence.PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       receipt_version, plan_argument_digest, graph_event_id, graph_id,
       graph_hash, contract_id, preamble_event_id, preamble_event_digest,
       delivery_key, delivery_event_id, delivery_status, delivery_reason,
       transport_receipt_json, transport_receipt_digest, transport_target,
       recorded_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', NULL,
            ?, ?, 'durable_conversation', ?)
  `).run(
    fixture.sessionId,
    fixture.sourceUserSeq,
    fixture.acceptedTaskId,
    fixture.logicalCallIds[0],
    fixture.argumentDigest,
    fixture.graphEventId,
    fixture.graphId,
    fixture.graphHash,
    fixture.contractId,
    fixture.preambleEventId,
    fixture.preambleEventDigest,
    fixture.deliveryKey,
    deliveryEventId,
    JSON.stringify(transportReceipt),
    transportReceiptDigest,
    '2026-08-30T12:00:02.000Z',
  );
}

test('v70 through current backfills exact v71 receipts, retains legacy ambiguity as held, and is idempotent', () => {
  const databasePath = eventlog.HARNESS_DB_PATH;
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  let ambiguous!: PreparedFixture;
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 70);
    const receipted = seedPreparedV70(db, 'receipted', 1);
    insertV70DeliveryReceipt(db, receipted);
    const unique = seedPreparedV70(db, 'unique-orphan', 1);
    ambiguous = seedPreparedV70(db, 'ambiguous-orphan', 2);

    schema.applyHarnessMigrations(db);
    assert.equal((db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as {
      version: number;
    }).version, 73);
    assert.deepEqual(db.prepare(`
      SELECT logical_tool_call_id, delivery_owner
        FROM ${coexistence.PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE}
       WHERE session_id = ? AND source_user_seq = ?
    `).get(receipted.sessionId, receipted.sourceUserSeq), {
      logical_tool_call_id: receipted.logicalCallIds[0],
      delivery_owner: 'durable_conversation',
    });
    assert.deepEqual(db.prepare(`
      SELECT logical_tool_call_id, delivery_owner
        FROM ${coexistence.PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE}
       WHERE session_id = ? AND source_user_seq = ?
    `).get(unique.sessionId, unique.sourceUserSeq), {
      logical_tool_call_id: unique.logicalCallIds[0],
      delivery_owner: 'legacy_unknown',
    });
    assert.equal(db.prepare(`
      SELECT 1 FROM ${coexistence.PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE}
       WHERE session_id = ? AND source_user_seq = ?
    `).get(ambiguous.sessionId, ambiguous.sourceUserSeq), undefined);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);

    const frozen = db.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name LIKE 'plan_task_preparation_%'
          OR name = 'plan_task_binding_seal_recovery_cursor'
          OR name = 'trg_plan_task_activation_receipt_exact_insert'
          OR name IN ('trg_accepted_task_resolution_excludes_host_root',
                      'trg_accepted_model_batch_admission_chain')
       ORDER BY type, name
    `).all();
    const versions = db.prepare(`SELECT * FROM schema_version ORDER BY version`).all();
    schema.applyHarnessMigrations(db);
    assert.deepEqual(db.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name LIKE 'plan_task_preparation_%'
          OR name = 'plan_task_binding_seal_recovery_cursor'
          OR name = 'trg_plan_task_activation_receipt_exact_insert'
          OR name IN ('trg_accepted_task_resolution_excludes_host_root',
                      'trg_accepted_model_batch_admission_chain')
       ORDER BY type, name
    `).all(), frozen);
    assert.deepEqual(db.prepare(`SELECT * FROM schema_version ORDER BY version`).all(), versions);
  } finally {
    db.close();
  }

  assert.deepEqual(settlement.settledPlanTaskActivationWinner({
    sessionId: ambiguous.sessionId,
    sourceUserSeq: ambiguous.sourceUserSeq,
  }), { status: 'held' }, 'an ambiguous v70 orphan retains an explicit non-executing owner');
  eventlog.closeEventLog();
});

test('fresh current schema installs the v71 checkpoint and refreshed proof walls idempotently', () => {
  const db = new Database(path.join(TEST_HOME, 'fresh-v71.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrations(db);
    coexistence.createPlanTaskPreparationCheckpointSchema(db);
    coexistence.createPlanTaskPreparationCheckpointSchema(db);
    const table = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(coexistence.PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE) as { sql: string } | undefined;
    assert.ok(table);
    assert.match(table.sql, /delivery_owner/);
    assert.match(table.sql, /legacy_unknown/);
    const recoveryCursor = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(coexistence.PLAN_TASK_BINDING_SEAL_RECOVERY_CURSOR_TABLE) as { sql: string } | undefined;
    assert.ok(recoveryCursor);
    assert.match(recoveryCursor.sql, /cursor_recorded_at/);
    assert.match(recoveryCursor.sql, /cursor_source_user_seq/);
    const checkpointTrigger = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
    `).get(coexistence.PLAN_TASK_PREPARATION_CHECKPOINT_INSERT_TRIGGER) as { sql: string } | undefined;
    assert.ok(checkpointTrigger);
    assert.match(checkpointTrigger.sql, /host_crossing_count = 1/);
    const receiptTrigger = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
    `).get(coexistence.PLAN_TASK_ACTIVATION_RECEIPT_INSERT_TRIGGER) as { sql: string } | undefined;
    assert.ok(receiptTrigger);
    assert.match(receiptTrigger.sql, /plan_task_preparation_checkpoints/);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    db.close();
  }
});

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});
