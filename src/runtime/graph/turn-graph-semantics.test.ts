/** Run: npx tsx --test src/runtime/graph/turn-graph-semantics.test.ts */
import '../semantic-boundary/typed-source-test-home.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admitTurnSemantics,
  type HostSemanticAuthorityV1,
} from '../semantic-boundary/admit-turn-semantics.js';
import { admitAndCompileAcceptedSource } from '../semantic-boundary/admit-and-compile-accepted-source.js';
import { installTurnSemanticModelPort } from '../semantic-boundary/turn-semantic-port-registry.js';
import { buildTurnSemanticHostViewV1 } from '../semantic-boundary/build-semantic-host-view.js';
import {
  collectConstructWork,
  fakeSemanticProposal,
  SEMANTIC_EVAL_FIXTURES,
} from '../semantic-boundary/fake-semantic-model.js';
import { projectCheckedSemantics } from '../semantic-boundary/project-checked-semantics.js';
import {
  awaitInputFromGraph,
  continuityPacketFromAwaitInput,
  sameRootFromProjection,
  typedDispositionFromProjection,
} from '../semantic-boundary/same-root-continuation.js';
import {
  isContextCheckedTurnSemanticProposalV1,
  validateTurnSemanticProposalV1,
  type TurnSemanticProposalV1,
} from '../semantic-boundary/turn-semantic-proposal.js';
import { compileTurnGraph } from './turn-graph-compiler.js';
import { entailedPlanGroundingJudge } from '../semantic-boundary/fake-semantic-model.js';
import { productionCapabilityManifests } from '../harness/production-capability-catalog.js';
import { capabilityManifestDigest } from '../harness/capability-manifest.js';
import { hostDescriptorFromRegistered } from '../semantic-boundary/admit-and-compile-accepted-source.js';
import { catalogSnapshotDigestFromDescriptors } from '../semantic-boundary/plan-grounding.js';
import { configureTypedExecutionRuntime, refreshTypedExecutionReadiness } from '../semantic-boundary/configure-typed-execution-runtime.js';
import { peekCapabilityManifestStore, resolveCurrentSuccessorManifest } from '../harness/capability-manifest-store.js';
import { isAdmittedTurnSemantics } from './admitted-turn-semantics.js';
import {
  admitConstructPublish,
  admitConstructWrite,
} from './collect-construct-vertical.js';
import { evaluateGoalEvidence } from './goal-evidence.js';
import { validateProposedGraph, type ProposedTurnGraphV1 } from './turn-graph-proposal.js';
import type { TurnGraphPolicySnapshot } from './turn-graph-ir.js';
import type { AcceptedGoalV1 } from './accepted-goal.js';

const { appendEvent, createSession, listEvents, openEventLog, resetEventLog } = await import('../harness/eventlog.js');
const { createTaskContinuityPacket } = await import('../../memory/task-continuity.js');
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
saveProactivityPolicy({ autoApproveScope: 'yolo' });

const POLICY: TurnGraphPolicySnapshot = {
  version: 'turn-policy-v1',
  autoApproveScope: 'yolo',
  proactiveWorkAllowed: true,
  allowComposioActions: true,
  allowComputerActions: true,
  requireWorkflowApprovalForExecution: true,
  batchConfirmThreshold: 5,
};

function writeAuthority(host: { policyRevision: string; source: { audienceHash: string } }): HostSemanticAuthorityV1 {
  return {
    policyRevision: host.policyRevision,
    audienceHash: host.source.audienceHash,
    policyMaxCeiling: 'external_write',
    allowedEffects: ['none', 'read', 'compute', 'host_only', 'unknown', 'local_write', 'external_write'],
  };
}

const AUDIENCE = {
  audienceKey: 'aud-1',
  userId: 'user-1',
  conversationKey: 'conv-1',
  policyRevision: 'd'.repeat(64),
} as const;

function productionDescriptors() {
  const store = peekCapabilityManifestStore();
  return productionCapabilityManifests().map((template) => {
    const manifest = store
      ? resolveCurrentSuccessorManifest(store, template.manifestId)?.manifest ?? template
      : template;
    return hostDescriptorFromRegistered({
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      destination: manifest.destination,
      account: manifest.accountId,
      advisoryRoles: manifest.advisoryRoles,
      manifestDigest: capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: async () => ({}),
    })!;
  });
}

