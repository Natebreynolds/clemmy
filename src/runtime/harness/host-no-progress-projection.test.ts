import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-no-progress-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  projectHostNoProgressAttempt,
  projectHostNoProgressAuthority,
} = await import('./host-no-progress-projection.js');
const eventlog = await import('./eventlog.js');
const {
  appendEvent,
  createSession,
} = eventlog;
const { buildHostToolDispositionResult } = await import('./host-model-result-receipt.js');
const {
  NO_PROGRESS_RECOVERY_TOOL_NAME_CAP,
  initializeNoProgressGovernor,
  observeNoProgress,
  NO_PROGRESS_RETRY_BUDGET,
} = await import('./no-progress-governor.js');
const { discoveryGovernor } = await import('./discovery-governor.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function accepted(label: string) {
  const session = createSession({ id: `no-progress-projection-${label}`, kind: 'chat' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: label },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function call(callId: string, name: string) {
  return { type: 'function_call', callId, name, arguments: '{}' };
}

function result(callId: string, name: string, text = 'settled') {
  return {
    type: 'function_call_result',
    callId,
    name,
    output: { type: 'text', text },
  };
}

function initializeDiscoveryRole(
  identity: ReturnType<typeof accepted>,
  roleKey = 'clause-0:unknown',
): string {
  discoveryGovernor.initializeTask({
    ...identity,
    knownCapability: false,
  });
  discoveryGovernor.initializeRoles({
    ...identity,
    requirements: [{
      roleKey,
      clauseIndex: 0,
      text: 'complete the accepted capability requirement',
      resolved: false,
    }],
    brokerCoverage: 'authorized_external_v1',
  });
  return roleKey;
}

function appendSettledDiscoveryStage(input: {
  identity: ReturnType<typeof accepted>;
  roleKey: string;
  callId: string;
  capabilityRef: string;
  effect: 'read' | 'external_write' | 'local_write';
  query?: string;
  summary?: string;
  siblings?: ReadonlyArray<{
    capabilityRef: string;
    effect: 'read' | 'external_write' | 'local_write';
  }>;
}): void {
  appendEvent({
    sessionId: input.identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'discovery_governor_decision',
    data: {
      sourceUserSeq: input.identity.sourceUserSeq,
      category: 'broad_discovery',
      subject: input.roleKey,
      callId: input.callId,
      decision: 'admitted',
    },
  });
  const capabilities = [{ capabilityRef: input.capabilityRef, effect: input.effect },
    ...(input.siblings ?? [])];
  appendEvent({
    sessionId: input.identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: input.identity.sourceUserSeq,
      capabilities: capabilities.map((candidate) => ({
        capabilityRef: candidate.capabilityRef,
        descriptor: {
          id: candidate.capabilityRef,
          effect: candidate.effect,
        },
      })),
    },
  });
  eventlog.writeToolOutput({
    sessionId: input.identity.sessionId,
    callId: input.callId,
    tool: 'tool_search',
    output: JSON.stringify({
      query: input.query ?? `model prose ${input.callId}`,
      role_key: input.roleKey,
      results: [
        {
          capabilityRef: input.capabilityRef,
          summary: input.summary ?? `arbitrary prose ${input.callId}`,
        },
        ...(input.siblings ?? []).map((candidate) => ({
          capabilityRef: candidate.capabilityRef,
          summary: `lower-ranked sibling ${candidate.capabilityRef}`,
        })),
      ],
    }),
  });
  appendEvent({
    sessionId: input.identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'discovery_governor_outcome',
    data: {
      sourceUserSeq: input.identity.sourceUserSeq,
      callId: input.callId,
      outcome: 'succeeded',
    },
  });
}

function settlementDb(entries: Array<{
  callId: string;
  executionKind?: string;
  outcomeKind: string;
  recoveryAction: string;
  businessCall?: number;
  mutating?: number;
  requiresReconciliation?: number;
  physicalCrossingCount?: number;
  hostCrossingCount?: number;
  /** Bounded host-owned outcome detail (mirrors the real column, <= 160). */
  outcomeDetail?: string;
}>, identity: ReturnType<typeof accepted>): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE logical_call_settlements (
      logical_tool_call_id TEXT NOT NULL,
      observer_call_id TEXT,
      execution_kind TEXT NOT NULL,
      outcome_kind TEXT NOT NULL,
      recovery_action TEXT NOT NULL,
      business_call INTEGER NOT NULL,
      mutating INTEGER NOT NULL,
      requires_reconciliation INTEGER NOT NULL,
      physical_crossing_count INTEGER NOT NULL,
      host_crossing_count INTEGER,
      outcome_detail TEXT CHECK (outcome_detail IS NULL OR length(outcome_detail) <= 160),
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO logical_call_settlements
      (logical_tool_call_id, observer_call_id, execution_kind, outcome_kind,
       recovery_action, business_call, mutating, requires_reconciliation,
       physical_crossing_count, host_crossing_count, outcome_detail,
       session_id, source_user_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const entry of entries) insert.run(
    entry.callId,
    entry.callId,
    entry.executionKind ?? 'refused_pre_dispatch',
    entry.outcomeKind,
    entry.recoveryAction,
    entry.businessCall ?? 0,
    entry.mutating ?? 0,
    entry.requiresReconciliation ?? 0,
    entry.physicalCrossingCount ?? 0,
    entry.hostCrossingCount ?? 0,
    entry.outcomeDetail ?? null,
    identity.sessionId,
    identity.sourceUserSeq,
  );
  return db;
}

test('all same-source citable catalog growth collapses to one pre-graph transition', () => {
  const identity = accepted('citable');
  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      capabilities: [
        { identifier: 'hint-only', schemaFingerprint: 'schema-hint' },
        {
          identifier: 'exact-one',
          capabilityRef: 'capability:one',
          schemaFingerprint: 'schema-one',
          accountIdentity: 'account:one',
        },
      ],
    },
  });
  const unrelated = accepted('unrelated');
  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: unrelated.sourceUserSeq,
      capabilities: [{ capabilityRef: 'capability:other', accountIdentity: 'account:other' }],
    },
  });

  const projected = projectHostNoProgressAuthority(identity);
  assert.equal(projected.status, 'ok');
  if (projected.status !== 'ok') return;
  assert.equal(projected.authority.operation.length, 1);
  assert.equal(projected.authority.account.length, 0, 'catalog account candidates are not selections');
  assert.equal(projected.authority.operation[0]?.length, 64, 'raw operation id stays private');
  assert.doesNotMatch(JSON.stringify(projected.authority), /capability:one|account:one/);

  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      capabilities: [
        { capabilityRef: 'capability:two', accountIdentity: 'account:two' },
        { capabilityRef: 'capability:three', accountIdentity: 'account:three' },
      ],
    },
  });
  const grown = projectHostNoProgressAuthority(identity);
  assert.equal(grown.status, 'ok');
  if (grown.status !== 'ok') return;
  assert.deepEqual(grown.authority, projected.authority);
});

