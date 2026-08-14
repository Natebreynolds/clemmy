import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-logical-refinement-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-logical-refinement\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const contracts = await import('./logical-call-contract.js');
const ledger = await import('./dispatch-ledger.js');
const identities = await import('./attempt-identity.js');
const settlement = await import('./attempt-settlement.js');
const resolution = await import('./resolution-ledger.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
function accept(text = 'Read the source and write the exact grounded result.') {
  const session = eventlog.createSession({ id: `logical-refinement-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

function logicalIdentity(task: ReturnType<typeof accept>, suffix: string) {
  return { ...task, logicalToolCallId: `logical:${suffix}` };
}

function admit(
  task: ReturnType<typeof accept>,
  suffix: string,
  tool: string,
  args: unknown,
) {
  const identity = logicalIdentity(task, suffix);
  const admitted = ledger.admitLogicalCall({ identity, tool, args });
  assert.equal(admitted.status, 'inserted');
  return identity;
}

test('carrier-only normalization is an exact no-op and exact refinement replay is idempotent', () => {
  const task = accept();
  const tool = 'alpha__records_search';
  const identity = admit(task, 'carrier-noop', tool, '{"limit":25,"query":"alpha"}');

  const noOp = ledger.refineLogicalCallContract({
    identity,
    tool,
    effectiveArgs: { query: 'alpha', limit: 25 },
  });
  assert.equal(noOp.status, 'replayed', 'carrier decoding/key order is not a semantic rewrite');
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['logical_call_contract_refined'] }).length,
    0,
    'a no-op does not manufacture a refinement event',
  );

  const physical = ledger.beginPhysicalDispatch({
    identity: { ...identity, physicalDispatchId: 'dispatch:carrier-noop', ordinal: 0 },
    tool,
    args: { limit: 25, query: 'alpha' },
  });
  assert.equal(physical.status, 'inserted');
});

test('one raw-to-effective refinement becomes the only physical and settlement contract', () => {
  const task = accept();
  const tool = 'alpha__records_create';
  const rawArgs = {
    account_alias: 'finance',
    amount: { $fromToolOutput: { callId: 'read-1', path: 'result.amount' } },
  };
  const effectiveArgs = { amount: 42, note: null };
  const identity = admit(task, 'effective-only', tool, rawArgs);

  const refined = ledger.refineLogicalCallContract({ identity, tool, effectiveArgs });
  assert.equal(refined.status, 'refined');
  if (refined.status !== 'refined') return;
  const expected = contracts.durableLogicalCallContract(task.acceptedTaskId, tool, effectiveArgs);
  assert.equal(refined.identity.argumentDigest, expected?.argumentDigest);

  const started = ledger.beginPhysicalDispatch({
    identity: { ...identity, physicalDispatchId: 'dispatch:effective-only', ordinal: 0 },
    tool,
    args: effectiveArgs,
  });
  assert.equal(started.status, 'inserted', 'the refined contract authorizes provider I/O');
  if (started.status !== 'inserted') return;
  assert.equal(ledger.settlePhysicalDispatch({
    identity: started.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  assert.doesNotThrow(() => settlement.settleToolAttempt({
    ...task,
    lane: 'native_mcp',
    toolName: tool,
    callId: identity.logicalToolCallId,
    args: effectiveArgs,
    businessCall: true,
    mutating: true,
    result: { successful: true, id: 'created-1' },
  }));
});

test('raw arguments cannot dispatch after refinement, but the same call may settle under its admission identity', () => {
  const physicalTask = accept();
  const tool = 'alpha__records_create';
  const rawArgs = { value: 'raw', account_alias: 'ops' };
  const effectiveArgs = { value: 'resolved' };
  const physicalIdentity = admit(physicalTask, 'raw-physical-refused', tool, rawArgs);
  assert.equal(ledger.refineLogicalCallContract({
    identity: physicalIdentity,
    tool,
    effectiveArgs,
  }).status, 'refined');
  assert.equal(ledger.beginPhysicalDispatch({
    identity: { ...physicalIdentity, physicalDispatchId: 'dispatch:raw-refused', ordinal: 0 },
    tool,
    args: rawArgs,
  }).status, 'conflict');
  assert.deepEqual(ledger.physicalCrossingsFor(physicalTask.sessionId, physicalTask.sourceUserSeq), []);

  const settlementTask = accept();
  const settlementIdentity = admit(settlementTask, 'raw-settlement-refused', tool, rawArgs);
  assert.equal(ledger.refineLogicalCallContract({
    identity: settlementIdentity,
    tool,
    effectiveArgs,
  }).status, 'refined');
  const settled = settlement.settleToolAttempt({
    ...settlementTask,
    lane: 'agents_runner',
    toolName: tool,
    callId: settlementIdentity.logicalToolCallId,
    args: rawArgs,
    businessCall: false,
    signals: { kind: 'policy_denial', evidence: 'nominal', dispatchState: 'not_started' },
  });
  assert.equal(settled.duplicate, false);
  const row = eventlog.openEventLog().prepare(`
    SELECT state, conflict_reason FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    settlementTask.sessionId,
    settlementTask.sourceUserSeq,
    settlementIdentity.logicalToolCallId,
  ) as { state: string; conflict_reason: string | null };
  assert.deepEqual(row, { state: 'settled', conflict_reason: null });
});

test('the raw and effective digests survive restart for audit without persisting either value', () => {
  const task = accept();
  const tool = 'alpha__records_create';
  const rawSecret = 'raw-secret-never-store';
  const effectiveSecret = 'effective-secret-never-store';
  const rawArgs = { value: rawSecret, account_alias: 'ops' };
  const effectiveArgs = { value: effectiveSecret };
  const identity = admit(task, 'restart-audit', tool, rawArgs);
  assert.equal(ledger.refineLogicalCallContract({ identity, tool, effectiveArgs }).status, 'refined');

  const rawContract = contracts.durableLogicalCallContract(task.acceptedTaskId, tool, rawArgs);
  const effectiveContract = contracts.durableLogicalCallContract(task.acceptedTaskId, tool, effectiveArgs);
  eventlog.closeEventLog();
  const row = eventlog.openEventLog().prepare(`
    SELECT raw_argument_digest, effective_argument_digest, argument_digest
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, identity.logicalToolCallId) as {
    raw_argument_digest: string;
    effective_argument_digest: string;
    argument_digest: string;
  };
  assert.deepEqual(row, {
    raw_argument_digest: rawContract?.argumentDigest,
    effective_argument_digest: effectiveContract?.argumentDigest,
    argument_digest: effectiveContract?.argumentDigest,
  });
  const persisted = JSON.stringify(eventlog.openEventLog().prepare(`
    SELECT * FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, identity.logicalToolCallId));
  assert.equal(persisted.includes(rawSecret), false);
  assert.equal(persisted.includes(effectiveSecret), false);
});