function constructHostExtras() {
  const capabilities = productionDescriptors();
  return {
    capabilities,
    capabilityIds: capabilities.map((entry) => entry.id),
    catalogSnapshotDigest: catalogSnapshotDigestFromDescriptors(capabilities),
  };
}

configureTypedExecutionRuntime();
const { installIndependentProductionPackForTests } = await import('../semantic-boundary/isolated-vertical.js');
installIndependentProductionPackForTests({
  invoke: async () => ({}),
  reconcile: async () => ({ exists: false }),
});
refreshTypedExecutionReadiness();

async function compileAdmitted(
  text: string,
  raw: TurnSemanticProposalV1,
  seq = 41,
  extras: {
    sessionId?: string;
    resumableGoals?: Parameters<typeof buildTurnSemanticHostViewV1>[0]['resumableGoals'];
    openQuestions?: Parameters<typeof buildTurnSemanticHostViewV1>[0]['openQuestions'];
    capabilityIds?: readonly string[];
    effectCeiling?: HostSemanticAuthorityV1['policyMaxCeiling'];
  } = {},
) {
  resetEventLog();
  const sessionId = extras.sessionId ?? 'semantics-test';
  createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
  let boundRaw = raw;
  if (extras.openQuestions?.[0] && extras.resumableGoals?.[0]) {
    const question = extras.openQuestions[0];
    const goal = extras.resumableGoals[0];
    const parent = appendEvent({
      sessionId,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'parent' },
    });
    createTaskContinuityPacket({
      sessionId,
      originatingSourceUserSeq: parent.seq,
      pause: {
        kind: 'clarification',
        question: question.question,
        options: [],
        slot: {
          goalId: goal.goalId,
          revision: goal.baseRevision,
          questionId: question.questionId,
          slotKey: question.slotKey,
          predecessorRefs: goal.settledEvidenceRefs,
        },
      },
    });
    if (boundRaw.slotAnswers[0]?.kind === 'option') {
      boundRaw = {
        ...boundRaw,
        slotAnswers: [{
          kind: 'value',
          questionId: question.questionId,
          slotKey: question.slotKey,
          value: boundRaw.slotAnswers[0].optionId,
        }],
      };
    }
  }
  const source = appendEvent({
    sessionId,
    turn: extras.openQuestions ? 2 : 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  installTurnSemanticModelPort({
    async interpret() {
      return { raw: boundRaw, modelIdentity: 'semantics-test', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
    },
    async judgeSourceEffect(call) {
      return {
        verdict: 'entailed',
        effect: call.proposedEffect,
        destinationPosture: call.proposedDestinationPosture,
        proposalDigest: call.proposalDigest,
        modelIdentity: 'semantics-test-judge',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgePlanGrounding(call) {
      return entailedPlanGroundingJudge(call, 'semantics-test-grounding');
    },
  });
  const compiled = await admitAndCompileAcceptedSource({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
    surface: 'home',
  });
  const interpreted = listEvents(sessionId, { types: ['turn_semantics_interpreted'] }).at(-1)?.data as {
    validationIssue?: { code?: string; message?: string; path?: string; capabilityRef?: string };
  } | undefined;
  assert.equal(
    compiled.ok,
    true,
    compiled.ok ? text : `${compiled.reason} ${JSON.stringify(interpreted?.validationIssue ?? null)}`,
  );
  if (!compiled.ok) throw new Error('admit failed');
  return compiled.compiled;
}

function constructProposal(hostText = SEMANTIC_EVAL_FIXTURES.newConstruct): TurnSemanticProposalV1 {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'semantics-test',
    sourceUserSeq: 41,
    acceptedText: hostText,
    ...AUDIENCE,
    ...constructHostExtras(),
  });
  return fakeSemanticProposal('newConstruct', host);
}

function topology(graph: ReturnType<typeof compileAdmitted>['graph']) {
  return {
    route: graph.classification.route,
    ceiling: graph.effectCeiling,
    kinds: graph.nodes.map((node) => node.kind),
    constraints: graph.classification.goalConstraints,
    identity: graph.classification.goalIdentity,
    collectThenConstruct: graph.classification.multiItem.collectThenConstruct,
  };
}


// ============================================================================
// RETIRED PINS — THE CLEAN LOOP (2026-08-19): live turns never run the
// semantic ceremony; typed execution enters only via the workflow-replay
// engine (future seam). Removed pins recoverable from this file's git
// history when the replay seam lands.
// ============================================================================

test('each operation above the admitted ceiling is rejected, not relabeled', () => {
  const raw = constructProposal();
  if (raw.work) {
    raw.work.operations = raw.work.operations.map((operation) => (
      operation.id === 'op-write'
        ? { ...operation, requestedEffect: 'admin' as const }
        : operation
    ));
  }
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'semantics-test',
    sourceUserSeq: 41,
    acceptedText: SEMANTIC_EVAL_FIXTURES.newConstruct,
    ...AUDIENCE,
  });
  const admitted = admitTurnSemantics(raw, host, writeAuthority(host));
  assert.equal(admitted.ok, false);
  if (!admitted.ok) assert.ok(admitted.issues.some((issue) => issue.code === 'effect_exceeds_ceiling'));
});

