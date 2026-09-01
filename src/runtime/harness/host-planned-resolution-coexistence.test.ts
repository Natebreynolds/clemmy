/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-planned-resolution-coexistence.test.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  PLAN_TASK_ACTIVATION_RECEIPTS_TABLE,
  PLAN_TASK_ACTIVATION_RECEIPT_INSERT_TRIGGER,
  PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE,
  createHostPlannedResolutionCoexistenceSchema,
  createPlanTaskPreparationCheckpointSchema,
  refreshPlanTaskActivationReceiptInsertTrigger,
} from './host-planned-resolution-coexistence.js';

const IDS = Object.freeze({
  session: 'settled-plan-recovery-session',
  sourceSeq: 1,
  source: 'source-event',
  acceptedTask: 'accepted-task',
  graphEvent: 'graph-event',
  graph: 'graph-id',
  graphHash: 'a'.repeat(64),
  contract: 'contract-id',
  logical: 'plan-call',
  argumentDigest: 'b'.repeat(64),
  preamble: 'preamble-event',
  preambleDigest: 'c'.repeat(64),
  delivery: 'delivery-event',
  deliveryKey: `preamble-delivery:v1:${'d'.repeat(64)}`,
  transportDigest: 'e'.repeat(64),
  settlementEvent: 'settlement-event',
  resultHandle: 'result-handle',
  physical: 'host-crossing',
});

function createFixtureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      turn INTEGER NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_event_id TEXT,
      data_json TEXT NOT NULL
    );
    CREATE TABLE accepted_turn_call_authorities (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      accepted_task_id TEXT NOT NULL,
      authority_kind TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      state TEXT NOT NULL,
      graph_event_id TEXT,
      graph_hash TEXT,
      source_event_id TEXT NOT NULL,
      source_turn INTEGER NOT NULL,
      PRIMARY KEY (session_id, source_user_seq)
    );
    CREATE TABLE accepted_task_authority (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      accepted_task_id TEXT NOT NULL,
      authority_protocol INTEGER NOT NULL,
      state TEXT NOT NULL,
      expected_work_required INTEGER NOT NULL,
      graph_event_id TEXT NOT NULL,
      graph_id TEXT NOT NULL,
      graph_hash TEXT NOT NULL,
      work_contract_id TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq)
    );
    CREATE TABLE accepted_task_work_contracts (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      accepted_task_id TEXT NOT NULL,
      contract_id TEXT NOT NULL UNIQUE,
      contract_version INTEGER NOT NULL,
      planner_source TEXT NOT NULL,
      graph_event_id TEXT NOT NULL,
      graph_id TEXT NOT NULL,
      graph_hash TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq)
    );
    CREATE TABLE logical_tool_calls (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      accepted_task_id TEXT NOT NULL,
      logical_tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      argument_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      settlement_event_id TEXT,
      outcome_kind TEXT,
      PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id)
    );
    CREATE TABLE physical_dispatches (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      accepted_task_id TEXT NOT NULL,
      logical_tool_call_id TEXT NOT NULL,
      physical_dispatch_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      argument_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      execution_site TEXT,
      PRIMARY KEY (session_id, source_user_seq, physical_dispatch_id)
    );
    CREATE TABLE durable_result_handles (
      handle_id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      session_id TEXT,
      source_user_seq INTEGER,
      accepted_task_id TEXT,
      logical_tool_call_id TEXT,
      physical_dispatch_id TEXT,
      tool_name TEXT NOT NULL,
      argument_digest TEXT NOT NULL,
      success INTEGER NOT NULL,
      rejection_reason TEXT,
      raw_payload_json TEXT,
      raw_payload_sha256 TEXT
    );
    CREATE TABLE logical_call_settlements (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      logical_tool_call_id TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      execution_kind TEXT NOT NULL,
      outcome_kind TEXT NOT NULL,
      business_call INTEGER NOT NULL,
      mutating INTEGER NOT NULL,
      requirement_id TEXT,
      physical_crossing_count INTEGER NOT NULL,
      host_crossing_count INTEGER NOT NULL,
      crossing_authority_version INTEGER NOT NULL,
      settlement_event_id TEXT NOT NULL,
      result_handle_id TEXT,
      PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id)
    );
    CREATE TABLE logical_call_settlement_crossings (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      logical_tool_call_id TEXT NOT NULL,
      physical_dispatch_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      argument_digest TEXT NOT NULL,
      terminal_state TEXT,
      execution_site TEXT,
      PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id)
    );
  `);
  createHostPlannedResolutionCoexistenceSchema(db);
}

function deliveryReceipt() {
  return {
    version: 1,
    deliveryKey: IDS.deliveryKey,
    eventId: IDS.preamble,
    eventDigest: IDS.preambleDigest,
    surface: 'channel_message',
    target: 'discord:channel-1:placeholder-1',
  };
}

function seedPlan(input: {
  state: 'open' | 'settled';
  rawResult?: Record<string, unknown>;
  businessCall?: number;
  hostCrossingCount?: number;
  extraHostResult?: boolean;
}): Database.Database {
  const db = new Database(':memory:');
  createFixtureSchema(db);
  const receipt = deliveryReceipt();
  const deliveryData = {
    version: 1,
    sourceUserSeq: IDS.sourceSeq,
    acceptedTaskId: IDS.acceptedTask,
    logicalToolCallId: IDS.logical,
    planArgumentDigest: IDS.argumentDigest,
    preambleEventId: IDS.preamble,
    preambleEventDigest: IDS.preambleDigest,
    deliveryKey: IDS.deliveryKey,
    deliveryStatus: 'delivered',
    transportReceipt: receipt,
    transportReceiptDigest: IDS.transportDigest,
  };
  const insertEvent = db.prepare(`
    INSERT INTO events
      (id, session_id, seq, turn, role, type, parent_event_id, data_json)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)
  `);
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run(IDS.session);
  insertEvent.run(IDS.source, IDS.session, IDS.sourceSeq, 'user', 'user_input_received', null,
    JSON.stringify({ text: 'Create the requested artifact.' }));
  insertEvent.run(IDS.graphEvent, IDS.session, 2, 'system', 'turn_graph_compiled', IDS.source,
    JSON.stringify({ route: 'act', sourceUserSeq: IDS.sourceSeq, graphId: IDS.graph, graphHash: IDS.graphHash }));
  insertEvent.run(IDS.preamble, IDS.session, 3, 'Clem', 'conversation_preamble', IDS.source,
    JSON.stringify({ version: 1, kind: 'pre_execution', sourceUserSeq: IDS.sourceSeq, text: 'I’ll do that now.' }));
  insertEvent.run(IDS.delivery, IDS.session, 4, 'system', 'conversation_preamble_delivered', IDS.preamble,
    JSON.stringify(deliveryData));
  insertEvent.run(IDS.settlementEvent, IDS.session, 5, 'system', 'logical_call_settled', IDS.source,
    JSON.stringify({ logicalToolCallId: IDS.logical }));

  db.prepare(`
    INSERT INTO accepted_turn_call_authorities
      (session_id, source_user_seq, accepted_task_id, authority_kind, engine_version,
       state, graph_event_id, graph_hash, source_event_id, source_turn)
    VALUES (?, ?, ?, 'host_v1', 'host_v1', 'open', NULL, NULL, ?, 1)
  `).run(IDS.session, IDS.sourceSeq, IDS.acceptedTask, IDS.source);
  db.prepare(`
    INSERT INTO accepted_task_authority
      (session_id, source_user_seq, accepted_task_id, authority_protocol, state,
       expected_work_required, graph_event_id, graph_id, graph_hash, work_contract_id)
    VALUES (?, ?, ?, 1, 'armed', 0, ?, ?, ?, ?)
  `).run(IDS.session, IDS.sourceSeq, IDS.acceptedTask, IDS.graphEvent, IDS.graph, IDS.graphHash, IDS.contract);
  db.prepare(`
    INSERT INTO accepted_task_work_contracts
      (session_id, source_user_seq, accepted_task_id, contract_id, contract_version,
       planner_source, graph_event_id, graph_id, graph_hash)
    VALUES (?, ?, ?, ?, 1, 'structured_model', ?, ?, ?)
  `).run(IDS.session, IDS.sourceSeq, IDS.acceptedTask, IDS.contract, IDS.graphEvent, IDS.graph, IDS.graphHash);
  db.prepare(`
    INSERT INTO logical_tool_calls
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       tool_name, argument_digest, state, settlement_event_id, outcome_kind)
    VALUES (?, ?, ?, ?, 'plan_task', ?, ?, ?, ?)
  `).run(
    IDS.session,
    IDS.sourceSeq,
    IDS.acceptedTask,
    IDS.logical,
    IDS.argumentDigest,
    input.state,
    input.state === 'settled' ? IDS.settlementEvent : null,
    input.state === 'settled' ? 'succeeded' : null,
  );

  if (input.state === 'settled') {
    const rawResult = input.rawResult ?? {
      ok: true,
      acceptedTaskId: IDS.acceptedTask,
      graphId: IDS.graph,
      graphHash: IDS.graphHash,
      contractId: IDS.contract,
    };
    db.prepare(`
      INSERT INTO physical_dispatches
        (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
         physical_dispatch_id, ordinal, tool_name, argument_digest, state, execution_site)
      VALUES (?, ?, ?, ?, ?, 1, 'plan_task', ?, 'returned', 'host')
    `).run(IDS.session, IDS.sourceSeq, IDS.acceptedTask, IDS.logical, IDS.physical, IDS.argumentDigest);
    db.prepare(`
      INSERT INTO durable_result_handles
        (handle_id, scope_kind, session_id, source_user_seq, accepted_task_id,
         logical_tool_call_id, physical_dispatch_id, tool_name, argument_digest,
         success, rejection_reason, raw_payload_json, raw_payload_sha256)
      VALUES (?, 'authoritative', ?, ?, ?, ?, ?, 'plan_task', ?, 1, NULL, ?, ?)
    `).run(
      IDS.resultHandle,
      IDS.session,
      IDS.sourceSeq,
      IDS.acceptedTask,
      IDS.logical,
      IDS.physical,
      IDS.argumentDigest,
      JSON.stringify(JSON.stringify(rawResult)),
      'f'.repeat(64),
    );
    db.prepare(`
      INSERT INTO logical_call_settlements
        (session_id, source_user_seq, logical_tool_call_id, protocol_version,
         execution_kind, outcome_kind, business_call, mutating, requirement_id,
         physical_crossing_count, host_crossing_count, crossing_authority_version,
         settlement_event_id, result_handle_id)
      VALUES (?, ?, ?, 1, 'local_execution', 'succeeded', ?, 0, NULL, 0, ?, 2, ?, ?)
    `).run(
      IDS.session,
      IDS.sourceSeq,
      IDS.logical,
      input.businessCall ?? 0,
      input.hostCrossingCount ?? 1,
      IDS.settlementEvent,
      IDS.resultHandle,
    );
    db.prepare(`
      INSERT INTO logical_call_settlement_crossings
        (session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id,
         ordinal, tool_name, argument_digest, terminal_state, execution_site)
      VALUES (?, ?, ?, ?, 1, 'plan_task', ?, 'returned', 'host')
    `).run(IDS.session, IDS.sourceSeq, IDS.logical, IDS.physical, IDS.argumentDigest);
    if (input.extraHostResult) {
      db.prepare(`
        INSERT INTO physical_dispatches
          (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
           physical_dispatch_id, ordinal, tool_name, argument_digest, state, execution_site)
        VALUES (?, ?, ?, ?, 'extra-host-crossing', 2, 'plan_task', ?, 'returned', 'host')
      `).run(IDS.session, IDS.sourceSeq, IDS.acceptedTask, IDS.logical, IDS.argumentDigest);
      db.prepare(`
        INSERT INTO durable_result_handles
          (handle_id, scope_kind, session_id, source_user_seq, accepted_task_id,
           logical_tool_call_id, physical_dispatch_id, tool_name, argument_digest,
           success, rejection_reason, raw_payload_json, raw_payload_sha256)
        VALUES ('extra-result', 'authoritative', ?, ?, ?, ?, 'extra-host-crossing',
                'plan_task', ?, 1, NULL, ?, ?)
      `).run(
        IDS.session,
        IDS.sourceSeq,
        IDS.acceptedTask,
        IDS.logical,
        IDS.argumentDigest,
        JSON.stringify(JSON.stringify(rawResult)),
        '1'.repeat(64),
      );
    }
  }
  return db;
}

function insertReceipt(db: Database.Database): void {
  const receipt = deliveryReceipt();
  db.prepare(`
    INSERT INTO ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       receipt_version, plan_argument_digest, graph_event_id, graph_id, graph_hash,
       contract_id, preamble_event_id, preamble_event_digest, delivery_key,
       delivery_event_id, delivery_status, delivery_reason, transport_receipt_json,
       transport_receipt_digest, transport_target, recorded_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', NULL, ?, ?, ?, ?)
  `).run(
    IDS.session,
    IDS.sourceSeq,
    IDS.acceptedTask,
    IDS.logical,
    IDS.argumentDigest,
    IDS.graphEvent,
    IDS.graph,
    IDS.graphHash,
    IDS.contract,
    IDS.preamble,
    IDS.preambleDigest,
    IDS.deliveryKey,
    IDS.delivery,
    JSON.stringify(receipt),
    IDS.transportDigest,
    receipt.target,
    '2026-08-23T00:00:00.000Z',
  );
}

function insertCheckpoint(
  db: Database.Database,
  deliveryOwner: 'durable_conversation' | 'carrier_owned' = 'carrier_owned',
): void {
  db.prepare(`
    INSERT INTO ${PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE}
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       checkpoint_version, plan_argument_digest, graph_event_id, graph_id,
       graph_hash, contract_id, preamble_event_id, preamble_event_digest,
       delivery_key, delivery_owner, recorded_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    IDS.session,
    IDS.sourceSeq,
    IDS.acceptedTask,
    IDS.logical,
    IDS.argumentDigest,
    IDS.graphEvent,
    IDS.graph,
    IDS.graphHash,
    IDS.contract,
    IDS.preamble,
    IDS.preambleDigest,
    IDS.deliveryKey,
    deliveryOwner,
    '2026-08-30T00:00:00.000Z',
  );
}

