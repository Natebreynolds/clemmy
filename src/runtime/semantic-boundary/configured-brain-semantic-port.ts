/**
 * Tool-less semantic port over the configured brain. Both primary and Claude
 * lanes install this same adapter; they do not grow vendor-specific schemas.
 */
import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import { extractJsonCandidate } from '../harness/json-repair.js';
import { resolveRoleModel } from '../harness/model-roles.js';
import type { ModelRole } from '../harness/model-roles.js';
import {
  modelUsageAttributionStorage,
  recordModelUsage,
} from '../usage-log.js';
import {
  PlanGroundingJudgeV1Schema,
  SourceEffectJudgeV1Schema,
  TurnSemanticProposalV1WireSchema,
  boundHostCapabilityDescriptors,
} from './turn-semantic-proposal.js';
import type {
  PlanGroundingJudgeCall,
  PlanGroundingJudgeResult,
  SourceEffectJudgeCall,
  SourceEffectJudgeResult,
  TurnSemanticModelCall,
  TurnSemanticModelPort,
  TurnSemanticModelResult,
} from './turn-semantic-model-port.js';
import { installTurnSemanticModelPort } from './turn-semantic-port-registry.js';

export interface ConfiguredBrainSemanticComplete {
  (input: {
    purpose: 'turn_semantics' | 'turn_semantics_effect_judge' | 'turn_semantics_plan_grounding';
    system: string;
    user: string;
    schemaName: 'TurnSemanticProposalV1' | 'SourceEffectJudgeV1' | 'PlanGroundingJudgeV1';
  }): Promise<{
    raw: unknown;
    modelIdentity: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }>;
}

const SYSTEM = [
  'You interpret one accepted user turn.',
  'Return only a TurnSemanticProposalV1 JSON object.',
  'Do not name tools, providers, or grant effects.',
  'Requested effects are requests. Criterion ids are opaque.',
  'Copy an exact supplied capabilityRef for every operation, including host_only.',
  'Do not invent a capability id that is not in host.capabilityIds.',
  'If an open question is present, answer it with an exact visible option or leave it ambiguous.',
].join(' ');

const JUDGE_SYSTEM = [
  'You are an independent source/effect judge.',
  'Assess the proposed effect and destination posture against the accepted source.',
  'Do not invent a provider, account, tool, or destination family.',
  'Copy proposalDigest exactly. Standing policy is not evidence.',
  'Return only a SourceEffectJudgeV1 JSON object.',
].join(' ');

const GROUNDING_SYSTEM = [
  'You are an independent whole-plan capability-grounding judge.',
  'Assess each proposed operation against its role in the DAG and its downstream consumers.',
  'Do not judge intermediate operations only against the final deliverable.',
  'Do not select, invent, or substitute another capability.',
  'Do not copy or invent authority hashes. Return only operation IDs and verdicts.',
  'Return only a PlanGroundingJudgeV1 JSON object.',
].join(' ');

export function semanticModelRoleForPurpose(
  purpose: 'turn_semantics' | 'turn_semantics_effect_judge' | 'turn_semantics_plan_grounding',
): ModelRole {
  return purpose === 'turn_semantics' ? 'brain' : 'judge';
}

async function completeStructured(input: {
  purpose: 'turn_semantics' | 'turn_semantics_effect_judge' | 'turn_semantics_plan_grounding';
  system: string;
  user: string;
  schema: z.ZodTypeAny;
}): Promise<{
  raw: unknown;
  modelIdentity: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}> {
  // Interpretation follows the configured brain. Consequential source/effect
  // review follows the configured judge role, which is cross-family when the
  // user's available model stack permits it. Calling the brain for both made
  // the supposedly independent gate self-approval by construction.
  const role = resolveRoleModel(semanticModelRoleForPurpose(input.purpose));
  const started = Date.now();
  const agent = new Agent({
    name: input.purpose === 'turn_semantics'
      ? 'turn-semantics'
      : input.purpose === 'turn_semantics_plan_grounding'
        ? 'turn-semantics-plan-grounding'
        : 'turn-semantics-effect-judge',
    instructions: input.system,
    model: role.modelId,
    tools: [],
    outputType: input.schema as typeof TurnSemanticProposalV1WireSchema,
  }) as unknown as Agent;
  const runner = new Runner({ workflowName: `clementine-${input.purpose}` });
  const result = await runner.run(agent, input.user, { maxTurns: 1 });
  const tokens = tokensFromAgentRun(result);
  const latencyMs = Date.now() - started;
  const final = result.finalOutput;
  if (final && typeof final === 'object') {
    return {
      raw: final,
      modelIdentity: role.modelId,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      latencyMs,
    };
  }
  const text = typeof final === 'string' ? final : JSON.stringify(final ?? null);
  const candidate = extractJsonCandidate(text);
  let raw: unknown = null;
  if (candidate) {
    try { raw = JSON.parse(candidate); } catch { raw = null; }
  }
  return {
    raw,
    modelIdentity: role.modelId,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    latencyMs,
  };
}

