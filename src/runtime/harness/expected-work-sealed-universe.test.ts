import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-sealed-universe-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-sealed-universe\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const admission = await import('./expected-work-admission.js');
const seals = await import('./expected-work-universe-seal.js');
const projector = await import('./expected-work-observed-projector.js');
const refinement = await import('./read-evidence-refinement.js');
const dispatch = await import('./dispatch-ledger.js');
const attempts = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const resolution = await import('./resolution-ledger.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/**
 * The natural count-only ask: the members are whatever the source read returns,
 * so the contract can only name the producer and where member identity lives.
 */
const ASK = 'Send a follow-up email to each open opportunity owner.';
const SOURCE_TOOL = 'alpha__list_opportunities';
const NOTIFY_TOOL = 'alpha__send_report';

let serial = 0;

interface SealedFanoutTask {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
  label: string;
}

function proposalFor(memberIdPointer: string) {
  return {
    version: 1 as const,
    operations: [
      {
        id: 'source',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'notify',
        effect: 'external_write' as const,
        dependsOn: ['source'],
        dataFrom: ['source'],
        cardinality: { kind: 'each' as const, universeId: 'opportunities' },
      },
    ],
    universes: [{
      id: 'opportunities',
      seal: 'complete_source_receipt' as const,
      producedBy: 'source',
      memberIdPointer,
    }],
  };
}

function acceptSealedFanout(label: string): SealedFanoutTask {
  const id = ++serial;
  const session = eventlog.createSession({ id: `sealed-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  const graphEvent = shadow.recordTurnGraphShadow({ identity: task });
  assert.ok(graphEvent, 'fixture graph persisted');
  const graph = graphEvent.data.graph as { classification: { route: string } };
  assert.equal(graph.classification.route, 'act', 'the fixture ask must be an accepted action turn');
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

function openLogicalCall(task: SealedFanoutTask, suffix: string, tool: string, args: unknown): string {
  const logicalToolCallId = `logical:${task.label}:${suffix}`;
  const opened = dispatch.admitLogicalCall({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: task.turn,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId,
    },
    tool,
    args,
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  return logicalToolCallId;
}

function settleCall(input: {
  task: SealedFanoutTask;
  logicalToolCallId: string;
  tool: string;
  args: unknown;
  payload: unknown;
  requirementId: string;
  mutating: boolean;
}): void {
  const physicalDispatchId = `dispatch:${input.logicalToolCallId}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: input.task.sessionId,
      sourceUserSeq: input.task.sourceUserSeq,
      turn: input.task.turn,
      acceptedTaskId: input.task.acceptedTaskId,
      logicalToolCallId: input.logicalToolCallId,
      physicalDispatchId,
      ordinal: 0,
    },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error(begun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.tool,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: input.task.sessionId,
      sourceUserSeq: input.task.sourceUserSeq,
      turn: input.task.turn,
      acceptedTaskId: input.task.acceptedTaskId,
      logicalToolCallId: input.logicalToolCallId,
    },
    contract: { toolName: input.tool, args: input.args },
    execution: { kind: 'provider_execution' },
    result: { payload: input.payload },
    outcome: attempts.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: input.mutating, requirementId: input.requirementId },
    observer: { lane: 'composio', turn: input.task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
}

/** The carrier settles its own pre-dispatch refusals; the fixture must too, or
 *  the turn never reaches its terminal boundary. */
function settleRefusal(task: SealedFanoutTask, logicalToolCallId: string, tool: string, args: unknown): void {
  const settled = settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: task.turn,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId,
    },
    contract: { toolName: tool, args },
    execution: { kind: 'refused_pre_dispatch' },
    outcome: attempts.classifyAttemptOutcome({
      preDispatch: true,
      argumentValidationFailed: true,
      schemaAvailable: true,
    }),
    recovery: { businessCall: true, mutating: true, requirementId: 'notify' },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
}

function sourcePayload(records: unknown[]): unknown {
  return { successful: true, complete: true, records };
}

/** Freeze the contract on the producer call, exactly as the carrier fuses it. */
function bindProducerRead(task: SealedFanoutTask, memberIdPointer = '/id'): string {
  const args = { status: 'open' };
  const logicalToolCallId = openLogicalCall(task, 'source', SOURCE_TOOL, args);
  const bound = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId,
    proposal: proposalFor(memberIdPointer),
    requirementId: 'source',
    tool: SOURCE_TOOL,
    args,
  });
  assert.equal(bound.status, 'bound', JSON.stringify(bound));
  return logicalToolCallId;
}