test('each distinct exact write ref disclosed is its own effect gain; re-disclosure and siblings are not', () => {
  const identity = accepted('write-refs');
  const disclose = (capabilities: Record<string, unknown>[]) => appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: { sourceUserSeq: identity.sourceUserSeq, capabilities },
  });
  // The first broad search discloses unrelated writes (live 2026-09-01:
  // workflow_run/create/edit_step) plus reads.
  disclose([
    { identifier: 'workflow_run', capabilityRef: 'cap:local:workflow_run', effectClass: 'write' },
    { identifier: 'workflow_create', capabilityRef: 'cap:local:workflow_create', effectClass: 'write' },
    { identifier: 'soql', capabilityRef: 'cap:live:soql', effectClass: 'read' },
  ]);
  const first = projectHostNoProgressAuthority(identity);
  assert.equal(first.status, 'ok');
  if (first.status !== 'ok') return;
  assert.equal(first.authority.effect.length, 3, 'one write class token + one token per exact write ref');
  assert.doesNotMatch(JSON.stringify(first.authority), /workflow_run|workflow_create|cap:local/);

  // Re-disclosing the same writes (a reworded query) mints nothing.
  disclose([
    { identifier: 'workflow_create', capabilityRef: 'cap:local:workflow_create', effectClass: 'write' },
    { identifier: 'workflow_run', capabilityRef: 'cap:local:workflow_run', effectClass: 'write' },
  ]);
  const repeated = projectHostNoProgressAuthority(identity);
  assert.equal(repeated.status, 'ok');
  if (repeated.status !== 'ok') return;
  assert.deepEqual(repeated.authority, first.authority);

  // The refusal's prescribed search discloses the exact write the draft
  // lacked: a genuinely new effect authority, not another sibling.
  disclose([
    { identifier: 'workflow_update', capabilityRef: 'cap:local:workflow_update:reversible', effectClass: 'write' },
  ]);
  const exact = projectHostNoProgressAuthority(identity);
  assert.equal(exact.status, 'ok');
  if (exact.status !== 'ok') return;
  assert.equal(exact.authority.effect.length, 4);
  assert.deepEqual(exact.authority.operation, first.authority.operation, 'catalog growth stays one transition');
  const governor = initializeNoProgressGovernor({ taskKey: 'write-refs', authority: repeated.authority });
  const decision = observeNoProgress(governor, {
    taskKey: 'write-refs',
    attemptClass: 'authority_acquisition',
    authority: exact.authority,
  });
  assert.equal(decision.action, 'continue');
  assert.equal(decision.reason, 'authority_progress');
  assert.deepEqual(decision.gained, ['effect']);

  // A read-only disclosure after that adds no effect authority.
  disclose([{ identifier: 'r', capabilityRef: 'cap:live:read-only', effectClass: 'read' }]);
  const readOnly = projectHostNoProgressAuthority(identity);
  assert.equal(readOnly.status, 'ok');
  if (readOnly.status !== 'ok') return;
  assert.deepEqual(readOnly.authority.effect, exact.authority.effect);
});

test('distinct role-bound top-ranked capability stages advance without counting catalog siblings', () => {
  const identity = accepted('role-bound-discovery-stages');
  const roleKey = initializeDiscoveryRole(identity);
  const baseline = projectHostNoProgressAuthority(identity);
  assert.equal(baseline.status, 'ok');
  if (baseline.status !== 'ok') return;
  let state = initializeNoProgressGovernor({
    taskKey: `${identity.sessionId}#${identity.sourceUserSeq}`,
    authority: baseline.authority,
  });

  appendSettledDiscoveryStage({
    identity,
    roleKey,
    callId: 'stage-create',
    capabilityRef: 'cap:exact:create',
    effect: 'external_write',
    query: 'first phrasing is deliberately not authority',
    siblings: [
      { capabilityRef: 'cap:exact:update', effect: 'external_write' },
      { capabilityRef: 'cap:exact:readback', effect: 'read' },
    ],
  });
  const create = projectHostNoProgressAuthority(identity);
  assert.equal(create.status, 'ok');
  if (create.status !== 'ok') return;
  assert.equal(create.authority.operation.length, 2,
    'one generic catalog transition plus only the top-ranked exact stage');
  const createDecision = observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass: 'authority_acquisition',
    authority: create.authority,
  });
  assert.equal(createDecision.reason, 'authority_progress');
  state = createDecision.state;

  appendSettledDiscoveryStage({
    identity,
    roleKey,
    callId: 'stage-update',
    capabilityRef: 'cap:exact:update',
    effect: 'external_write',
    query: 'totally different query prose',
    summary: 'totally different result prose',
  });
  const update = projectHostNoProgressAuthority(identity);
  assert.equal(update.status, 'ok');
  if (update.status !== 'ok') return;
  assert.equal(update.authority.operation.length, 3);
  const updateDecision = observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass: 'authority_acquisition',
    authority: update.authority,
  });
  assert.equal(updateDecision.reason, 'authority_progress');
  state = updateDecision.state;

  appendSettledDiscoveryStage({
    identity,
    roleKey,
    callId: 'stage-readback',
    capabilityRef: 'cap:exact:readback',
    effect: 'read',
  });
  const readback = projectHostNoProgressAuthority(identity);
  assert.equal(readback.status, 'ok');
  if (readback.status !== 'ok') return;
  assert.equal(readback.authority.operation.length, 4);
  const readbackDecision = observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass: 'authority_acquisition',
    authority: readback.authority,
  });
  assert.equal(readbackDecision.reason, 'authority_progress');
});

test('role-bound discovery variation, repeated stages, A-B-A cycles, and fourth-stage breadth stay bounded', () => {
  const identity = accepted('role-bound-discovery-cycle');
  const roleKey = initializeDiscoveryRole(identity);
  const baseline = projectHostNoProgressAuthority(identity);
  assert.equal(baseline.status, 'ok');
  if (baseline.status !== 'ok') return;
  let state = initializeNoProgressGovernor({
    taskKey: `${identity.sessionId}#${identity.sourceUserSeq}`,
    authority: baseline.authority,
  });

  const observe = () => {
    const projected = projectHostNoProgressAuthority(identity);
    assert.equal(projected.status, 'ok');
    if (projected.status !== 'ok') throw new Error(projected.reason);
    const decision = observeNoProgress(state, {
      taskKey: state.taskKey,
      attemptClass: 'authority_acquisition',
      authority: projected.authority,
    });
    state = decision.state;
    return { projected, decision };
  };

  appendSettledDiscoveryStage({
    identity, roleKey, callId: 'a-1', capabilityRef: 'cap:stage:a', effect: 'read',
  });
  assert.equal(observe().decision.reason, 'authority_progress');

  appendSettledDiscoveryStage({
    identity,
    roleKey,
    callId: 'a-2-different-id',
    capabilityRef: 'cap:stage:a',
    effect: 'read',
    query: 'new query words cannot make A new',
    summary: 'new result prose cannot make A new',
  });
  assert.equal(observe().decision.reason, 'retry_available',
    'a repeated exact stage spends the one bounded retry');

  appendSettledDiscoveryStage({
    identity, roleKey, callId: 'b-1', capabilityRef: 'cap:stage:b', effect: 'external_write',
  });
  assert.equal(observe().decision.reason, 'authority_progress');

  appendSettledDiscoveryStage({
    identity, roleKey, callId: 'a-after-b', capabilityRef: 'cap:stage:a', effect: 'read',
  });
  assert.equal(observe().decision.reason, 'retry_available',
    'A -> B -> A is a no-gain cycle rather than a new stage');

  appendSettledDiscoveryStage({
    identity, roleKey, callId: 'c-1', capabilityRef: 'cap:stage:c', effect: 'local_write',
  });
  const third = observe();
  assert.equal(third.decision.reason, 'authority_progress');
  assert.equal(third.projected.authority.operation.length, 4,
    'the authority contains the generic catalog fact plus three exact stages');

  appendSettledDiscoveryStage({
    identity, roleKey, callId: 'd-ignored', capabilityRef: 'cap:stage:d', effect: 'read',
  });
  const fourth = observe();
  assert.equal(fourth.decision.reason, 'retry_available');
  assert.equal(fourth.projected.authority.operation.length, 4,
    'a fourth arbitrary catalog candidate cannot widen the authority set');
});

