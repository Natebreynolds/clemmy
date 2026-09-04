import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-work-denial-latch-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-work-denial-latch\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const admission = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const currentCapabilities = await import('./current-capability-manifest.fixture.js');

const OPERATION = 'FIXTURE_UPDATE_RECORD';
const READ_OPERATION = 'FIXTURE_LIST_RECORDS';
const CAPABILITY_REQUIREMENT = `cap:resolved:${OPERATION.toLowerCase()}:definition:${'a'.repeat(24)}`;
const ARGS = { record_id: 'record-1', value: 'ready' };
const ASK = 'Update one record with the approved value.';
const COUNT_ASK = 'Find five suitable prospects, then create five reversible drafts for them.';
const COUNT_MEMBERS = ['prospect-a', 'prospect-b', 'prospect-c', 'prospect-d', 'prospect-e'];

const priorCapabilityCatalog = currentCapabilities.installCurrentCapabilityManifestFixtures([
  {
    operationId: OPERATION,
    providerKind: 'native_mcp',
    effect: 'external_write',
    operationSemantics: { version: 1, reversibility: 'reversible' },
  },
  {
    operationId: READ_OPERATION,
    providerKind: 'native_mcp',
    effect: 'read',
  },
]);

test.after(() => {
  currentCapabilities.restoreCurrentCapabilityManifestFixtures(priorCapabilityCatalog);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function acceptAction(label: string, text = ASK) {
  const id = ++serial;
  const session = eventlog.createSession({ id: `denial-latch-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }), 'fixture graph persisted');
  const activated = admission.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  return {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    label: `${label}-${id}`,
  };
}

function proposal() {
  return {
    version: 1 as const,
    operations: [{
      id: CAPABILITY_REQUIREMENT,
      effect: 'external_write' as const,
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' as const },
    }],
    universes: [],
  };
}

function countOnlyProposal() {
  return {
    version: 1 as const,
    operations: [{
      id: CAPABILITY_REQUIREMENT,
      effect: 'external_write' as const,
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'each' as const, universeId: 'prospects' },
    }],
    universes: [{
      id: 'prospects',
      seal: 'accepted_input' as const,
      members: COUNT_MEMBERS,
    }],
  };
}

function openExactCall(
  task: ReturnType<typeof acceptAction>,
  suffix: string,
  tool: string,
  args: unknown,
): string {
  const logicalToolCallId = `logical:${task.label}:${suffix}`;
  const opened = dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId },
    tool,
    args,
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  return logicalToolCallId;
}

function openCall(task: ReturnType<typeof acceptAction>, suffix: string): string {
  return openExactCall(task, suffix, OPERATION, ARGS);
}

function settleSourceMembers(task: ReturnType<typeof acceptAction>): string {
  const args = { scope: 'prospects' };
  const logicalToolCallId = openExactCall(task, 'source-members', READ_OPERATION, args);
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId,
      physicalDispatchId: `dispatch:${task.label}:source-members`,
      ordinal: 1,
    },
    tool: READ_OPERATION,
    args,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error(JSON.stringify(begun));
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: READ_OPERATION,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: READ_OPERATION, args },
    execution: { kind: 'provider_execution' },
    result: {
      payload: {
        successful: true,
        complete: true,
        records: COUNT_MEMBERS.map((id) => ({ id, name: `Name ${id}` })),
      },
    },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'native_mcp', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  return logicalToolCallId;
}

function bind(input: {
  task: ReturnType<typeof acceptAction>;
  logicalToolCallId: string;
  withProposal: boolean;
}) {
  return admission.admitExpectedWorkInvocation({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    logicalToolCallId: input.logicalToolCallId,
    proposal: input.withProposal ? proposal() : null,
    // The provider/model operation slug is the transport spelling of the
    // frozen capability requirement, not a second model-authored work id.
    requirementId: OPERATION,
    tool: OPERATION,
    args: ARGS,
  });
}

function settlePreDispatchPolicyMiss(
  task: ReturnType<typeof acceptAction>,
  logicalToolCallId: string,
): void {
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: OPERATION, args: ARGS },
    execution: { kind: 'refused_pre_dispatch' },
    outcome: outcomes.classifyAttemptOutcome({ preDispatch: true, policyRefused: true }),
    recovery: {
      businessCall: true,
      mutating: true,
      requirementId: CAPABILITY_REQUIREMENT,
    },
    observer: { lane: 'native_mcp', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  const row = eventlog.openEventLog().prepare(`
    SELECT outcome_kind, execution_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId);
  assert.deepEqual(row, {
    outcome_kind: 'policy_denial',
    execution_kind: 'refused_pre_dispatch',
    physical_crossing_count: 0,
  });
}

test('provider operation slug binds the unique frozen definition-qualified capability requirement', () => {
  const task = acceptAction('operation-identity');
  const result = bind({ task, logicalToolCallId: openCall(task, 'first'), withProposal: true });
  assert.equal(result.status, 'bound', JSON.stringify(result));
  if (result.status === 'bound') {
    assert.equal(result.binding.requirementId, CAPABILITY_REQUIREMENT);
  }
});

test('zero-crossing pre-dispatch policy denial does not latch the requirement closed', () => {
  const task = acceptAction('policy-miss');
  const first = openCall(task, 'first');
  const firstAdmission = bind({ task, logicalToolCallId: first, withProposal: true });
  assert.equal(firstAdmission.status, 'bound', JSON.stringify(firstAdmission));
  settlePreDispatchPolicyMiss(task, first);

  const retried = bind({ task, logicalToolCallId: openCall(task, 'retry'), withProposal: false });
  assert.equal(retried.status, 'bound', JSON.stringify(retried));
  if (retried.status === 'refused') {
    assert.doesNotMatch(
      retried.reason,
      /the prior policy_denial outcome authorizes no retry for this requirement/,
    );
  }
});

test('count-only each write binds from a settled result handle without a model selector', () => {
  const task = acceptAction('settled-members', COUNT_ASK);
  const sourceCallId = settleSourceMembers(task);
  const args = { recipient_email: 'one@example.test', body: 'reversible draft' };
  const logicalToolCallId = openExactCall(task, 'draft-one', OPERATION, args);
  const admitted = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId,
    proposal: countOnlyProposal(),
    requirementId: OPERATION,
    universeItemId: COUNT_MEMBERS[0],
    universeSelector: null,
    tool: OPERATION,
    args,
  });
  assert.equal(admitted.status, 'bound', JSON.stringify(admitted));
  const row = eventlog.openEventLog().prepare(`
    SELECT universe_item_id, universe_selector_json,
           input_source_kind, input_source_ref
      FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId);
  assert.deepEqual(row, {
    universe_item_id: COUNT_MEMBERS[0],
    universe_selector_json: JSON.stringify({ argumentPointer: '', memberIdPointer: null }),
    input_source_kind: 'complete_source_receipt',
    input_source_ref: sourceCallId,
  });
});

test('count-only each write can bind from its own concrete target without a result handle', () => {
  const task = acceptAction('call-target', COUNT_ASK);
  const args = { recipient_email: 'one@example.test', body: 'reversible draft' };
  const logicalToolCallId = openExactCall(task, 'draft-one', OPERATION, args);
  const admitted = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId,
    proposal: countOnlyProposal(),
    requirementId: OPERATION,
    universeItemId: COUNT_MEMBERS[0],
    universeSelector: null,
    tool: OPERATION,
    args,
  });
  assert.equal(admitted.status, 'bound', JSON.stringify(admitted));
  const row = eventlog.openEventLog().prepare(`
    SELECT universe_item_id, universe_selector_json,
           input_source_kind, input_source_ref
      FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId);
  assert.deepEqual(row, {
    universe_item_id: COUNT_MEMBERS[0],
    universe_selector_json: JSON.stringify({ argumentPointer: '', memberIdPointer: null }),
    input_source_kind: 'complete_source_receipt',
    input_source_ref: logicalToolCallId,
  });
});