function settleProducerRead(task: SealedFanoutTask, logicalToolCallId: string, records: unknown[]): void {
  settleCall({
    task,
    logicalToolCallId,
    tool: SOURCE_TOOL,
    args: { status: 'open' },
    payload: sourcePayload(records),
    requirementId: 'source',
    mutating: false,
  });
}

function notifyArgs(memberId: string) {
  return {
    destination: `${memberId}@example.test`,
    body: `follow-up for ${memberId}`,
    opportunity_id: memberId,
  };
}

function admitNotify(task: SealedFanoutTask, memberId: string, suffix = memberId) {
  const args = notifyArgs(memberId);
  const logicalToolCallId = openLogicalCall(task, `notify-${suffix}`, NOTIFY_TOOL, args);
  const result = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId,
    proposal: null,
    requirementId: 'notify',
    universeItemId: memberId,
    universeSelector: { argumentPointer: '/opportunity_id', memberIdPointer: null },
    tool: NOTIFY_TOOL,
    args,
  });
  return { logicalToolCallId, args, result };
}

function frozenContract(task: SealedFanoutTask): contracts.AcceptedTaskWorkContractV1 {
  const loaded = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok', JSON.stringify(loaded));
  if (loaded.status !== 'ok') throw new Error('contract missing');
  return loaded.contract;
}

function sealFor(task: SealedFanoutTask): seals.ExpectedWorkUniverseSealResult {
  const contract = frozenContract(task);
  const universe = contract.universes.find((entry) => entry.id === 'opportunities');
  assert.ok(universe && universe.seal === 'complete_source_receipt');
  if (!universe || universe.seal !== 'complete_source_receipt') throw new Error('universe missing');
  return seals.sealSourceDerivedUniverse({
    db: eventlog.openEventLog(),
    contract,
    universe,
  });
}

test('a count-only fanout seals its universe from the producer read and binds one call per sealed member', () => {
  const task = acceptSealedFanout('endtoend');
  const producerCall = bindProducerRead(task);

  // Before the source read settles there is no universe to fan out over, and
  // the refusal names the producer requirement rather than a shape to guess.
  const early = admitNotify(task, 'opp-1', 'early');
  assert.equal(early.result.status, 'refused');
  if (early.result.status !== 'refused') throw new Error('early notify was admitted');
  assert.match(early.result.reason, /source/);
  settleRefusal(task, early.logicalToolCallId, NOTIFY_TOOL, early.args);
  const unsettled = sealFor(task);
  assert.equal(unsettled.status, 'unsealed');
  assert.match(
    unsettled.status === 'unsealed' ? unsettled.reason : '',
    /complete source read source has not settled/,
  );

  settleProducerRead(task, producerCall, [
    { id: 'opp-2', name: 'Beta renewal' },
    { id: 'opp-1', name: 'Acme expansion' },
  ]);

  const sealed = sealFor(task);
  assert.equal(sealed.status, 'sealed', JSON.stringify(sealed));
  if (sealed.status !== 'sealed') throw new Error('universe did not seal');
  assert.deepEqual(sealed.seal.members, ['opp-1', 'opp-2'], 'members are the exact source records, sorted');
  assert.equal(sealed.seal.producerLogicalToolCallId, producerCall);
  assert.match(sealed.seal.digest, /^[a-f0-9]{64}$/);

  // An item the source never returned stays outside the universe, and the
  // refusal now carries a plan whose per-item requirement knows its true size.
  const stranger = admitNotify(task, 'opp-404');
  assert.equal(stranger.result.status, 'refused');
  if (stranger.result.status !== 'refused') throw new Error('stranger notify was admitted');
  assert.equal(stranger.result.kind, 'work_cardinality_mismatch');
  const strangerLine = stranger.result.plan?.find((line) => line.requirementId === 'notify');
  assert.equal(strangerLine?.requiredInstances, 2, 'the sealed universe sizes the per-item requirement');
  settleRefusal(task, stranger.logicalToolCallId, NOTIFY_TOOL, stranger.args);

  for (const memberId of ['opp-1', 'opp-2']) {
    const admitted = admitNotify(task, memberId);
    assert.equal(admitted.result.status, 'bound', JSON.stringify(admitted.result));
    if (admitted.result.status !== 'bound') throw new Error('sealed member was not admitted');
    assert.equal(admitted.result.binding.universeItemId, memberId);
    settleCall({
      task,
      logicalToolCallId: admitted.logicalToolCallId,
      tool: NOTIFY_TOOL,
      args: admitted.args,
      payload: { successful: true, data: { message_id: `sent-${memberId}` } },
      requirementId: 'notify',
      mutating: true,
    });
  }

  // The seal is durable on the consumer bindings: which producer call sealed
  // the universe, and the digest of the member list every reader recomputes.
  const db = eventlog.openEventLog();
  const bindings = db.prepare(`
    SELECT universe_item_id, universe_seal, input_source_kind, input_source_ref, input_source_digest
      FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? AND requirement_id = 'notify'
     ORDER BY universe_item_id
  `).all(task.sessionId, task.sourceUserSeq);
  assert.deepEqual(bindings, ['opp-1', 'opp-2'].map((memberId) => ({
    universe_item_id: memberId,
    universe_seal: 'complete_source_receipt',
    input_source_kind: 'complete_source_receipt',
    input_source_ref: producerCall,
    input_source_digest: sealed.seal.digest,
  })));

  const projected = projector.projectObservedExpectedWorkHistory({
    contract: frozenContract(task),
    finalized: true,
  });
  assert.equal(projected.status, 'ok');
  if (projected.status !== 'ok') throw new Error(projected.reason);
  assert.deepEqual(projected.history.universes, [{
    universeId: 'opportunities',
    seal: 'complete_source_receipt',
    producerRequirementId: 'source',
    complete: true,
    members: ['opp-1', 'opp-2'],
  }]);

  const finalized = resolution.finalizeResolutionAgainstExpectedWork({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  });
  assert.equal(finalized.status, 'finalized', JSON.stringify(finalized.status === 'incomplete'
    ? finalized.match.gaps
    : finalized));
  if (finalized.status !== 'finalized') throw new Error('sealed fanout did not finalize');
  assert.equal(finalized.match.status, 'complete');
  assert.deepEqual(finalized.match.gaps, []);
});

