/**
 * Provider-neutral, tool-less semantic interpretation port.
 * Both configured-brain lanes use this schema and the same host validator.
 */
import type { TurnSemanticHostViewV1 } from './turn-semantic-proposal.js';

export const TURN_SEMANTIC_CALL_PURPOSE = 'turn_semantics' as const;

export interface TurnSemanticModelCall {
  purpose: typeof TURN_SEMANTIC_CALL_PURPOSE;
  host: TurnSemanticHostViewV1;
  acceptedText: string;
  recentTurns?: ReadonlyArray<{ who: 'user' | 'assistant'; text: string }>;
  repairHint?: string;
}

export interface TurnSemanticModelResult {
  raw: unknown;
  modelIdentity: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export const TURN_SEMANTIC_EFFECT_JUDGE_PURPOSE = 'turn_semantics_effect_judge' as const;

export interface SourceEffectJudgeCall {
  purpose: typeof TURN_SEMANTIC_EFFECT_JUDGE_PURPOSE;
  sessionId: string;
  sourceUserSeq: number;
  acceptedText: string;
  recentTurns: ReadonlyArray<{ who: 'user' | 'assistant'; text: string }>;
  activeGoals: ReadonlyArray<{ goalId: string; baseRevision: number }>;
  proposedConstruct: string;
  proposedEffect: 'none' | 'read' | 'compute' | 'host_only' | 'unknown' | 'local_write' | 'external_write' | 'admin';
  proposedDestinationPosture: 'create_new' | 'named_existing' | null;
  proposalDigest: string;
  proposedHandleRequired: boolean;
}

export interface SourceEffectJudgeResult {
  verdict: 'entailed' | 'conflict' | 'uncertain';
  effect: 'none' | 'read' | 'compute' | 'host_only' | 'unknown' | 'local_write' | 'external_write' | 'admin';
  destinationPosture: 'create_new' | 'named_existing' | null;
  proposalDigest: string;
  modelIdentity: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export const TURN_SEMANTIC_CAPABILITY_GROUNDING_PURPOSE = 'turn_semantics_capability_grounding' as const;
export const TURN_SEMANTIC_PLAN_GROUNDING_PURPOSE = 'turn_semantics_plan_grounding' as const;

export interface PlanGroundingOperationView {
  id: string;
  role: string;
  requestedEffect: string;
  capabilityRef: string | null;
  dependsOn: readonly string[];
  downstream: readonly string[];
  evidence: readonly string[];
}

export interface PlanGroundingJudgeCall {
  purpose: typeof TURN_SEMANTIC_PLAN_GROUNDING_PURPOSE;
  sessionId: string;
  sourceUserSeq: number;
  acceptedText: string;
  recentTurns: ReadonlyArray<{ who: 'user' | 'assistant'; text: string }>;
  goal: {
    objective: string;
    criteria: ReadonlyArray<{ id: string; statement: string }>;
    revision: number;
  } | null;
  dag: {
    construct: string;
    cardinality: { count: number; fields: readonly string[] } | null;
    destination: { posture: string; family: string; handleRequired: boolean } | null;
    requestedEffect: string;
    operations: readonly PlanGroundingOperationView[];
    deliverables: ReadonlyArray<{ id: string; kind: string }>;
  };
  descriptors: ReadonlyArray<{
    id: string;
    effect: string;
    purpose: string;
    acceptedInputKinds: readonly string[];
    producedOutputKinds: readonly string[];
    applicableDeliverableKinds: readonly string[];
    destinationPosture: 'create_new' | 'named_existing' | null;
    evidenceKinds: readonly string[];
    handleRequired: boolean;
    readbackRequired: boolean;
    accountScope: string;
  }>;
  catalogSnapshotDigest: string;
  proposalDigest: string;
}

export interface PlanGroundingJudgeResult {
  verdict: 'entailed' | 'conflict' | 'uncertain';
  operations: ReadonlyArray<{
    operationId: string;
    verdict: 'entailed' | 'conflict' | 'uncertain';
    rationale: string;
  }>;
  modelIdentity: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/** Routing evidence only: this judgment never grants a provider effect. */
export interface SourceAccountJudgeCall {
  purpose: 'turn_semantics_account_selection';
  mode: 'explicit_selection' | 'current_source_default';
  sessionId: string;
  sourceUserSeq: number;
  acceptedText: string;
  /** Exact nominated user quote, which may continue establishedSource implicitly. */
  sourceQuote: string | null;
  toolkit: string;
  accountIdentity: string;
  accountLabel: string | null;
  /** An exact earlier user source from this conversation, never arbitrary history. */
  establishedSource: { acceptedText: string; sourceQuote: string; previouslyChecked: boolean } | null;
  /** Complete ordered user-source range: between explicit origin and current source,
   * or all bounded conversation ancestors before a current-source default. */
  interveningAcceptedSources: readonly { sourceUserSeq: number; acceptedText: string }[];
  /** The host's own account question this accepted source answered, when the
   *  continuity store shows it consumed such a clarification. The judge then
   *  reads the answer against the labeled options, so "the Scorpion one",
   *  "the recommended one" or "my default" can select an identity the bare
   *  answer never names (live 2026-09-08: every calendar run stalled here). */
  clarification?: {
    question: string;
    options: readonly string[];
    answer: string;
    selectedOption: string | null;
  } | null;
  proposalDigest: string;
}

export interface SourceAccountJudgeResult {
  verdict: 'entailed' | 'default_compatible' | 'conflict' | 'uncertain';
  proposalDigest: string;
  modelIdentity: string;
}

export interface TurnSemanticModelPort {
  interpret(call: TurnSemanticModelCall): Promise<TurnSemanticModelResult>;
  /** Independent tool-less judge. Must not see the proposing model's write claim. */
  judgeSourceEffect?(call: SourceEffectJudgeCall): Promise<SourceEffectJudgeResult>;
  /** One whole-plan grounding judgment. May not select or invent a capability. */
  judgePlanGrounding?(call: PlanGroundingJudgeCall): Promise<PlanGroundingJudgeResult>;
  /** Checks source-versus-recipient meaning using the existing judge role. */
  judgeAccountSelection?(call: SourceAccountJudgeCall): Promise<SourceAccountJudgeResult>;
}