test('uncitable, unproven, unbound, and lower-ranked discovery rows cannot mint a stage', () => {
  const identity = accepted('role-bound-discovery-inert-rows');
  const roleKey = initializeDiscoveryRole(identity);
  const baseline = projectHostNoProgressAuthority(identity);
  assert.equal(baseline.status, 'ok');
  if (baseline.status !== 'ok') return;

  // The exact capability is host-proven, but it is only a lower-ranked
  // sibling. The top row is uncitable, so this whole result mints no stage.
  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'discovery_governor_decision',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      category: 'broad_discovery',
      subject: roleKey,
      callId: 'uncitable-top',
      decision: 'admitted',
    },
  });
  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      capabilities: [{
        capabilityRef: 'cap:lower-ranked:exact',
        descriptor: { id: 'cap:lower-ranked:exact', effect: 'read' },
      }],
    },
  });
  eventlog.writeToolOutput({
    sessionId: identity.sessionId,
    callId: 'uncitable-top',
    tool: 'tool_search',
    output: JSON.stringify({
      role_key: roleKey,
      query: 'query text is inert',
      results: [
        { name: 'uncitable-top-row', summary: 'no exact ref' },
        { capabilityRef: 'cap:lower-ranked:exact', summary: 'must remain breadth' },
      ],
    }),
  });
  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'discovery_governor_outcome',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      callId: 'uncitable-top',
      outcome: 'succeeded',
    },
  });
  const projected = projectHostNoProgressAuthority(identity);
  assert.equal(projected.status, 'ok');
  if (projected.status !== 'ok') return;
  assert.equal(projected.authority.operation.length, 1,
    'only the legacy one-time citable-catalog fact remains; no ranked stage was proven');

  const decision = observeNoProgress(initializeNoProgressGovernor({
    taskKey: `${identity.sessionId}#${identity.sourceUserSeq}`,
    authority: baseline.authority,
  }), {
    taskKey: `${identity.sessionId}#${identity.sourceUserSeq}`,
    attemptClass: 'authority_acquisition',
    authority: projected.authority,
  });
  assert.equal(decision.reason, 'authority_progress',
    'the pre-existing one-time catalog fact remains independently useful');

  appendSettledDiscoveryStage({
    identity,
    roleKey: 'model-invented-role',
    callId: 'unbound-role',
    capabilityRef: 'cap:unbound',
    effect: 'read',
  });
  const unbound = projectHostNoProgressAuthority(identity);
  assert.equal(unbound.status, 'ok');
  if (unbound.status === 'ok') assert.deepEqual(unbound.authority, projected.authority);
});

test('resolution alternatives remain candidates until a task-needed binding selects one', () => {
  const identity = accepted('resolution');
  for (const authoritativeForTask of [false, true]) {
    appendEvent({
      sessionId: identity.sessionId,
      turn: 1,
      role: 'system',
      type: 'capability_resolution',
      data: {
        sourceUserSeq: identity.sourceUserSeq,
        authoritativeForTask,
        entries: [{
          identifier: authoritativeForTask ? 'exact' : 'retry-prompt-only',
          status: 'proven',
          effectClass: 'write',
          accountIdentity: authoritativeForTask ? 'account:exact' : 'account:retry',
        }],
      },
    });
  }
  const projected = projectHostNoProgressAuthority(identity);
  assert.equal(projected.status, 'ok');
  if (projected.status !== 'ok') return;
  assert.equal(projected.authority.operation.length, 0);
  assert.equal(projected.authority.account.length, 0);
});

test('new authoritative resolution alternatives do not mint task progress before a task-needed binding', () => {
  const identity = accepted('resolution-alternatives-are-not-progress');
  const baseline = projectHostNoProgressAuthority(identity);
  assert.equal(baseline.status, 'ok');
  if (baseline.status !== 'ok') return;
  const state = initializeNoProgressGovernor({
    taskKey: `${identity.sessionId}#${identity.sourceUserSeq}`,
    authority: baseline.authority,
  });
  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_resolution',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      authoritativeForTask: true,
      entries: [
        { identifier: 'arbitrary-new-operation-a', status: 'proven', effectClass: 'read', accountIdentity: 'candidate-a' },
        { identifier: 'arbitrary-new-operation-b', status: 'proven', effectClass: 'read', accountIdentity: 'candidate-b' },
      ],
    },
  });
  const projected = projectHostNoProgressAuthority(identity);
  assert.equal(projected.status, 'ok');
  if (projected.status !== 'ok') return;
  const decision = observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass: 'dependency_lookup',
    authority: projected.authority,
  });
  assert.equal(decision.reason, 'retry_available');
  assert.deepEqual(decision.gained, []);
  assert.deepEqual(projected.authority.operation, []);
  assert.deepEqual(projected.authority.account, []);
});

test('unchanged expected-work cards dedupe while real state transitions gain a token', () => {
  const identity = accepted('plan-progress');
  const emit = (state: string, settled: boolean) => appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'expected_work_progress',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      lines: [{ id: 'operation:one', effect: 'read', state, settled, observed: settled }],
    },
  });
  emit('ready', false);
  emit('ready', false);
  const ready = projectHostNoProgressAuthority(identity);
  assert.equal(ready.status, 'ok');
  if (ready.status !== 'ok') return;
  assert.equal(ready.authority.operation.length, 1);

  emit('satisfied', true);
  const satisfied = projectHostNoProgressAuthority(identity);
  assert.equal(satisfied.status, 'ok');
  if (satisfied.status !== 'ok') return;
  assert.equal(satisfied.authority.operation.length, 2);
});

test('attempt-specific write event ids cannot mint effect progress', () => {
  const identity = accepted('write-event-id');
  for (const proofId of ['attempt-proof-one', 'attempt-proof-two']) {
    appendEvent({
      sessionId: identity.sessionId,
      turn: 1,
      role: 'system',
      type: 'write_evidence_proved',
      data: { sourceUserSeq: identity.sourceUserSeq, proofId },
    });
  }
  const projected = projectHostNoProgressAuthority(identity);
  assert.equal(projected.status, 'ok');
  if (projected.status !== 'ok') return;
  assert.deepEqual(projected.authority.effect, []);
});

test('discovery admission classifies a call without reading tool/provider vocabulary', () => {
  const identity = accepted('discovery-attempt');
  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'discovery_governor_decision',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      callId: 'call-discovery',
      decision: 'admitted',
    },
  });
  const projected = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('call-discovery', 'arbitrary_registry_name'),
      result('call-discovery', 'arbitrary_registry_name'),
    ],
  });
  assert.deepEqual(projected, { status: 'ok', attemptClass: 'authority_acquisition' });
});

test('host disposition result outranks varied call names as zero-crossing repair', () => {
  const identity = accepted('refusal-attempt');
  const refused = buildHostToolDispositionResult({
    callId: 'call-refused',
    toolName: 'different_name_every_time',
    disposition: 'refused_pre_dispatch',
    frameDigest: 'f'.repeat(64),
    frameIndex: 0,
    frameSize: 1,
    countsRefusal: true,
  });
  const projected = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [call('call-refused', 'different_name_every_time'), refused],
  });
  assert.equal(projected.status, 'ok');
  if (projected.status === 'ok') {
    assert.equal(projected.attemptClass, 'zero_crossing_repair');
    assert.equal(projected.consequence?.stage, 'host_disposition:refused_pre_dispatch');
  }
});

