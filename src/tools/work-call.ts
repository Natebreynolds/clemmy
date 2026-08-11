/**
 * `work_call` — action-only semantic carrier.
 *
 * It fuses the main model's bounded expected-work proposal with the first
 * schema-validated inner call. The proposal never names tools/providers; the
 * ordinary `name`/`args_json` transport fields remain outside it. Direct and
 * deterministic-retrieve turns do not register this schema.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import {
  admitExpectedWorkInvocation,
  withExpectedWorkBinding,
  type ExpectedWorkAdmissionFailureKind,
  type ExpectedWorkUniverseSelectorV1,
} from '../runtime/harness/expected-work-admission.js';
import type { ExpectedWorkProposalV1 } from '../runtime/harness/expected-work-contract.js';
import { ExternalWritePreDispatchResult } from '../runtime/harness/external-write-admission.js';
import type { SettleToolAttemptInput } from '../runtime/harness/attempt-settlement.js';
import { settleResolvedCarrierRefusal } from '../runtime/harness/resolved-carrier-refusal.js';
import { buildCallTool, type BuildCallToolOptions } from './call-tool.js';

const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);
const MemberSchema = z.string().min(1).max(256);
const EffectSchema = z.enum(['read', 'compute', 'local_write', 'external_write', 'admin']);
const CoverageSchema = z.enum(['single', 'accepted_set', 'complete_set']);

const CardinalitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once') }).strict(),
  z.object({ kind: z.literal('each'), universeId: IdSchema }).strict(),
  z.object({ kind: z.literal('set'), universeId: IdSchema }).strict(),
]);

const OperationSchema = z.object({
  id: IdSchema,
  effect: EffectSchema,
  /** Null for non-read operations; normalized away before validation. */
  coverage: CoverageSchema.nullable(),
  dependsOn: z.array(IdSchema).max(32),
  dataFrom: z.array(IdSchema).max(32),
  cardinality: CardinalitySchema,
}).strict();

const UniverseSchema = z.discriminatedUnion('seal', [
  z.object({
    id: IdSchema,
    seal: z.literal('accepted_input'),
    members: z.array(MemberSchema).min(1).max(2_048),
  }).strict(),
  z.object({
    id: IdSchema,
    seal: z.literal('complete_source_receipt'),
    producedBy: IdSchema,
  }).strict(),
]);

export const WorkProposalSchema = z.object({
  version: z.literal(1),
  operations: z.array(OperationSchema).min(1).max(32),
  universes: z.array(UniverseSchema).max(16),
}).strict();

export const WorkCallInputSchema = z.object({
  proposal: WorkProposalSchema.nullable().describe(
    'Complete provider-neutral work topology. Required on the first work_call; use null after it is frozen.',
  ),
  requirement_id: IdSchema.describe('Operation id in the frozen proposal discharged by this inner call.'),
  universe_item_id: MemberSchema.nullable().describe(
    'Exact accepted universe member for cardinality=each; otherwise null.',
  ),
  universe_selector: z.object({
    argument_pointer: z.string().max(512),
    member_id_pointer: z.string().max(512).nullable(),
  }).strict().nullable().describe(
    'RFC 6901 pointer selecting the exact member or finite member array in normalized inner arguments.',
  ),
  name: z.string().min(1).describe('Exact reachable inner tool name returned by tool_search/catalog.'),
  args_json: z.string().describe('JSON object string matching the inner tool schema.'),
}).strict();

export type WorkCallInput = z.infer<typeof WorkCallInputSchema>;

interface WorkCallFrame {
  input: WorkCallInput;
  refusalKind?: ExpectedWorkAdmissionFailureKind;
}

const workCallStorage = new AsyncLocalStorage<WorkCallFrame>();

function normalizedProposal(input: WorkCallInput['proposal']): ExpectedWorkProposalV1 | null {
  if (!input) return null;
  return {
    ...input,
    operations: input.operations.map((operation) => {
      const { coverage, ...withoutCoverage } = operation;
      return coverage === null
        ? withoutCoverage
        : { ...withoutCoverage, coverage };
    }),
  } as ExpectedWorkProposalV1;
}

function normalizedSelector(input: WorkCallInput['universe_selector']): ExpectedWorkUniverseSelectorV1 | null {
  if (!input) return null;
  return {
    argumentPointer: input.argument_pointer,
    memberIdPointer: input.member_id_pointer,
  };
}

function refusalResult(kind: ExpectedWorkAdmissionFailureKind, reason: string): ExternalWritePreDispatchResult {
  return new ExternalWritePreDispatchResult(
    JSON.stringify({
      error: kind,
      dispatch_state: 'not_started',
      detail: reason,
      repair: kind === 'work_contract_required' || kind === 'work_contract_invalid'
        ? 'Retry work_call with one corrected complete semantic proposal and the same intended inner call.'
        : 'Use the frozen requirement/cardinality exactly, or explain the blocker conversationally.',
    }),
    kind,
  );
}