test('an unfinished per-item lane reports its missing sealed items, not an unsealed universe', () => {
  const task = acceptSealedFanout('partial');
  const producerCall = bindProducerRead(task);
  settleProducerRead(task, producerCall, [{ id: 'opp-a' }, { id: 'opp-b' }]);
  const admitted = admitNotify(task, 'opp-a');
  assert.equal(admitted.result.status, 'bound', JSON.stringify(admitted.result));
  settleCall({
    task,
    logicalToolCallId: admitted.logicalToolCallId,
    tool: NOTIFY_TOOL,
    args: admitted.args,
    payload: { successful: true, data: { message_id: 'sent-opp-a' } },
    requirementId: 'notify',
    mutating: true,
  });

  const finalized = resolution.finalizeResolutionAgainstExpectedWork({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  });
  assert.equal(finalized.status, 'incomplete');
  if (finalized.status !== 'incomplete') throw new Error('half a fanout must not finalize');
  assert.equal(
    finalized.match.gaps.some((gap) => gap.kind === 'universe_unsealed'),
    false,
    'a sealed universe is no longer reported as unsealed',
  );
  assert.ok(finalized.match.gaps.some((gap) =>
    gap.kind === 'cardinality_item_missing' && gap.universeItemId === 'opp-b'));
});