test('a frame of many refused siblings projects a bounded, distinct recovery surface instead of throwing', () => {
  // Live 2026-09-01 (platform-49 on GLM): one frame carried nine refused
  // call_tool siblings; mapping every refused call into recoveryToolNames
  // exceeded the governor cap, the constructor threw, and the projection
  // exception became a blocked run after two successful reads.
  const identity = accepted('many-refused-siblings');
  const sameCarrier = Array.from({ length: 9 }, (_, index) => `call-same-${index}`);
  const projectedSame = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: sameCarrier.flatMap((callId, index) => [
      call(callId, 'call_tool'),
      buildHostToolDispositionResult({
        callId,
        toolName: 'call_tool',
        disposition: 'refused_pre_dispatch',
        frameDigest: 'a'.repeat(64),
        frameIndex: index,
        frameSize: sameCarrier.length,
        countsRefusal: true,
      }),
    ]),
  });
  assert.equal(projectedSame.status, 'ok');
  if (projectedSame.status === 'ok') {
    assert.equal(projectedSame.attemptClass, 'zero_crossing_repair');
    assert.deepEqual(projectedSame.consequence?.recoveryToolNames, ['call_tool']);
  }

  const distinct = Array.from({ length: 10 }, (_, index) => `carrier_${index}`);
  const projectedDistinct = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: distinct.flatMap((toolName, index) => [
      call(`call-distinct-${index}`, toolName),
      buildHostToolDispositionResult({
        callId: `call-distinct-${index}`,
        toolName,
        disposition: 'refused_pre_dispatch',
        frameDigest: 'b'.repeat(64),
        frameIndex: index,
        frameSize: distinct.length,
        countsRefusal: true,
      }),
    ]),
  });
  assert.equal(projectedDistinct.status, 'ok');
  if (projectedDistinct.status === 'ok') {
    assert.equal(projectedDistinct.consequence?.recoveryToolNames.length, NO_PROGRESS_RECOVERY_TOOL_NAME_CAP);
  }
});

test('a structural host control is plan admission and a generic read is dependency lookup', () => {
  const identity = accepted('structural-attempt');
  const plan = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [call('call-plan', 'plan_task'), result('call-plan', 'plan_task')],
  });
  assert.deepEqual(plan, { status: 'ok', attemptClass: 'plan_admission' });

  const lookup = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [call('call-lookup', 'opaque_read'), result('call-lookup', 'opaque_read')],
  });
  assert.deepEqual(lookup, { status: 'ok', attemptClass: 'dependency_lookup' });
});

test('a durable business settlement makes the frame task work', () => {
  const identity = accepted('business-attempt');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE logical_call_settlements (
      logical_tool_call_id TEXT NOT NULL,
      observer_call_id TEXT,
      execution_kind TEXT NOT NULL,
      outcome_kind TEXT NOT NULL,
      recovery_action TEXT NOT NULL,
      business_call INTEGER NOT NULL,
      mutating INTEGER NOT NULL,
      requires_reconciliation INTEGER NOT NULL,
      physical_crossing_count INTEGER NOT NULL,
      host_crossing_count INTEGER,
      outcome_detail TEXT,
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO logical_call_settlements
      (logical_tool_call_id, observer_call_id, execution_kind, outcome_kind,
       recovery_action, business_call, mutating, requires_reconciliation,
       physical_crossing_count, host_crossing_count, session_id, source_user_seq)
    VALUES (?, ?, 'local_execution', 'succeeded', 'settle', 1, 0, 0, 0, 1, ?, ?)
  `).run('call-business', 'call-business', identity.sessionId, identity.sourceUserSeq);
  const projected = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [call('call-business', 'opaque_business'), result('call-business', 'opaque_business')],
  }, db);
  assert.deepEqual(projected, { status: 'ok', attemptClass: 'task_work' });
  db.close();
});

test('a history delta without a balanced result is not observed', () => {
  const identity = accepted('unbalanced');
  assert.deepEqual(projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [call('open-call', 'opaque')],
  }), { status: 'none' });
  assert.deepEqual(projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('closed-call', 'opaque'),
      call('still-open-call', 'opaque'),
      result('closed-call', 'opaque'),
    ],
  }), { status: 'none' });
});

test('projection storage failure is typed unavailable rather than silently empty', () => {
  const identity = accepted('projection-unavailable');
  const incomplete = new Database(':memory:');
  const projected = projectHostNoProgressAuthority(identity, incomplete);
  assert.equal(projected.status, 'unavailable');
  if (projected.status === 'unavailable') {
    assert.match(projected.reason, /accepted_task_work_contracts/i);
  }
  incomplete.close();
});

test('varied call ids and irrelevant capability refs cannot buy repeated retries', () => {
  const identity = accepted('varied-catalog-loop');
  const baseline = projectHostNoProgressAuthority(identity);
  assert.equal(baseline.status, 'ok');
  if (baseline.status !== 'ok') return;
  let state = initializeNoProgressGovernor({
    taskKey: `${identity.sessionId}#${identity.sourceUserSeq}`,
    authority: baseline.authority,
  });

  const addCatalogResult = (ordinal: number) => {
    const callId = `different-call-${ordinal}`;
    appendEvent({
      sessionId: identity.sessionId,
      turn: 1,
      role: 'system',
      type: 'discovery_governor_decision',
      data: {
        sourceUserSeq: identity.sourceUserSeq,
        callId,
        subject: 'accepted-clause:one',
        decision: 'admitted',
      },
    });
    appendEvent({
      sessionId: identity.sessionId,
      turn: 1,
      role: 'system',
      type: 'capability_discovered',
      data: {
        sourceUserSeq: identity.sourceUserSeq,
        capabilities: [{
          capabilityRef: `irrelevant-ref-${ordinal}`,
          schemaFingerprint: `different-schema-${ordinal}`,
          accountIdentity: `different-account-${ordinal}`,
        }],
      },
    });
    const projected = projectHostNoProgressAuthority(identity);
    assert.equal(projected.status, 'ok');
    if (projected.status !== 'ok') throw new Error(projected.reason);
    return projected.authority;
  };

  const first = observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass: 'authority_acquisition',
    authority: addCatalogResult(1),
  });
  assert.equal(first.reason, 'authority_progress', 'the first citable catalog may enable a plan');
  state = first.state;

  const second = observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass: 'authority_acquisition',
    authority: addCatalogResult(2),
  });
  assert.equal(second.reason, 'retry_available');
  state = second.state;
  for (let index = 2; index <= NO_PROGRESS_RETRY_BUDGET; index += 1) {
    const spend = observeNoProgress(state, {
      taskKey: state.taskKey,
      attemptClass: 'authority_acquisition',
      authority: addCatalogResult(index + 1),
    });
    assert.equal(spend.reason, 'retry_available', 'more catalog siblings are not authority');
    state = spend.state;
  }

  const third = observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass: 'authority_acquisition',
    authority: addCatalogResult(NO_PROGRESS_RETRY_BUDGET + 2),
  });
  assert.equal(third.action, 'terminalize');
  assert.equal(third.state.authority.operation.length, 1);
  assert.equal(third.state.authority.account.length, 0);
});

