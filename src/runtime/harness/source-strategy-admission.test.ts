import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MCPServer } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-source-strategy-admission-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-source-strategy-admission\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const expectedWork = await import('./expected-work-contract.js');
const expectedWorkAdmission = await import('./expected-work-admission.js');
const resolution = await import('./resolution-ledger.js');
const identities = await import('./attempt-identity.js');
const dispatchLeases = await import('./dispatch-lease.js');
const logicalContracts = await import('./logical-call-contract.js');
const sourceAdmission = await import('./source-strategy-admission.js');
const turnControl = await import('./turn-control.js');
const brackets = await import('./brackets.js');
const groundingGate = await import('./grounding-gate.js');
const goalFidelityGate = await import('./goal-fidelity-gate.js');
const outputGroundingGate = await import('./output-grounding-gate.js');
const mcpNamespace = await import('../mcp-namespace-shim.js');
const { buildWorkCall } = await import('../../tools/work-call.js');
const { _setInnerDispatchToolsForTests } = await import('../../tools/inner-dispatch.js');

test.after(() => {
  _setInnerDispatchToolsForTests(null);
  groundingGate._setGroundingJudgeForTests(null);
  goalFidelityGate._setGoalFidelityJudgeForTests(null);
  outputGroundingGate._setOutputGroundingJudgeForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const APIFY = {
  capabilityId: 'capability:composio:APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
  accountIdentity: 'research@example.com',
  schemaFingerprint: 'schema:apify:v7',
} as const;
const SOURCECO_FALLBACK = {
  capabilityId: 'capability:mcp:sourceco__search_places',
  schemaFingerprint: 'schema:sourceco:v1',
} as const;
const BINDING: turnControl.TurnSourceStrategyBindingV1 = {
  version: 1,
  primary: APIFY,
  equivalentFallbacks: [SOURCECO_FALLBACK],
  topology: 'single_aggregate_read_then_single_artifact_write',
  topologyDigest: 'a'.repeat(64),
  destination: { family: 'workbook', posture: 'create_new' },
  effect: 'external_write',
};

function decision(
  posture: turnControl.TurnSourceStrategyPosture = 'confirmed_exact',
  binding: turnControl.TurnSourceStrategyBindingV1 | null = BINDING,
): turnControl.TurnPreflightDecision {
  return {
    phase: posture === 'confirmed_exact' ? 'execute' : 'align',
    consequential: true,
    sourceStrategyPosture: posture,
    ...(posture === 'materially_variant'
      ? { confirmationDisposition: 'material_source_strategy' as const }
      : {}),
    ...(binding ? { sourceStrategyBinding: binding } : {}),
    reason: posture === 'confirmed_exact' ? 'continuation_approved' : 'collect_then_construct',
  };
}

test('incident policy: unconfirmed Pismo source starts no business call; confirmed Apify and only an exact listed fallback are admitted', () => {
  const unconfirmed = sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: 'read',
    requirementRole: 'collection',
    decision: decision('materially_variant'),
    capability: APIFY,
  });
  assert.equal(unconfirmed.status, 'refused');
  if (unconfirmed.status === 'refused') assert.equal(unconfirmed.kind, 'source_strategy_unconfirmed');

  assert.deepEqual(sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: 'read',
    requirementRole: 'collection',
    decision: decision(),
    capability: APIFY,
    args: {},
  }), { status: 'admitted', match: 'primary', binding: BINDING });

  assert.deepEqual(sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: 'compute',
    requirementRole: 'collection',
    decision: decision(),
    capability: APIFY,
    args: {},
  }), { status: 'admitted', match: 'primary', binding: BINDING });

  assert.deepEqual(sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: 'read',
    requirementRole: 'collection',
    decision: decision(),
    capability: SOURCECO_FALLBACK,
    args: {},
  }), { status: 'admitted', match: 'equivalent_fallback', binding: BINDING });

  const wrongPrimarySchema = sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: 'read',
    requirementRole: 'collection',
    decision: decision(),
    capability: { ...APIFY, schemaFingerprint: 'schema:apify:v8' },
  });
  assert.equal(wrongPrimarySchema.status, 'refused');
  if (wrongPrimarySchema.status === 'refused') assert.equal(wrongPrimarySchema.kind, 'source_strategy_mismatch');

  for (const [label, binding, capability] of [
    [
      'missing expected schema',
      { ...BINDING, primary: { capabilityId: APIFY.capabilityId, accountIdentity: APIFY.accountIdentity } },
      APIFY,
    ],
    [
      'missing expected account for an account-bound manifest',
      { ...BINDING, primary: { capabilityId: APIFY.capabilityId, schemaFingerprint: APIFY.schemaFingerprint } },
      APIFY,
    ],
    [
      'missing physical account',
      BINDING,
      { capabilityId: APIFY.capabilityId, schemaFingerprint: APIFY.schemaFingerprint },
    ],
  ] as const) {
    const result = sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
      requirementEffect: 'read',
      requirementRole: 'collection',
      decision: decision('confirmed_exact', binding as turnControl.TurnSourceStrategyBindingV1),
      capability,
      args: {},
    });
    assert.equal(result.status, 'refused', label);
    if (result.status === 'refused') assert.equal(result.kind, 'source_strategy_mismatch', label);
  }
});