test('compiler output depends on typed semantics, not raw text', async () => {
  const raw = constructProposal();
  const first = await compileAdmitted('alpha widgets into a notebook please', raw);
  const second = await compileAdmitted('put five beta records on a ledger for me', raw);
  assert.equal(first.validation.ok, true);
  assert.equal(second.validation.ok, true);
  assert.deepEqual(topology(first.graph), topology(second.graph));
  assert.notEqual(first.graph.source.inputHash, second.graph.source.inputHash);
});




test('a plain structural object cannot compile', () => {
  assert.throws(() => compileTurnGraph({
    identity: { sessionId: 'semantics-test', turn: 1, sourceUserSeq: 41 },
    input: 'x',
    sessionKind: 'chat',
    surface: 'home',
    policy: POLICY,
    admitted: {
      scope: 'admitted_turn_semantics_v1',
      source: {
        sessionId: 'semantics-test',
        sourceUserSeq: 41,
        inputHash: 'a'.repeat(64),
        audienceHash: 'b'.repeat(64),
      },
      policyRevision: 'd'.repeat(64),
      clamped: {
        kind: 'conversation',
        construct: 'none',
        effectCeiling: 'none',
        requestedEffect: 'none',
        route: 'direct_reply',
      },
      payloadHash: 'a'.repeat(64),
      contextHash: 'b'.repeat(64),
    } as never,
  }), /unsealed semantics/);
});

test('admitted semantics for another source are rejected', async () => {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'semantics-test',
    sourceUserSeq: 41,
    acceptedText: 'hello',
    ...AUDIENCE,
  });
  const admitted = admitTurnSemantics({
    version: 1,
    relation: 'conversation',
    targetGoal: null,
    goal: null,
    work: null,
    slotAnswers: [],
    rationale: 'chat',
  }, host, writeAuthority(host));
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.equal('admitted' in admitted, false);
  resetEventLog();
  createSession({ id: 'semantics-test', kind: 'chat', userId: 'user-1' });
  appendEvent({
    sessionId: 'semantics-test',
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'hello' },
  });
  installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: {
          version: 1,
          relation: 'conversation',
          targetGoal: null,
          goal: null,
          work: null,
          slotAnswers: [],
          rationale: 'chat',
        },
        modelIdentity: 'semantics-test',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  });
  const compiled = await admitAndCompileAcceptedSource({
    identity: { sessionId: 'semantics-test', turn: 1, sourceUserSeq: 99 },
    surface: 'home',
  });
  assert.equal(compiled.ok, false);
  if (!compiled.ok) assert.match(compiled.reason, /durable accepted source is missing|source_mismatch/);
});