test('mixed recall discovery and refusal gains one citable path, then repeated lookup spends recovery', () => {
  const identity = accepted('mixed-live-shape');
  const baseline = projectHostNoProgressAuthority(identity);
  assert.equal(baseline.status, 'ok');
  if (baseline.status !== 'ok') return;
  let state = initializeNoProgressGovernor({
    taskKey: `${identity.sessionId}#${identity.sourceUserSeq}`,
    authority: baseline.authority,
  });

  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'discovery_governor_decision',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      callId: 'mixed-discovery',
      decision: 'admitted',
    },
  });
  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      capabilities: [{ capabilityRef: 'first-citable-path' }],
    },
  });
  const refused = buildHostToolDispositionResult({
    callId: 'mixed-refusal',
    toolName: 'opaque_control',
    disposition: 'refused_pre_dispatch',
    frameDigest: 'a'.repeat(64),
    frameIndex: 2,
    frameSize: 3,
    countsRefusal: true,
  });
  const firstAttempt = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('mixed-memory', 'opaque_recall'),
      call('mixed-discovery', 'opaque_discovery'),
      call('mixed-refusal', 'opaque_control'),
      result('mixed-memory', 'opaque_recall'),
      result('mixed-discovery', 'opaque_discovery'),
      refused,
    ],
  });
  assert.equal(firstAttempt.status, 'ok');
  if (firstAttempt.status === 'ok') {
    assert.equal(firstAttempt.attemptClass, 'zero_crossing_repair');
    assert.equal(firstAttempt.consequence?.stage, 'host_disposition:refused_pre_dispatch');
  }
  const firstAuthority = projectHostNoProgressAuthority(identity);
  assert.equal(firstAuthority.status, 'ok');
  if (firstAuthority.status !== 'ok' || firstAttempt.status !== 'ok') return;
  const first = observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass: firstAttempt.attemptClass,
    authority: firstAuthority.authority,
  });
  assert.equal(first.reason, 'authority_progress');
  state = first.state;

  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'discovery_governor_decision',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      callId: 'second-search',
      decision: 'admitted',
    },
  });
  appendEvent({
    sessionId: identity.sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      capabilities: [{ capabilityRef: 'different-but-irrelevant-path' }],
    },
  });
  const secondAttempt = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('second-memory', 'another_recall'),
      call('second-search', 'another_discovery'),
      result('second-memory', 'another_recall'),
      result('second-search', 'another_discovery'),
    ],
  });
  assert.deepEqual(secondAttempt, { status: 'ok', attemptClass: 'authority_acquisition' });
  const secondAuthority = projectHostNoProgressAuthority(identity);
  assert.equal(secondAuthority.status, 'ok');
  if (secondAuthority.status !== 'ok' || secondAttempt.status !== 'ok') return;
  const second = observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass: secondAttempt.attemptClass,
    authority: secondAuthority.authority,
  });
  assert.equal(second.reason, 'retry_available');
  assert.equal(second.state.authority.operation.length, 1);
  assert.equal(second.state.retriesRemaining, NO_PROGRESS_RETRY_BUDGET - 1);
});

test('typed plan consequences advance by host stage while ids, args, and detail prose cannot mint stages', () => {
  const identity = accepted('typed-plan-consequences');
  const db = settlementDb([
    { callId: 'schema-one', outcomeKind: 'invalid_arguments', recoveryAction: 'repair_arguments' },
    { callId: 'missing-write', outcomeKind: 'unknown', recoveryAction: 'stop_and_explain', executionKind: 'local_execution', hostCrossingCount: 1 },
    { callId: 'missing-lineage', outcomeKind: 'unknown', recoveryAction: 'stop_and_explain', executionKind: 'local_execution', hostCrossingCount: 1 },
    { callId: 'semantic-one', outcomeKind: 'unknown', recoveryAction: 'stop_and_explain', executionKind: 'local_execution', hostCrossingCount: 1 },
    { callId: 'semantic-two', outcomeKind: 'unknown', recoveryAction: 'stop_and_explain', executionKind: 'local_execution', hostCrossingCount: 1 },
  ], identity);
  const schema = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      { ...call('schema-one', 'plan_task'), arguments: '{"draft":"arbitrary-one"}' },
      result('schema-one', 'plan_task', JSON.stringify({
        ok: false, code: 'plan_invalid_input', detail: 'different validation prose', repair: 'repair it',
      })),
    ],
  }, db);
  const semanticOne = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      { ...call('semantic-one', 'plan_task'), arguments: '{"draft":"arbitrary-two"}' },
      result('semantic-one', 'plan_task', JSON.stringify({
        ok: false,
        code: 'plan_not_admitted',
        detail: 'host_destination_identity_unavailable:cap:first:model prose one',
        repair: 'first repair prose',
      })),
    ],
  }, db);
  const missingWrite = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('missing-write', 'plan_task'),
      result('missing-write', 'plan_task', JSON.stringify({
        ok: false,
        code: 'plan_incomplete_missing_write',
        detail: 'model prose must not define the stage',
        requestedEffectScope: 'mixed',
        admissibleCapabilities: [{
          capabilityRef: 'cap:local:workflow_create:reversible',
          effect: 'local_write',
          purpose: 'author_workflow',
        }],
        repair: 'repair internally',
        recoveryTool: 'plan_task',
      })),
    ],
  }, db);
  const missingLineage = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('missing-lineage', 'plan_task'),
      result('missing-lineage', 'plan_task', JSON.stringify({
        ok: false,
        code: 'plan_incomplete_data_lineage',
        detail: 'different model prose must not define the stage',
        writeOperationIds: ['write_output'],
        sourceOperationIds: ['read_source'],
        repair: 'repair internally',
        recoveryTool: 'plan_task',
      })),
    ],
  }, db);
  const semanticTwo = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      { ...call('semantic-two', 'plan_task'), arguments: '{"draft":"totally-different"}' },
      result('semantic-two', 'plan_task', JSON.stringify({
        ok: false,
        code: 'plan_not_admitted',
        detail: 'host_destination_identity_unavailable:cap:second:model prose two',
        repair: 'unrelated repair prose',
      })),
    ],
  }, db);
  assert.equal(schema.status, 'ok');
  assert.equal(missingWrite.status, 'ok');
  assert.equal(missingLineage.status, 'ok');
  assert.equal(semanticOne.status, 'ok');
  assert.equal(semanticTwo.status, 'ok');
  if (
    schema.status === 'ok'
    && missingWrite.status === 'ok'
    && missingLineage.status === 'ok'
    && semanticOne.status === 'ok'
    && semanticTwo.status === 'ok'
  ) {
    assert.equal(schema.consequence?.stage, 'schema_invalid');
    assert.equal(missingWrite.consequence?.stage, 'plan_incomplete:missing_write');
    assert.equal(missingWrite.consequence?.recovery, 'repair_model');
    assert.deepEqual(missingWrite.consequence?.recoveryToolNames, ['plan_task']);
    assert.equal(missingLineage.consequence?.stage, 'plan_incomplete:data_lineage');
    assert.equal(missingLineage.consequence?.recovery, 'repair_model');
    assert.deepEqual(missingLineage.consequence?.recoveryToolNames, ['plan_task']);
    assert.notEqual(missingWrite.consequence?.key, missingLineage.consequence?.key);
    assert.equal(semanticOne.consequence?.stage,
      'semantic_admission:host_destination_identity_unavailable');
    assert.equal(semanticOne.consequence?.recovery, 'retry_host');
    assert.equal(semanticOne.consequence?.key, semanticTwo.consequence?.key);
    assert.notEqual(schema.consequence?.key, semanticOne.consequence?.key);
  }
  db.close();
});

test('missing-write recovery searches only when the bounded card has no write repair', () => {
  const identity = accepted('missing-write-empty-card');
  const db = settlementDb([{
    callId: 'missing-write-empty-card',
    outcomeKind: 'unknown',
    recoveryAction: 'stop_and_explain',
    executionKind: 'local_execution',
    hostCrossingCount: 1,
  }], identity);
  const projected = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('missing-write-empty-card', 'plan_task'),
      result('missing-write-empty-card', 'plan_task', JSON.stringify({
        ok: false,
        code: 'plan_incomplete_missing_write',
        detail: 'the current bounded planning card has no host-attested write',
        requestedEffectScope: 'mixed',
        admissibleCapabilities: [],
        repair: 'discover the exact write once',
        recoveryTool: 'tool_search',
      })),
    ],
  }, db);
  assert.equal(projected.status, 'ok');
  if (projected.status === 'ok') {
    assert.equal(projected.consequence?.stage, 'plan_incomplete:missing_write');
    assert.equal(projected.consequence?.recovery, 'repair_model');
    assert.deepEqual(projected.consequence?.recoveryToolNames, ['tool_search']);
  }
  db.close();
});

