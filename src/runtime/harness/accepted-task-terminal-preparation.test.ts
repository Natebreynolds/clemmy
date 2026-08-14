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
const attempts = await import('./attempt-settlement.js');

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

function recordCanonicalSdkReturn(input: {
  task: ReturnType<typeof acceptActivatedAction>;
  tool: string;
  callId: string;
  successfulBusinessResult?: true;
  successfulAuthoringResult?: true;
}): void {
  const called = eventlog.appendEvent({
    sessionId: input.task.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: input.task.sourceUserSeq,
      tool: input.tool,
      callId: input.callId,
      canonicalCallId: input.callId,
      accounting: 'top_level',
      topologyRole: input.successfulAuthoringResult ? 'control' : 'business',
    },
  });
  eventlog.appendEvent({
    sessionId: input.task.sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: {
      sourceUserSeq: input.task.sourceUserSeq,
      tool: input.tool,
      callId: input.callId,
      canonicalCallId: input.callId,
      accounting: 'top_level',
      ok: true,
      ...(input.successfulBusinessResult ? { successfulBusinessResult: true } : {}),
      ...(input.successfulAuthoringResult ? { successfulAuthoringResult: true } : {}),
    },
  });
}

test('only the canonical successful SDK authoring return closes an uncontracted workflow-create action', () => {
  const task = acceptActivatedAction('Create a daily digest workflow.');
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: 1,
    role: 'system',
    type: 'sdk_tool_use_recorded',
    data: { sourceUserSeq: task.sourceUserSeq, tools: ['workflow_create'] },
  });
  const summaryOnly = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(summaryOnly.status, 'needs_verification', JSON.stringify(summaryOnly));

  recordCanonicalSdkReturn({
    task,
    tool: 'workflow_create',
    callId: 'toolu_workflow_create_success',
    successfulAuthoringResult: true,
  });
  const returned = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(returned.status, 'ready', JSON.stringify(returned));
  assert.match(
    returned.status === 'ready' ? returned.verdict.facts.join('; ') : '',
    /durable work evidence/,
  );
});

test('a successful-looking SDK control return without the host authoring verdict remains held', () => {
  const task = acceptActivatedAction('Create a daily digest workflow.');
  recordCanonicalSdkReturn({
    task,
    tool: 'workflow_create',
    callId: 'toolu_workflow_create_unproven',
  });
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.deepEqual(
    prepared.status === 'needs_verification' ? prepared.missing : [],
    ['work_contract_missing'],
  );
});

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
    data: { text: 'Write the current office calendar time to the local note now.' },
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
    result: { payload: { successful: true, data: { path: '/tmp/pin.txt', bytesWritten: 1 } } },
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

// A question about current state is retrieval, not an action whose lack of
// mutations can be waved through as conversation. It must remain read work and
// obtain accepted-source-local freshness evidence before publication.
test('a current-state question is not activated as an action and waits for read evidence', () => {
  const task = accept('what time is it?');
  const activated = admission.activateActionExpectedWork(task);
  assert.equal(activated.status, 'not_action', JSON.stringify(activated));
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.ok(
    prepared.status === 'needs_verification'
      && (
        prepared.missing.includes('requirement_unobserved')
        || prepared.missing.includes('freshness_current_state_read_missing')
      ),
    JSON.stringify(prepared),
  );
});


// The classifier reads reply-directives as action intent ("ping — reply with
// one word" scored action 0.65, identical to a real work ask). The reply
// decides: claim-free content publishes; a claim-shaped "Done." with zero
// evidence still holds (live 2026-08-11 dev-daemon smoke: plain ping was
// replaced by the verification hold on the real home).
test('a zero-evidence action terminal publishes a claim-free reply and holds a claim-shaped one', () => {
  const task = acceptActivatedAction('ping the harness and reply with one word please');
  const published = preparation.prepareAcceptedTaskTerminal({ ...task, proposedReply: 'pong' });
  assert.equal(published.status, 'ready', JSON.stringify(published));
  const held = preparation.prepareAcceptedTaskTerminal({ ...task, proposedReply: 'Done from the model.' });
  assert.equal(held.status, 'needs_verification', JSON.stringify(held));
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

test('a retrieve answered through an unbound local CLI execution publishes done (live 2026-08-11)', () => {
  // The exact incident shape: "How do I access Salesforce?" compiled to the
  // deterministic retrieve route, the model answered through one read-only
  // `sf` CLI call (an UNBOUND agents_runner local execution, classified
  // 'compute' by the safety taxonomy), the answer was complete and the
  // delivery verdict passed — and the terminal still blocked as
  // verification_required, replacing the answer with fallback text.
  const task = accept('How do I access Salesforce?');
  const args = { command: 'sf org display user --json' };
  const logicalToolCallId = `logical:terminal-preparation:${serial}:shell`;
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId },
    tool: 'run_shell_command',
    args,
  }).status, 'inserted');
  const settled = attempts.settleToolAttempt({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    lane: 'agents_runner',
    toolName: 'run_shell_command',
    callId: logicalToolCallId,
    args,
    mutating: false,
    businessCall: true,
    result: JSON.stringify({
      status: 0,
      result: {
        instanceUrl: 'https://example.my.salesforce.com',
        username: 'user@example.com',
        connectedStatus: 'Connected',
      },
    }),
  });
  assert.equal(settled.outcome.kind, 'succeeded', JSON.stringify(settled.outcome));

  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'Go to https://example.my.salesforce.com and sign in as user@example.com.',
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.status === 'ready' && prepared.verdict.status, 'done');
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['resolution_finalized'] }).length,
    1,
    'the retrieve resolution finalizes instead of holding the turn open',
  );
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['obligation_manifest'] }).length,
    1,
  );
});

test('a retrieve answered by a provider collection read without a completeness signal publishes done (live 2026-08-12)', () => {
  // The calendar incident: "What's on my calendar tomorrow?" compiled to the
  // deterministic retrieve route; the Composio Outlook read dispatched,
  // settled succeeded with 10 records, NO cursor and completeness 'unknown' —
  // a bounded view has nothing more to say. The old completeness obligation
  // demanded exhaustion proof the provider cannot express, and the terminal
  // replaced a correct grounded answer with verification_required fallback.
  const task = accept('Find all current alpha records.');
  settleRead({
    task,
    tool: 'alpha_records_list_view',
    args: { window: 'tomorrow' },
    payload: {
      successful: true,
      data: { records: [{ id: 'evt-1' }, { id: 'evt-2' }] },
      // Deliberately NO meta.complete and NO cursor: completeness stays
      // 'unknown', which previously could never discharge the read.
    },
  });
  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'You have two events tomorrow.',
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.status === 'ready' && prepared.verdict.status, 'done');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['resolution_finalized'] }).length, 1);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['evidence_receipt'] }).length, 1);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_satisfied'] }).length, 1);
});
