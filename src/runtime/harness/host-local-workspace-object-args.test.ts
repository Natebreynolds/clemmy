import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { proveHostLocalWorkspaceDerivation } from './host-local-workspace-derivation.js';
import { durableLogicalCallContract } from './logical-call-contract.js';

/** Exercise the real retained-frame reader with exact work/write bindings.
 * Deliberately provide no settled source: readable argument transport must
 * neither lose a genuine binding nor manufacture derivation evidence. */
function fixture(args: unknown, boundArgs = args) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accepted_task_work_contracts (
      session_id TEXT, source_user_seq INTEGER, accepted_task_id TEXT,
      contract_id TEXT, contract_json TEXT);
    CREATE TABLE expected_work_call_bindings (
      session_id TEXT, source_user_seq INTEGER, accepted_task_id TEXT,
      contract_id TEXT, requirement_id TEXT, logical_tool_call_id TEXT,
      tool_name TEXT, argument_digest TEXT, effect_kind TEXT);
    CREATE TABLE logical_call_settlements (
      session_id TEXT, source_user_seq INTEGER, logical_tool_call_id TEXT,
      outcome_kind TEXT, continues_requirement INTEGER,
      requires_reconciliation INTEGER, result_handle_id TEXT);
    CREATE TABLE accepted_model_batch_admissions_readable_v1 (
      session_id TEXT, source_user_seq INTEGER, accepted_task_id TEXT,
      work_contract_id TEXT, batch_ordinal INTEGER, batch_id TEXT,
      frame_history_json TEXT, pre_history_json TEXT, call_ids_json TEXT);
    CREATE TABLE accepted_model_batch_checkpoints_readable_v1 (
      session_id TEXT, source_user_seq INTEGER, batch_ordinal INTEGER,
      batch_id TEXT, disposition TEXT);
    CREATE TABLE logical_tool_calls (
      session_id TEXT, source_user_seq INTEGER, logical_tool_call_id TEXT,
      accepted_task_id TEXT, tool_name TEXT, raw_argument_digest TEXT,
      argument_digest TEXT);
    CREATE TABLE logical_model_result_projection_receipts (
      session_id TEXT, source_user_seq INTEGER, call_id TEXT,
      settlement_logical_tool_call_id TEXT, result_class TEXT,
      result_item_bytes INTEGER, result_item_sha256 TEXT);
  `);
  const sessionId = 'workspace-object-frame';
  const sourceUserSeq = 7;
  const acceptedTaskId = 'task:workspace-object-frame';
  const writeLogicalToolCallId = 'write-workspace';
  const contractId = 'contract:workspace-object-frame';
  const contract = durableLogicalCallContract(acceptedTaskId, 'space_save', boundArgs);
  const digest = contract?.argumentDigest ?? 'unreadable';
  db.prepare('INSERT INTO accepted_task_work_contracts VALUES (?, ?, ?, ?, ?)').run(
    sessionId, sourceUserSeq, acceptedTaskId, contractId, JSON.stringify({ operations: [
      { id: 'read-source', effect: 'read', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
      { id: 'save-workspace', effect: 'local_write', dependsOn: ['read-source'], dataFrom: ['read-source'], cardinality: { kind: 'once' } },
    ] }),
  );
  db.prepare('INSERT INTO expected_work_call_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    sessionId, sourceUserSeq, acceptedTaskId, contractId, 'save-workspace', writeLogicalToolCallId,
    'space_save', digest, 'local_write',
  );
  const rawFrame = JSON.stringify([{ type: 'function_call', callId: writeLogicalToolCallId,
    name: 'work_call', arguments: JSON.stringify({ requirement_id: 'save-workspace', name: 'space_save', args_json: args }) }]);
  db.prepare('INSERT INTO accepted_model_batch_admissions_readable_v1 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    sessionId, sourceUserSeq, acceptedTaskId, contractId, 1, 'batch-1', rawFrame, '[]', JSON.stringify([writeLogicalToolCallId]),
  );
  db.prepare('INSERT INTO accepted_model_batch_checkpoints_readable_v1 VALUES (?, ?, ?, ?, ?)').run(
    sessionId, sourceUserSeq, 1, 'batch-1', 'ready',
  );
  db.prepare('INSERT INTO logical_tool_calls VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    sessionId, sourceUserSeq, writeLogicalToolCallId, acceptedTaskId, 'space_save', digest, digest,
  );
  return {
    db, rawFrame,
    prove: () => proveHostLocalWorkspaceDerivation({ db, sessionId, sourceUserSeq, acceptedTaskId, writeLogicalToolCallId,
      resolveSuccessfulResult: () => assert.fail('missing source must never be replaced with invented successful evidence') }),
  };
}

const args = {
  slug: 'controlled-object-frame', title: 'Controlled report',
  view_html: '<!doctype html><p data-json=\'{"name":"literal"}\'>café 😀\\n</p>',
  initial_data_json: { records: [{ n: 1, flags: [true, false, null], literal: '{"keep":"string"}' }] },
};

for (const representation of ['object', 'text'] as const) {
  test(`retained Workspace ${representation} arguments reopen their exact binding without inventing source proof`, () => {
    const f = fixture(representation === 'object' ? args : JSON.stringify(args), args);
    try {
      assert.deepEqual(f.prove(), { status: 'unavailable', reason: 'compound Workspace source settlement is missing' },
        'the raw argument format is readable; the independent source-evidence floor still applies');
      const row = f.db.prepare('SELECT frame_history_json FROM accepted_model_batch_admissions_readable_v1').get() as { frame_history_json: string };
      assert.equal(row.frame_history_json, f.rawFrame, 'reading never rewrites original admitted model bytes');
    } finally { f.db.close(); }
  });
}

test('changed structured Workspace bytes do not inherit the original write binding', () => {
  const f = fixture({ ...args, view_html: '<p>Different bytes</p>' }, args);
  try {
    assert.deepEqual(f.prove(), { status: 'unavailable', reason: 'compound Workspace accepted arguments do not match the write binding' });
  } finally { f.db.close(); }
});

for (const invalid of [null, [], 7, true]) {
  test(`invalid Workspace argument document ${JSON.stringify(invalid)} cannot become a derivation proof`, () => {
    const f = fixture(invalid, args);
    try {
      assert.deepEqual(f.prove(), { status: 'unavailable', reason: 'compound Workspace carrier contradicts the exact requirement' });
    } finally { f.db.close(); }
  });
}