test('structural plan refusal contract projects exact next surfaces and rejects malformed authority', () => {
  const identity = accepted('structural-plan-refusal-surfaces');
  const cases = [
    {
      callId: 'admission-plan',
      stage: 'semantic_admission:write_not_aligned',
      recovery: 'repair_model',
      tools: ['plan_task'],
      payload: {
        ok: false, code: 'plan_not_admitted', detail: 'write_not_aligned:destination',
        reasonCode: 'write_not_aligned',
        admissibleCapabilities: [{ capabilityRef: 'cap:write', effect: 'external_write', purpose: 'write rows' }],
        ceiling: 'external_write', withheld: [], repair: 'Correct the exact proposal.', recoveryTool: 'plan_task',
      },
    },
    {
      callId: 'admission-search',
      stage: 'semantic_admission:capability_not_disclosed',
      recovery: 'repair_model',
      tools: ['tool_search'],
      payload: {
        ok: false, code: 'plan_not_admitted', detail: 'primary model proposal cites a capability that was not disclosed to this source',
        reasonCode: 'capability_not_disclosed', admissibleCapabilities: [], ceiling: 'read', withheld: [],
        repair: 'Search for the missing exact capability.', recoveryTool: 'tool_search',
      },
    },
    {
      callId: 'admission-verifier',
      stage: 'semantic_admission:verification_successor_required',
      recovery: 'repair_model',
      tools: ['tool_search'],
      payload: {
        ok: false, code: 'plan_not_admitted', detail: 'verification_successor_required:missing_compatible_verifier',
        reasonCode: 'verification_successor_required',
        admissibleCapabilities: [{ capabilityRef: 'cap:write', effect: 'external_write', purpose: 'write rows' }],
        ceiling: 'external_write', withheld: [], repair: 'Search for the verifier.', recoveryTool: 'tool_search',
      },
    },
    {
      callId: 'graph-neutral',
      stage: 'plan_not_required:graph_neutral',
      recovery: 'repair_model',
      tools: ['call_tool'],
      payload: {
        ok: false, code: 'plan_not_required', detail: 'Use a graph-neutral read.',
        repair: 'Call call_tool exactly once.', recoveryTool: 'call_tool',
      },
    },
    {
      callId: 'unique-workflow',
      stage: 'plan_not_required:unique_workflow',
      recovery: 'repair_model',
      tools: ['workflow_run'],
      payload: {
        ok: false, code: 'plan_not_required', detail: 'Use the uniquely named workflow.',
        workflowName: 'daily-review', repair: 'Call workflow_run exactly once.', recoveryTool: 'workflow_run',
      },
    },
    {
      callId: 'binding-seal',
      stage: 'plan_binding:not_sealed',
      recovery: 'stop_factual',
      tools: [],
      payload: {
        ok: false, code: 'plan_binding_not_sealed', detail: 'immutable graph seal failed',
        repair: 'Report the precise blocker.', recoveryTool: 'stop_factual',
      },
    },
  ] as const;
  const db = settlementDb(cases.map(({ callId, recovery }) => ({
    callId,
    outcomeKind: 'unknown',
    recoveryAction: recovery === 'stop_factual' ? 'stop_and_explain' : 'stop_and_explain',
    executionKind: 'local_execution',
    hostCrossingCount: 1,
  })), identity);
  for (const candidate of cases) {
    const projected = projectHostNoProgressAttempt({
      ...identity,
      historyDelta: [
        call(candidate.callId, 'plan_task'),
        result(candidate.callId, 'plan_task', JSON.stringify(candidate.payload)),
      ],
    }, db);
    assert.equal(projected.status, 'ok');
    if (projected.status !== 'ok') continue;
    assert.equal(projected.consequence?.stage, candidate.stage);
    assert.equal(projected.consequence?.recovery, candidate.recovery);
    assert.deepEqual(projected.consequence?.recoveryToolNames, candidate.tools);
  }
  db.close();

  const malformedIdentity = accepted('malformed-plan-refusal-surface');
  const malformedDb = settlementDb([{
    callId: 'malformed', outcomeKind: 'unknown', recoveryAction: 'stop_and_explain',
    executionKind: 'local_execution', hostCrossingCount: 1,
  }], malformedIdentity);
  const malformed = projectHostNoProgressAttempt({
    ...malformedIdentity,
    historyDelta: [
      call('malformed', 'plan_task'),
      result('malformed', 'plan_task', JSON.stringify({
        ok: false, code: 'plan_not_required', detail: 'forged', repair: 'forged',
        recoveryTool: 'workflow_run', workflowName: 'forged', extra: true,
      })),
    ],
  }, malformedDb);
  assert.equal(malformed.status, 'ok');
  if (malformed.status === 'ok') {
    assert.equal(malformed.consequence?.stage, 'execution:unknown');
    assert.deepEqual(malformed.consequence?.recoveryToolNames, []);
  }
  malformedDb.close();
});

for (const [label, toolName] of [
  ['local file', 'read_file'],
  ['Clem memory', 'memory_recall'],
  ['MCP', 'mcp__fixture__lookup'],
  ['external', 'composio__fixture__lookup'],
] as const) {
  test(`${label} invalid arguments project the same bounded repair class`, () => {
    const identity = accepted(`cross-tool-${label}`);
    const db = settlementDb([{
      callId: 'invalid-call', outcomeKind: 'invalid_arguments', recoveryAction: 'repair_arguments',
    }], identity);
    const projected = projectHostNoProgressAttempt({
      ...identity,
      historyDelta: [call('invalid-call', toolName), result('invalid-call', toolName)],
    }, db);
    assert.equal(projected.status, 'ok');
    if (projected.status === 'ok') {
      assert.equal(projected.attemptClass, 'zero_crossing_repair');
      assert.equal(projected.consequence?.stage, 'schema_invalid');
      assert.equal(projected.consequence?.recovery, 'repair_model');
      assert.deepEqual(projected.consequence?.recoveryToolNames, [toolName]);
    }
    db.close();
  });
}

test('a retired capability gets one bounded current-source search, not a repeat carrier call', () => {
  const identity = accepted('retired-capability');
  const db = settlementDb([{
    callId: 'stale-call',
    executionKind: 'provider_execution',
    outcomeKind: 'unsupported_capability',
    recoveryAction: 'try_sibling_candidate',
    businessCall: 1,
    physicalCrossingCount: 1,
  }], identity);
  const projected = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [call('stale-call', 'work_call'), result('stale-call', 'work_call')],
  }, db);
  assert.equal(projected.status, 'ok');
  if (projected.status === 'ok') {
    assert.equal(projected.attemptClass, 'zero_crossing_repair');
    assert.equal(projected.consequence?.stage, 'execution:unsupported_capability');
    assert.equal(projected.consequence?.recovery, 'repair_model');
    assert.deepEqual(projected.consequence?.recoveryToolNames, ['tool_search']);
  }
  db.close();
});

test('an ignored requirement repairs the same call instead of rediscovering its capability', () => {
  const identity = accepted('ignored-requirement');
  const db = settlementDb([{
    callId: 'ignored-call',
    executionKind: 'provider_execution',
    outcomeKind: 'ignored_requirement',
    recoveryAction: 'repair_arguments',
    businessCall: 1,
    physicalCrossingCount: 1,
  }], identity);
  const projected = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [call('ignored-call', 'work_call'), result('ignored-call', 'work_call')],
  }, db);
  assert.equal(projected.status, 'ok');
  if (projected.status === 'ok') {
    assert.equal(projected.consequence?.stage, 'execution:ignored_requirement');
    assert.equal(projected.consequence?.recovery, 'repair_model');
    assert.deepEqual(projected.consequence?.recoveryToolNames, ['work_call']);
  }
  db.close();
});

test('an unknown external crossing remains reconciliation-owned', () => {
  const identity = accepted('unknown-crossing');
  const db = settlementDb([{
    callId: 'external-write',
    executionKind: 'provider_execution',
    outcomeKind: 'uncertain_write',
    recoveryAction: 'reconcile_then_decide',
    businessCall: 1,
    mutating: 1,
    requiresReconciliation: 1,
    physicalCrossingCount: 1,
  }], identity);
  const projected = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('external-write', 'mcp__fixture__create'),
      result('external-write', 'mcp__fixture__create'),
    ],
  }, db);
  assert.equal(projected.status, 'ok');
  if (projected.status === 'ok') {
    assert.equal(projected.consequence?.recovery, 'reconcile');
    assert.equal(projected.consequence?.effectState, 'unknown');
  }
  db.close();
});

