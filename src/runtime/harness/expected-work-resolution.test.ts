import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-expected-work-resolution-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-expected-work-resolution\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const resolution = await import('./resolution-ledger.js');
const projector = await import('./expected-work-observed-projector.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

interface Task {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
}

function accept(text: string): Task {
  const session = eventlog.createSession({ id: `expected-resolution-${++serial}`, kind: 'chat' });
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
  const frozen = contracts.freezeDeterministicExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

function settleProvider(input: {
  task: Task;
  id: string;
  tool: string;
  payload: unknown;
  args?: unknown;
  businessCall?: boolean;
  mutating?: boolean;
  empty?: boolean;
  continuesRequirement?: boolean;
  requirementId?: string;
}): void {
  const logicalToolCallId = `logical:${input.id}`;
  const physicalDispatchId = `dispatch:${input.id}`;
  const args = input.args ?? {};
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId,
      physicalDispatchId,
      ordinal: 0,
    },
    tool: input.tool,
    args,
  });
  assert.equal(begun.status, 'inserted');
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.tool,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...input.task, logicalToolCallId },
    contract: { toolName: input.tool, args },
    execution: { kind: 'provider_execution' },
    result: { payload: input.payload },
    outcome: input.empty
      ? outcomes.classifyAttemptOutcome({ envelopeSuccessful: true, emptyResult: true })
      : outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: {
      businessCall: input.businessCall !== false,
      mutating: input.mutating === true,
      ...(input.continuesRequirement ? { continuesRequirement: true } : {}),
      ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    },
    observer: { lane: 'composio', turn: input.task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
}