test('settled exact plan receipt inserts on restart and can cross the activation CAS', () => {
  const db = seedPlan({ state: 'settled' });
  try {
    insertReceipt(db);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}`).get() as { n: number }).n, 1);
    const activated = db.prepare(`
      UPDATE accepted_task_authority
         SET expected_work_required = 1
       WHERE session_id = ? AND source_user_seq = ?
         AND expected_work_required = 0 AND state != 'conflict'
    `).run(IDS.session, IDS.sourceSeq);
    assert.equal(activated.changes, 1, 'the durable receipt is followed by the one activation CAS');
    assert.equal((db.prepare(`
      SELECT expected_work_required AS required FROM accepted_task_authority
       WHERE session_id = ? AND source_user_seq = ?
    `).get(IDS.session, IDS.sourceSeq) as { required: number }).required, 1);
  } finally {
    db.close();
  }
});

test('the ordinary live open-plan receipt path remains unchanged', () => {
  const db = seedPlan({ state: 'open' });
  try {
    insertReceipt(db);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}`).get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
});

test('settled receipt wall rejects unredeemed repairs and malformed host settlement authority', async (t) => {
  const cases: Array<{ label: string; fixture: Parameters<typeof seedPlan>[0] }> = [
    {
      label: 'ok-false-repair',
      fixture: {
        state: 'settled',
        rawResult: {
          ok: false,
          acceptedTaskId: IDS.acceptedTask,
          graphId: IDS.graph,
          graphHash: IDS.graphHash,
          contractId: IDS.contract,
        },
      },
    },
    {
      label: 'wrong-graph-result',
      fixture: {
        state: 'settled',
        rawResult: {
          ok: true,
          acceptedTaskId: IDS.acceptedTask,
          graphId: 'foreign-graph',
          graphHash: IDS.graphHash,
          contractId: IDS.contract,
        },
      },
    },
    { label: 'business-call', fixture: { state: 'settled', businessCall: 1 } },
    { label: 'wrong-host-crossing-count', fixture: { state: 'settled', hostCrossingCount: 0 } },
    { label: 'multiple-host-results', fixture: { state: 'settled', extraHostResult: true } },
  ];
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.label, () => {
      const db = seedPlan(fixtureCase.fixture);
      try {
        assert.throws(() => insertReceipt(db), /plan_task receipt requires exact host/);
        assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}`).get() as { n: number }).n, 0);
        assert.equal((db.prepare(`SELECT expected_work_required AS required FROM accepted_task_authority`).get() as { required: number }).required, 0);
      } finally {
        db.close();
      }
    });
  }
});

test('v57 refresh helper replaces the installed trigger idempotently', () => {
  const db = seedPlan({ state: 'settled' });
  try {
    refreshPlanTaskActivationReceiptInsertTrigger(db);
    refreshPlanTaskActivationReceiptInsertTrigger(db);
    const trigger = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
    `).get(PLAN_TASK_ACTIVATION_RECEIPT_INSERT_TRIGGER) as { sql: string } | undefined;
    assert.ok(trigger);
    assert.match(trigger.sql, /call\.state = 'open' OR/);
    assert.match(trigger.sql, /call\.state = 'settled'/);
    assert.match(trigger.sql, /json_extract\(json_extract\(result\.raw_payload_json/);
    insertReceipt(db);
  } finally {
    db.close();
  }
});

test('v71 checkpoint lets an interrupted host-only plan bind its exact later receipt', () => {
  const db = seedPlan({ state: 'settled' });
  try {
    db.prepare(`UPDATE logical_tool_calls SET outcome_kind = 'unknown'`).run();
    db.prepare(`UPDATE logical_call_settlements SET outcome_kind = 'unknown'`).run();
    db.prepare(`UPDATE physical_dispatches SET state = 'unknown'`).run();
    db.prepare(`UPDATE logical_call_settlement_crossings SET terminal_state = 'unknown'`).run();
    createPlanTaskPreparationCheckpointSchema(db);

    assert.throws(
      () => insertReceipt(db),
      /plan_task receipt requires exact host/,
      'an interrupted settlement alone cannot acquire delivery authority',
    );
    insertCheckpoint(db);
    insertReceipt(db);
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}
    `).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`
      SELECT outcome_kind FROM logical_call_settlements
    `).get() as { outcome_kind: string }).outcome_kind, 'unknown', 'recovery never fabricates success');
  } finally {
    db.close();
  }
});

test('v71 presentation owner prevents a carrier receipt from substituting for the durable lane', () => {
  const db = seedPlan({ state: 'open' });
  try {
    createPlanTaskPreparationCheckpointSchema(db);
    insertCheckpoint(db, 'durable_conversation');
    assert.throws(
      () => insertReceipt(db),
      /plan_task receipt requires exact host/,
    );
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}
    `).get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});
