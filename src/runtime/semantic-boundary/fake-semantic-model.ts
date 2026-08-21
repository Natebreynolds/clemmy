/**
 * Deterministic CI semantic model. Maps typed A/Q/B fixtures to proposals.
 * It does not inspect production authority paths and must not be used as a
 * phrase parser in graph/continuation code.
 */
import type {
  PlanGroundingJudgeCall,
  PlanGroundingJudgeResult,
  SourceEffectJudgeCall,
  SourceEffectJudgeResult,
} from './turn-semantic-model-port.js';
import type {
  ProposedSemanticWorkV1,
  TurnSemanticHostViewV1,
  TurnSemanticProposalV1,
} from './turn-semantic-proposal.js';

export interface FakeSemanticTurn {
  relation: TurnSemanticProposalV1['relation'];
  targetGoal?: TurnSemanticProposalV1['targetGoal'];
  goal?: TurnSemanticProposalV1['goal'];
  work?: TurnSemanticProposalV1['work'];
  slotAnswers?: TurnSemanticProposalV1['slotAnswers'];
}

/** Fixture utterances used only to drive the fake model in tests. */
export const SEMANTIC_EVAL_FIXTURES = {
  affirmDidYouMean: 'i did yes',
  affirmNamedHost: 'yes acme.io',
  newConstruct: 'find five widgets and put them in a workbook',
} as const;

function capabilityRefFor(
  host: TurnSemanticHostViewV1 | undefined,
  role: string,
): string {
  return host?.catalog.capabilities?.find((entry) => entry.advisoryRoles?.includes(role))?.id
    ?? `cap:fake:${role}`;
}

export function collectConstructWork(input: {
  count: number;
  fields: string[];
  family: string;
  requestedEffect?: ProposedSemanticWorkV1['requestedEffect'];
  host?: TurnSemanticHostViewV1;
}): ProposedSemanticWorkV1 {
  const ref = (role: string) => capabilityRefFor(input.host, role);
  return {
    construct: 'collect_then_construct',
    cardinality: { count: input.count, fields: input.fields },
    destination: { posture: 'create_new', family: input.family, handleRequired: true },
    requestedEffect: input.requestedEffect ?? 'external_write',
    operations: [
      { id: 'op-source', role: 'source', requestedEffect: 'read', dependsOn: [], evidence: ['source-locator'], capabilityRef: ref('source') },
      { id: 'op-collect', role: 'collection', requestedEffect: 'read', dependsOn: ['op-source'], evidence: ['collection'], capabilityRef: ref('collection') },
      { id: 'op-transform', role: 'transform', requestedEffect: 'host_only', dependsOn: ['op-collect'], evidence: ['lineage'], capabilityRef: ref('transform') },
      { id: 'op-write', role: 'destination', requestedEffect: input.requestedEffect ?? 'external_write', dependsOn: ['op-transform'], evidence: ['create-receipt'], capabilityRef: ref('destination') },
      { id: 'op-readback', role: 'readback', requestedEffect: 'read', dependsOn: ['op-write'], evidence: ['readback'], capabilityRef: ref('readback') },
    ],
    deliverables: [{ id: 'artifact', kind: input.family }],
    evidenceRequirements: ['collection', 'create-receipt', 'readback'],
  };
}

/** Independent judge that assesses the proposed effect/posture, never a family. */
export function entailedSourceEffectJudge(
  call: SourceEffectJudgeCall,
  modelIdentity = 'fake-semantic/judge',
): SourceEffectJudgeResult {
  return {
    verdict: 'entailed',
    effect: call.proposedEffect,
    destinationPosture: call.proposedDestinationPosture,
    proposalDigest: call.proposalDigest,
    modelIdentity,
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
  };
}

/** Test-only whole-plan grounding judge. Never invents another capability. */
export function entailedPlanGroundingJudge(
  call: PlanGroundingJudgeCall,
  modelIdentity = 'fake-semantic/grounding',
): PlanGroundingJudgeResult {
  const operations = call.dag.operations.map((operation) => ({
    operationId: operation.id,
    verdict: 'entailed' as const,
    rationale: '',
  }));
  return {
    verdict: operations.every((operation) => operation.verdict === 'entailed') ? 'entailed' : 'uncertain',
    operations,
    modelIdentity,
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
  };
}

/** @deprecated Use entailedPlanGroundingJudge. Kept as a name alias for test fixtures. */
export const entailedCapabilityGroundingJudge = entailedPlanGroundingJudge;

export function fakeSemanticProposal(
  fixture: keyof typeof SEMANTIC_EVAL_FIXTURES | FakeSemanticTurn,
  host: TurnSemanticHostViewV1,
): TurnSemanticProposalV1 {
  if (typeof fixture !== 'string') {
    return {
      version: 1,
      relation: fixture.relation,
      targetGoal: fixture.targetGoal ?? null,
      goal: fixture.goal ?? null,
      work: fixture.work ?? null,
      slotAnswers: fixture.slotAnswers ?? [],
      rationale: 'fake-semantic-model',
    };
  }
  const open = host.openQuestions[0];
  const goal = host.resumableGoals[0];
  if (
    (fixture === 'affirmDidYouMean' || fixture === 'affirmNamedHost')
    && open
    && goal
  ) {
    const optionId = open.options[0]?.optionId;
    return {
      version: 1,
      relation: 'answer_open_slot',
      targetGoal: { goalId: goal.goalId, baseRevision: goal.baseRevision },
      goal: null,
      work: null,
      slotAnswers: optionId
        ? [{ kind: 'option', questionId: open.questionId, slotKey: open.slotKey, optionId }]
        : [{ kind: 'value', questionId: open.questionId, slotKey: open.slotKey, value: SEMANTIC_EVAL_FIXTURES[fixture] }],
      rationale: 'fake-semantic-model',
    };
  }
  return {
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Produce the requested collection in one destination.',
      criteria: [
        { id: 'c-set', statement: 'Bounded collection is present.' },
        { id: 'c-dest', statement: 'Destination artifact is verifiable.' },
      ],
      openSlots: [],
      candidates: [],
    },
    work: collectConstructWork({
      count: 5,
      fields: ['title', 'date', 'link'],
      family: 'workbook',
      host,
    }),
    slotAnswers: [],
    rationale: 'fake-semantic-model',
  };
}