test('a source whose records carry no usable member id refuses instead of sealing a guess', () => {
  const missing = acceptSealedFanout('missing-id');
  settleProducerRead(missing, bindProducerRead(missing), [{ id: 'opp-1' }, { name: 'no id here' }]);
  const missingSeal = sealFor(missing);
  assert.equal(missingSeal.status, 'unsealed');
  assert.match(
    missingSeal.status === 'unsealed' ? missingSeal.reason : '',
    /source record 1 has no value at member id pointer '\/id'/,
  );

  const duplicate = acceptSealedFanout('duplicate-id');
  settleProducerRead(duplicate, bindProducerRead(duplicate), [{ id: 'opp-1' }, { id: 'opp-1' }]);
  const duplicateSeal = sealFor(duplicate);
  assert.equal(duplicateSeal.status, 'unsealed');
  assert.match(
    duplicateSeal.status === 'unsealed' ? duplicateSeal.reason : '',
    /repeat member id 'opp-1'/,
  );

  const nonString = acceptSealedFanout('numeric-id');
  settleProducerRead(nonString, bindProducerRead(nonString), [{ id: 7 }]);
  const nonStringSeal = sealFor(nonString);
  assert.equal(nonStringSeal.status, 'unsealed');
  assert.match(
    nonStringSeal.status === 'unsealed' ? nonStringSeal.reason : '',
    /no bounded string member id/,
  );

  // Every one of them fails closed at admission with the exact seal defect.
  for (const task of [missing, duplicate, nonString]) {
    const refused = admitNotify(task, 'opp-1');
    assert.equal(refused.result.status, 'refused');
    if (refused.result.status !== 'refused') throw new Error('an unsealable universe was admitted');
    assert.equal(refused.result.kind, 'work_universe_unsealed');
    const line = refused.result.plan?.find((entry) => entry.requirementId === 'notify');
    assert.equal(line?.requiredInstances, 'unknown', 'an unsealed universe never invents a size');
  }
});

test('an unexhausted source read cannot seal its universe', () => {
  const task = acceptSealedFanout('paginated');
  const producerCall = bindProducerRead(task);
  settleCall({
    task,
    logicalToolCallId: producerCall,
    tool: SOURCE_TOOL,
    args: { status: 'open' },
    payload: { successful: true, records: [{ id: 'opp-1' }], next_cursor: 'page-2' },
    requirementId: 'source',
    mutating: false,
  });
  const sealed = sealFor(task);
  assert.equal(sealed.status, 'unsealed');
  assert.match(
    sealed.status === 'unsealed' ? sealed.reason : '',
    /does not prove it exhausted its collection/,
  );
});

test('the same settled source seals identical members and digest across a restart', () => {
  const task = acceptSealedFanout('restart');
  settleProducerRead(task, bindProducerRead(task), [
    { id: 'opp-z' },
    { id: 'opp-m' },
    { id: 'opp-a' },
  ]);
  const before = sealFor(task);
  assert.equal(before.status, 'sealed', JSON.stringify(before));

  eventlog.closeEventLog();
  const after = sealFor(task);
  assert.deepEqual(after, before, 'a seal is derived from immutable settled bytes, not from memory');

  // And a member still binds after the restart, against the same seal.
  const admitted = admitNotify(task, 'opp-m');
  assert.equal(admitted.result.status, 'bound', JSON.stringify(admitted.result));
  const digest = eventlog.openEventLog().prepare(`
    SELECT input_source_digest FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, admitted.logicalToolCallId) as { input_source_digest: string };
  assert.equal(digest.input_source_digest, before.status === 'sealed' ? before.seal.digest : '');
});

test('a per-item read is provable against sealed members and unprovable without them', () => {
  const operation = {
    id: 'detail',
    effect: 'read' as const,
    coverage: 'single' as const,
    dependsOn: ['source'],
    dataFrom: ['source'],
    cardinality: { kind: 'each' as const, universeId: 'opportunities' },
  };
  const universes = [{
    id: 'opportunities',
    seal: 'complete_source_receipt' as const,
    producedBy: 'source',
    memberIdPointer: '/id',
  }];
  const shape = {
    inputSchema: {
      type: 'object',
      properties: { opportunity_id: { type: 'string' } },
      required: ['opportunity_id'],
    },
    args: { opportunity_id: 'opp-1' },
    universeItemId: 'opp-1',
  };

  const unsealed = refinement.refinePreDispatchReadEvidence({ operation, universes, ...shape });
  assert.equal(unsealed.status, 'unknown');
  assert.equal(unsealed.status === 'unknown' ? unsealed.reason : '', 'finite_universe_is_not_accepted_input');

  const sealed = refinement.refinePreDispatchReadEvidence({
    operation,
    universes,
    universeMembers: ['opp-1', 'opp-2'],
    ...shape,
  });
  assert.equal(sealed.status, 'authoritative');
  if (sealed.status !== 'authoritative') throw new Error('a sealed member read stayed unprovable');
  assert.equal(sealed.mode, 'point_read');
  assert.equal(sealed.basis, 'sealed_source_member');

  const stranger = refinement.refinePreDispatchReadEvidence({
    operation,
    universes,
    universeMembers: ['opp-2'],
    ...shape,
  });
  assert.equal(stranger.status, 'unknown', 'a member outside the seal proves nothing');
});
