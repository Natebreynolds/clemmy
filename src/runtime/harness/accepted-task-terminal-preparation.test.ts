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
const admission = await import('./expected-work-admission.js');
const workManifest = await import('./work-manifest.js');

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

function acceptActivatedAction(text: string) {
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
  const activated = admission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

// The fan-out lane's durable work manifest is completion authority for an
// accepted action that never froze a work_call contract: refusing it replaced
// a fully settled 12/12 completion with a canned blocked terminal (live
// 2026-08-11, long-horizon-manifest run 5).
test('a fully settled source-bound work manifest publishes done without a frozen work contract', () => {
  const task = acceptActivatedAction('Email alex@example.com the update for every record.');
  workManifest.declareWorkManifest({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    manifestId: 'pin-fanout-manifest',
    contractVersion: '1',
    phases: [{ id: 'analyze' }, { id: 'validate', dependsOn: ['analyze'] }],
    items: [{ id: 'record-001' }, { id: 'record-002' }],
  });
  for (const phase of ['analyze', 'validate']) {
    for (const itemId of ['record-001', 'record-002']) {
      workManifest.checkpointWorkItem({
        sessionId: task.sessionId,
        manifestId: 'pin-fanout-manifest',
        contractVersion: '1',
        phase,
        itemId,
        status: 'succeeded',
        evidence: [{ kind: 'worker_result', ref: `worker:${phase}:${itemId}` }],
      });
    }
  }
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.status === 'ready' && prepared.verdict.status, 'done');
  assert.match(
    prepared.status === 'ready' ? prepared.verdict.facts.join('; ') : '',
    /4 item-phase\(s\)/,
  );
});


// A mid-run contract revision (steer) supersedes earlier checkpoints; they
// remain in the ledger as STALE history. Completion is judged on canonical
// current coverage — a steered task that redid all items under v2 carried 42
// stale v1 rows and was wrongly blocked (live 2026-08-11,
// background-steer-in-flight, goal validation had already passed).
test('a revised manifest fully settled under the new contract publishes despite stale rows', () => {
  const task = acceptActivatedAction('Email alex@example.com the update for every record.');
  workManifest.declareWorkManifest({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    manifestId: 'pin-steered-manifest',
    contractVersion: '1',
    phases: [{ id: 'research' }],
    items: [{ id: 'account-01' }],
  });
  workManifest.checkpointWorkItem({
    sessionId: task.sessionId,
    manifestId: 'pin-steered-manifest',
    contractVersion: '1',
    phase: 'research',
    itemId: 'account-01',
    status: 'succeeded',
    evidence: [{ kind: 'worker_result', ref: 'worker:v1:account-01' }],
  });
  workManifest.reviseWorkContract({
    sessionId: task.sessionId,
    manifestId: 'pin-steered-manifest',
    fromVersion: '1',
    toVersion: '2',
    instruction: 'Use the corrected keyword for every account.',
    evidencePolicy: 'redo',
  });
  workManifest.checkpointWorkItem({
    sessionId: task.sessionId,
    manifestId: 'pin-steered-manifest',
    contractVersion: '2',
    phase: 'research',
    itemId: 'account-01',
    status: 'succeeded',
    evidence: [{ kind: 'worker_result', ref: 'worker:v2:account-01' }],
  });
  const summary = workManifest.summarizeWorkManifest(task.sessionId, 'pin-steered-manifest');
  assert.ok((summary?.staleCheckpoints ?? 0) > 0, 'the superseded v1 checkpoint is stale history');
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.status === 'ready' && prepared.verdict.status, 'done');
});

test('a half-settled work manifest keeps the verification gap and names the open phases', () => {
  const task = acceptActivatedAction('Email alex@example.com the update for every record.');
  workManifest.declareWorkManifest({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    manifestId: 'pin-open-manifest',
    contractVersion: '1',
    phases: [{ id: 'analyze' }],
    items: [{ id: 'record-001' }, { id: 'record-002' }],
  });
  workManifest.checkpointWorkItem({
    sessionId: task.sessionId,
    manifestId: 'pin-open-manifest',
    contractVersion: '1',
    phase: 'analyze',
    itemId: 'record-001',
    status: 'succeeded',
    evidence: [{ kind: 'worker_result', ref: 'worker:analyze:record-001' }],
  });
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.match(
    prepared.status === 'needs_verification' ? prepared.reason : '',
    /not fully settled/,
  );
  assert.deepEqual(
    prepared.status === 'needs_verification' ? prepared.missing : [],
    ['cardinality_item_missing'],
  );
});

test('a worked turn without manifest or contract publishes on its durable work evidence', () => {
  // The dispatch lands in the pre-activation window (restart/bridge race) —
  // post-activation, the dispatch-ledger backstop refuses unbound dispatch
  // outright. A turn that DID work publishes as it always has; the
  // zero-evidence action-claim pin below is what fails closed.
  const session = eventlog.createSession({ id: `terminal-preparation-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'what time is it in the office calendar?' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const task = { sessionId: session.id, sourceUserSeq: source.seq };
  const identity = {
    ...task,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    logicalToolCallId: `logical:terminal-preparation:mutating:${serial}`,
    physicalDispatchId: `dispatch:terminal-preparation:mutating:${serial}`,
    ordinal: 0,
  };
  // A provider business dispatch is refused pre-dispatch without a binding
  // (work_binding_required backstop) — the mutation lane this branch guards is
  // the LOCAL one, where a mutating local execution settles without any
  // provider crossing.
  const begun = dispatch.beginPhysicalDispatch({
    identity,
    tool: 'write_file',
    args: { path: '/tmp/pin.txt', content: 'x' },
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error(begun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: 'write_file',
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: {
      ...task,
      turn: 1,
      acceptedTaskId: identity.acceptedTaskId,
      logicalToolCallId: identity.logicalToolCallId,
    },
    contract: { toolName: 'write_file', args: { path: '/tmp/pin.txt', content: 'x' } },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', turn: 1 },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  const activated = admission.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.match(
    prepared.status === 'ready' ? prepared.verdict.facts.join('; ') : '',
    /durable work evidence/,
  );
});

// The route classifier sends plain conversational asks down the act route
// ("what time is it?" classifies act). An activated action that settled zero
// mutating calls and owns no manifest was answered in conversation — blocking
// it replaced ordinary replies with a canned verification refusal.
test('an activated action with zero mutating settlements publishes the conversational terminal', () => {
  const task = acceptActivatedAction('what time is it?');
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.match(
    prepared.status === 'ready' ? prepared.verdict.facts.join('; ') : '',
    /conversational reply is the terminal/,
  );
});

test('a zero-call done claim on an action-intent ask still fails closed', () => {
  const task = acceptActivatedAction('Email alex@example.com the update for every record.');
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.deepEqual(
    prepared.status === 'needs_verification' ? prepared.missing : [],
    ['work_contract_missing'],
  );
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