test('explicit or collect-then-construct source intent without a durable exact binding fails closed; legacy turns still no-op', () => {
  assert.deepEqual(sourceAdmission.evaluateSourceStrategyIdentityAdmission({
    requirementEffect: 'read',
    requirementRole: 'collection',
    decision: null,
    capability: APIFY,
    bindingRequired: false,
  }), { status: 'not_applicable', reason: 'no_binding' },
  'an ordinary current-turn chat source is not blanket-rejected for lacking historical binding');

  const missingDecision = sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: 'read',
    requirementRole: 'collection',
    decision: null,
    capability: APIFY,
    requireDurableDecision: true,
  });
  assert.equal(missingDecision.status, 'refused');
  if (missingDecision.status === 'refused') {
    assert.equal(missingDecision.kind, 'source_strategy_authority_invalid');
    assert.match(missingDecision.message, /no durable preflight decision/i);
  }

  for (const missingBindingDecision of [
    decision('confirmed_exact', null),
    {
      phase: 'align',
      consequential: true,
      confirmationDisposition: 'material_source_strategy',
      reason: 'collect_then_construct',
    } satisfies turnControl.TurnPreflightDecision,
  ]) {
    const admission = sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
      requirementEffect: 'read',
      requirementRole: 'collection',
      decision: missingBindingDecision,
      capability: APIFY,
    });
    assert.equal(admission.status, 'refused');
    if (admission.status === 'refused') {
      assert.equal(admission.kind, 'source_strategy_authority_invalid');
      assert.match(admission.message, /No source provider call was started/);
    }
  }

  assert.deepEqual(sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: 'read',
    requirementRole: 'collection',
    decision: {
      phase: 'execute',
      consequential: true,
      reason: 'ordinary_execution',
    },
    capability: APIFY,
  }), { status: 'not_applicable', reason: 'no_binding' });
});

test('source strategy does not become a second destination/readback policy kernel', () => {
  assert.deepEqual(sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: 'external_write',
    requirementRole: 'destination',
    decision: decision(),
    capability: { capabilityId: 'capability:composio:GOOGLESHEETS_CREATE_SPREADSHEET' },
  }), { status: 'not_applicable', reason: 'not_read' });
  assert.deepEqual(sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: 'read',
    requirementRole: 'readback',
    decision: decision(),
    capability: { capabilityId: 'capability:composio:GOOGLESHEETS_GET_SPREADSHEET' },
  }), { status: 'not_applicable', reason: 'not_source_requirement' });
});

test('multiple durable source decisions fail closed instead of degrading to an unspecified source', () => {
  const task = acceptedSourceTask();
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: 0,
    role: 'system',
    type: 'turn_preflight_decision',
    data: { ...decision(), sourceUserSeq: task.sourceUserSeq },
  });
  const admission = sourceAdmission.withSourceStrategyRequirement(
    { role: 'collection', effect: 'read', bindingRequired: true },
    () => sourceAdmission.admitSourceStrategyPhysicalDispatch({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      capability: APIFY,
      tool: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
      args: {},
    }),
  );
  assert.equal(admission.status, 'refused');
  if (admission.status === 'refused') {
    assert.equal(admission.kind, 'source_strategy_authority_invalid');
    assert.match(admission.message, /ambiguous or malformed durable preflight authority/i);
  }
});

let serial = 0;
function acceptedSourceTask(
  binding: turnControl.TurnSourceStrategyBindingV1 | null = BINDING,
  posture: turnControl.TurnSourceStrategyPosture = 'confirmed_exact',
  persistDecision = true,
) {
  const session = eventlog.createSession({ id: `source-strategy-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Find the top 5 restaurants in Pismo Beach by public reviews and create one new Google Sheet.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const frozen = expectedWork.freezeDeterministicExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', `contract was ${frozen.status}`);
  if (frozen.status !== 'fixed' && frozen.status !== 'replayed') throw new Error(frozen.reason);
  const expected = resolution.expectedTaskFor(session.id, source.seq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') throw new Error(expected.reason);
  const requirement = frozen.contract.operations.find((operation) => operation.effect === 'read');
  assert.ok(requirement);
  if (persistDecision) {
    eventlog.appendEvent({
      sessionId: session.id,
      turn: 0,
      role: 'system',
      type: 'turn_preflight_decision',
      data: { ...decision(posture, binding), sourceUserSeq: source.seq },
    });
  }
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    requirementId: requirement!.id,
    frozenContract: frozen.contract,
  };
}

function continuationLikeSourceTaskWithoutBinding() {
  const session = eventlog.createSession({ id: `source-strategy-continuation-${++serial}`, kind: 'chat' });
  const parent = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Find the top 5 public records by rating and create one new spreadsheet.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: parent.seq, turn: 1 },
  }));
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Yes—use exactly the primary source action you named, with the same parameters. Do not use the fallback.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 2 },
  }));
  const expected = resolution.expectedTaskFor(session.id, source.seq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') throw new Error(expected.reason);
  assert.equal(expected.graph.classification.route, 'act');
  assert.equal(expected.graph.classification.multiItem.collectThenConstruct, false);
  assert.ok(expected.graph.nodes.every((node) => node.capabilityRole === undefined));
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'system',
    type: 'turn_preflight_decision',
    data: {
      phase: 'execute',
      consequential: false,
      reason: 'ordinary_execution',
      sourceUserSeq: source.seq,
    },
  });
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 2,
    requirementId: 'read_source',
  };
}

function trustedCollectThenConstructTask(requirementId: string) {
  const session = eventlog.createSession({ id: `source-strategy-trusted-ctc-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Find the top 5 public records by rating and create one new spreadsheet.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const expected = resolution.expectedTaskFor(session.id, source.seq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') throw new Error(expected.reason);
  assert.equal(expected.graph.classification.multiItem.collectThenConstruct, true);
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'system',
    type: 'turn_preflight_decision',
    data: { ...decision(), sourceUserSeq: source.seq },
  });
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    requirementId,
  };
}