test('hidden options, wrong questions, audiences, goals, and revisions fail validation', () => {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'session-9',
    sourceUserSeq: 42,
    acceptedText: SEMANTIC_EVAL_FIXTURES.affirmDidYouMean,
    ...AUDIENCE,
    resumableGoals: [{ goalId: 'goal-17', baseRevision: 4 }],
    openQuestions: [{
      questionId: 'question-3',
      goalId: 'goal-17',
      goalRevision: 4,
      slotKey: 'resource-choice',
      question: 'Which host should I use?',
      options: [{ optionId: 'choice-a', label: 'Acme.io' }],
      allowFreeText: false,
    }],
  });
  const cases = [
    {
      relation: 'answer_open_slot' as const,
      targetGoal: { goalId: 'goal-17', baseRevision: 4 },
      slotAnswers: [{
        kind: 'option' as const,
        questionId: 'question-3',
        slotKey: 'resource-choice',
        optionId: 'hidden',
      }],
    },
    {
      relation: 'answer_open_slot' as const,
      targetGoal: { goalId: 'goal-17', baseRevision: 4 },
      slotAnswers: [{
        kind: 'option' as const,
        questionId: 'wrong-q',
        slotKey: 'resource-choice',
        optionId: 'choice-a',
      }],
    },
    {
      relation: 'continue_goal' as const,
      targetGoal: { goalId: 'goal-17', baseRevision: 3 },
    },
    {
      relation: 'continue_goal' as const,
      targetGoal: { goalId: 'goal-other', baseRevision: 4 },
    },
  ];
  for (const candidate of cases) {
    const result = validateTurnSemanticProposalV1({
      version: 1,
      goal: null,
      work: null,
      rationale: 'x',
      slotAnswers: [],
      ...candidate,
    }, host);
    assert.equal(result.ok, false, JSON.stringify(candidate));
  }
});

test('context-checked values cannot be forged or mutated', () => {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'session-9',
    sourceUserSeq: 42,
    acceptedText: 'x',
    ...AUDIENCE,
  });
  const checked = validateTurnSemanticProposalV1(fakeSemanticProposal('newConstruct', host), host);
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  const lookalike = JSON.parse(JSON.stringify(checked.checked));
  assert.equal(isContextCheckedTurnSemanticProposalV1(lookalike), false);
  assert.throws(() => {
    (checked.checked.proposal as { relation: string }).relation = 'abandon_goal';
  }, TypeError);
});

test('graph patches cannot widen effects, destinations, cardinality, capabilities, or budgets', () => {
  const goal: AcceptedGoalV1 = {
    sourceUserSeq: 41,
    construct: 'collect_then_construct',
    effectCeiling: 'external_write',
    route: 'act',
    collection: { count: 5, projection: ['title'] },
    destination: { posture: 'create_new', family: 'workbook', handleRequired: true },
  };
  const legal: ProposedTurnGraphV1 = {
    nodes: [
      { kind: 'retrieve', effect: 'read', id: 'r1', cardinality: 5 },
      { kind: 'execute', effect: 'external_write', id: 'w1' },
      { kind: 'verify', id: 'v1' },
    ],
  };
  assert.equal(validateProposedGraph(goal, legal).ok, true);
  assert.equal(validateProposedGraph(goal, { ...legal, requestedEffect: 'admin' }).ok, false);
  assert.equal(validateProposedGraph(goal, { ...legal, destinationFamily: 'mailbox' }).ok, false);
  assert.equal(validateProposedGraph(goal, {
    nodes: legal.nodes.map((node) => node.id === 'r1' ? { ...node, cardinality: 50 } : node),
  }).ok, false);
  assert.equal(validateProposedGraph(goal, {
    nodes: [...legal.nodes, { kind: 'execute', effect: 'external_write', capabilityRole: 'invented' }],
  }, { capabilityRoles: new Set(['source']) }).ok, false);
  assert.equal(validateProposedGraph(goal, legal, { maxNodes: 2 }).ok, false);
});


test('unknown effects never become reads by omission', () => {
  const goal: AcceptedGoalV1 = {
    sourceUserSeq: 41,
    construct: 'single_act',
    effectCeiling: 'unknown',
    route: 'act',
  };
  const asRead: ProposedTurnGraphV1 = {
    nodes: [
      { kind: 'retrieve', effect: 'read' },
      { kind: 'execute', effect: 'read' },
      { kind: 'verify' },
    ],
  };
  const result = validateProposedGraph(goal, asRead, { effect: 'unknown' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /read by omission/);
});

test('requested write is refused without policy allowance even when aligned', () => {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'semantics-test',
    sourceUserSeq: 41,
    acceptedText: SEMANTIC_EVAL_FIXTURES.newConstruct,
    ...AUDIENCE,
  });
  const raw = fakeSemanticProposal('newConstruct', host);
  const clamped = admitTurnSemantics(raw, host, {
    policyRevision: host.policyRevision,
    audienceHash: host.source.audienceHash,
    policyMaxCeiling: 'read',
    allowedEffects: ['none', 'read', 'compute', 'host_only'],
  });
  assert.equal(clamped.ok, false);
});