function state(task: Task): string | undefined {
  return (eventlog.openEventLog().prepare(`
    SELECT state FROM accepted_task_resolutions
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { state: string } | undefined)?.state;
}

test('direct zero-operation work finalizes synchronously and exactly replays', () => {
  const task = accept('Hello, how are you?');
  const first = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(first.status, 'finalized');
  assert.equal(first.status === 'finalized' && first.match.status, 'complete');
  assert.equal(state(task), 'finalized');
  const replay = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(replay.status, 'replayed');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['resolution_finalized'] }).length, 1);
});

test('replay fails closed when immutable contract bytes disappear after finalization', () => {
  const task = accept('Hello there.');
  assert.equal(resolution.finalizeResolutionAgainstExpectedWork(task).status, 'finalized');
  eventlog.openEventLog().prepare(`
    DELETE FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `).run(task.sessionId, task.sourceUserSeq);
  assert.equal(resolution.finalizeResolutionAgainstExpectedWork(task).status, 'conflict');
  assert.equal(resolution.frozenResolutionFor(task.sessionId, task.sourceUserSeq).status, 'ambiguous');
});

test('point and successful empty business reads discharge deterministic retrieve work', () => {
  for (const fixture of [
    { id: 'point', payload: { successful: true, data: { id: 'a' } }, empty: false },
    { id: 'empty', payload: { successful: true, data: null }, empty: true },
  ]) {
    const task = accept('What is the current status of the Acme account?');
    settleProvider({
      task,
      id: `${fixture.id}:${serial}`,
      tool: 'alpha_record_get_by_id',
      args: { id: fixture.id },
      payload: fixture.payload,
      empty: fixture.empty,
    });
    const result = resolution.finalizeResolutionAgainstExpectedWork(task);
    assert.equal(result.status, 'finalized', JSON.stringify(result));
    assert.equal(result.status === 'finalized' && result.match.status, 'complete');
  }
});

test('projector obtains explicit requirement identity from the exact settlement join', () => {
  const task = accept('What is the current status of the Acme account?');
  const loaded = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok');
  if (loaded.status !== 'ok') return;
  const requirementId = loaded.contract.operations[0]!.id;
  settleProvider({
    task,
    id: `explicit:${serial}`,
    tool: 'alpha_record_get_by_id',
    args: { id: 'acme' },
    payload: { successful: true, data: { id: 'acme' } },
    requirementId,
  });
  const projected = projector.projectObservedExpectedWorkHistory({
    contract: loaded.contract,
    finalized: true,
  });
  assert.equal(projected.status, 'ok');
  assert.equal(
    projected.status === 'ok' && projected.history.operations[0]?.requirementId,
    requirementId,
  );
  assert.equal(resolution.finalizeResolutionAgainstExpectedWork(task).status, 'finalized');
});

test('partial collection returns typed incomplete and does not irreversibly close', () => {
  const task = accept('Find all current alpha records.');
  settleProvider({
    task,
    id: `partial:${serial}`,
    tool: 'alpha_records_search',
    payload: {
      successful: true,
      data: { records: [{ id: 'a' }] },
      meta: { complete: false },
      next_cursor: 'opaque-next',
    },
  });
  const result = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(result.status, 'incomplete');
  assert.ok(result.status === 'incomplete' && result.match.gaps.some((gap) =>
    gap.kind === 'coverage_unproven'));
  assert.equal(state(task), 'open');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['resolution_finalized'] }).length, 0);
});

test('a continued partial read can complete under the same accepted task', () => {
  const task = accept('Find all current alpha records.');
  settleProvider({
    task,
    id: `continued-partial:${serial}`,
    tool: 'alpha_records_search',
    payload: {
      successful: true,
      data: { records: [{ id: 'a' }] },
      meta: { complete: false },
      next_cursor: 'opaque-next',
    },
    continuesRequirement: true,
  });
  const waiting = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(waiting.status, 'incomplete');
  assert.equal(state(task), 'open');

  settleProvider({
    task,
    id: `continued-complete:${serial}`,
    tool: 'alpha_records_search',
    payload: {
      successful: true,
      data: { records: [{ id: 'a' }, { id: 'b' }] },
      meta: { complete: true },
    },
  });
  const repaired = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(repaired.status, 'finalized', JSON.stringify(repaired));
  assert.equal(repaired.status === 'finalized' && repaired.match.status, 'complete');
});

test('two distinct implicit reads conflict and do not close by first-wins', () => {
  const task = accept('What is the current status of the Acme account?');
  for (const suffix of ['one', 'two']) {
    settleProvider({
      task,
      id: `${suffix}:${serial}`,
      tool: 'alpha_record_get_by_id',
      args: { id: suffix },
      payload: { successful: true, data: { id: suffix } },
    });
  }
  const result = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(result.status, 'conflict');
  assert.ok(result.status === 'conflict' && result.match.gaps.some((gap) =>
    gap.kind === 'requirement_ambiguous'));
  assert.equal(state(task), 'open');
});

test('an empty discovery call cannot satisfy accepted business retrieval', () => {
  const task = accept('Find all current alpha records.');
  settleProvider({
    task,
    id: `discovery:${serial}`,
    tool: 'alpha_records_search',
    payload: { successful: true, data: { records: [] }, meta: { complete: true } },
    empty: true,
    businessCall: false,
  });
  const result = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(result.status, 'incomplete');
  assert.ok(result.status === 'incomplete' && result.match.gaps.some((gap) =>
    gap.kind === 'requirement_unobserved'));
  assert.equal(state(task), 'open');
});

test('an undeclared successful mutation conflicts with a retrieve contract', () => {
  const task = accept('What is the current status of the Acme account?');
  settleProvider({
    task,
    id: `send:${serial}`,
    tool: 'email_send',
    payload: { successful: true, data: { id: 'message-1' } },
    mutating: true,
  });
  const result = resolution.finalizeResolutionAgainstExpectedWork(task);
  assert.equal(result.status, 'conflict');
  assert.ok(result.status === 'conflict' && result.match.gaps.some((gap) =>
    gap.kind === 'unexpected_effectful_observation'));
  assert.equal(state(task), 'open');
});

test('v31 makes every settlement authority field and the row itself immutable', () => {
  const task = accept('What is the current status of the Acme account?');
  const loaded = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok');
  if (loaded.status !== 'ok') return;
  const requirementId = loaded.contract.operations[0]!.id;
  settleProvider({
    task,
    id: `immutable:${serial}`,
    tool: 'alpha_record_get_by_id',
    args: { id: 'acme' },
    payload: { successful: true, data: { id: 'acme' } },
    requirementId,
  });
  const db = eventlog.openEventLog();
  assert.ok(db.prepare('SELECT 1 FROM schema_version WHERE version = 31').get());
  const logicalToolCallId = `logical:immutable:${serial}`;
  for (const assignment of [
    'requirement_id = NULL',
    'business_call = 0',
    'continues_requirement = 1',
    "outcome_kind = 'empty_result'",
  ]) {
    db.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => db.prepare(`
        UPDATE logical_call_settlements SET ${assignment}
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).run(task.sessionId, task.sourceUserSeq, logicalToolCallId), /immutable/i, assignment);
    } finally {
      db.exec('ROLLBACK');
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => db.prepare(`
      DELETE FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).run(task.sessionId, task.sourceUserSeq, logicalToolCallId), /immutable/i);
  } finally {
    db.exec('ROLLBACK');
  }
});

test('v31 standalone-delete guard preserves parent session retention cascades', () => {
  const task = accept('What is the current status of the Acme account?');
  settleProvider({
    task,
    id: `retention:${serial}`,
    tool: 'alpha_record_get_by_id',
    args: { id: 'acme' },
    payload: { successful: true, data: { id: 'acme' } },
  });
  const db = eventlog.openEventLog();
  assert.doesNotThrow(() => db.prepare('DELETE FROM sessions WHERE id = ?').run(task.sessionId));
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_call_settlements WHERE session_id = ?
  `).get(task.sessionId) as { n: number }).n, 0);
});

test('dropped settlement trigger corruption still fails exact finalization replay', () => {
  const task = accept('What is the current status of the Acme account?');
  const loaded = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok');
  if (loaded.status !== 'ok') return;
  settleProvider({
    task,
    id: `corrupt-settlement:${serial}`,
    tool: 'alpha_record_get_by_id',
    args: { id: 'acme' },
    payload: { successful: true, data: { id: 'acme' } },
    requirementId: loaded.contract.operations[0]!.id,
  });
  assert.equal(resolution.finalizeResolutionAgainstExpectedWork(task).status, 'finalized');
  const db = eventlog.openEventLog();
  db.exec('DROP TRIGGER IF EXISTS trg_logical_call_settlement_row_immutable');
  db.prepare(`
    UPDATE logical_call_settlements SET requirement_id = NULL
     WHERE session_id = ? AND source_user_seq = ?
  `).run(task.sessionId, task.sourceUserSeq);
  assert.equal(
    resolution.finalizeResolutionAgainstExpectedWork(task).status,
    'conflict',
    'implicit retrieve binding must not hide settlement-row corruption',
  );
});
