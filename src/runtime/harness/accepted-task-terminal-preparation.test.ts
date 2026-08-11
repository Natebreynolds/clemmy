import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-terminal-preparation-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-terminal-preparation\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const authority = await import('./accepted-task-authority.js');
const preparation = await import('./accepted-task-terminal-preparation.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(text: string) {
  const session = eventlog.createSession({ id: `terminal-preparation-${++serial}`, kind: 'chat' });
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
  const fixed = contracts.freezeDeterministicExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(fixed.status === 'fixed' || fixed.status === 'replayed', JSON.stringify(fixed));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

function settleRead(input: {
  task: ReturnType<typeof accept>;
  tool: string;
  args: unknown;
  payload: unknown;
}) {
  const logicalToolCallId = `logical:terminal-preparation:${serial}`;
  const physicalDispatchId = `dispatch:terminal-preparation:${serial}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId,
      physicalDispatchId,
      ordinal: 0,
    },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(begun.status, 'inserted');
  if (begun.status !== 'inserted') throw new Error(begun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.tool,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...input.task, logicalToolCallId },
    contract: { toolName: input.tool, args: input.args },
    execution: { kind: 'provider_execution' },
    result: { payload: input.payload },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: input.task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  return { logicalToolCallId, physicalDispatchId };
}

test('a direct conversation prepares a real zero-obligation terminal without provider work', () => {
  const task = accept('Hello, how are you?');
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.status === 'ready' && prepared.verdict.status, 'done');
  const loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'manifested_verifying');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_manifest'] }).length, 1);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['evidence_receipt'] }).length, 0);
});

test('a settled complete read mints and satisfies host evidence at the production seam', () => {
  const task = accept('Find all current alpha records.');
  settleRead({
    task,
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
    payload: {
      successful: true,
      data: { records: [{ id: 'a' }, { id: 'b' }] },
      meta: { complete: true },
    },
  });
  const first = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(first.status, 'ready', JSON.stringify(first));
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['evidence_receipt'] }).length, 1);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_satisfied'] }).length, 1);

  eventlog.closeEventLog();
  const replay = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(replay.status, 'ready', JSON.stringify(replay));
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['evidence_receipt'] }).length, 1);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_satisfied'] }).length, 1);
});

test('an incomplete collection remains repairable and cannot freeze a manifest', () => {
  const task = accept('Find all current alpha records.');
  settleRead({
    task,
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
    payload: {
      successful: true,
      data: { records: [{ id: 'a' }] },
      meta: { complete: false },
      next_cursor: 'opaque-next',
    },
  });
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  const loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'armed');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['resolution_finalized'] }).length, 0);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_manifest'] }).length, 0);
});

test('an accepted action that bypassed durable activation fails closed at terminal preparation', () => {
  const session = eventlog.createSession({ id: `terminal-preparation-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Email alex@example.com with the update.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  assert.deepEqual(contracts.requireKnownExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }), { status: 'action_deferred' });
  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(prepared.status, 'conflict', JSON.stringify(prepared));
  assert.match(
    prepared.status === 'conflict' ? prepared.reason : '',
    /not durably activated before execution/,
  );
});
