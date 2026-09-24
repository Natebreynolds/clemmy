import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { readWorkflowSettlementEvidence } from './workflow-settlement-evidence.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE logical_call_settlements (session_id TEXT, source_user_seq INTEGER, logical_tool_call_id TEXT, execution_kind TEXT, outcome_kind TEXT, mutating INTEGER, result_handle_id TEXT, settlement_event_id TEXT);
    CREATE TABLE logical_tool_calls (session_id TEXT, source_user_seq INTEGER, logical_tool_call_id TEXT, tool_name TEXT, argument_digest TEXT);
    CREATE TABLE events (session_id TEXT, seq INTEGER, type TEXT, role TEXT);`);
  function add(run: string, call: string, tool: string, mutating: number, outcome = 'succeeded', source = 1) {
    const session = `workflow:${run}:main`;
    db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(session, source, 'user_input_received', 'user');
    db.prepare('INSERT INTO logical_tool_calls VALUES (?,?,?,?,?)').run(session, source, call, tool, `args-${call}`);
    db.prepare('INSERT INTO logical_call_settlements VALUES (?,?,?,?,?,?,?,?)').run(session, source, call, 'local_execution', outcome, mutating, `result-${call}`, `event-${call}`);
  }
  return { db, add };
}

test('parent sees actual child writes and refreshes even when child output is an empty list', () => {
  const { db, add } = fixture();
  try {
    add('r1', 'w1', 'provider_update', 1);
    add('r1', 'w2', 'provider_update', 1, 'succeeded', 2);
    add('r1', 'refresh', 'space_refresh', 1, 'succeeded', 3);
    add('r1', 'failed', 'provider_read', 0, 'failed', 4);
    add('r10', 'foreign', 'foreign_write', 1);
    const result = readWorkflowSettlementEvidence('r1', db);
    assert.equal(result.settledCalls, 4);
    assert.equal(result.groups?.find(g => g.tool === 'provider_update')?.calls, 2);
    assert.equal(result.groups?.find(g => g.tool === 'space_refresh')?.mutating, true);
    assert.equal(result.groups?.find(g => g.tool === 'provider_read')?.outcome, 'failed');
    assert.ok(!result.groups?.some(g => g.tool === 'foreign_write'));
    const digest = result.ledgerDigest;
    db.prepare('UPDATE logical_tool_calls SET argument_digest = ? WHERE logical_tool_call_id = ?').run('changed-arguments', 'w1');
    assert.notEqual(readWorkflowSettlementEvidence('r1', db).ledgerDigest, digest);
    assert.match(readWorkflowSettlementEvidence('missing', db).meaning, /do not prove unchanged/);
  } finally { db.close(); }
});

test('unreadable ledger is unknown, never a zero-write claim', () => {
  const db = new Database(':memory:');
  try {
    const result = readWorkflowSettlementEvidence('r1', db);
    assert.equal(result.available, false);
    assert.equal(result.settledCalls, undefined);
  } finally { db.close(); }
});