function readUsageNumber(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return 0;
}

function extractUsage(value: unknown): { inputTokens: number; outputTokens: number } {
  if (!value || typeof value !== 'object') return { inputTokens: 0, outputTokens: 0 };
  if (Array.isArray(value)) {
    return value.reduce(
      (sum, item) => {
        const next = extractUsage(item);
        return {
          inputTokens: sum.inputTokens + next.inputTokens,
          outputTokens: sum.outputTokens + next.outputTokens,
        };
      },
      { inputTokens: 0, outputTokens: 0 },
    );
  }
  const record = value as Record<string, unknown>;
  const nested = record.usage && record.usage !== value
    ? extractUsage(record.usage)
    : { inputTokens: 0, outputTokens: 0 };
  const entries = extractUsage(record.requestUsageEntries ?? record.request_usage_entries);
  const inputTokens = readUsageNumber(
    record,
    'inputTokens',
    'input_tokens',
    'promptTokens',
    'prompt_tokens',
    'requestTokens',
    'request_tokens',
  ) || nested.inputTokens || entries.inputTokens;
  const outputTokens = readUsageNumber(
    record,
    'outputTokens',
    'output_tokens',
    'completionTokens',
    'completion_tokens',
    'responseTokens',
    'response_tokens',
  ) || nested.outputTokens || entries.outputTokens;
  return { inputTokens, outputTokens };
}

/** Walk Agents SDK RunResult / Usage / rawResponses without double-counting. */
export function tokensFromAgentRun(result: unknown): { inputTokens: number; outputTokens: number } {
  const empty = { inputTokens: 0, outputTokens: 0 };
  if (!result || typeof result !== 'object') return empty;
  const root = result as Record<string, unknown>;
  const state = root.state && typeof root.state === 'object'
    ? root.state as Record<string, unknown>
    : undefined;
  const runContext = root.runContext && typeof root.runContext === 'object'
    ? root.runContext as Record<string, unknown>
    : undefined;
  const context = state?._context && typeof state._context === 'object'
    ? state._context as Record<string, unknown>
    : undefined;
  const aggregated = [
    extractUsage(root.usage),
    extractUsage(state?.usage),
    extractUsage(runContext?.usage),
    extractUsage(context?.usage),
  ].reduce((best, candidate) => (
    candidate.inputTokens + candidate.outputTokens > best.inputTokens + best.outputTokens
      ? candidate
      : best
  ), empty);
  if (aggregated.inputTokens + aggregated.outputTokens > 0) return aggregated;
  const responses = [root.rawResponses, state?.rawResponses, runContext?.rawResponses, context?.rawResponses];
  return responses.reduce(
    (sum: { inputTokens: number; outputTokens: number }, group): { inputTokens: number; outputTokens: number } => {
      const next = extractUsage(group);
      return {
        inputTokens: sum.inputTokens + next.inputTokens,
        outputTokens: sum.outputTokens + next.outputTokens,
      };
    },
    empty,
  );
}

function recordSemanticModelUsage(input: {
  sessionId?: string;
  sourceUserSeq?: number;
  modelIdentity: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}): void {
  if (input.inputTokens + input.outputTokens <= 0) return;
  const attribution = modelUsageAttributionStorage.getStore();
  recordModelUsage({
    sessionId: input.sessionId || attribution?.sessionId || 'unknown',
    sourceUserSeq: input.sourceUserSeq ?? attribution?.sourceUserSeq,
    attemptId: attribution?.attemptId,
    model: input.modelIdentity,
    cacheDialect: 'inclusive',
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.inputTokens + input.outputTokens,
    durationMs: input.latencyMs,
  });
}

/** Production complete: one tool-less call on the configured brain/judge role. */
export async function completeViaConfiguredBrain(input: {
  purpose: 'turn_semantics' | 'turn_semantics_effect_judge' | 'turn_semantics_plan_grounding';
  system: string;
  user: string;
  schemaName: 'TurnSemanticProposalV1' | 'SourceEffectJudgeV1' | 'PlanGroundingJudgeV1';
}): Promise<{
  raw: unknown;
  modelIdentity: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}> {
  return completeStructured({
    purpose: input.purpose,
    system: input.system,
    user: input.user,
    schema: input.schemaName === 'SourceEffectJudgeV1'
      ? SourceEffectJudgeV1Schema
      : input.schemaName === 'PlanGroundingJudgeV1'
        ? PlanGroundingJudgeV1Schema
        // The WIRE schema: structurally identical, no semantic refinements.
        // Refinement failures used to THROW here as `model_failed` and bypass
        // the repair gate; admission re-validates with the full schema and is
        // the sole judge. See TurnSemanticProposalV1WireSchema's doc.
        : TurnSemanticProposalV1WireSchema,
  });
}