function trustedCollectThenConstructDeliveryTask(requirementId: string) {
  const session = eventlog.createSession({ id: `source-strategy-trusted-ctc-delivery-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Find the top 5 public records by rating, create one new spreadsheet, verify it, and email me the link.',
    },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const expected = resolution.expectedTaskFor(session.id, source.seq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') throw new Error(expected.reason);
  assert.equal(expected.graph.classification.multiItem.collectThenConstruct, true);
  assert.ok(expected.graph.classification.externalEffectKinds.includes('communication'));
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'system',
    type: 'turn_preflight_decision',
    data: { ...decision(), sourceUserSeq: source.seq },
  });
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    requirementId,
  };
}

async function physicalSourceAttempt(input: {
  task: ReturnType<typeof acceptedSourceTask>;
  tool: string;
  capability: sourceAdmission.PhysicalSourceCapabilityIdentityV1;
  args?: Record<string, unknown>;
  provider: () => Promise<string>;
}): Promise<string> {
  const args = input.args ?? {};
  const acceptedTaskId = identities.acceptedTaskIdFor(
    input.task.sessionId,
    input.task.sourceUserSeq,
  );
  const recovery = logicalContracts.durableLogicalCallRecoveryMaterial(
    acceptedTaskId,
    input.tool,
    args,
  );
  assert.ok(recovery);
  const parentLease = dispatchLeases.activateDispatchLease({
    sessionId: input.task.sessionId,
    scopeId: `${input.task.sessionId}::source-test-parent`,
  });
  let childLease: dispatchLeases.DispatchLeaseRef | undefined;
  try {
    return await identities.withLogicalToolCall({
      ...input.task,
      tool: input.tool,
      args,
    }, (logical) => {
      childLease = dispatchLeases.activateDispatchLease({
        sessionId: input.task.sessionId,
        scopeId: `${input.task.sessionId}::source-test-call`,
        parentLease,
        sourceUserSeq: input.task.sourceUserSeq,
        acceptedTaskId,
        logicalToolCallId: logical.logicalToolCallId,
        recovery: {
          effect: 'read',
          businessCall: true,
          material: recovery!,
          turn: input.task.turn,
        },
      });
      return dispatchLeases.runWithDispatchLease(childLease, () => (
        sourceAdmission.withSourceStrategyRequirement(
          { role: 'collection', effect: 'read', bindingRequired: true },
          () => identities.withPhysicalDispatch({
            ...input.task,
            tool: input.tool,
            args,
            sourceCapability: input.capability,
          }, input.provider),
        )
      ));
    });
  } finally {
    dispatchLeases.revokeDispatchLease(childLease);
    dispatchLeases.revokeDispatchLease(parentLease);
  }
}

test('Composio physical pin: bound Apify crosses; DataForSEO is denied before dispatch, including exact account/schema drift', async () => {
  let missingDecisionCalls = 0;
  const missingDecisionTask = acceptedSourceTask(BINDING, 'confirmed_exact', false);
  await assert.rejects(
    physicalSourceAttempt({
      task: missingDecisionTask,
      tool: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
      capability: APIFY,
      provider: async () => { missingDecisionCalls += 1; return 'must not run'; },
    }),
    (error: unknown) => error instanceof identities.SourceStrategyPhysicalDispatchError
      && error.kind === 'source_strategy_authority_invalid',
  );
  assert.equal(missingDecisionCalls, 0);

  let missingBindingCalls = 0;
  const missingBindingTask = acceptedSourceTask(null, 'confirmed_exact');
  await assert.rejects(
    physicalSourceAttempt({
      task: missingBindingTask,
      tool: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
      capability: APIFY,
      provider: async () => { missingBindingCalls += 1; return 'must not run'; },
    }),
    (error: unknown) => error instanceof identities.SourceStrategyPhysicalDispatchError
      && error.kind === 'source_strategy_authority_invalid',
  );
  assert.equal(missingBindingCalls, 0);

  let unconfirmedCalls = 0;
  const unconfirmedTask = acceptedSourceTask(BINDING, 'materially_variant');
  await assert.rejects(
    physicalSourceAttempt({
      task: unconfirmedTask,
      tool: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
      capability: APIFY,
      provider: async () => { unconfirmedCalls += 1; return 'must not run'; },
    }),
    (error: unknown) => error instanceof identities.SourceStrategyPhysicalDispatchError
      && error.kind === 'source_strategy_unconfirmed',
  );
  assert.equal(unconfirmedCalls, 0);

  let apifyCalls = 0;
  const allowedTask = acceptedSourceTask();
  const result = await physicalSourceAttempt({
    task: allowedTask,
    tool: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
    capability: APIFY,
    args: {
      actorId: 'compass/crawler-google-places',
      runInput: { searchStringsArray: ['restaurants in Pismo Beach CA'] },
      maxItems: 5,
    },
    provider: async () => { apifyCalls += 1; return 'five restaurants'; },
  });
  assert.equal(result, 'five restaurants');
  assert.equal(apifyCalls, 1);

  for (const capability of [
    { capabilityId: 'capability:composio:DATAFORSEO_CREATE_SERP_GOOGLE_MAPS_TASK' },
    { ...APIFY, accountIdentity: 'other@example.com' },
    { ...APIFY, schemaFingerprint: 'schema:apify:v8' },
  ]) {
    let providerCalls = 0;
    const deniedTask = acceptedSourceTask();
    await assert.rejects(
      physicalSourceAttempt({
        task: deniedTask,
        tool: capability.capabilityId.split(':').at(-1)!,
        capability,
        provider: async () => { providerCalls += 1; return 'must not run'; },
      }),
      (error: unknown) => error instanceof identities.SourceStrategyPhysicalDispatchError
        && error.kind === 'source_strategy_mismatch'
        && /No provider call was started/.test(error.message),
    );
    assert.equal(providerCalls, 0);
  }
});

test('native MCP physical pin: only the exact enumerated fallback crosses', async () => {
  let allowedCalls = 0;
  const allowedTask = acceptedSourceTask();
  await physicalSourceAttempt({
    task: allowedTask,
    tool: 'sourceco__search_places',
    capability: SOURCECO_FALLBACK,
    provider: async () => { allowedCalls += 1; return 'ok'; },
  });
  assert.equal(allowedCalls, 1);

  let deniedCalls = 0;
  const deniedTask = acceptedSourceTask();
  await assert.rejects(
    physicalSourceAttempt({
      task: deniedTask,
      tool: 'dataforseo__maps_search',
      capability: { capabilityId: 'capability:mcp:dataforseo__maps_search' },
      provider: async () => { deniedCalls += 1; return 'must not run'; },
    }),
    identities.SourceStrategyPhysicalDispatchError,
  );
  assert.equal(deniedCalls, 0);
});

test('native MCP source mismatch refuses before grounding, goal-fidelity, or output-grounding judges can spend model I/O', async () => {
  const boundNativeSource: turnControl.TurnSourceStrategyBindingV1 = {
    ...BINDING,
    primary: { capabilityId: 'capability:mcp:sourceco__search_places' },
    equivalentFallbacks: [],
  };
  const task = acceptedSourceTask(boundNativeSource);
  const args = {
    method: 'POST',
    url: 'https://alternate-source.example.test/search',
    to: 'lead@example.com',
    body: 'Quarterly pipeline is 29 accounts for lead@example.com.',
  };

  // This is the supported captured-output fixture used by the gate suites. It
  // makes all three deterministic prefilters reach their injected judges; the
  // admitted precondition below prevents a vacuous zero-counter assertion.
  const sourceCallId = `judge-source-${task.sourceUserSeq}`;
  const sourceCalled = eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'tool',
    type: 'tool_called',
    data: {
      tool: 'sourceco__read_record',
      callId: sourceCallId,
      effect: 'read',
      sourceUserSeq: task.sourceUserSeq,
    },
  });
  eventlog.writeToolOutput({
    sessionId: task.sessionId,
    callId: sourceCallId,
    tool: 'sourceco__read_record',
    output: 'lead@example.com has a quarterly pipeline of 17 accounts.',
    invocationNonce: `nonce-${sourceCallId}`,
  });
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: sourceCalled.id,
    data: {
      tool: 'sourceco__read_record',
      callId: sourceCallId,
      effect: 'read',
      result: 'stored separately',
      sourceUserSeq: task.sourceUserSeq,
    },
  });

  const judgeCalls = { grounding: 0, goalFidelity: 0, outputGrounding: 0 };
  groundingGate._setGroundingJudgeForTests(async () => {
    judgeCalls.grounding += 1;
    return { grounded: true, reason: 'test fixture reached grounding judge' };
  });
  goalFidelityGate._setGoalFidelityJudgeForTests(async () => {
    judgeCalls.goalFidelity += 1;
    return { fulfills: true, gap: 'test fixture reached goal-fidelity judge' };
  });
  outputGroundingGate._setOutputGroundingJudgeForTests(async () => {
    judgeCalls.outputGrounding += 1;
    return { verdict: 'grounded', offending: [], reason: 'test fixture reached output-grounding judge' };
  });

  const previousGateEnv = {
    grounding: process.env.CLEMMY_GROUNDING_GATE,
    goalFidelity: process.env.CLEMMY_GOAL_FIDELITY_GATE,
    goalAlignment: process.env.CLEMMY_GOAL_ALIGNMENT_GATE,
    outputGrounding: process.env.CLEMMY_OUTPUT_GROUNDING_GATE,
  };
  process.env.CLEMMY_GROUNDING_GATE = 'on';
  process.env.CLEMMY_GOAL_FIDELITY_GATE = 'on';
  process.env.CLEMMY_GOAL_ALIGNMENT_GATE = 'on';
  process.env.CLEMMY_OUTPUT_GROUNDING_GATE = 'on';

  let providerBodies = 0;
  const server = {
    name: 'dataforseo',
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {},
    async close() {},
    async invalidateToolsCache() {},
    async listTools() {
      return [{ name: 'maps_search', description: 'search', inputSchema: { type: 'object' } }];
    },
    async callTool() {
      providerBodies += 1;
      return [{ type: 'text', text: 'must not execute' }];
    },
  } as unknown as MCPServer;
  const shim = mcpNamespace.createMcpNamespaceShim({ servers: [server] });
  const namespaced = mcpNamespace.namespaceToolName(
    mcpNamespace.slugifyServerName(server.name),
    'maps_search',
  );

  try {
    await groundingGate.evaluateGrounding(task.sessionId, namespaced, args);
    await goalFidelityGate.evaluateGoalFidelity(task.sessionId, namespaced, args);
    await outputGroundingGate.evaluateOutputGrounding(
      task.sessionId,
      String(args.body),
    );
    assert.deepEqual(judgeCalls, { grounding: 1, goalFidelity: 1, outputGrounding: 1 },
      'the fixture would spend all three judge calls if execution reached the gates');
    judgeCalls.grounding = 0;
    judgeCalls.goalFidelity = 0;
    judgeCalls.outputGrounding = 0;

    // Route preparation is explicitly outside the business call. The assertion
    // below owns only provider bodies and model judges after the accepted call.
    await shim.listTools();
    const acceptedTaskId = identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq);
    const recovery = logicalContracts.durableLogicalCallRecoveryMaterial(
      acceptedTaskId,
      namespaced,
      args,
    );
    assert.ok(recovery);
    const parentLease = dispatchLeases.activateDispatchLease({
      sessionId: task.sessionId,
      scopeId: `${task.sessionId}::native-source-parent`,
    });
    let childLease: dispatchLeases.DispatchLeaseRef | undefined;
    try {
      await assert.rejects(
        () => identities.withLogicalToolCall({
          ...task,
          tool: namespaced,
          args,
        }, (logical) => {
          childLease = dispatchLeases.activateDispatchLease({
            sessionId: task.sessionId,
            scopeId: `${task.sessionId}::native-source-call`,
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
          return dispatchLeases.runWithDispatchLease(childLease, () => (
            brackets.withHarnessRunContext({
              ...task,
              counter: new brackets.ToolCallsCounter(20),
              dispatchLease: childLease,
            }, () => sourceAdmission.withSourceStrategyRequirement(
              { role: 'collection', effect: 'read', bindingRequired: true },
              () => shim.callTool(namespaced, args),
            ))
          ));
        }),
        (error: unknown) => error instanceof identities.SourceStrategyPhysicalDispatchError
          && error.kind === 'source_strategy_mismatch',
      );
    } finally {
      dispatchLeases.revokeDispatchLease(childLease);
      dispatchLeases.revokeDispatchLease(parentLease);
    }

    assert.deepEqual(judgeCalls, { grounding: 0, goalFidelity: 0, outputGrounding: 0 },
      'source mismatch is earlier than every model-backed integrity judge');
    assert.equal(providerBodies, 0, 'source mismatch cannot enter the MCP provider body');
    assert.equal(eventlog.listEvents(task.sessionId, { types: ['external_write'] }).length, 0,
      'source mismatch cannot reserve an external write');
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS count FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(task.sessionId, task.sourceUserSeq) as { count: number }).count, 0,
    'source mismatch owns no physical provider row');
  } finally {
    groundingGate._setGroundingJudgeForTests(null);
    goalFidelityGate._setGoalFidelityJudgeForTests(null);
    outputGroundingGate._setOutputGroundingJudgeForTests(null);
    for (const [key, value] of Object.entries({
      CLEMMY_GROUNDING_GATE: previousGateEnv.grounding,
      CLEMMY_GOAL_FIDELITY_GATE: previousGateEnv.goalFidelity,
      CLEMMY_GOAL_ALIGNMENT_GATE: previousGateEnv.goalAlignment,
      CLEMMY_OUTPUT_GROUNDING_GATE: previousGateEnv.outputGrounding,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('work_call refuses shell/curl before execution and admits the exact bound Composio carrier', async () => {
  const invokeWorkCall = async (input: {
    task: ReturnType<typeof acceptedSourceTask>;
    name: string;
    args: Record<string, unknown>;
    callId: string;
    sourceStrategyBinding?: turnControl.TurnSourceStrategyBindingV1;
  }): Promise<unknown> => {
    const activated = expectedWorkAdmission.activateActionExpectedWork(input.task);
    assert.ok(
      activated.status === 'activated' || activated.status === 'replayed',
      JSON.stringify(activated),
    );
    const workInput = {
      proposal: null,
      requirement_id: input.task.requirementId,
      universe_item_id: null,
      universe_selector: null,
      seal_amendment: null,
      name: input.name,
      args_json: JSON.stringify(input.args),
    };
    const workCall = buildWorkCall({
      reachableBuiltinNames: new Set(['run_shell_command', 'composio_execute_tool']),
      firstClassNames: new Set(),
      frozenContract: input.task.frozenContract,
      ...(input.sourceStrategyBinding ? { sourceStrategyBinding: input.sourceStrategyBinding } : {}),
    }) as unknown as {
      invoke: (runContext: unknown, value: string, details?: unknown) => Promise<unknown>;
    };
    return brackets.withHarnessRunContext({
      ...input.task,
      counter: new brackets.ToolCallsCounter(20),
    }, () => identities.withLogicalToolCall({
      ...input.task,
      tool: 'work_call',
      args: workInput,
      logicalToolCallId: input.callId,
    }, () => workCall.invoke(
      { context: input.task },
      JSON.stringify(workInput),
      { toolCall: { callId: input.callId } },
    )));
  };

  let shellCallbacks = 0;
  let composioCallbacks = 0;
  _setInnerDispatchToolsForTests(new Map([
    ['run_shell_command', {
      name: 'run_shell_command',
      invoke: async () => {
        shellCallbacks += 1;
        return 'must not execute';
      },
    }],
    ['composio_execute_tool', {
      name: 'composio_execute_tool',
      invoke: async () => {
        composioCallbacks += 1;
        return { successful: true, data: [{ name: 'Restaurant A' }] };
      },
    }],
  ] as never));
  try {
    const shellOutput = await invokeWorkCall({
      task: acceptedSourceTask(),
      name: 'run_shell_command',
      args: { command: 'curl https://alternate-source.example.test/pismo' },
      callId: 'work-source-shell-refused',
      sourceStrategyBinding: BINDING,
    });
    assert.equal(shellCallbacks, 0, 'the shell process callback is refused before execution');
    assert.match(String(shellOutput), /cannot present an exact bound capability\/account\/schema identity/i);

    const unspecifiedCurrentTaskOutput = await invokeWorkCall({
      task: acceptedSourceTask(BINDING, 'confirmed_exact', false),
      name: 'run_shell_command',
      args: { command: 'curl https://unbound-source.example.test/pismo' },
      callId: 'work-source-shell-current-task-unbound',
    });
    assert.equal(shellCallbacks, 1,
      'an ordinary current-task source is not blanket-rejected merely because the session is chat');
    assert.match(String(unspecifiedCurrentTaskOutput), /must not execute/);

    const unconfirmedOutput = await invokeWorkCall({
      task: acceptedSourceTask(BINDING, 'materially_variant'),
      name: 'run_shell_command',
      args: { command: 'curl https://unconfirmed-source.example.test/pismo' },
      callId: 'work-source-shell-unconfirmed-refused',
    });
    assert.equal(shellCallbacks, 1, 'an entered but unconfirmed strategy starts no inner callback');
    assert.match(String(unconfirmedOutput), /no reconstructable confirmed source binding/i);

    const ambiguousTask = acceptedSourceTask();
    eventlog.appendEvent({
      sessionId: ambiguousTask.sessionId,
      turn: 0,
      role: 'system',
      type: 'turn_preflight_decision',
      data: { ...decision(), sourceUserSeq: ambiguousTask.sourceUserSeq },
    });
    const ambiguousOutput = await invokeWorkCall({
      task: ambiguousTask,
      name: 'run_shell_command',
      args: { command: 'curl https://ambiguous-source.example.test/pismo' },
      callId: 'work-source-shell-ambiguous-refused',
    });
    assert.equal(shellCallbacks, 1, 'ambiguous durable authority starts no inner callback');
    assert.match(String(ambiguousOutput), /ambiguous or malformed durable source-strategy authority/i);

    const composioOutput = await invokeWorkCall({
      task: acceptedSourceTask(),
      name: 'composio_execute_tool',
      args: {
        tool_slug: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
        arguments: JSON.stringify({
          actorId: 'compass/crawler-google-places',
          runInput: { searchStringsArray: ['restaurants in Pismo Beach CA'] },
        }),
        connected_account_id: null,
      },
      callId: 'work-source-composio-admitted',
      sourceStrategyBinding: BINDING,
    });
    assert.equal(composioCallbacks, 1, String(composioOutput));
    assert.match(String(composioOutput), /Restaurant A/);
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
});

async function attemptContinuationAggregateWithoutBinding(input: {
  operations: Array<Record<string, unknown>>;
  universes?: Array<Record<string, unknown>>;
  callId: string;
  task?: ReturnType<typeof continuationLikeSourceTaskWithoutBinding>;
  targetName?: string;
  targetArgs?: Record<string, unknown>;
}): Promise<{ output: unknown; providerCallbacks: number }> {
  const task = input.task ?? continuationLikeSourceTaskWithoutBinding();
  const activated = expectedWorkAdmission.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  const workInput = {
    proposal: {
      version: 1,
      operations: input.operations,
      universes: input.universes ?? [],
    },
    requirement_id: task.requirementId,
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: input.targetName ?? 'composio_execute_tool',
    args_json: JSON.stringify(input.targetArgs ?? {
      tool_slug: 'GENERIC_GET_ITEMS',
      arguments: JSON.stringify({ query: 'bounded public records' }),
      connected_account_id: null,
    }),
  };
  const workCall = buildWorkCall({
    reachableBuiltinNames: new Set([input.targetName ?? 'composio_execute_tool']),
    firstClassNames: new Set(),
  }) as unknown as {
    invoke: (runContext: unknown, value: string, details?: unknown) => Promise<unknown>;
  };
  let providerCallbacks = 0;
  const targetName = input.targetName ?? 'composio_execute_tool';
  _setInnerDispatchToolsForTests(new Map([
    [targetName, {
      name: targetName,
      invoke: async () => {
        providerCallbacks += 1;
        return { successful: true, data: [{ id: 'must-not-return' }] };
      },
    }],
  ] as never));
  try {
    const output = await brackets.withHarnessRunContext({
      ...task,
      counter: new brackets.ToolCallsCounter(20),
    }, () => identities.withLogicalToolCall({
      ...task,
      tool: 'work_call',
      args: workInput,
      logicalToolCallId: input.callId,
    }, () => workCall.invoke(
      { context: task },
      JSON.stringify(workInput),
      { toolCall: { callId: input.callId } },
    )));
    return { output, providerCallbacks };
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
}

const aggregateRead = {
  id: 'read_source',
  effect: 'read',
  coverage: 'complete_set',
  dependsOn: [],
  dataFrom: [],
  cardinality: { kind: 'once' },
};
const aggregateWrite = {
  id: 'write_once',
  effect: 'external_write',
  coverage: null,
  dependsOn: ['read_source'],
  dataFrom: ['read_source'],
  cardinality: { kind: 'once' },
};

test('continuation graph role loss cannot bypass chat aggregate-source binding: provider-neutral callback stays at zero', async () => {
  const attempted = await attemptContinuationAggregateWithoutBinding({
    operations: [aggregateRead, aggregateWrite],
    callId: 'work-source-continuation-role-loss',
  });
  assert.equal(attempted.providerCallbacks, 0, 'the provider carrier callback must be refused before execution');
  assert.match(String(attempted.output), /ambiguous or malformed durable source-strategy authority/i);
});

test('an unused second read cannot erase aggregate source-role inference before provider I/O', async () => {
  const attempted = await attemptContinuationAggregateWithoutBinding({
    operations: [
      aggregateRead,
      {
        id: 'unused_read',
        effect: 'read',
        coverage: 'single',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      },
      aggregateWrite,
    ],
    callId: 'work-source-continuation-unused-read',
  });
  assert.equal(attempted.providerCallbacks, 0, 'an unrelated root read cannot open the provider callback');
  assert.match(String(attempted.output), /ambiguous or malformed durable source-strategy authority/i);
});

test('an unrelated per-item operation cannot erase aggregate source-role inference before provider I/O', async () => {
  const attempted = await attemptContinuationAggregateWithoutBinding({
    operations: [
      aggregateRead,
      {
        id: 'compute_each',
        effect: 'compute',
        coverage: null,
        dependsOn: ['read_source'],
        dataFrom: ['read_source'],
        cardinality: { kind: 'each', universeId: 'records' },
      },
      aggregateWrite,
    ],
    universes: [{
      id: 'records',
      seal: 'complete_source_receipt',
      producedBy: 'read_source',
      memberIdPointer: '/id',
    }],
    callId: 'work-source-continuation-unrelated-per-item',
  });
  assert.equal(attempted.providerCallbacks, 0, 'an unrelated fanout cannot open the provider callback');
  assert.match(String(attempted.output), /ambiguous or malformed durable source-strategy authority/i);
});

test('a prep predecessor cannot relabel a trusted CTC source read out of the carrier gate', async () => {
  const attempted = await attemptContinuationAggregateWithoutBinding({
    task: trustedCollectThenConstructTask('read_source'),
    operations: [
      {
        id: 'prep_compute',
        effect: 'compute',
        coverage: null,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      },
      {
        ...aggregateRead,
        dependsOn: ['prep_compute'],
      },
      aggregateWrite,
    ],
    targetName: 'run_shell_command',
    targetArgs: { command: 'curl https://source-bypass.example.test/items' },
    callId: 'work-source-trusted-ctc-predecessor',
  });
  assert.equal(attempted.providerCallbacks, 0, 'dependent aggregate source callback stays at zero');
  assert.match(String(attempted.output), /cannot present an exact bound capability\/account\/schema identity/i);
});

test('a source-fetching compute label cannot bypass trusted CTC source admission', async () => {
  const attempted = await attemptContinuationAggregateWithoutBinding({
    task: trustedCollectThenConstructTask('compute_source'),
    operations: [
      {
        id: 'compute_source',
        effect: 'compute',
        coverage: null,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      },
      {
        ...aggregateWrite,
        dependsOn: ['compute_source'],
        dataFrom: ['compute_source'],
      },
    ],
    targetName: 'run_shell_command',
    targetArgs: { command: 'curl https://compute-source-bypass.example.test/items' },
    callId: 'work-source-trusted-ctc-compute-label',
  });
  assert.equal(attempted.providerCallbacks, 0, 'compute-labelled source callback stays at zero');
  assert.match(String(attempted.output), /cannot present an exact bound capability\/account\/schema identity/i);
});

test('an intermediate compute source ancestor cannot bypass trusted CTC source admission', async () => {
  const attempted = await attemptContinuationAggregateWithoutBinding({
    task: trustedCollectThenConstructTask('compute_fetch'),
    operations: [
      aggregateRead,
      {
        id: 'compute_fetch',
        effect: 'compute',
        coverage: null,
        dependsOn: ['read_source'],
        dataFrom: ['read_source'],
        cardinality: { kind: 'once' },
      },
      {
        ...aggregateWrite,
        dependsOn: ['compute_fetch'],
        dataFrom: ['compute_fetch'],
      },
    ],
    targetName: 'run_shell_command',
    targetArgs: { command: 'curl https://intermediate-compute-source-bypass.example.test/items' },
    callId: 'work-source-trusted-ctc-intermediate-compute',
  });
  assert.equal(attempted.providerCallbacks, 0, 'intermediate compute source callback stays at zero');
  assert.match(String(attempted.output), /cannot present an exact bound capability\/account\/schema identity/i);
});

test('a valid CTC proposal cannot lend an unknown or construct-write requirement id to a source-fetching shell', async () => {
  for (const requirementId of ['unknown_compute_source', 'write_once']) {
    const attempted = await attemptContinuationAggregateWithoutBinding({
      task: trustedCollectThenConstructTask(requirementId),
      operations: [aggregateRead, aggregateWrite],
      targetName: 'run_shell_command',
      targetArgs: { command: `curl https://${requirementId}.example.test/items` },
      callId: `work-source-valid-proposal-${requirementId}`,
    });
    assert.equal(
      attempted.providerCallbacks,
      0,
      `${requirementId} cannot open the source callback`,
    );
    assert.match(String(attempted.output), /cannot present an exact bound capability\/account\/schema identity/i);
  }
});