test('hello plus a proposed write is refused', () => {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'semantics-test',
    sourceUserSeq: 41,
    acceptedText: 'hello',
    ...AUDIENCE,
  });
  const result = admitTurnSemantics({
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Say hello.',
      criteria: [{ id: 'c-1', statement: 'A greeting.' }],
      openSlots: [],
      candidates: [],
    },
    work: {
      construct: 'none',
      cardinality: null,
      destination: null,
      requestedEffect: 'external_write',
      operations: [],
      deliverables: [],
      evidenceRequirements: [],
    },
    slotAnswers: [],
    rationale: 'write',
  }, host, writeAuthority(host));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((entry) => entry.code === 'write_not_aligned'));
});


test('public callers cannot seal admitted authority', async () => {
  const mod = await import('./admitted-turn-semantics.js');
  const boundary = await import('../semantic-boundary/admit-turn-semantics.js');
  assert.equal('sealAdmittedTurnSemantics' in mod, false);
  assert.equal('compileSealedTurnGraph' in mod, false);
  assert.equal('isAdmittedTurnSemantics' in boundary, false);
  assert.equal('compileSealedTurnGraph' in boundary, false);
  assert.equal('compileAdmittedTurn' in boundary, false);
  assert.equal('compileTurnGraphFromAdmitted' in boundary, false);
  const admitted = admitTurnSemantics({
    version: 1,
    relation: 'conversation',
    targetGoal: null,
    goal: null,
    work: null,
    slotAnswers: [],
    rationale: 'chat',
  }, buildTurnSemanticHostViewV1({
    sessionId: 'semantics-test',
    sourceUserSeq: 41,
    acceptedText: 'hello',
    ...AUDIENCE,
  }), writeAuthority(buildTurnSemanticHostViewV1({
    sessionId: 'semantics-test',
    sourceUserSeq: 41,
    acceptedText: 'hello',
    ...AUDIENCE,
  })));
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.equal(isAdmittedTurnSemantics(admitted), false);
});

test('wrong audience, policy revision, source, or input hash is refused', async () => {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'semantics-test',
    sourceUserSeq: 41,
    acceptedText: 'hello',
    ...AUDIENCE,
  });
  const raw = {
    version: 1 as const,
    relation: 'conversation' as const,
    targetGoal: null,
    goal: null,
    work: null,
    slotAnswers: [],
    rationale: 'chat',
  };
  assert.equal(admitTurnSemantics(raw, host, {
    ...writeAuthority(host),
    audienceHash: 'c'.repeat(64),
  }).ok, false);
  assert.equal(admitTurnSemantics(raw, host, {
    ...writeAuthority(host),
    policyRevision: 'e'.repeat(64),
  }).ok, false);
  resetEventLog();
  createSession({ id: 'semantics-hash', kind: 'chat', userId: 'user-1' });
  const source = appendEvent({
    sessionId: 'semantics-hash',
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'hello' },
  });
  installTurnSemanticModelPort({
    async interpret() {
      return { raw, modelIdentity: 'semantics-test', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
    },
  });
  const compiled = await admitAndCompileAcceptedSource({
    identity: { sessionId: 'semantics-hash', turn: 1, sourceUserSeq: source.seq },
    surface: 'home',
  });
  assert.equal(compiled.ok, true);
});