test('only a durable typed exact input result projects a precise user question', () => {
  const identity = accepted('exact-input');
  const db = settlementDb([{
    callId: 'exact-input-call',
    outcomeKind: 'input_required',
    recoveryAction: 'ask_user',
  }, {
    callId: 'untyped-input-call',
    outcomeKind: 'input_required',
    recoveryAction: 'ask_user',
  }], identity);
  const exact = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('exact-input-call', 'plan_task'),
      result('exact-input-call', 'plan_task', JSON.stringify({
        ok: false,
        code: 'account_selection_required',
        detail: 'The matching write needs one exact connected account.',
        question: 'Which connected account should I use?',
        accountChoices: ['Scorpion', 'Breakthrough'],
        repair: 'Ask exactly once and do not select an account for the user.',
        recoveryTool: 'ask_user_question',
      })),
    ],
  }, db);
  const untyped = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('untyped-input-call', 'opaque_tool'),
      result('untyped-input-call', 'opaque_tool', 'please tell me something'),
    ],
  }, db);
  assert.equal(exact.status, 'ok');
  assert.equal(untyped.status, 'ok');
  if (exact.status === 'ok' && untyped.status === 'ok') {
    assert.equal(exact.consequence?.recovery, 'ask_user');
    assert.equal(exact.consequence?.userInput?.question,
      'Which connected account should I use?');
    assert.deepEqual(exact.consequence?.userInput?.choices, ['Scorpion', 'Breakthrough']);
    assert.equal(untyped.consequence?.recovery, 'stop_factual');
    assert.equal(untyped.consequence?.userInput, undefined);
  }
  db.close();
});

// ---------------------------------------------------------------------------
// Nested-schema repair: a host-authored, value-free repair key on the refusal
// keys the stage, so a NEW failing-path set is bounded structural progress for
// the governor while a byte-identical repeat re-enters the seen consequence
// key. The recovery surface (the refused carrier only) never changes, and a
// refusal without a key keeps the pre-existing stage.
// ---------------------------------------------------------------------------
const REPAIR_KEY_A = '0123456789abcdef'.repeat(4);
const REPAIR_KEY_B = 'fedcba9876543210'.repeat(4);
const SCHEMA_DIAGNOSTIC = '[provider-dispatch:not-started:invalid-args] OPAQUE_TABLE_INSERT_V7 arguments did not match its exact current schema. Failing paths: "/insertion/range" (missing required, expected object). No provider request was sent.';

function refusalMarker(input: {
  callId: string;
  toolName: string;
  repairKey?: string;
  frameIndex?: number;
  frameSize?: number;
}) {
  return buildHostToolDispositionResult({
    callId: input.callId,
    toolName: input.toolName,
    disposition: 'refused_pre_dispatch',
    frameDigest: 'e'.repeat(64),
    frameIndex: input.frameIndex ?? 0,
    frameSize: input.frameSize ?? 1,
    countsRefusal: false,
    diagnostic: SCHEMA_DIAGNOSTIC,
    ...(input.repairKey ? { repairKey: input.repairKey } : {}),
  });
}

test('a refusal marker carrying a repair key projects a keyed schema_invalid stage on the same carrier surface', () => {
  const identity = accepted('keyed-marker');
  const projected = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('call-keyed', 'opaque_provider_carrier'),
      refusalMarker({ callId: 'call-keyed', toolName: 'opaque_provider_carrier', repairKey: REPAIR_KEY_A }),
    ],
  });
  assert.equal(projected.status, 'ok');
  if (projected.status !== 'ok') return;
  assert.equal(projected.attemptClass, 'zero_crossing_repair');
  assert.equal(projected.consequence?.stage, `schema_invalid:${REPAIR_KEY_A.slice(0, 16)}`);
  assert.equal(projected.consequence?.recovery, 'repair_model');
  assert.equal(projected.consequence?.effectState, 'not_started');
  assert.deepEqual(projected.consequence?.recoveryToolNames, ['opaque_provider_carrier']);
});

test('a settlement whose outcome detail carries validation:<key> projects the same keyed stage as the marker path', () => {
  const identity = accepted('keyed-settlement');
  const db = settlementDb([{
    callId: 'invalid-call',
    outcomeKind: 'invalid_arguments',
    recoveryAction: 'repair_arguments',
    outcomeDetail: `validation:${REPAIR_KEY_A.slice(0, 32)}`,
  }], identity);
  const viaSettlement = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [call('invalid-call', 'opaque_provider_carrier'), result('invalid-call', 'opaque_provider_carrier')],
  }, db);
  db.close();
  assert.equal(viaSettlement.status, 'ok');
  if (viaSettlement.status !== 'ok') return;
  assert.equal(viaSettlement.attemptClass, 'zero_crossing_repair');
  assert.equal(viaSettlement.consequence?.stage, `schema_invalid:${REPAIR_KEY_A.slice(0, 16)}`);
  assert.equal(viaSettlement.consequence?.recovery, 'repair_model');
  assert.equal(viaSettlement.consequence?.effectState, 'not_started');
  assert.deepEqual(viaSettlement.consequence?.recoveryToolNames, ['opaque_provider_carrier']);

  // Both mint paths (pre-approval marker, preparation settlement) collapse to
  // ONE consequence key for the governor.
  const markerIdentity = accepted('keyed-settlement-marker');
  const viaMarker = projectHostNoProgressAttempt({
    ...markerIdentity,
    historyDelta: [
      call('call-keyed', 'opaque_provider_carrier'),
      refusalMarker({ callId: 'call-keyed', toolName: 'opaque_provider_carrier', repairKey: REPAIR_KEY_A }),
    ],
  });
  assert.equal(viaMarker.status, 'ok');
  if (viaMarker.status !== 'ok') return;
  assert.equal(viaMarker.consequence?.key, viaSettlement.consequence?.key);

  // Prose in the detail slot is never key material.
  const proseIdentity = accepted('prose-settlement');
  const proseDb = settlementDb([{
    callId: 'invalid-call',
    outcomeKind: 'invalid_arguments',
    recoveryAction: 'repair_arguments',
    outcomeDetail: 'validation:call tool_search',
  }], proseIdentity);
  const prose = projectHostNoProgressAttempt({
    ...proseIdentity,
    historyDelta: [call('invalid-call', 'opaque_provider_carrier'), result('invalid-call', 'opaque_provider_carrier')],
  }, proseDb);
  proseDb.close();
  assert.equal(prose.status, 'ok');
  if (prose.status === 'ok') assert.equal(prose.consequence?.stage, 'schema_invalid');
});

