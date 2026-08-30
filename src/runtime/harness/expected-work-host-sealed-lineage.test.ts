/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/expected-work-host-sealed-lineage.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SealedNodeBinding } from './host-capability-catalog-factory.js';
import type {
  AcceptedTaskWorkContractV1,
  ExpectedWorkOperationV1,
} from './expected-work-contract.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-sealed-lineage-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-host-sealed-lineage\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const admission = await import('./expected-work-admission.js');
const logicalContracts = await import('./logical-call-contract.js');
const sealedBindings = await import('./host-capability-catalog-factory.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

type Operation = ExpectedWorkOperationV1;

interface LineageTask {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
  contract: AcceptedTaskWorkContractV1;
  operations: ReadonlyMap<string, Operation>;
}

let serial = 0;

function acceptLineageTask(operations: Operation[]): LineageTask {
  const session = eventlog.createSession({
    id: `host-sealed-lineage-${++serial}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create one exact fixture report from the declared source records.' },
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
  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposal: { version: 1, operations, universes: [] },
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') throw new Error(prepared.reason);
  const db = eventlog.openEventLog();
  const frozen = db.transaction(() => contracts.freezePreparedExpectedWorkContractInTransaction(db, {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    contract: prepared.contract,
  })).immediate();
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  const loaded = contracts.loadExpectedWorkContract(session.id, source.seq);
  assert.equal(loaded.status, 'ok', JSON.stringify(loaded));
  if (loaded.status !== 'ok') throw new Error(loaded.reason);
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    contract: loaded.contract,
    operations: new Map(loaded.contract.operations.map((operation) => [operation.id, operation])),
  };
}

function persistNodeBinding(input: {
  task: LineageTask;
  nodeId: string;
  providerOperationId: string;
  effect: SealedNodeBinding['effect'];
}): SealedNodeBinding {
  const logicalToolName = logicalContracts.canonicalLogicalToolName(input.providerOperationId);
  assert.ok(logicalToolName);
  const unsealed: Omit<SealedNodeBinding, 'bindingDigest'> = {
    nodeId: input.nodeId,
    capabilityId: `cap:${input.task.sessionId}:${input.nodeId}`,
    providerOperationId: input.providerOperationId,
    logicalToolName: logicalToolName!,
    toolName: input.providerOperationId,
    schemaVersion: '1',
    schemaDigest: contracts.expectedWorkDigest(`schema:${input.providerOperationId}`),
    argumentDigest: contracts.expectedWorkDigest(JSON.stringify({
      nodeId: input.nodeId,
      capabilityId: `cap:${input.task.sessionId}:${input.nodeId}`,
    })),
    account: 'account:host-sealed-lineage',
    effect: input.effect,
    ...(input.effect === 'external_write' || input.effect === 'local_write'
      ? { destination: { family: 'fixture-report', posture: 'create_new' } }
      : {}),
  };
  const binding: SealedNodeBinding = {
    ...unsealed,
    bindingDigest: sealedBindings.bindingDigestOf(unsealed),
  };
  assert.equal(sealedBindings.persistSealedNodeBinding({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    binding,
  }), true);
  return binding;
}

function hostArgs(binding: SealedNodeBinding, payload: unknown): Record<string, unknown> {
  return {
    nodeId: binding.nodeId,
    capabilityId: binding.capabilityId,
    schemaVersion: binding.schemaVersion,
    schemaDigest: binding.schemaDigest,
    digest: contracts.expectedWorkDigest(JSON.stringify(payload ?? null)),
  };
}

function bindTaskNodes(task: LineageTask): ReadonlyMap<string, SealedNodeBinding> {
  const bindings = new Map<string, SealedNodeBinding>();
  for (const operation of task.contract.operations) {
    const providerOperationId = operation.id.includes('create')
      ? `fixture_create_report_${serial}`
      : operation.id.includes('readback')
        ? `fixture_get_report_${serial}`
        : operation.effect === 'compute'
          ? `fixture_transform_records_${serial}`
          : `fixture_list_records_${serial}_${operation.id.replace(/[^a-z0-9]/gi, '_')}`;
    bindings.set(operation.id, persistNodeBinding({
      task,
      nodeId: operation.id,
      providerOperationId,
      effect: operation.effect === 'compute' ? 'host_only' : operation.effect,
    }));
  }
  return bindings;
}

function admitAndSettleLineageNode(input: {
  task: LineageTask;
  binding: SealedNodeBinding;
  inputPayload: unknown;
  resultPayload: unknown;
  suffix?: string;
}): string {
  const operation = input.task.operations.get(input.binding.nodeId);
  assert.ok(operation);
  assert.ok(operation!.effect === 'read' || operation!.effect === 'compute');
  const args = hostArgs(input.binding, input.inputPayload);
  const logicalToolCallId = `logical:${input.binding.nodeId}:${input.suffix ?? 'one'}`;
  const opened = dispatch.admitLogicalCall({
    identity: { ...input.task, logicalToolCallId },
    tool: input.binding.toolName,
    args,
  });
  assert.ok(opened.status === 'inserted' || opened.status === 'replayed', JSON.stringify(opened));
  const admitted = admission.admitExpectedWorkInvocation({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    logicalToolCallId,
    proposal: null,
    requirementId: input.binding.nodeId,
    universeItemId: null,
    universeSelector: null,
    tool: input.binding.toolName,
    args,
    hostSealedEffect: operation!.effect,
  });
  assert.ok(
    admitted.status === 'bound' || admitted.status === 'replayed',
    JSON.stringify(admitted),
  );
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: input.task.sessionId,
      sourceUserSeq: input.task.sourceUserSeq,
      acceptedTaskId: input.task.acceptedTaskId,
      logicalToolCallId,
      physicalDispatchId: `dispatch:${input.task.sessionId}:${input.binding.nodeId}:${input.suffix ?? 'one'}`,
      ordinal: 1,
    },
    tool: input.binding.toolName,
    args,
    ...(operation!.effect === 'compute' ? { executionSite: 'host' as const } : {}),
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error(JSON.stringify(begun));
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.binding.toolName,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...input.task, logicalToolCallId },
    contract: { toolName: input.binding.toolName, args },
    execution: {
      kind: operation!.effect === 'compute' ? 'local_execution' : 'provider_execution',
    },
    result: { payload: input.resultPayload },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: {
      businessCall: true,
      mutating: false,
      requirementId: input.binding.nodeId,
    },
    observer: { lane: 'agents_runner', turn: input.task.turn },
  });
  assert.ok(settled.status === 'committed' || settled.status === 'replayed', JSON.stringify(settled));
  return logicalToolCallId;
}

function admitCreateWithoutDispatch(input: {
  task: LineageTask;
  binding: SealedNodeBinding;
  records: unknown[];
  suffix?: string;
}) {
  const args = hostArgs(input.binding, input.records);
  const logicalToolCallId = `logical:${input.binding.nodeId}:${input.suffix ?? 'one'}`;
  const opened = dispatch.admitLogicalCall({
    identity: { ...input.task, logicalToolCallId },
    tool: input.binding.toolName,
    args,
  });
  assert.ok(opened.status === 'inserted' || opened.status === 'replayed', JSON.stringify(opened));
  const result = admission.admitExpectedWorkInvocation({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    logicalToolCallId,
    proposal: null,
    requirementId: input.binding.nodeId,
    universeItemId: null,
    universeSelector: null,
    tool: input.binding.toolName,
    args,
    hostSealedEffect: 'external_write',
  });
  const physical = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    input.task.sessionId,
    input.task.sourceUserSeq,
    logicalToolCallId,
  ) as { count: number };
  assert.equal(physical.count, 0, 'lineage admission cannot execute the mutation body');
  return { result, logicalToolCallId };
}

const read = (id: string, dependsOn: string[] = []): Operation => ({
  id,
  effect: 'read',
  coverage: 'single',
  dependsOn,
  dataFrom: [],
  cardinality: { kind: 'once' },
});
const compute = (id: string, dependsOn: string[], dataFrom = dependsOn): Operation => ({
  id,
  effect: 'compute',
  dependsOn,
  dataFrom,
  cardinality: { kind: 'once' },
});
const create = (dependsOn: string[], dataFrom = dependsOn): Operation => ({
  id: 'op-create',
  effect: 'external_write',
  dependsOn,
  dataFrom,
  cardinality: { kind: 'once' },
});
const readback = (): Operation => read('op-readback', ['op-create']);

const SOURCE_RECORDS = [{ id: 'alpha', status: 'raw' }];
const TRANSFORMED_RECORDS = [{ id: 'alpha', status: 'ready' }];

test('host-sealed generic create admits direct read lineage and exact transformed lineage', async (t) => {
  await t.test('direct read -> create -> readback', () => {
    const task = acceptLineageTask([read('op-source'), create(['op-source']), readback()]);
    const bindings = bindTaskNodes(task);
    admitAndSettleLineageNode({
      task,
      binding: bindings.get('op-source')!,
      inputPayload: { query: 'alpha' },
      resultPayload: { records: SOURCE_RECORDS, total: 1, has_more: false },
    });
    const admitted = admitCreateWithoutDispatch({
      task,
      binding: bindings.get('op-create')!,
      records: SOURCE_RECORDS,
    }).result;
    assert.equal(admitted.status, 'bound', JSON.stringify(admitted));
    assert.equal(
      admitted.status === 'bound'
        && (admitted.binding.generatedArtifactContentContract as { lineageNodeId?: string } | undefined)
          ?.lineageNodeId,
      'op-source',
    );
  });

  await t.test('read -> exact compute -> create -> readback', () => {
    const task = acceptLineageTask([
      read('op-source'),
      compute('op-transform', ['op-source']),
      create(['op-transform']),
      readback(),
    ]);
    const bindings = bindTaskNodes(task);
    admitAndSettleLineageNode({
      task,
      binding: bindings.get('op-source')!,
      inputPayload: { query: 'alpha' },
      resultPayload: { records: SOURCE_RECORDS, total: 1, has_more: false },
    });
    admitAndSettleLineageNode({
      task,
      binding: bindings.get('op-transform')!,
      inputPayload: SOURCE_RECORDS,
      resultPayload: TRANSFORMED_RECORDS,
    });
    const admitted = admitCreateWithoutDispatch({
      task,
      binding: bindings.get('op-create')!,
      records: TRANSFORMED_RECORDS,
    }).result;
    assert.equal(admitted.status, 'bound', JSON.stringify(admitted));
    assert.equal(
      admitted.status === 'bound'
        && (admitted.binding.generatedArtifactContentContract as { lineageNodeId?: string } | undefined)
          ?.lineageNodeId,
      'op-transform',
      'the content contract names the transformed bytes, never the raw ancestor',
    );
  });
});

test('host-sealed generic create rejects ambiguous, missing, or mismatched lineage before mutation I/O', async (t) => {
  const assertSourceWitnessRefusal = (
    task: LineageTask,
    binding: SealedNodeBinding,
    records: unknown[],
    label: string,
  ) => {
    const attempt = admitCreateWithoutDispatch({ task, binding, records, suffix: label });
    assert.equal(attempt.result.status, 'refused', JSON.stringify(attempt.result));
    assert.equal(
      attempt.result.status === 'refused' && attempt.result.kind,
      'work_source_witness_missing',
      JSON.stringify(attempt.result),
    );
    const bound = eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS count FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(task.sessionId, task.sourceUserSeq, attempt.logicalToolCallId) as { count: number };
    assert.equal(bound.count, 0, 'a refused create cannot retain mutation work authority');
  };

  await t.test('ambiguous multiple dataFrom sources', () => {
    const task = acceptLineageTask([
      read('op-source-a'),
      read('op-source-b'),
      create(['op-source-a', 'op-source-b']),
      readback(),
    ]);
    const bindings = bindTaskNodes(task);
    for (const sourceId of ['op-source-a', 'op-source-b']) {
      admitAndSettleLineageNode({
        task,
        binding: bindings.get(sourceId)!,
        inputPayload: { query: sourceId },
        resultPayload: { records: SOURCE_RECORDS, total: 1, has_more: false },
      });
    }
    assertSourceWitnessRefusal(task, bindings.get('op-create')!, SOURCE_RECORDS, 'ambiguous');
  });

  await t.test('compute node with no declared dataFrom ancestor', () => {
    const task = acceptLineageTask([
      read('op-source'),
      compute('op-transform', ['op-source'], []),
      create(['op-transform']),
      readback(),
    ]);
    const bindings = bindTaskNodes(task);
    admitAndSettleLineageNode({
      task,
      binding: bindings.get('op-source')!,
      inputPayload: { query: 'alpha' },
      resultPayload: { records: SOURCE_RECORDS, total: 1, has_more: false },
    });
    admitAndSettleLineageNode({
      task,
      binding: bindings.get('op-transform')!,
      inputPayload: SOURCE_RECORDS,
      resultPayload: TRANSFORMED_RECORDS,
    });
    assertSourceWitnessRefusal(task, bindings.get('op-create')!, TRANSFORMED_RECORDS, 'missing');
  });

  await t.test('transform input digest does not match the exact source bytes', () => {
    const task = acceptLineageTask([
      read('op-source'),
      compute('op-transform', ['op-source']),
      create(['op-transform']),
      readback(),
    ]);
    const bindings = bindTaskNodes(task);
    admitAndSettleLineageNode({
      task,
      binding: bindings.get('op-source')!,
      inputPayload: { query: 'alpha' },
      resultPayload: { records: SOURCE_RECORDS, total: 1, has_more: false },
    });
    admitAndSettleLineageNode({
      task,
      binding: bindings.get('op-transform')!,
      inputPayload: [{ id: 'different', status: 'raw' }],
      resultPayload: TRANSFORMED_RECORDS,
    });
    assertSourceWitnessRefusal(task, bindings.get('op-create')!, TRANSFORMED_RECORDS, 'mismatch');
  });

});