test('a novel mock connector is an advisory catalog id, not a production-name grant', () => {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'session-9',
    sourceUserSeq: 42,
    acceptedText: 'collect rows',
    ...AUDIENCE,
    capabilityIds: ['mock-cli:inventory.list', 'mock-mcp:vault.export'],
    capabilities: [
      {
        id: 'mock-cli:inventory.list',
        effect: 'read',
        purpose: 'list_records',
        acceptedInputKinds: ['query'],
        producedOutputKinds: ['records'],
        applicableDeliverableKinds: ['records'],
        inputShape: 'query',
        outputShape: 'records',
        outputKind: 'records',
        deliverableKind: 'records',
        destinationPosture: null,
        evidenceKinds: ['payload'],
        handleRequired: false,
        readbackRequired: false,
        accountScope: 'host:test',
        manifestDigest: 'e'.repeat(64),
        advisoryRoles: ['source', 'collection', 'readback'],
      },
      {
        id: 'mock-mcp:vault.export',
        effect: 'compute',
        purpose: 'export_records',
        acceptedInputKinds: ['records'],
        producedOutputKinds: ['records'],
        applicableDeliverableKinds: ['records'],
        inputShape: 'records',
        outputShape: 'records',
        outputKind: 'records',
        deliverableKind: 'records',
        destinationPosture: null,
        evidenceKinds: ['payload'],
        handleRequired: false,
        readbackRequired: false,
        accountScope: 'host:test',
        manifestDigest: 'f'.repeat(64),
        advisoryRoles: ['transform', 'destination'],
      },
    ],
  });
  const allowed = validateTurnSemanticProposalV1({
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Collect the requested rows.',
      criteria: [{ id: 'c-set', statement: 'A set.' }],
      openSlots: [],
      candidates: [{ kind: 'capability', id: 'mock-mcp:vault.export' }],
    },
    work: {
      construct: 'single_act',
      cardinality: null,
      destination: null,
      requestedEffect: 'read',
      operations: [{
        id: 'op-read',
        role: 'source',
        requestedEffect: 'read',
        capabilityRef: 'mock-cli:inventory.list',
        dependsOn: [],
        evidence: ['payload'],
      }],
      deliverables: [{ id: 'rows', kind: 'records' }],
      evidenceRequirements: ['payload'],
    },
    slotAnswers: [],
    rationale: 'novel-connector',
  }, host);
  const unknown = validateTurnSemanticProposalV1({
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Collect the requested rows.',
      criteria: [{ id: 'c-set', statement: 'A set.' }],
      openSlots: [],
      candidates: [{ kind: 'capability', id: 'sheets.create' }],
    },
    work: {
      construct: 'single_act',
      cardinality: null,
      destination: null,
      requestedEffect: 'read',
      operations: [{
        id: 'op-read',
        role: 'source',
        requestedEffect: 'read',
        capabilityRef: 'sheets.create',
        dependsOn: [],
        evidence: ['payload'],
      }],
      deliverables: [{ id: 'rows', kind: 'records' }],
      evidenceRequirements: ['payload'],
    },
    slotAnswers: [],
    rationale: 'novel-connector',
  }, host);
  assert.equal(allowed.ok, true);
  assert.equal(unknown.ok, false);
});




test('a participated failed admission stays graphless and commits a blocked zero-tool terminal', async () => {
  // Once the semantic port participates, its refusal is the route decision.
  // Rebuilding an identity-only compatibility graph here would create a
  // second tool-bearing executor after that decision. The production caller
  // reduces the graphless result to one resumable blocked terminal instead.
  const {
    commitUnadmittedSemanticTurn,
    recordAcceptedSourceGraph,
  } = await import('../harness/record-accepted-source-graph.js');
  resetEventLog();
  const sessionId = 'unadmitted-degrade';
  createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user',
    type: 'user_input_received',
    data: { text: 'whats on my roster for tomorrow' },
  });
  installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: { not: 'a valid proposal shape' } as never,
        modelIdentity: 'degrade-test', inputTokens: 1, outputTokens: 1, latencyMs: 1,
      };
    },
    async judgeSourceEffect() { throw new Error('never reached'); },
    async judgePlanGrounding() { throw new Error('never reached'); },
  });
  const graphEvent = await recordAcceptedSourceGraph({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
    surface: 'home',
  });
  assert.equal(graphEvent, null, 'a participated refusal cannot mint a compatibility graph');
  assert.equal(listEvents(sessionId, { types: ['turn_graph_compiled'] }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['accepted_task_authority_armed'] }).length, 0);

  const blocked = commitUnadmittedSemanticTurn({
    sessionId,
    turn: source.turn,
    sourceUserSeq: source.seq,
  });
  assert.match(blocked.text, /stopped before (?:finishing|using any tools)/i);
  assert.match(blocked.text, /No provider call was made/i);
  assert.match(blocked.text, /No external change was made/i);
  const terminal = listEvents(sessionId, { types: ['conversation_completed'] })[0];
  assert.ok(terminal);
  const outcome = terminal.data.turnOutcome as { status?: string; resumable?: boolean };
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.resumable, true, 'the exact accepted source has one recoverable public winner');
  const bodies = openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_calls,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?) AS physical_dispatches
  `).get(sessionId, source.seq, sessionId, source.seq) as {
    logical_calls: number;
    physical_dispatches: number;
  };
  assert.deepEqual(bodies, { logical_calls: 0, physical_dispatches: 0 });
});
