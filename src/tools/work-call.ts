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
import { openEventLog } from '../runtime/harness/eventlog.js';
import { ExternalWritePreDispatchResult } from '../runtime/harness/external-write-admission.js';
import { acceptedTaskIdFor } from '../runtime/harness/attempt-identity.js';
import type { SettleToolAttemptInput } from '../runtime/harness/attempt-settlement.js';
import { durableLogicalCallContract } from '../runtime/harness/logical-call-contract.js';
import { expectedTaskFor } from '../runtime/harness/resolution-ledger.js';
import { settleResolvedCarrierRefusal } from '../runtime/harness/resolved-carrier-refusal.js';
import { redeemSuccessfulSettlementResultForHost } from '../runtime/harness/result-handle.js';
import { classifyRuntimeToolEffect } from '../runtime/harness/tool-effect.js';
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
    memberIdPointer: z.string().max(512).describe(
      'RFC 6901 pointer to one member id inside ONE record returned by the producing read; empty string when the record is itself the id.',
    ),
  }).strict(),
]);

export const WorkProposalSchema = z.object({
  version: z.literal(1),
  operations: z.array(OperationSchema).min(1).max(32),
  universes: z.array(UniverseSchema).max(16),
}).strict();

/** A VALID first-call proposal for the count-only fanout shape ("do one
 * thing per record from this read") — embedded verbatim in the tool
 * description because a working example outperforms field prose on the
 * first call (hints-are-schema, live-proven 2026-08-05). The pin parses
 * this constant against WorkProposalSchema, so schema drift breaks the
 * build, not the model. */
