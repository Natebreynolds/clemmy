import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-attempt-settlement-atomic-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-attempt-settlement\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identity = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const governorModule = await import('./discovery-governor.js');
const settlement = await import('./attempt-settlement.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(label: string) {
  const session = eventlog.createSession({ id: `attempt-atomic-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Read the ${label} records and report what you find.` },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identity.acceptedTaskIdFor(session.id, source.seq),
  };
}

function admitReturnedProviderCall(input: {
  task: ReturnType<typeof accept>;
  logicalToolCallId: string;
  tool: string;
  args: unknown;
}) {
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId: input.logicalToolCallId,
      physicalDispatchId: `dispatch:${input.logicalToolCallId}`,
      ordinal: 0,
    },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') throw new Error('provider fixture was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool: input.tool,
    outcome: 'returned',
  }).status, 'inserted');
}

test('settleToolAttempt commits once and an exact carrier replay returns the persisted first verdict', () => {
  const task = accept('exact replay');
  const tool = 'alpha__read_records';
  const args = { query: 'current' };
  const providerResult = { successful: true, data: [{ id: 'row-1' }] };
  const logicalToolCallId = 'logical:exact-replay';
  admitReturnedProviderCall({ task, logicalToolCallId, tool, args });

  const first = settlement.settleToolAttempt({
    ...task,
    lane: 'native_mcp',
    toolName: tool,
    callId: logicalToolCallId,
    args,
    businessCall: true,
    result: providerResult,
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.outcome.kind, 'succeeded');

  const replay = settlement.settleToolAttempt({
    ...task,
    lane: 'agents_runner',
    toolName: tool,
    callId: logicalToolCallId,
    args,
    businessCall: true,
    result: providerResult,
  });
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.outcome, first.outcome, 'the first durable verdict is returned');
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] }).length,
    1,
  );
});

test('candidate elimination survives cache reset without spending an already-unused discovery epoch', () => {
  const task = accept('unsupported candidate');
  const governor = new governorModule.DiscoveryGovernor();
  governor.initializeTask({ ...task, knownCapability: true });
  const tool = 'alpha__unsupported_read';
  const args = { query: 'current' };
  const logicalToolCallId = 'logical:unsupported';
  admitReturnedProviderCall({ task, logicalToolCallId, tool, args });

  const first = settlement.settleToolAttempt({
    ...task,
    lane: 'composio',
    toolName: tool,
    callId: logicalToolCallId,
    args,
    businessCall: true,
    result: { status: 404, successful: false },
  });
  assert.equal(first.outcome.directive.eliminatesCandidate, true);
  assert.equal(first.openedDiscoveryEpoch, false);
  assert.equal(governor.getTaskState(task)?.policy.epoch, 0);

  settlement._resetAttemptSettlementStateForTests();
  assert.equal(
    settlement.candidateEliminatedForTask(task.sessionId, task.sourceUserSeq, tool),
    true,
    'normalized settlement rows, not process memory, own elimination',
  );
  assert.deepEqual(
    settlement.eliminatedCandidatesForTask(task.sessionId, task.sourceUserSeq),
    [tool],
  );
});

test('two logical calls for one canonical completed step credit progress only once', () => {
  const task = accept('distinct progress');
  const governor = new governorModule.DiscoveryGovernor();
  governor.initializeTask({ ...task, knownCapability: false });
  assert.equal(governor.admit({
    ...task,
    category: 'broad_discovery',
    callId: 'seed-search',
  }).admitted, true);
  const tool = 'alpha__read_records';
  const args = { end: 'D3', start: 'D1' };
  const credits: boolean[] = [];
  for (const suffix of ['first', 'second']) {
    const logicalToolCallId = `logical:progress-${suffix}`;
    admitReturnedProviderCall({ task, logicalToolCallId, tool, args });
    credits.push(settlement.settleToolAttempt({
      ...task,
      lane: 'composio',
      toolName: tool,
      callId: logicalToolCallId,
      args,
      businessCall: true,
      result: { successful: true, data: [{ id: 'same-row' }] },
    }).creditedProgress);
  }
  assert.deepEqual(credits, [true, false]);
  assert.equal(governor.getTaskState(task)?.policy.epoch, 1);
});

test('a missing logical call fails closed instead of masquerading as a duplicate', () => {
  const task = accept('missing logical call');
  assert.throws(
    () => settlement.settleToolAttempt({
      ...task,
      lane: 'code_mode',
      toolName: 'alpha__read_records',
      callId: 'logical:not-admitted',
      args: { query: 'current' },
      businessCall: true,
      result: { successful: true, data: [{ id: 'row-1' }] },
    }),
    (error: unknown) => {
      assert.ok(error instanceof settlement.ToolAttemptSettlementAuthorityError);
      assert.equal(error.status, 'missing');
      return true;
    },
  );
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] }).length,
    0,
  );
});

test('contract conflict and storage failure surface as typed authority errors', () => {
  const conflictTask = accept('contract conflict');
  const tool = 'alpha__read_records';
  const logicalToolCallId = 'logical:contract-conflict';
  admitReturnedProviderCall({
    task: conflictTask,
    logicalToolCallId,
    tool,
    args: { query: 'admitted' },
  });
  assert.throws(
    () => settlement.settleToolAttempt({
      ...conflictTask,
      lane: 'native_mcp',
      toolName: tool,
      callId: logicalToolCallId,
      args: { query: 'different' },
      businessCall: true,
      result: { successful: true, data: [{ id: 'row-1' }] },
    }),
    (error: unknown) => {
      assert.ok(error instanceof settlement.ToolAttemptSettlementAuthorityError);
      assert.equal(error.status, 'conflict');
      return true;
    },
  );

  const storageTask = accept('storage failure');
  const storageLogicalId = 'logical:storage-failure';
  const args = { query: 'current' };
  admitReturnedProviderCall({ task: storageTask, logicalToolCallId: storageLogicalId, tool, args });
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_attempt_settlement_insert_failure
    BEFORE INSERT ON logical_call_settlements
    BEGIN
      SELECT RAISE(ABORT, 'forced attempt settlement failure');
    END;
  `);
  try {
    assert.throws(
      () => settlement.settleToolAttempt({
        ...storageTask,
        lane: 'native_mcp',
        toolName: tool,
        callId: storageLogicalId,
        args,
        businessCall: true,
        result: { successful: true, data: [{ id: 'row-1' }] },
      }),
      (error: unknown) => {
        assert.ok(error instanceof settlement.ToolAttemptSettlementAuthorityError);
        assert.equal(error.status, 'storage_error');
        assert.match(error.reason, /forced attempt settlement failure/);
        return true;
      },
    );
  } finally {
    db.exec('DROP TRIGGER force_attempt_settlement_insert_failure');
  }
  assert.equal(
    eventlog.listEvents(storageTask.sessionId, { types: ['tool_attempt_settled'] }).length,
    0,
  );
});