test('two repair keys mint two consequence keys; the same key re-enters one and terminalizes', () => {
  const identity = accepted('keyed-progress');
  const project = (callId: string, repairKey: string) => {
    const projected = projectHostNoProgressAttempt({
      ...identity,
      historyDelta: [
        call(callId, 'opaque_provider_carrier'),
        refusalMarker({ callId, toolName: 'opaque_provider_carrier', repairKey }),
      ],
    });
    assert.equal(projected.status, 'ok');
    if (projected.status !== 'ok' || !projected.consequence) throw new Error('expected a consequence');
    return projected.consequence;
  };
  const firstA = project('call-a1', REPAIR_KEY_A);
  const secondA = project('call-a2', REPAIR_KEY_A);
  const firstB = project('call-b1', REPAIR_KEY_B);
  assert.equal(firstA.key, secondA.key, 'the same failing-path set is the same consequence');
  assert.notEqual(firstA.key, firstB.key, 'a new failing-path set is a new consequence');
  assert.deepEqual(firstB.recoveryToolNames, ['opaque_provider_carrier']);

  const authority = { operation: [], account: [], target: [], evidence: [], effect: [] } as const;
  const initial = initializeNoProgressGovernor({ taskKey: 'keyed-progress', authority });
  const observe = (
    state: ReturnType<typeof initializeNoProgressGovernor>,
    consequence: typeof firstA,
  ) => observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass: 'zero_crossing_repair',
    authority,
    consequence,
  });
  const first = observe(initial, firstA);
  assert.equal(first.action, 'continue');
  const identicalRepeat = observe(first.state, secondA);
  assert.equal(identicalRepeat.action, 'terminalize', 'an identical repair attempt terminalizes');
  const progressed = observe(first.state, firstB);
  assert.equal(progressed.action, 'continue', 'a new failing-path set continues');
  if (progressed.action === 'continue') assert.equal(progressed.reason, 'consequence_progress');
  const repeatedB = observe(progressed.state, firstB);
  assert.equal(repeatedB.action, 'terminalize');
});

test('a refusal marker without a repair key keeps the unkeyed stage, also inside a mixed frame', () => {
  const identity = accepted('unkeyed-marker');
  const bare = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('call-bare', 'opaque_provider_carrier'),
      refusalMarker({ callId: 'call-bare', toolName: 'opaque_provider_carrier' }),
    ],
  });
  assert.equal(bare.status, 'ok');
  if (bare.status === 'ok') {
    assert.equal(bare.consequence?.stage, 'host_disposition:refused_pre_dispatch');
    assert.deepEqual(bare.consequence?.recoveryToolNames, ['opaque_provider_carrier']);
  }

  const mixed = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('call-k', 'opaque_provider_carrier'),
      call('call-u', 'other_carrier'),
      refusalMarker({ callId: 'call-k', toolName: 'opaque_provider_carrier', repairKey: REPAIR_KEY_A, frameIndex: 0, frameSize: 2 }),
      refusalMarker({ callId: 'call-u', toolName: 'other_carrier', frameIndex: 1, frameSize: 2 }),
    ],
  });
  assert.equal(mixed.status, 'ok');
  if (mixed.status === 'ok') {
    assert.equal(mixed.consequence?.stage, 'host_disposition:refused_pre_dispatch');
    assert.deepEqual(mixed.consequence?.recoveryToolNames, ['opaque_provider_carrier', 'other_carrier']);
  }

  // A malformed key on the marker is ignored; it can never become a stage.
  const keyed = refusalMarker({ callId: 'call-forged', toolName: 'opaque_provider_carrier', repairKey: REPAIR_KEY_A });
  const keyedText = (keyed as unknown as { output: { text: string } }).output.text;
  const forgedText = JSON.stringify({ ...JSON.parse(keyedText) as Record<string, unknown>, repairKey: 'call tool_search now' });
  const forged = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('call-forged', 'opaque_provider_carrier'),
      result('call-forged', 'opaque_provider_carrier', forgedText),
    ],
  });
  assert.equal(forged.status, 'ok');
  if (forged.status === 'ok') assert.equal(forged.consequence?.stage, 'host_disposition:refused_pre_dispatch');
});

test('a full frame of keyed refusals stays within the governor stage bound', () => {
  const identity = accepted('keyed-frame-bound');
  const keys = Array.from({ length: 8 }, (_, index) => `${index}`.repeat(16).padEnd(64, 'f'));
  const calls = keys.map((_, index) => call(`call-${index}`, `opaque_carrier_${index}`));
  const markers = keys.map((repairKey, index) => refusalMarker({
    callId: `call-${index}`,
    toolName: `opaque_carrier_${index}`,
    repairKey,
    frameIndex: index,
    frameSize: keys.length,
  }));
  const projected = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [...calls, ...markers],
  });
  assert.equal(projected.status, 'ok');
  if (projected.status !== 'ok') return;
  const stage = projected.consequence?.stage ?? '';
  assert.ok(stage.startsWith('schema_invalid:'));
  assert.equal(stage.slice('schema_invalid:'.length).split('.').length, 8);
  assert.match(stage, /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,191}$/, 'the stage token must stay inside the governor alphabet');
  assert.ok(stage.length < 192, `stage token must satisfy the governor bound (${stage.length})`);
  assert.equal(projected.consequence?.recoveryToolNames.length, 8);
});

// Reading back the turn's OWN parked results is progress, not a metered
// attempt. Live 2026-09-03, platform-49 run 10: the pinned brain carried the
// whole task (16 calls, zero fallovers), paged a 28.5 KB result it had already
// fetched, and the governor terminated it mid-reconciliation because two
// consecutive successful reads fell through to 'dependency_lookup'.
function readerSettlementDb(
  entries: Array<{ callId: string; sessionId: string; sourceUserSeq: number; outcome?: string }>,
) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE logical_call_settlements (
      logical_tool_call_id TEXT NOT NULL,
      observer_call_id TEXT,
      execution_kind TEXT NOT NULL,
      outcome_kind TEXT NOT NULL,
      recovery_action TEXT NOT NULL,
      business_call INTEGER NOT NULL,
      mutating INTEGER NOT NULL,
      requires_reconciliation INTEGER NOT NULL,
      physical_crossing_count INTEGER NOT NULL,
      host_crossing_count INTEGER,
      outcome_detail TEXT,
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO logical_call_settlements
      (logical_tool_call_id, observer_call_id, execution_kind, outcome_kind,
       recovery_action, business_call, mutating, requires_reconciliation,
       physical_crossing_count, host_crossing_count, session_id, source_user_seq)
    VALUES (?, ?, 'local_execution', ?, 'settle', 0, 0, 0, 0, 1, ?, ?)
  `);
  for (const entry of entries) {
    insert.run(entry.callId, entry.callId, entry.outcome ?? 'succeeded', entry.sessionId, entry.sourceUserSeq);
  }
  return db;
}

test('paging the turn\'s own parked result is progress, not a metered attempt', () => {
  const identity = accepted('recall-progress');
  const db = readerSettlementDb([
    { callId: 'call-recall', sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq },
  ]);
  const projected = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [call('call-recall', 'recall_tool_result'), result('call-recall', 'recall_tool_result')],
  }, db);
  assert.deepEqual(projected, { status: 'ok', attemptClass: 'task_work' },
    'reading evidence the turn already paid for is work, not a stalled retry');
  db.close();
});

test('a mixed frame and a failed read keep their metered class', () => {
  const identity = accepted('recall-mixed');
  // A reader beside real work is not a pure read — it keeps the old class.
  const mixed = readerSettlementDb([
    { callId: 'r1', sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq },
    { callId: 'w1', sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq },
  ]);
  const projectedMixed = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [
      call('r1', 'recall_tool_result'), result('r1', 'recall_tool_result'),
      call('w1', 'some_other_tool'), result('w1', 'some_other_tool'),
    ],
  }, mixed);
  assert.equal(projectedMixed.status, 'ok');
  if (projectedMixed.status === 'ok') {
    assert.notEqual(projectedMixed.attemptClass, 'task_work',
      'a reader beside real work must not launder the frame into progress');
  }
  mixed.close();

  // A read that FAILED is a stalled retry like any other.
  const failed = readerSettlementDb([
    { callId: 'r2', sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, outcome: 'failed' },
  ]);
  const projectedFailed = projectHostNoProgressAttempt({
    ...identity,
    historyDelta: [call('r2', 'tool_output_query'), result('r2', 'tool_output_query')],
  }, failed);
  assert.equal(projectedFailed.status, 'ok');
  if (projectedFailed.status === 'ok') {
    assert.notEqual(projectedFailed.attemptClass, 'task_work', 'a failed read is not progress');
  }
  failed.close();
});