export interface BuildWorkCallOptions extends Omit<BuildCallToolOptions, 'aroundResolvedDispatch' | 'resolvedRefusalLane'> {
  /** Adapter attribution only; admission and recovery remain provider-neutral. */
  settlementLane?: SettleToolAttemptInput['lane'];
}

export function buildWorkCall(options: BuildWorkCallOptions = {}): Tool<RuntimeContextValue> {
  const { settlementLane = 'agents_runner', ...dispatcherOptions } = options;
  const dispatcher = buildCallTool({
    ...dispatcherOptions,
    resolvedRefusalLane: settlementLane,
    aroundResolvedDispatch: async (resolved, dispatch) => {
      const frame = workCallStorage.getStore();
      const refuse = (
        kind: ExpectedWorkAdmissionFailureKind,
        reason: string,
      ): ExternalWritePreDispatchResult => {
        const refusal = refusalResult(kind, reason);
        const repairableInvocationShape = kind === 'work_contract_required'
          || kind === 'work_contract_invalid'
          || kind === 'work_binding_required'
          || kind === 'work_requirement_unknown'
          || kind === 'work_effect_mismatch'
          || kind === 'work_cardinality_mismatch';
        // call_tool has already resolved/materialized the INNER invocation and
        // refined this logical call to that exact contract. Settle the refusal
        // here against those exact bytes; letting the outer work_call brackets
        // settle their raw carrier envelope would contradict the refinement
        // (and could turn a correct refusal into a lane-ending authority error).
        // The outer wrapper observes the now-settled logical row and skips its
        // transport mirror, preserving one invocation -> one settlement.
        settleResolvedCarrierRefusal({
          resolved,
          lane: settlementLane,
          refusal,
          classification: repairableInvocationShape ? 'invalid_arguments' : 'policy_denial',
        });
        return refusal;
      };
      if (!frame) return refuse('work_authority_unavailable', 'work_call frame is unavailable');
      if (
        !Number.isSafeInteger(resolved.sourceUserSeq)
        || (resolved.sourceUserSeq ?? 0) <= 0
        || !resolved.logicalToolCallId
      ) {
        frame.refusalKind = 'work_authority_unavailable';
        return refuse(frame.refusalKind, 'accepted source or logical call identity is unavailable');
      }
      const admission = admitExpectedWorkInvocation({
        sessionId: resolved.sessionId,
        sourceUserSeq: resolved.sourceUserSeq as number,
        logicalToolCallId: resolved.logicalToolCallId,
        proposal: normalizedProposal(frame.input.proposal),
        requirementId: frame.input.requirement_id,
        universeItemId: frame.input.universe_item_id,
        universeSelector: normalizedSelector(frame.input.universe_selector),
        tool: resolved.targetName,
        args: resolved.targetArgs,
        inputSchema: resolved.targetInputSchema ?? undefined,
        ...(resolved.evidenceArgs !== undefined ? { evidenceArgs: resolved.evidenceArgs } : {}),
        ...(resolved.evidenceInputSchema !== undefined
          ? { evidenceInputSchema: resolved.evidenceInputSchema }
          : {}),
      });
      if (admission.status === 'refused') {
        frame.refusalKind = admission.kind;
        return refuse(admission.kind, admission.reason);
      }
      return withExpectedWorkBinding(admission.binding, dispatch);
    },
  }) as unknown as {
    invoke: (
      runContext: unknown,
      input: string,
      details?: { toolCall?: { callId?: string; id?: string } },
    ) => Promise<unknown>;
  };

  return tool({
    name: 'work_call',
    description: [
      'Invoke one business tool under the frozen semantic work contract.',
      'On the FIRST call, provide the complete provider-neutral proposal plus the first requirement binding; this freezes and dispatches in one tool call, with no separate planner round trip.',
      'The proposal describes only effects, dependencies, coverage, cardinality and universes—never tool names, providers, services or slugs.',
      'For later calls set proposal to null and bind the exact requirement/item from the frozen contract.',
      'Use tool_search first when the inner name/schema is unknown. Ask the user naturally if the intended work itself is ambiguous.',
    ].join(' '),
    parameters: WorkCallInputSchema,
    errorFunction: (_context, error) => {
      const detail = error instanceof Error ? error.message : String(error);
      return refusalResult('work_contract_invalid', detail) as unknown as string;
    },
    execute: async (input, runContext, details): Promise<string> => {
      const frame: WorkCallFrame = { input: input as WorkCallInput };
      const output = await workCallStorage.run(frame, () => dispatcher.invoke(
        runContext,
        JSON.stringify({ name: frame.input.name, args_json: frame.input.args_json }),
        details as { toolCall?: { callId?: string; id?: string } } | undefined,
      ));
      const rendered = output instanceof ExternalWritePreDispatchResult
        ? output.output
        : typeof output === 'string'
          ? output
          : JSON.stringify(output ?? null);
      if (output instanceof ExternalWritePreDispatchResult) {
        return output as unknown as string;
      }
      return frame.refusalKind
        ? refusalResult(frame.refusalKind, rendered) as unknown as string
        : rendered;
    },
  });
}