export const WORK_CALL_COUNT_ONLY_EXAMPLE = {
  version: 1,
  operations: [
    { id: 'read_source', effect: 'read', coverage: 'complete_set', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
    { id: 'write_per_record', effect: 'external_write', coverage: null, dependsOn: ['read_source'], dataFrom: ['read_source'], cardinality: { kind: 'each', universeId: 'records' } },
  ],
  universes: [
    { id: 'records', seal: 'complete_source_receipt', producedBy: 'read_source', memberIdPointer: '/Id' },
  ],
} as const;

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
  seal_amendment: z.object({
    universe_id: IdSchema,
    member_id_pointer: z.string().max(512),
  }).strict().nullable().optional().describe(
    'ONE correction to a source-derived universe\'s memberIdPointer, allowed only after a seal refusal named the record\'s actual keys and only before any member is bound. The frozen proposal itself never changes.',
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

function isHostReadOrCompute(toolName: string, args: unknown): boolean {
  try {
    const effect = classifyRuntimeToolEffect(toolName, args).effect;
    return effect === 'read' || effect === 'compute';
  } catch {
    return false;
  }
}

/** Only semantic plan disagreements are dispensable for a non-mutating host
 * call. A stored binding collision and an already-settled instance are
 * identity/once-ness facts, not proposal advice. */
export function isReadComputeSemanticRefusal(
  kind: ExpectedWorkAdmissionFailureKind,
  reason: string,
): boolean {
  switch (kind) {
    case 'work_contract_required':
    case 'work_contract_invalid':
    case 'work_requirement_unknown':
    case 'work_effect_mismatch':
    case 'work_dependency_pending':
    case 'work_cardinality_mismatch':
    case 'work_universe_unsealed':
    case 'work_source_witness_missing':
      return true;
    case 'work_contract_conflict':
      // Only the candidate proposal disagrees. A persisted binding collision
      // (`logical call already owns a different work binding`) is durable
      // once-ness/identity authority and must remain a refusal.
      return reason === 'a different action topology is already frozen';
    case 'work_binding_required':
    case 'work_authority_unavailable':
    case 'work_already_satisfied':
    case 'work_evidence_incomplete':
    case 'work_effect_already_executed':
    case 'work_attempt_budget_exhausted':
      return false;
  }
}

/** Re-prove the substrate that semantic admission normally reaches only after
 * proposal validation. This keeps a malformed/conflicting proposal from
 * masking missing storage, a closed accepted task, or a poisoned logical id.
 * Dispatch leases and provider authority remain downstream and fail closed. */
export function unboundReadComputeAuthority(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  toolName: string;
  args: unknown;
}): { ok: true } | { ok: false; reason: string } {
  try {
    const acceptedTaskId = acceptedTaskIdFor(input.sessionId, input.sourceUserSeq);
    const expected = expectedTaskFor(input.sessionId, input.sourceUserSeq);
    if (
      expected.status !== 'ok'
      || expected.expectation.acceptedTaskId !== acceptedTaskId
    ) {
      return {
        ok: false,
        reason: expected.status === 'ok'
          ? 'accepted task identity does not match its exact graph'
          : expected.reason,
      };
    }
    const contract = durableLogicalCallContract(acceptedTaskId, input.toolName, input.args);
    if (!contract) return { ok: false, reason: 'resolved logical call contract is unsafe' };

    const db = openEventLog();
    const authority = db.prepare(`
      SELECT accepted_task_id, expected_work_required, state
        FROM accepted_task_authority
       WHERE session_id = ? AND source_user_seq = ?
    `).get(input.sessionId, input.sourceUserSeq) as {
      accepted_task_id: string;
      expected_work_required: number;
      state: string;
    } | undefined;
    if (
      !authority
      || authority.accepted_task_id !== acceptedTaskId
      || authority.expected_work_required !== 1
      || authority.state !== 'armed'
    ) {
      return { ok: false, reason: 'action expected-work authority is not active and armed' };
    }

    const binding = db.prepare(`
      SELECT 1 FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
       LIMIT 1
    `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId);
    if (binding) {
      return { ok: false, reason: 'logical call already owns a durable work binding' };
    }

    const logical = db.prepare(`
      SELECT accepted_task_id, tool_name, argument_digest, state
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as {
      accepted_task_id: string;
      tool_name: string;
      argument_digest: string;
      state: string;
    } | undefined;
    if (
      !logical
      || logical.accepted_task_id !== acceptedTaskId
      || logical.tool_name !== contract.toolName
      || logical.argument_digest !== contract.argumentDigest
      || logical.state !== 'open'
    ) {
      return { ok: false, reason: 'logical call is not the exact open normalized inner call' };
    }
    const crossings = db.prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as { n: number };
    if (crossings.n !== 0) {
      return { ok: false, reason: 'logical call already crossed a provider boundary' };
    }
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: reason.replace(/\s+/g, ' ').slice(0, 300) };
  }
}

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

/** Per-kind actionable repair lines. A refusal that only says "retry with a
 *  corrected proposal" produced blind guess-loops (live 2026-08-11: 84
 *  refusals on one ask); each line now names the next concrete move and the
 *  plan card carries the frozen state to move against. */
function repairLineFor(kind: ExpectedWorkAdmissionFailureKind): string {
  switch (kind) {
    case 'work_contract_required':
    case 'work_contract_invalid':
      return 'Retry work_call with one corrected complete semantic proposal and the same intended inner call. The plan array (when present) lists the already-frozen requirements — reuse their ids and shapes exactly.';
    case 'work_already_satisfied':
      return 'This requirement is already complete — its stored result is included under `result`. Use it; do NOT re-run this requirement. Continue with the next `open` entry in `plan`.';
    case 'work_evidence_incomplete':
      return 'The exact read or compute already settled but did not prove the requested evidence complete. Its retained result is included; use it instead of replaying. To gather different evidence, change the non-mutating call. A safe retry does not itself prove coverage; `plan` remains open until the canonical evidence oracle discharges it.';
    case 'work_effect_already_executed':
      return 'The mutation crossed once but is not yet durably verified. Do NOT repeat it. Use the stored result when present, then verify/read back or reconcile the existing effect; `plan` remains open until proof exists.';
    case 'work_dependency_pending':
      return 'Complete the dependency named in `detail` first — `plan` shows each requirement\'s state. Dispatch the blocked requirement only after its dependency reads `satisfied`.';
    case 'work_universe_unsealed':
      return 'The source universe is not sealed. If the detail names the record keys, the member id pointer in the proposal does not match the source: re-issue this same work_call with seal_amendment { universe_id, member_id_pointer } set to the correct pointer — allowed ONCE, before any member is bound.';
    case 'work_requirement_unknown':
    case 'work_effect_mismatch':
    case 'work_cardinality_mismatch':
      return 'Bind an EXISTING requirement from `plan` exactly — matching id, effect, and cardinality. Do not invent new requirement ids or reshape the frozen proposal.';
    default:
      return 'Use the frozen requirement/cardinality exactly, or explain the blocker conversationally.';
  }
}

function refusalResult(
  kind: ExpectedWorkAdmissionFailureKind,
  reason: string,
  extras?: { plan?: unknown; result?: unknown },
): ExternalWritePreDispatchResult {
  return new ExternalWritePreDispatchResult(
    JSON.stringify({
      error: kind,
      dispatch_state: 'not_started',
      detail: reason,
      repair: repairLineFor(kind),
      ...(extras?.plan ? { plan: extras.plan } : {}),
      ...(extras?.result !== undefined ? { result: extras.result } : {}),
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
        extras?: { plan?: unknown; result?: unknown },
      ): ExternalWritePreDispatchResult => {
        const refusal = refusalResult(kind, reason, extras);
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
        ...(frame.input.seal_amendment
          ? {
              sealAmendment: {
                universeId: frame.input.seal_amendment.universe_id,
                memberIdPointer: frame.input.seal_amendment.member_id_pointer,
              },
            }
          : {}),
        tool: resolved.targetName,
        args: resolved.targetArgs,
        inputSchema: resolved.targetInputSchema ?? undefined,
        ...(resolved.evidenceArgs !== undefined ? { evidenceArgs: resolved.evidenceArgs } : {}),
        ...(resolved.evidenceInputSchema !== undefined
          ? { evidenceInputSchema: resolved.evidenceInputSchema }
          : {}),
      });
      if (admission.status === 'refused') {
        // Proposal semantics cannot veto an objectively non-mutating host
        // operation. The exact accepted/logical substrate is re-proved first;
        // the inner dispatch still owns lease, capability, and provider gates.
        if (
          isHostReadOrCompute(resolved.targetName, resolved.targetArgs)
          && isReadComputeSemanticRefusal(admission.kind, admission.reason)
        ) {
          const fallbackAuthority = unboundReadComputeAuthority({
            sessionId: resolved.sessionId,
            sourceUserSeq: resolved.sourceUserSeq as number,
            logicalToolCallId: resolved.logicalToolCallId,
            toolName: resolved.targetName,
            args: resolved.targetArgs,
          });
          if (fallbackAuthority.ok) return dispatch();
          frame.refusalKind = 'work_authority_unavailable';
          return refuse(frame.refusalKind, fallbackAuthority.reason);
        }
        frame.refusalKind = admission.kind;
        return refuse(admission.kind, admission.reason, admission.plan ? { plan: admission.plan } : undefined);
      }
      if (admission.status === 'satisfied') {
        // The requirement instance is already settled: hand back the STORED
        // result instead of an error. The model asked because it needs the
        // data — refusing restarted the whole guess-loop (live 2026-08-11).
        frame.refusalKind = 'work_already_satisfied';
        let redeemedResult: unknown;
        try {
          const redeemed = redeemSuccessfulSettlementResultForHost({
            sessionId: resolved.sessionId,
            sourceUserSeq: resolved.sourceUserSeq as number,
            acceptedTaskId: admission.contract.acceptedTaskId,
            logicalToolCallId: admission.priorLogicalToolCallId,
          });
          if (redeemed.status === 'ok') {
            redeemedResult = {
              records: redeemed.value.handle.projectedRecords,
              recordCount: redeemed.value.handle.recordCount,
              completeness: redeemed.value.handle.completeness,
              tool: redeemed.value.toolName,
            };
          }
        } catch { /* fall through to the plain already-satisfied refusal */ }
        return refuse(
          'work_already_satisfied',
          'this requirement instance is already durably settled — its stored result is included',
          { plan: admission.plan, ...(redeemedResult !== undefined ? { result: redeemedResult } : {}) },
        );
      }
      if (admission.status === 'evidence_retained') {
        // Exact non-mutating replay is pure latency/cost. Return the retained
        // bytes while keeping the plan open; a differently identified read
        // may still dispatch to gather better evidence.
        frame.refusalKind = 'work_evidence_incomplete';
        let redeemedResult: unknown;
        try {
          const redeemed = redeemSuccessfulSettlementResultForHost({
            sessionId: resolved.sessionId,
            sourceUserSeq: resolved.sourceUserSeq as number,
            acceptedTaskId: admission.contract.acceptedTaskId,
            logicalToolCallId: admission.priorLogicalToolCallId,
          });
          if (redeemed.status === 'ok') {
            redeemedResult = {
              records: redeemed.value.handle.projectedRecords,
              recordCount: redeemed.value.handle.recordCount,
              completeness: redeemed.value.handle.completeness,
              tool: redeemed.value.toolName,
            };
          }
        } catch { /* the no-replay decision remains authoritative */ }
        return refuse(
          'work_evidence_incomplete',
          'the exact read or compute already settled without complete evidence — its retained result is included',
          { plan: admission.plan, ...(redeemedResult !== undefined ? { result: redeemedResult } : {}) },
        );
      }
      if (admission.status === 'effect_already_executed') {
        // Once-ness is independent of verification. A successful mutation may
        // not replay merely because the canonical discharge oracle (correctly)
        // keeps its plan requirement open pending readback/reconciliation.
        frame.refusalKind = 'work_effect_already_executed';
        let redeemedResult: unknown;
        try {
          const redeemed = redeemSuccessfulSettlementResultForHost({
            sessionId: resolved.sessionId,
            sourceUserSeq: resolved.sourceUserSeq as number,
            acceptedTaskId: admission.contract.acceptedTaskId,
            logicalToolCallId: admission.priorLogicalToolCallId,
          });
          if (redeemed.status === 'ok') {
            redeemedResult = {
              records: redeemed.value.handle.projectedRecords,
              recordCount: redeemed.value.handle.recordCount,
              completeness: redeemed.value.handle.completeness,
              tool: redeemed.value.toolName,
            };
          }
        } catch { /* the once-only refusal remains authoritative */ }
        return refuse(
          'work_effect_already_executed',
          'this mutation already executed once but is not durably verified — do not repeat it',
          { plan: admission.plan, ...(redeemedResult !== undefined ? { result: redeemedResult } : {}) },
        );
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
      `Count-only fanout ("one write per record from this read") — a VALID first-call proposal: ${JSON.stringify(WORK_CALL_COUNT_ONLY_EXAMPLE)}. The sealed universe sizes itself from the settled read; memberIdPointer is an RFC 6901 pointer to each record's id (empty string when the record itself is the id).`,
      'Content you compose yourself (drafts, summaries, messages) is NOT a compute operation — composition happens inside the consuming write\'s args. Propose compute ONLY for work a tool will perform; a compute requirement no tool call ever carries can never be proven and will block everything that depends on it.',
      'Invoke a runtime-resolved inner name/schema directly. When a requirement is unresolved, use tool_search once for that requirement; when only an exact schema is missing, describe that exact tool once instead of broad-searching. Ask the user naturally if the intended work itself is ambiguous.',
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
      if (!frame.refusalKind) return rendered;
      // The dispatcher may hand the pre-dispatch refusal back as an ALREADY
      // rendered envelope string; re-wrapping it buried the whole steering
      // card (plan/result/repair) inside an escaped `detail` field (mapped
      // 2026-08-11 as the double-wrap hardening). Pass a rendered envelope
      // through untouched; wrap only bare reasons.
      try {
        const parsed = JSON.parse(rendered) as { error?: unknown; dispatch_state?: unknown };
        if (typeof parsed?.error === 'string' && parsed.dispatch_state === 'not_started') {
          return rendered;
        }
      } catch { /* not an envelope — wrap it */ }
      return refusalResult(frame.refusalKind, rendered) as unknown as string;
    },
  });
}