test('a conflicting second refinement poisons the logical call and accepted resolution', () => {
  const task = accept();
  const tool = 'alpha__records_create';
  const identity = admit(task, 'second-conflict', tool, { value: 'raw' });
  const first = ledger.refineLogicalCallContract({ identity, tool, effectiveArgs: { value: 'first' } });
  assert.equal(first.status, 'refined');
  const replay = ledger.refineLogicalCallContract({ identity, tool, effectiveArgs: { value: 'first' } });
  assert.equal(replay.status, 'replayed');
  const conflict = ledger.refineLogicalCallContract({ identity, tool, effectiveArgs: { value: 'second' } });
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(eventlog.openEventLog().prepare(`
    SELECT r.state AS resolution_state, l.state AS logical_state
      FROM accepted_task_resolutions r
      JOIN logical_tool_calls l
        ON l.session_id = r.session_id AND l.source_user_seq = r.source_user_seq
     WHERE r.session_id = ? AND r.source_user_seq = ? AND l.logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, identity.logicalToolCallId), {
    resolution_state: 'legacy_ambiguous',
    logical_state: 'conflict',
  });
});

test('refinement is bound to the exact accepted task, logical call, and canonical tool', () => {
  const task = accept();
  const identity = admit(task, 'binding', 'alpha__records_create', { value: 'raw' });
  const wrongTask = ledger.refineLogicalCallContract({
    identity: { ...identity, acceptedTaskId: 'task:foreign#99' },
    tool: 'alpha__records_create',
    effectiveArgs: { value: 'resolved' },
  });
  assert.equal(wrongTask.status, 'conflict');

  const toolTask = accept();
  const toolIdentity = admit(toolTask, 'tool-binding', 'alpha__records_create', { value: 'raw' });
  const wrongTool = ledger.refineLogicalCallContract({
    identity: toolIdentity,
    tool: 'alpha__records_delete',
    effectiveArgs: { value: 'resolved' },
  });
  assert.equal(wrongTool.status, 'conflict');
});

test('the trusted resolver API cannot nominate authority without its ambient logical owner', () => {
  const task = accept();
  const tool = 'alpha__records_create';
  const identity = admit(task, 'host-only', tool, { value: 'raw' });
  assert.throws(() => identities.authorizeResolvedLogicalCallContract({
    ...task,
    tool,
    effectiveArgs: { value: 'resolved' },
  }), identities.LogicalCallPreDispatchAuthorityError);
  const row = eventlog.openEventLog().prepare(`
    SELECT argument_digest, raw_argument_digest, effective_argument_digest
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, identity.logicalToolCallId) as {
    argument_digest: string;
    raw_argument_digest: string;
    effective_argument_digest: string | null;
  };
  assert.equal(row.argument_digest, row.raw_argument_digest);
  assert.equal(row.effective_argument_digest, null);
});

test('refinement after a physical crossing starts or returns refuses without rewriting authority', () => {
  for (const state of ['started', 'returned'] as const) {
    const task = accept();
    const tool = 'alpha__records_search';
    const identity = admit(task, `physical-${state}`, tool, { query: 'raw' });
    const started = ledger.beginPhysicalDispatch({
      identity: { ...identity, physicalDispatchId: `dispatch:physical-${state}`, ordinal: 0 },
      tool,
      args: { query: 'raw' },
    });
    assert.equal(started.status, 'inserted');
    if (started.status !== 'inserted') continue;
    if (state === 'returned') {
      assert.equal(ledger.settlePhysicalDispatch({
        identity: started.identity,
        tool,
        outcome: 'returned',
      }).status, 'inserted');
    }
    const late = ledger.refineLogicalCallContract({
      identity,
      tool,
      effectiveArgs: state === 'started' ? { query: 'raw' } : { query: 'resolved' },
    });
    assert.equal(late.status, 'closed', `a ${state} crossing freezes the contract`);
  }
});

test('refinement after logical settlement or accepted-task finalization refuses', () => {
  const settledTask = accept();
  const settledTool = 'alpha__records_search';
  const settledIdentity = logicalIdentity(settledTask, 'settled');
  identities.withLogicalToolCall({
    ...settledTask,
    logicalToolCallId: settledIdentity.logicalToolCallId,
    tool: settledTool,
    args: { query: 'raw' },
  }, () => settlement.settleToolAttempt({
    ...settledTask,
    lane: 'agents_runner',
    toolName: settledTool,
    callId: settledIdentity.logicalToolCallId,
    args: { query: 'raw' },
    businessCall: false,
    signals: { kind: 'policy_denial', evidence: 'nominal', dispatchState: 'not_started' },
  }));
  assert.equal(ledger.refineLogicalCallContract({
    identity: settledIdentity,
    tool: settledTool,
    effectiveArgs: { query: 'resolved' },
  }).status, 'closed');

  const finalizedTask = accept();
  assert.equal(resolution.finalizeResolution(finalizedTask), true);
  assert.equal(ledger.refineLogicalCallContract({
    identity: logicalIdentity(finalizedTask, 'never-admitted'),
    tool: 'alpha__records_search',
    effectiveArgs: { query: 'resolved' },
  }).status, 'closed');
});

test('the refinement mirror and normalized authority commit or roll back together', () => {
  const task = accept();
  const tool = 'alpha__records_create';
  const identity = admit(task, 'atomic-mirror', tool, { value: 'raw' });
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_contract_refinement_failure
    BEFORE UPDATE OF effective_argument_digest ON logical_tool_calls
    BEGIN
      SELECT RAISE(ABORT, 'forced refinement failure');
    END;
  `);
  try {
    const failed = ledger.refineLogicalCallContract({
      identity,
      tool,
      effectiveArgs: { value: 'resolved' },
    });
    assert.equal(failed.status, 'storage_error');
  } finally {
    db.exec('DROP TRIGGER IF EXISTS force_contract_refinement_failure');
  }
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['logical_call_contract_refined'] }).length,
    0,
  );
  const row = db.prepare(`
    SELECT argument_digest, raw_argument_digest, effective_argument_digest
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, identity.logicalToolCallId) as {
    argument_digest: string;
    raw_argument_digest: string;
    effective_argument_digest: string | null;
  };
  assert.equal(row.argument_digest, row.raw_argument_digest);
  assert.equal(row.effective_argument_digest, null);
});
