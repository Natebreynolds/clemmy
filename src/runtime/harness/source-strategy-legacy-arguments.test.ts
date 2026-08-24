import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TurnSourceStrategyBindingV1 } from './turn-control.js';

const PRIOR_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const PRIOR_MCP_AUTO_IMPORT_ENABLED = process.env.MCP_AUTO_IMPORT_ENABLED;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-source-strategy-legacy-args-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'state', 'machine-id'),
  'machine-source-strategy-legacy-args\n',
  'utf8',
);

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const expectedWork = await import('./expected-work-contract.js');
const expectedWorkAdmission = await import('./expected-work-admission.js');
const identities = await import('./attempt-identity.js');
const dispatchLedger = await import('./dispatch-ledger.js');
const dispatchLeases = await import('./dispatch-lease.js');
const logicalContracts = await import('./logical-call-contract.js');
const sourceAdmission = await import('./source-strategy-admission.js');
const continuityRuntime = await import('./task-continuity-runtime.js');
const turnControl = await import('./turn-control.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { recordAcceptedSourceGraph } = await import('./record-accepted-source-graph.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_CLEMENTINE_HOME;
  if (PRIOR_MCP_AUTO_IMPORT_ENABLED === undefined) delete process.env.MCP_AUTO_IMPORT_ENABLED;
  else process.env.MCP_AUTO_IMPORT_ENABLED = PRIOR_MCP_AUTO_IMPORT_ENABLED;
});

const TOOL = 'SOURCECO_GET_ITEMS';
const CAPABILITY = {
  capabilityId: `capability:composio:${TOOL}`,
  accountIdentity: 'source-reader@example.test',
  schemaFingerprint: 'schema:sourceco:v1',
} as const;
const BINDING: TurnSourceStrategyBindingV1 = {
  version: 1,
  primary: CAPABILITY,
  equivalentFallbacks: [],
  topology: 'single_aggregate_read_then_single_artifact_write',
  topologyDigest: 'b'.repeat(64),
  destination: { family: 'workbook', posture: 'create_new' },
  effect: 'external_write',
};

let serial = 0;
async function acceptedSourceTask(): Promise<{ sessionId: string; sourceUserSeq: number; turn: number }> {
  const session = eventlog.createSession({ id: `legacy-source-args-${++serial}`, kind: 'chat' });
  const objective = 'Find the top 5 restaurants in Pismo Beach by public reviews and create one new Google Sheet.';
  const question = 'Use the exact bound SourceCo collection before creating the sheet?';
  const intentKey = `legacy-source-args-${serial}`;
  const parent = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: objective },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: parent.seq, turn: 1 },
  }));
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'system',
    type: 'turn_preflight_decision',
    data: {
      phase: 'align',
      consequential: true,
      objective,
      intentKey,
      reason: 'collect_then_construct',
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyPosture: 'materially_variant',
      sourceStrategyBinding: BINDING,
      sourceUserSeq: parent.seq,
    },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      purpose: 'clarification',
      source: 'preflight_alignment',
      sourceUserSeq: parent.seq,
      intentKey,
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyBinding: BINDING,
    },
  });
  const parentIdentity = { sessionId: session.id, sourceUserSeq: parent.seq, turn: 1 };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentIdentity),
    identity: parentIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Yes' },
  });
  const enriched = await continuityRuntime.enrichAcceptedRequestWithTaskContinuity({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    message: 'Yes',
  }, source.seq, { typedClassification: { disposition: 'affirmed' } });
  const inspection = continuityRuntime.inspectDurableMaterialSourceContinuation({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(inspection.status, 'verified', JSON.stringify(inspection));
  if (inspection.status !== 'verified') throw new Error('formal A/Q/B inspection failed');
  turnControl.recordTurnPreflightDecision(session.id, inspection.decision, source.seq);
  const graph = await recordAcceptedSourceGraph({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 2 },
    surface: 'direct',
    acceptedText: 'Yes',
    verifiedTaskContinuation: enriched.taskContinuation,
  });
  assert.ok(graph);
  const frozen = expectedWork.freezeDeterministicExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  const activated = expectedWorkAdmission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 2,
  });
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 2 };
}