test('an invalid replacement proposal cannot bypass a frozen trusted CTC source contract', async () => {
  const task = trustedCollectThenConstructTask('unknown_compute_source');
  const frozen = expectedWork.freezeActionExpectedWorkContract({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposal: { version: 1, operations: [aggregateRead, aggregateWrite], universes: [] },
  });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));

  const attempted = await attemptContinuationAggregateWithoutBinding({
    task,
    operations: [{
      id: 'unknown_compute_source',
      effect: 'compute',
      coverage: null,
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' },
    }],
    targetName: 'run_shell_command',
    targetArgs: { command: 'curl https://invalid-proposal-source-bypass.example.test/items' },
    callId: 'work-source-invalid-replacement-proposal',
  });
  assert.equal(attempted.providerCallbacks, 0, 'invalid replacement proposal cannot open the source callback');
  assert.match(String(attempted.output), /cannot present an exact bound capability\/account\/schema identity/i);
});

test('post-construct verification is not relabeled as source before terminal delivery', async () => {
  const attempted = await attemptContinuationAggregateWithoutBinding({
    task: trustedCollectThenConstructDeliveryTask('verify_sheet'),
    operations: [
      {
        id: 'fetch_records',
        effect: 'read',
        coverage: 'complete_set',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      },
      {
        id: 'create_sheet',
        effect: 'external_write',
        coverage: null,
        dependsOn: ['fetch_records'],
        dataFrom: ['fetch_records'],
        cardinality: { kind: 'once' },
      },
      {
        id: 'verify_sheet',
        effect: 'read',
        coverage: 'complete_set',
        dependsOn: ['create_sheet'],
        dataFrom: [],
        cardinality: { kind: 'once' },
      },
      {
        id: 'send_link',
        effect: 'external_write',
        coverage: null,
        dependsOn: ['verify_sheet'],
        dataFrom: ['verify_sheet'],
        cardinality: { kind: 'once' },
      },
    ],
    targetName: 'run_shell_command',
    targetArgs: { command: 'curl https://artifact-readback.example.test/sheet' },
    callId: 'work-source-post-construct-readback',
  });
  assert.equal(attempted.providerCallbacks, 1, 'verification remains outside the confirmed source gate');
});