export function installConfiguredBrainSemanticPort(): void {
  installTurnSemanticModelPort(configuredBrainSemanticPort(completeViaConfiguredBrain));
}

export function configuredBrainSemanticPort(
  complete: ConfiguredBrainSemanticComplete,
): TurnSemanticModelPort {
  return {
    async interpret(call: TurnSemanticModelCall): Promise<TurnSemanticModelResult> {
      const started = Date.now();
      const result = await complete({
        purpose: 'turn_semantics',
        system: SYSTEM,
        user: JSON.stringify({
          acceptedText: call.acceptedText,
          recentTurns: (call.recentTurns ?? []).slice(-6),
          host: {
            source: call.host.source,
            policyRevision: call.host.policyRevision,
            resumableGoals: call.host.resumableGoals,
            openQuestions: call.host.openQuestions,
            capabilities: boundHostCapabilityDescriptors(call.host.catalog.capabilities ?? []),
            capabilityIds: [...call.host.catalog.capabilityIds],
            workflowIds: [...call.host.catalog.workflowIds],
          },
          repairHint: call.repairHint ?? null,
        }),
        schemaName: 'TurnSemanticProposalV1',
      });
      recordSemanticModelUsage({
        sessionId: call.host.source.sessionId,
        sourceUserSeq: call.host.source.sourceUserSeq,
        modelIdentity: result.modelIdentity,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs || (Date.now() - started),
      });
      return {
        raw: result.raw,
        modelIdentity: result.modelIdentity,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs || (Date.now() - started),
      };
    },
    async judgeSourceEffect(call: SourceEffectJudgeCall): Promise<SourceEffectJudgeResult> {
      const started = Date.now();
      const result = await complete({
        purpose: 'turn_semantics_effect_judge',
        system: JUDGE_SYSTEM,
        user: JSON.stringify({
          acceptedText: call.acceptedText,
          recentTurns: call.recentTurns.slice(-6),
          activeGoals: call.activeGoals,
          proposedConstruct: call.proposedConstruct,
          proposedEffect: call.proposedEffect,
          proposedDestinationPosture: call.proposedDestinationPosture,
          proposalDigest: call.proposalDigest,
          proposedHandleRequired: call.proposedHandleRequired,
        }),
        schemaName: 'SourceEffectJudgeV1',
      });
      const parsed = SourceEffectJudgeV1Schema.safeParse(result.raw);
      recordSemanticModelUsage({
        sessionId: call.sessionId,
        sourceUserSeq: call.sourceUserSeq,
        modelIdentity: result.modelIdentity,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs || (Date.now() - started),
      });
      return {
        verdict: parsed.success ? parsed.data.verdict : 'uncertain',
        effect: parsed.success ? parsed.data.effect : 'unknown',
        destinationPosture: parsed.success ? parsed.data.destinationPosture : null,
        proposalDigest: parsed.success ? parsed.data.proposalDigest : '',
        modelIdentity: result.modelIdentity,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs || (Date.now() - started),
      };
    },
    async judgePlanGrounding(call: PlanGroundingJudgeCall): Promise<PlanGroundingJudgeResult> {
      const started = Date.now();
      const result = await complete({
        purpose: 'turn_semantics_plan_grounding',
        system: GROUNDING_SYSTEM,
        user: JSON.stringify({
          acceptedText: call.acceptedText,
          recentTurns: call.recentTurns.slice(-6),
          goal: call.goal,
          dag: call.dag,
          descriptors: call.descriptors,
          catalogSnapshotDigest: call.catalogSnapshotDigest,
          proposalDigest: call.proposalDigest,
        }),
        schemaName: 'PlanGroundingJudgeV1',
      });
      const parsed = PlanGroundingJudgeV1Schema.safeParse(result.raw);
      recordSemanticModelUsage({
        sessionId: call.sessionId,
        sourceUserSeq: call.sourceUserSeq,
        modelIdentity: result.modelIdentity,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs || (Date.now() - started),
      });
      return {
        verdict: parsed.success ? parsed.data.verdict : 'uncertain',
        operations: parsed.success ? parsed.data.operations : [],
        modelIdentity: result.modelIdentity,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs || (Date.now() - started),
      };
    },
  };
}