async function invokeSource<T>(
  task: Awaited<ReturnType<typeof acceptedSourceTask>>,
  args: Record<string, unknown>,
  callback: () => Promise<T>,
  options: { callBound?: boolean } = {},
): Promise<T> {
  const cross = () => sourceAdmission.withSourceStrategyRequirement(
    { role: 'collection', effect: 'read', bindingRequired: true },
    () => identities.withPhysicalDispatch({
      ...task,
      tool: TOOL,
      args,
      sourceCapability: CAPABILITY,
    }, callback),
  );
  if (!options.callBound) {
    return identities.withLogicalToolCall({
      ...task,
      tool: TOOL,
      args,
    }, cross);
  }
  const acceptedTaskId = identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq);
  const recovery = logicalContracts.durableLogicalCallRecoveryMaterial(
    acceptedTaskId,
    TOOL,
    args,
  );
  assert.ok(recovery);
  const parentLease = dispatchLeases.activateDispatchLease({
    sessionId: task.sessionId,
    scopeId: `${task.sessionId}::legacy-args-parent`,
  });
  let childLease: dispatchLeases.DispatchLeaseRef | undefined;
  try {
    return await identities.withLogicalToolCall({
      ...task,
      tool: TOOL,
      args,
    }, (logical) => {
      childLease = dispatchLeases.activateDispatchLease({
        sessionId: task.sessionId,
        scopeId: `${task.sessionId}::legacy-args-call`,
        parentLease,
        sourceUserSeq: task.sourceUserSeq,
        acceptedTaskId,
        logicalToolCallId: logical.logicalToolCallId,
        recovery: {
          effect: 'read',
          businessCall: true,
          material: recovery!,
          turn: task.turn,
        },
      });
      return dispatchLeases.runWithDispatchLease(childLease, cross);
    });
  } finally {
    dispatchLeases.revokeDispatchLease(childLease);
    dispatchLeases.revokeDispatchLease(parentLease);
  }
}

test('historical binding alone refuses nonempty args, while a fresh current call token and exact empty args cross', async () => {
  const nonemptyTask = await acceptedSourceTask();
  let nonemptyCallbacks = 0;
  await assert.rejects(
    invokeSource(nonemptyTask, { request: { query: 'pismo restaurants' } }, async () => {
      nonemptyCallbacks += 1;
      return 'must not run';
    }),
    (error: unknown) => error instanceof identities.SourceStrategyPhysicalDispatchError
      && error.kind === 'source_strategy_authority_invalid'
      && /does not carry current call-bound authority/i.test(error.message),
  );
  assert.equal(nonemptyCallbacks, 0);
  assert.deepEqual(
    dispatchLedger.physicalCrossingsFor(nonemptyTask.sessionId, nonemptyTask.sourceUserSeq),
    [],
    'a legacy nonempty source acquired a physical provider row',
  );

  const callBoundTask = await acceptedSourceTask();
  let callBoundCallbacks = 0;
  const callBoundResult = await invokeSource(
    callBoundTask,
    {
      request: {
        query: 'top five restaurants in Pismo Beach by public reviews',
        limit: 5,
      },
    },
    async () => {
      callBoundCallbacks += 1;
      return 'five current restaurants';
    },
    { callBound: true },
  );
  assert.equal(callBoundResult, 'five current restaurants');
  assert.equal(callBoundCallbacks, 1);
  assert.equal(
    dispatchLedger.physicalCrossingsFor(
      callBoundTask.sessionId,
      callBoundTask.sourceUserSeq,
    ).length,
    1,
  );

  const emptyTask = await acceptedSourceTask();
  let emptyCallbacks = 0;
  const result = await invokeSource(emptyTask, {}, async () => {
    emptyCallbacks += 1;
    return 'empty source returned';
  });
  assert.equal(result, 'empty source returned');
  assert.equal(emptyCallbacks, 1);
  const crossings = dispatchLedger.physicalCrossingsFor(emptyTask.sessionId, emptyTask.sourceUserSeq);
  assert.equal(crossings.length, 1);
  assert.equal(crossings[0]?.outcome, 'returned');
  assert.equal(crossings[0]?.settled, true);
});
