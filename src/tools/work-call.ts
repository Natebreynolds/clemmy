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
  ActionWorkTopologySchema,
  WorkTopologyIdSchema,
  WorkTopologyMemberSchema,
} from '../runtime/graph/work-topology.js';
import {
  admitExpectedWorkInvocation,
  loadExpectedWorkCallBindingState,
  withExpectedWorkBinding,
  withUnboundWorkRequirement,
  type ExpectedWorkAdmissionFailureKind,
  type ExpectedWorkCallBinding,
  type ExpectedWorkUniverseSelectorV1,
} from '../runtime/harness/expected-work-admission.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import {
  loadExpectedWorkContract,
  prepareActionExpectedWorkContract,
  type AcceptedTaskWorkContractV1,
  type ExpectedWorkProposalV1,
} from '../runtime/harness/expected-work-contract.js';
import { formatFrozenWorkCallDescription } from '../runtime/harness/frozen-work-surface.js';
import { getTurnGraphEventForSource, openEventLog } from '../runtime/harness/eventlog.js';
import { ExternalWritePreDispatchResult } from '../runtime/harness/external-write-admission.js';
import {
  acceptedTaskIdFor,
  withLogicalToolCall,
} from '../runtime/harness/attempt-identity.js';
import {
  settleAdmittedLogicalCallPreDispatchRefusal,
  type SettleToolAttemptInput,
} from '../runtime/harness/attempt-settlement.js';
import {
  durableLogicalCallContract,
  durableLogicalCallRecoveryMaterial,
} from '../runtime/harness/logical-call-contract.js';
import { logicalCallAuthorityState } from '../runtime/harness/dispatch-ledger.js';
import { currentHostCallAttestation } from '../runtime/harness/accepted-turn-call-authority.js';
import {
  loadHostCallCapabilityBinding,
  hostCallCapabilityBindingMatchesAttestation,
  persistHostCallCapabilityBinding,
  type HostCallCapabilityBinding,
} from '../runtime/harness/host-call-capability-binding.js';
import { canonicalExternalInputSchemaDigestV1 } from '../runtime/harness/external-capability-risk-loader.js';
import { expectedTaskFor } from '../runtime/harness/resolution-ledger.js';
import {
  inspectExactSourceStrategyDecisionForSource,
  turnPreflightDecisionEntersSourceStrategy,
  withSourceStrategyRequirement,
  type SourceStrategyRequirementContext,
} from '../runtime/harness/source-strategy-admission.js';
import {
  validatedTurnSourceStrategyBinding,
  type TurnSourceStrategyBindingV1,
} from '../runtime/harness/turn-control.js';
import { settleResolvedCarrierRefusal } from '../runtime/harness/resolved-carrier-refusal.js';
import { redeemSuccessfulSettlementResultForHost } from '../runtime/harness/result-handle.js';
import { classifyRuntimeToolEffect } from '../runtime/harness/tool-effect.js';
import {
  buildCallTool,
  isResolvedDispatchPreparedWithoutExecution,
  resolvedDispatchPreparedWithoutExecution,
  type BuildCallToolOptions,
} from './call-tool.js';
import { isMcpNamespacedTool } from './inner-dispatch.js';
import {
  markHostPlanRequiredWorkCall,
  registerHostWorkCallPreparer,
  type HostWorkCallPreparationRequest,
  type HostWorkCallPreparationResult,
} from './work-call-mode.js';

export { isHostPlanRequiredWorkCall } from './work-call-mode.js';

const IdSchema = WorkTopologyIdSchema;
const MemberSchema = WorkTopologyMemberSchema;

/** Compatibility export for the public work_call schema. The grammar itself
 * has exactly one owner in runtime/graph/work-topology.ts. */
export const WorkProposalSchema = ActionWorkTopologySchema;

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

/** A VALID first-call proposal for collect-then-construct ("read the set
 * once, write one artifact once"). The host freezes this shape itself when
 * the graph owns it; the example is for deferred acts that still need a
 * proposal, so the model does not invent per-item writes. */
export const WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE = {
  version: 1,
  operations: [
    { id: 'read_source', effect: 'read', coverage: 'complete_set', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
    { id: 'write_once', effect: 'external_write', coverage: null, dependsOn: ['read_source'], dataFrom: ['read_source'], cardinality: { kind: 'once' } },
  ],
  universes: [],
} as const;

export const WorkCallInputSchema = z.object({
  proposal: WorkProposalSchema.nullable().describe(
    'Complete provider-neutral work topology. Null when the host already froze the contract, and null after the first successful freeze. Required only when no contract exists yet.',
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

/** Foreground plan_task already owns topology. Removing `proposal` from the
 * post-plan wire saves the large union/examples on every later model step and
 * makes a second semantic writer structurally impossible. */
export const HostPlannedWorkCallInputSchema = WorkCallInputSchema.omit({ proposal: true }).strict();

export type WorkCallInput = z.infer<typeof WorkCallInputSchema>;

interface WorkCallFrame {
  input: WorkCallInput;
  refusalKind?: ExpectedWorkAdmissionFailureKind;
  preparation?: {
    observedTarget?: {
      name: string;
      args: unknown;
    };
    resolved?: Omit<PreparedHostWorkCallV1, 'version' | 'hostCapabilityBinding'>;
  };
}

const workCallStorage = new AsyncLocalStorage<WorkCallFrame>();

/** Exact resolved material retained behind an opaque process-local candidate.
 * Durable rows remain the authority; the candidate only carries normalized
 * arguments/schema that cannot be reconstructed from value-opaque ledgers. */
export interface PreparedHostWorkCallV1 {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  targetName: string;
  targetArgs: unknown;
  targetInputSchema: unknown | null;
  evidenceArgs?: unknown;
  evidenceInputSchema?: unknown;
  binding: ExpectedWorkCallBinding;
  contract: AcceptedTaskWorkContractV1;
  settlementLane: SettleToolAttemptInput['lane'];
  hostCapabilityBinding: HostCallCapabilityBinding;
}

const preparedHostWorkCalls = new WeakMap<object, Readonly<PreparedHostWorkCallV1>>();

/** A model-created structural lookalike has no entry and therefore no consent
 * or execution authority. Consumers must still reopen every durable row. */
export function inspectPreparedHostWorkCall(
  candidate: object,
): Readonly<PreparedHostWorkCallV1> | null {
  return preparedHostWorkCalls.get(candidate) ?? null;
}

export type PrepareExactBoundHostCallForConsentResult =
  | { status: 'prepared'; preparation: object }
  | { status: 'conflict'; reason: string };

/**
 * Reopen an already-admitted exact host call for the shared consent reducer.
 *
 * `work_call` normally creates this opaque preparation while resolving its
 * inner carrier. A provider-neutral direct/catalog adapter may already own the
 * final logical contract instead. It must not manufacture a second consent
 * path, so this seam accepts only the current host-attestation ALS owner and
 * reopens the same logical/work/catalog rows before minting the identical
 * process-opaque preparation consumed by `evaluatePreparedHostWorkCallConsent`.
 * It starts no body and grants no physical authority.
 */
export function prepareExactBoundHostCallForConsent(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  targetName: string;
  targetArgs: unknown;
  targetInputSchema: unknown;
  settlementLane?: SettleToolAttemptInput['lane'];
}): PrepareExactBoundHostCallForConsentResult {
  try {
    const acceptedTaskId = acceptedTaskIdFor(input.sessionId, input.sourceUserSeq);
    const logical = durableLogicalCallContract(
      acceptedTaskId,
      input.targetName,
      input.targetArgs,
    );
    const attestation = currentHostCallAttestation();
    if (
      !logical
      || !attestation
      || attestation.sessionId !== input.sessionId
      || attestation.sourceUserSeq !== input.sourceUserSeq
      || attestation.acceptedTaskId !== acceptedTaskId
      || attestation.logicalToolCallId !== input.logicalToolCallId
      || attestation.toolName !== logical.toolName
      || attestation.argumentDigest !== logical.argumentDigest
    ) {
      return { status: 'conflict', reason: 'exact host call preparation lacks its current attestation' };
    }
    const host = loadHostCallCapabilityBinding({
      db: openEventLog(),
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      logicalToolCallId: input.logicalToolCallId,
    });
    const work = loadExpectedWorkCallBindingState({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      logicalToolCallId: input.logicalToolCallId,
    });
    const frozen = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    const logicalState = logicalCallAuthorityState({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId,
      logicalToolCallId: input.logicalToolCallId,
    });
    const physical = openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      input.logicalToolCallId,
    ) as { n: number };
    if (
      host.status !== 'ok'
      || !hostCallCapabilityBindingMatchesAttestation(host.binding, attestation)
      || host.binding.effectiveArgumentDigest !== logical.argumentDigest
      || work.status !== 'ok'
      || work.binding.sessionId !== input.sessionId
      || work.binding.sourceUserSeq !== input.sourceUserSeq
      || work.binding.acceptedTaskId !== acceptedTaskId
      || work.binding.logicalToolCallId !== input.logicalToolCallId
      || work.binding.effect !== host.binding.effect
      || frozen.status !== 'ok'
      || frozen.contract.acceptedTaskId !== acceptedTaskId
      || frozen.contract.contractId !== work.binding.contractId
      || !frozen.contract.operations.some((operation) => (
        operation.id === work.binding.requirementId
        && operation.effect === work.binding.effect
      ))
      || logicalState.status !== 'open'
      || physical.n !== 0
    ) {
      return { status: 'conflict', reason: 'exact host call preparation no longer reopens its durable authority' };
    }
    if (host.binding.providerInputSchemaDigest) {
      const observedSchemaDigest = canonicalExternalInputSchemaDigestV1(input.targetInputSchema);
      if (!observedSchemaDigest || observedSchemaDigest !== host.binding.providerInputSchemaDigest) {
        return { status: 'conflict', reason: 'exact host call preparation input schema drifted' };
      }
    }
    const candidate = Object.freeze({});
    preparedHostWorkCalls.set(candidate, Object.freeze({
      version: 1,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId,
      logicalToolCallId: input.logicalToolCallId,
      targetName: logical.toolName,
      targetArgs: clonePreparationValue(input.targetArgs),
      targetInputSchema: clonePreparationValue(input.targetInputSchema),
      binding: clonePreparationValue(work.binding),
      contract: clonePreparationValue(frozen.contract),
      settlementLane: input.settlementLane ?? 'agents_runner',
      hostCapabilityBinding: clonePreparationValue(host.binding),
    }));
    return { status: 'prepared', preparation: candidate };
  } catch {
    return { status: 'conflict', reason: 'exact host call preparation could not reopen durably' };
  }
}

/**
 * Close a prepared, zero-crossing call when a later sibling makes the model
 * frame repair as a unit. The expected-work binding remains as truthful audit
 * evidence on a refused_pre_dispatch settlement; admission may bind a fresh
 * logical id because no effect was executed.
 */
export function releasePreparedHostWorkCallForRepair(
  candidate: object,
  reason = 'prepared_frame_replanned',
): boolean {
  const prepared = preparedHostWorkCalls.get(candidate);
  if (!prepared) return false;
  try {
    const physical = openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      prepared.sessionId,
      prepared.sourceUserSeq,
      prepared.logicalToolCallId,
    ) as { n: number };
    if (physical.n !== 0) return false;
    const state = logicalCallAuthorityState({
      sessionId: prepared.sessionId,
      sourceUserSeq: prepared.sourceUserSeq,
      acceptedTaskId: prepared.acceptedTaskId,
      logicalToolCallId: prepared.logicalToolCallId,
    });
    if (state.status === 'settled') return true;
    if (state.status !== 'open') return false;
    settleAdmittedLogicalCallPreDispatchRefusal({
      sessionId: prepared.sessionId,
      sourceUserSeq: prepared.sourceUserSeq,
      logicalToolCallId: prepared.logicalToolCallId,
      toolName: prepared.targetName,
      args: prepared.targetArgs,
      lane: prepared.settlementLane,
      mutating: prepared.binding.effect === 'local_write'
        || prepared.binding.effect === 'external_write'
        || prepared.binding.effect === 'admin',
      reason,
    });
    return true;
  } catch {
    return false;
  }
}

function clonePreparationValue<T>(value: T): T {
  return structuredClone(value);
}

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

function hasUpstreamMutation(
  contract: AcceptedTaskWorkContractV1,
  operationId: string,
): boolean {
  const seen = new Set([operationId]);
  const queue = [operationId];
  while (queue.length > 0) {
    const successorId = queue.shift()!;
    const successor = contract.operations.find((candidate) => candidate.id === successorId);
    if (!successor) continue;
    for (const predecessorId of new Set([...successor.dependsOn, ...successor.dataFrom])) {
      if (seen.has(predecessorId)) continue;
      const predecessor = contract.operations.find((candidate) => candidate.id === predecessorId);
      if (!predecessor) continue;
      if (
        predecessor.effect === 'local_write'
        || predecessor.effect === 'external_write'
        || predecessor.effect === 'admin'
      ) return true;
      seen.add(predecessor.id);
      queue.push(predecessor.id);
    }
  }
  return false;
}

/** True only while an operation remains on the pre-construct side of a CTC
 * DAG. The first once mutation is the provider-neutral construct boundary.
 * Traversal never crosses a mutation, and an operation with any upstream
 * mutation (for example artifact readback before terminal delivery) is not a
 * source ancestor even if it later feeds another once external write. */
function feedsInitialOnceConstructWrite(
  contract: AcceptedTaskWorkContractV1,
  operationId: string,
): boolean {
  if (hasUpstreamMutation(contract, operationId)) return false;
  const seen = new Set([operationId]);
  const queue = [operationId];
  while (queue.length > 0) {
    const predecessor = queue.shift()!;
    for (const candidate of contract.operations) {
      if (
        seen.has(candidate.id)
        || (!candidate.dependsOn.includes(predecessor) && !candidate.dataFrom.includes(predecessor))
      ) continue;
      if (
        (candidate.effect === 'local_write' || candidate.effect === 'external_write')
        && candidate.cardinality.kind === 'once'
      ) return true;
      // Source lineage can be refined through provider-neutral reads and
      // computes, but never through an effectful boundary.
      if (candidate.effect !== 'read' && candidate.effect !== 'compute') continue;
      seen.add(candidate.id);
      queue.push(candidate.id);
    }
  }
  return false;
}

function isInitialOnceConstructWrite(
  contract: AcceptedTaskWorkContractV1,
  operationId: string,
): boolean {
  const operation = contract.operations.find((candidate) => candidate.id === operationId);
  return Boolean(
    operation
    && (operation.effect === 'local_write' || operation.effect === 'external_write')
    && operation.cardinality.kind === 'once'
    && !hasUpstreamMutation(contract, operation.id),
  );
}

function trustedParentCollectThenConstruct(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
}): boolean {
  const graphEvent = getTurnGraphEventForSource(input.sessionId, input.sourceUserSeq);
  const lineage = graphEvent?.data.taskContinuationLineage;
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage)) return false;
  const row = lineage as Record<string, unknown>;
  const parentSourceUserSeq = row.parentSourceUserSeq;
  if (
    !Number.isSafeInteger(parentSourceUserSeq)
    || Number(parentSourceUserSeq) <= 0
    || Number(parentSourceUserSeq) >= input.sourceUserSeq
    || row.consumingSourceUserSeq !== input.sourceUserSeq
    || row.acceptedTaskId !== input.acceptedTaskId
  ) return false;
  const parent = expectedTaskFor(input.sessionId, Number(parentSourceUserSeq));
  return parent.status === 'ok'
    && row.parentAcceptedTaskId === parent.expectation.acceptedTaskId
    && (
      parent.graph.classification.goalConstraints?.construct === 'collect_then_construct'
      || parent.graph.classification.multiItem.collectThenConstruct
    );
}

/** Resolve the current requirement's role from the exact accepted graph and
 * immutable work contract. This is the trusted bridge into the physical
 * source-strategy gate: neither the model nor a provider adapter can label an
 * arbitrary call as collection/source work.
 *
 * Typed graphs carry operation ids directly. Older/model-proposed action
 * contracts may use their own provider-neutral ids, so collect-then-construct
 * has one deliberately narrow fallback: a root complete-set read is an
 * aggregate collection requirement when a once-cardinality write consumes it
 * directly. This immutable DAG edge survives both a continuation graph losing
 * its source-role annotation and unrelated model-proposed operations; adding a
 * decoy read or fanout operation cannot erase the source gate. */
type DurableWorkSourceStrategyState =
  | { status: 'not_required' }
  | { status: 'required'; binding?: TurnSourceStrategyBindingV1 }
  | { status: 'invalid'; reason: string };

/** Exact durable strategy state for this accepted source. Session/surface kind
 * is deliberately absent: an ordinary current-turn chat query may choose a
 * source now, while an entered/unconfirmed/malformed strategy must fail closed. */
function durableWorkSourceStrategyState(
  sessionId: string,
  sourceUserSeq: number,
): DurableWorkSourceStrategyState {
  try {
    const inspection = inspectExactSourceStrategyDecisionForSource(
      sessionId,
      sourceUserSeq,
    );
    if (inspection.status === 'absent') return { status: 'not_required' };
    if (inspection.status === 'invalid') {
      return {
        status: 'invalid',
        reason: 'The accepted source has ambiguous or malformed durable source-strategy authority. No inner tool was started.',
      };
    }
    if (!turnPreflightDecisionEntersSourceStrategy(inspection.decision)) {
      return { status: 'not_required' };
    }
    const binding = inspection.decision.sourceStrategyPosture === 'confirmed_exact'
      ? validatedTurnSourceStrategyBinding(inspection.decision.sourceStrategyBinding)
      : null;
    return {
      status: 'required',
      ...(binding ? { binding } : {}),
    };
  } catch {
    return {
      status: 'invalid',
      reason: 'The accepted source strategy could not be read durably. No inner tool was started.',
    };
  }
}

function sourceStrategyRequirementContext(input: {
  sessionId: string;
  sourceUserSeq: number;
  requirementId: string;
  contract?: AcceptedTaskWorkContractV1;
  /** Fail-closed first-proposal seam: runtime effect after exact inner
   * resolution, used only when no valid contract can yet be loaded/prepared. */
  uncontractedEffect?: SourceStrategyRequirementContext['effect'];
}): SourceStrategyRequirementContext | null {
  try {
    const withBindingRequirement = (
      role: SourceStrategyRequirementContext['role'],
      effect: SourceStrategyRequirementContext['effect'],
    ): SourceStrategyRequirementContext => {
      const strategy = durableWorkSourceStrategyState(input.sessionId, input.sourceUserSeq);
      return {
        role,
        effect,
        ...(strategy.status === 'not_required' ? {} : { bindingRequired: true }),
      };
    };
    const expected = expectedTaskFor(input.sessionId, input.sourceUserSeq);
    if (expected.status !== 'ok') return null;
    const trustedCollectThenConstruct = expected.graph.classification.goalConstraints?.construct === 'collect_then_construct'
      || expected.graph.classification.multiItem.collectThenConstruct
      || trustedParentCollectThenConstruct({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: expected.expectation.acceptedTaskId,
      });
    const failClosedUncontractedRequirement = (): SourceStrategyRequirementContext | null => (
      trustedCollectThenConstruct
        && (input.uncontractedEffect === 'read' || input.uncontractedEffect === 'compute')
        ? withBindingRequirement('collection', input.uncontractedEffect)
        : null
    );
    const loaded = input.contract
      ? { status: 'ok' as const, contract: input.contract }
      : loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (loaded.status !== 'ok') return failClosedUncontractedRequirement();
    const contract = loaded.contract;
    if (
      contract.acceptedTaskId !== expected.expectation.acceptedTaskId
      || contract.graphEventId !== expected.expectation.graphEventId
      || contract.graphId !== expected.expectation.graphId
      || contract.graphHash !== expected.expectation.graphHash
    ) return failClosedUncontractedRequirement();
    const operation = contract.operations.find((candidate) => candidate.id === input.requirementId);
    if (!operation) return failClosedUncontractedRequirement();

    // A runtime-proven read/compute cannot borrow the construct-write id to
    // escape source admission through the generic semantic-read fallback. The
    // initial once mutation is the construct boundary; later delivery writes
    // have an upstream mutation and therefore remain outside this clause.
    if (
      trustedCollectThenConstruct
      && (input.uncontractedEffect === 'read' || input.uncontractedEffect === 'compute')
      && isInitialOnceConstructWrite(contract, operation.id)
    ) {
      return withBindingRequirement('collection', input.uncontractedEffect);
    }

    const exactNode = expected.graph.nodes.find((node) =>
      node.operationId === operation.id || node.id === operation.id);
    if (exactNode?.capabilityRole) {
      return withBindingRequirement(exactNode.capabilityRole, operation.effect);
    }

    const directAggregateCollectionShape = operation.effect === 'read'
      && operation.coverage === 'complete_set'
      && operation.cardinality.kind === 'once'
      && operation.dependsOn.length === 0
      && contract.operations.some((candidate) => (
        (candidate.effect === 'local_write' || candidate.effect === 'external_write')
        && candidate.cardinality.kind === 'once'
        && candidate.dependsOn.includes(operation.id)
        && candidate.dataFrom.includes(operation.id)
      ));
    // A verified current/parent CTC graph is trusted semantic authority. Every
    // roleless read/compute ancestor of its once construct write stays inside
    // the confirmed source boundary: proposal-authored coverage, a prep node,
    // or an intermediate compute cannot relabel source acquisition out of the
    // gate. Without that lineage, accept only the narrow complete-set/direct-
    // write read shape.
    const trustedAggregateAncestor = trustedCollectThenConstruct
      && (operation.effect === 'read' || operation.effect === 'compute')
      && feedsInitialOnceConstructWrite(contract, operation.id);
    if (trustedAggregateAncestor || directAggregateCollectionShape) {
      return withBindingRequirement('collection', operation.effect);
    }
    return null;
  } catch {
    return null;
  }
}

function withSourceRequirementIfKnown<T>(
  requirement: SourceStrategyRequirementContext | null,
  work: () => T,
): T {
  return requirement ? withSourceStrategyRequirement(requirement, work) : work();
}

export type SourceStrategyWorkCarrierAdmission =
  | { status: 'not_applicable' }
  | {
      status: 'admitted';
      capabilityId: string;
      match: 'primary' | 'equivalent_fallback';
    }
  | { status: 'refused'; reason: string };

/** Resolve only identities that still have a downstream physical verifier.
 * A shell/CLI/browser/HTTP call can reach the network, but it cannot present
 * the capability/account/schema identity consumed by the provider gateway and
 * therefore cannot stand in for a confirmed collection source. */
function resolvedSourceCarrierCapabilityId(
  targetName: string,
  targetArgs: unknown,
): string | null {
  if (targetName === 'composio_execute_tool') {
    if (!targetArgs || typeof targetArgs !== 'object' || Array.isArray(targetArgs)) return null;
    const slug = (targetArgs as Record<string, unknown>).tool_slug;
    return typeof slug === 'string' && slug.trim()
      ? `capability:composio:${slug.trim()}`
      : null;
  }
  return isMcpNamespacedTool(targetName)
    ? `capability:mcp:${targetName}`
    : null;
}

/** Provider-neutral routing half of source admission. This does not pretend
 * to verify a live account/schema early: it admits only a carrier that can
 * present the exact bound capability to the existing provider gateway, whose
 * physical seam still resolves and matches account/schema before I/O. */
export function evaluateSourceStrategyWorkCarrier(input: {
  requirement: SourceStrategyRequirementContext | null;
  binding?: TurnSourceStrategyBindingV1;
  bindingRequired?: boolean;
  targetName: string;
  targetArgs: unknown;
}): SourceStrategyWorkCarrierAdmission {
  if (input.requirement?.role !== 'source' && input.requirement?.role !== 'collection') {
    return { status: 'not_applicable' };
  }
  if (!input.binding) {
    return input.bindingRequired
      ? {
          status: 'refused',
          reason: 'The source/collection requirement has no reconstructable confirmed source binding. No inner tool was started.',
        }
      : { status: 'not_applicable' };
  }
  const capabilityId = resolvedSourceCarrierCapabilityId(input.targetName, input.targetArgs);
  if (!capabilityId) {
    return {
      status: 'refused',
      reason: `The source/collection target ${input.targetName} cannot present an exact bound capability/account/schema identity. Shell, CLI, browser, and generic HTTP substitutes are not admitted for this confirmed source. No inner tool was started.`,
    };
  }
  const identities = [input.binding.primary, ...input.binding.equivalentFallbacks];
  const index = identities.findIndex((identity) => identity.capabilityId === capabilityId);
  if (index < 0) {
    return {
      status: 'refused',
      reason: `The source/collection target ${capabilityId} is outside the confirmed source binding. No inner tool was started.`,
    };
  }
  const matched = identities[index]!;
  if (capabilityId.startsWith('capability:composio:') && !matched.schemaFingerprint) {
    return {
      status: 'refused',
      reason: `The bound Composio source ${capabilityId} has no schema fingerprint for the physical gateway to verify. No inner tool was started.`,
    };
  }
  return {
    status: 'admitted',
    capabilityId,
    match: index === 0 ? 'primary' : 'equivalent_fallback',
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
      return 'The exact read or compute already settled but did not prove the requested evidence complete. Its retained result is included; use it instead of replaying. To gather different evidence, issue a DIFFERENT non-mutating call now — distinct productive reads are admitted; never ask the user for permission to search again. A safe retry does not itself prove coverage; `plan` remains open until the canonical evidence oracle discharges it.';
    case 'work_effect_already_executed':
      return 'The mutation crossed once but is not yet durably verified. Do NOT repeat it. Use the stored result when present, then verify/read back or reconcile the existing effect; `plan` remains open until proof exists.';
    case 'work_dependency_pending':
      return 'Complete the dependency named in `detail` first — `plan` shows each requirement\'s state. A `data_in` predecessor is ready for the next read or reversible write; only `blocked_on_dependency` is still waiting.';
    case 'work_attempt_budget_exhausted':
      return 'This requirement has used its one attempt and one repair. Do not retry it. Use landed data from `plan` / `result`, continue the next open requirement, or reply with the precise blocker.';
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
  /** Host-frozen contract for this exact accepted source, when one exists. */
  frozenContract?: AcceptedTaskWorkContractV1 | null;
  /** Reachable inner names the host may uniquely bind onto a frozen write. */
  catalogIdentifiers?: readonly string[];
  /** Fresh host lane: plan_task must freeze the graph-derived contract first,
   * and model-authored work_call proposals are never accepted. */
  requireHostPlan?: boolean;
}

export function buildWorkCall(options: BuildWorkCallOptions = {}): Tool<RuntimeContextValue> {
  const {
    settlementLane = 'agents_runner',
    frozenContract = null,
    catalogIdentifiers,
    requireHostPlan = false,
    ...dispatcherOptions
  } = options;
  const frozenAuthority = formatFrozenWorkCallDescription({
    frozenContract,
    catalogIdentifiers,
    sourceStrategyBinding: options.sourceStrategyBinding,
  });
  const suppliedSourceStrategyBinding = validatedTurnSourceStrategyBinding(
    options.sourceStrategyBinding,
  );
  const sourceCarrierAdmission = (input: {
    sessionId: string;
    sourceUserSeq: number;
    requirement: SourceStrategyRequirementContext | null;
    targetName: string;
    targetArgs: unknown;
  }): SourceStrategyWorkCarrierAdmission => {
    if (input.requirement?.role !== 'source' && input.requirement?.role !== 'collection') {
      return { status: 'not_applicable' };
    }
    const durableStrategy = durableWorkSourceStrategyState(
      input.sessionId,
      input.sourceUserSeq,
    );
    if (durableStrategy.status === 'invalid') {
      return {
        status: 'refused',
        reason: durableStrategy.reason,
      };
    }
    const requireDurableBinding = options.sourceStrategyBinding !== undefined
      || input.requirement.bindingRequired === true
      || durableStrategy.status === 'required';
    const durableBinding = durableStrategy.status === 'required'
      ? durableStrategy.binding
      : undefined;
    if (
      options.sourceStrategyBinding !== undefined
      && (
        !suppliedSourceStrategyBinding
        || !durableBinding
        || JSON.stringify(suppliedSourceStrategyBinding) !== JSON.stringify(durableBinding)
      )
    ) {
      return {
        status: 'refused',
        reason: 'The work carrier source binding does not reproduce the exact durable confirmed binding. No inner tool was started.',
      };
    }
    return evaluateSourceStrategyWorkCarrier({
      requirement: input.requirement,
      ...(durableBinding ? { binding: durableBinding } : {}),
      bindingRequired: requireDurableBinding || Boolean(durableBinding),
      targetName: input.targetName,
      targetArgs: input.targetArgs,
    });
  };
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
      if (frame.preparation) {
        frame.preparation.observedTarget = {
          name: resolved.targetName,
          args: clonePreparationValue(resolved.targetArgs),
        };
      }
      if (
        !Number.isSafeInteger(resolved.sourceUserSeq)
        || (resolved.sourceUserSeq ?? 0) <= 0
        || !resolved.logicalToolCallId
      ) {
        frame.refusalKind = 'work_authority_unavailable';
        return refuse(frame.refusalKind, 'accepted source or logical call identity is unavailable');
      }
      const proposal = normalizedProposal(frame.input.proposal);
      if (requireHostPlan && proposal !== null) {
        frame.refusalKind = 'work_contract_required';
        return refuse(
          frame.refusalKind,
          'This fresh host turn accepts only the graph-derived plan. Call plan_task alone first, then retry work_call with proposal:null.',
        );
      }
      const durableHostContract = requireHostPlan
        ? (() => {
            const loaded = loadExpectedWorkContract(
              resolved.sessionId,
              resolved.sourceUserSeq as number,
            );
            return loaded.status === 'ok' ? loaded.contract : null;
          })()
        : null;
      if (requireHostPlan && !durableHostContract) {
        frame.refusalKind = 'work_contract_required';
        return refuse(
          frame.refusalKind,
          'No admitted plan is active for this accepted request. Call plan_task alone before any business operation.',
        );
      }
      const preparedProposal = !frozenContract && !durableHostContract && proposal
        ? prepareActionExpectedWorkContract({
            sessionId: resolved.sessionId,
            sourceUserSeq: resolved.sourceUserSeq as number,
            proposal,
          })
        : null;
      const sourceContract = frozenContract
        ?? durableHostContract
        ?? (preparedProposal?.status === 'prepared' ? preparedProposal.contract : undefined);
      const resolvedRuntimeEffect = classifyRuntimeToolEffect(
        resolved.targetName,
        resolved.targetArgs,
      ).effect;
      const preAdmissionSourceRequirement = sourceStrategyRequirementContext({
        sessionId: resolved.sessionId,
        sourceUserSeq: resolved.sourceUserSeq as number,
        requirementId: frame.input.requirement_id,
        ...(sourceContract ? { contract: sourceContract } : {}),
        uncontractedEffect: resolvedRuntimeEffect,
      });
      const preAdmissionSourceCarrier = sourceCarrierAdmission({
        sessionId: resolved.sessionId,
        sourceUserSeq: resolved.sourceUserSeq as number,
        requirement: preAdmissionSourceRequirement,
        targetName: resolved.targetName,
        targetArgs: resolved.targetArgs,
      });
      if (preAdmissionSourceCarrier.status === 'refused') {
        frame.refusalKind = 'work_authority_unavailable';
        return refuse(frame.refusalKind, preAdmissionSourceCarrier.reason);
      }
      const admission = admitExpectedWorkInvocation({
        sessionId: resolved.sessionId,
        sourceUserSeq: resolved.sourceUserSeq as number,
        logicalToolCallId: resolved.logicalToolCallId,
        proposal,
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
          // The named requirement rides along so the read's settlement stays
          // visible to the dependency oracle; the bypass grants no discharge
          // authority — the oracle alone decides what the evidence is worth.
          if (fallbackAuthority.ok) {
            const sourceRequirement = sourceStrategyRequirementContext({
              sessionId: resolved.sessionId,
              sourceUserSeq: resolved.sourceUserSeq as number,
              requirementId: frame.input.requirement_id,
              ...(sourceContract ? { contract: sourceContract } : {}),
              uncontractedEffect: resolvedRuntimeEffect,
            });
            const sourceCarrier = sourceCarrierAdmission({
              sessionId: resolved.sessionId,
              sourceUserSeq: resolved.sourceUserSeq as number,
              requirement: sourceRequirement,
              targetName: resolved.targetName,
              targetArgs: resolved.targetArgs,
            });
            if (sourceCarrier.status === 'refused') {
              frame.refusalKind = 'work_authority_unavailable';
              return refuse(frame.refusalKind, sourceCarrier.reason);
            }
            return withUnboundWorkRequirement(frame.input.requirement_id, () =>
              withSourceRequirementIfKnown(sourceRequirement, dispatch));
          }
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
          'this requirement instance is already durably settled — its stored result is included; continue with the NEXT open requirement (or a different read under it) now, and never ask the user for permission to keep working',
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
      const sourceRequirement = sourceStrategyRequirementContext({
        sessionId: resolved.sessionId,
        sourceUserSeq: resolved.sourceUserSeq as number,
        requirementId: admission.binding.requirementId,
        contract: admission.contract,
      });
      const sourceCarrier = sourceCarrierAdmission({
        sessionId: resolved.sessionId,
        sourceUserSeq: resolved.sourceUserSeq as number,
        requirement: sourceRequirement,
        targetName: resolved.targetName,
        targetArgs: resolved.targetArgs,
      });
      if (sourceCarrier.status === 'refused') {
        frame.refusalKind = 'work_authority_unavailable';
        return refuse(frame.refusalKind, sourceCarrier.reason);
      }
      if (frame.preparation) {
        frame.preparation.resolved = {
          sessionId: resolved.sessionId,
          sourceUserSeq: resolved.sourceUserSeq as number,
          acceptedTaskId: admission.contract.acceptedTaskId,
          logicalToolCallId: resolved.logicalToolCallId!,
          targetName: resolved.targetName,
          targetArgs: clonePreparationValue(resolved.targetArgs),
          targetInputSchema: clonePreparationValue(resolved.targetInputSchema),
          ...(resolved.evidenceArgs !== undefined
            ? { evidenceArgs: clonePreparationValue(resolved.evidenceArgs) }
            : {}),
          ...(resolved.evidenceInputSchema !== undefined
            ? { evidenceInputSchema: clonePreparationValue(resolved.evidenceInputSchema) }
            : {}),
          binding: clonePreparationValue(admission.binding),
          contract: clonePreparationValue(admission.contract),
          settlementLane,
        };
        return resolvedDispatchPreparedWithoutExecution();
      }
      return withExpectedWorkBinding(admission.binding, () =>
        withSourceRequirementIfKnown(sourceRequirement, dispatch));
    },
  }) as unknown as {
    invoke: (
      runContext: unknown,
      input: string,
      details?: { toolCall?: { callId?: string; id?: string } },
    ) => Promise<unknown>;
  };

  const invokeResolvedCarrier = async (
    normalizedInput: WorkCallInput,
    runContext: unknown,
    details: { toolCall?: { callId?: string; id?: string } } | undefined,
    preparation = false,
  ): Promise<{ frame: WorkCallFrame; output: unknown }> => {
    const frame: WorkCallFrame = {
      input: normalizedInput,
      ...(preparation ? { preparation: {} } : {}),
    };
    const output = await workCallStorage.run(frame, () => dispatcher.invoke(
      runContext,
      JSON.stringify({ name: frame.input.name, args_json: frame.input.args_json }),
      details,
    ));
    return { frame, output };
  };

  const built = tool({
    name: 'work_call',
    description: [
      'Invoke one business tool under the frozen semantic work contract.',
      frozenAuthority
        ?? (requireHostPlan
          ? 'This is the proposal-free foreground carrier. Before activation it is valid only as the one second call in the same model frame as a direct plan_task, and only for that plan’s dependency-root read/compute requirement. The host settles, delivers, and activates plan_task before admitting the sibling. It refuses alone before activation. After activation, bind one exact requirement_id normally.'
          : [
              'If the host already froze a contract, pass proposal:null and bind the exact requirement id. Otherwise the FIRST call provides the complete provider-neutral proposal plus the first requirement binding.',
              'The proposal describes only effects, dependencies, coverage, cardinality and universes—never tool names, providers, services or slugs.',
              `Collect-then-construct ("read the set once, write one artifact once") — a VALID first-call proposal: ${JSON.stringify(WORK_CALL_COLLECT_THEN_CONSTRUCT_EXAMPLE)}.`,
              `Count-only fanout ("one write per record from this read") — a VALID first-call proposal only when the graph is genuine per-item work: ${JSON.stringify(WORK_CALL_COUNT_ONLY_EXAMPLE)}. The sealed universe sizes itself from the settled read; memberIdPointer is an RFC 6901 pointer to each record's id (empty string when the record itself is the id).`,
            ].join(' ')),
      'Content you compose yourself (drafts, summaries, messages) is NOT a compute operation — composition happens inside the consuming write\'s args. Propose compute ONLY for work a tool will perform; a compute requirement no tool call ever carries can never be proven and will block everything that depends on it.',
      'Invoke a runtime-resolved inner name/schema directly. When a requirement is unresolved, use tool_search once for that requirement; when only an exact schema is missing, describe that exact tool once instead of broad-searching. Ask the user naturally if the intended work itself is ambiguous.',
    ].join(' '),
    parameters: (requireHostPlan
      ? HostPlannedWorkCallInputSchema
      : WorkCallInputSchema) as typeof WorkCallInputSchema,
    isEnabled: async () => {
      if (!requireHostPlan) return true;
      const context = harnessRunContextStorage.getStore();
      // Visibility is not authority. The host exposes this one compact schema
      // so the primary model can emit the sanctioned plan+root-read frame;
      // host-model-frame-policy refuses it alone before activation, and the
      // execution body still requires the exact durable host plan.
      return Boolean(
        context?.sessionId
        && Number.isSafeInteger(context.sourceUserSeq)
        && (context.sourceUserSeq ?? 0) > 0
      );
    },
    errorFunction: (_context, error) => {
      const detail = error instanceof Error ? error.message : String(error);
      return refusalResult('work_contract_invalid', detail) as unknown as string;
    },
    execute: async (input, runContext, details): Promise<string> => {
      const normalizedInput = requireHostPlan
        ? { ...(input as Omit<WorkCallInput, 'proposal'>), proposal: null }
        : input as WorkCallInput;
      const { frame, output } = await invokeResolvedCarrier(
        normalizedInput,
        runContext,
        details as { toolCall?: { callId?: string; id?: string } } | undefined,
      );
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

  const renderPreparationRefusal = (output: unknown): string => {
    if (output instanceof ExternalWritePreDispatchResult) return output.output;
    if (typeof output === 'string') return output;
    if (isResolvedDispatchPreparedWithoutExecution(output)) {
      return JSON.stringify({
        error: 'work_authority_unavailable',
        dispatch_state: 'not_started',
        detail: 'The resolved preparation did not produce its exact durable capture.',
        repair: 'Re-plan this exact work_call from the current capability schema.',
      });
    }
    try {
      return JSON.stringify(output ?? null);
    } catch {
      return JSON.stringify({
        error: 'work_authority_unavailable',
        dispatch_state: 'not_started',
        detail: 'The pre-dispatch result could not be represented safely.',
        repair: 'Re-plan this exact work_call from the current capability schema.',
      });
    }
  };

  const settlePreparationRefusalIfOpen = (input: {
    request: HostWorkCallPreparationRequest;
    acceptedTaskId: string;
    frame?: WorkCallFrame;
    reason: string;
  }): void => {
    const state = logicalCallAuthorityState({
      sessionId: input.request.sessionId,
      sourceUserSeq: input.request.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      logicalToolCallId: input.request.logicalToolCallId,
    });
    if (state.status === 'settled') return;
    if (state.status !== 'open') {
      throw new Error(`prepared logical call is ${state.status}${'reason' in state ? `: ${state.reason}` : ''}`);
    }
    const observed = input.frame?.preparation?.observedTarget;
    const recovery = observed
      ? durableLogicalCallRecoveryMaterial(input.acceptedTaskId, observed.name, observed.args)
      : durableLogicalCallRecoveryMaterial(input.acceptedTaskId, 'work_call', input.request.outerArgs);
    if (!recovery) throw new Error('preparation refusal lacks an exact logical recovery contract');
    settleAdmittedLogicalCallPreDispatchRefusal({
      sessionId: input.request.sessionId,
      sourceUserSeq: input.request.sourceUserSeq,
      logicalToolCallId: input.request.logicalToolCallId,
      toolName: recovery.toolName,
      args: recovery.args,
      lane: settlementLane,
      mutating: ['local_write', 'external_write', 'admin'].includes(
        classifyRuntimeToolEffect(recovery.toolName, recovery.args).effect,
      ),
      reason: input.reason,
    });
  };

  const prepareForHostConsent = async (
    request: HostWorkCallPreparationRequest,
  ): Promise<HostWorkCallPreparationResult> => {
    const ambient = harnessRunContextStorage.getStore();
    const attestation = currentHostCallAttestation();
    const acceptedTaskId = acceptedTaskIdFor(request.sessionId, request.sourceUserSeq);
    const outerContract = durableLogicalCallContract(
      acceptedTaskId,
      'work_call',
      request.outerArgs,
    );
    if (
      !ambient
      || ambient.sessionId !== request.sessionId
      || ambient.sourceUserSeq !== request.sourceUserSeq
      || !attestation
      || attestation.sessionId !== request.sessionId
      || attestation.sourceUserSeq !== request.sourceUserSeq
      || attestation.acceptedTaskId !== acceptedTaskId
      || attestation.logicalToolCallId !== request.logicalToolCallId
      || !outerContract
      || attestation.toolName !== outerContract.toolName
      || attestation.argumentDigest !== outerContract.argumentDigest
    ) {
      return { status: 'conflict', reason: 'work_call preparation lacks its exact current host source and attestation' };
    }

    const parsed = (requireHostPlan ? HostPlannedWorkCallInputSchema : WorkCallInputSchema)
      .safeParse(request.outerArgs);
    if (!parsed.success) {
      return {
        status: 'refused',
        output: JSON.stringify({
          error: 'work_contract_invalid',
          dispatch_state: 'not_started',
          detail: parsed.error.issues.map((issue) => (
            `${issue.path.join('.') || '(root)'}: ${issue.message}`
          )).join('; '),
          repair: 'Retry one corrected work_call using the exact current schema.',
        }),
      };
    }
    const normalizedInput = requireHostPlan
      ? { ...(parsed.data as Omit<WorkCallInput, 'proposal'>), proposal: null }
      : parsed.data as WorkCallInput;

    try {
      return await withLogicalToolCall({
        sessionId: request.sessionId,
        sourceUserSeq: request.sourceUserSeq,
        logicalToolCallId: request.logicalToolCallId,
        tool: 'work_call',
        args: request.outerArgs,
      }, async (logical): Promise<HostWorkCallPreparationResult> => {
        if (
          logical.acceptedTaskId !== acceptedTaskId
          || logical.logicalToolCallId !== request.logicalToolCallId
        ) {
          settlePreparationRefusalIfOpen({
            request,
            acceptedTaskId,
            reason: 'logical_identity_changed_during_preparation',
          });
          return { status: 'conflict', reason: 'work_call logical identity changed during preparation' };
        }

        const hostBinding = persistHostCallCapabilityBinding({
          db: openEventLog(),
          attestation,
          sessionId: request.sessionId,
          sourceUserSeq: request.sourceUserSeq,
          logicalToolCallId: request.logicalToolCallId,
          acceptedTaskId,
          toolName: outerContract.toolName,
          argumentDigest: outerContract.argumentDigest,
          effect: attestation.effect,
        });
        if (hostBinding.status !== 'bound' && hostBinding.status !== 'replayed') {
          settlePreparationRefusalIfOpen({
            request,
            acceptedTaskId,
            reason: `host_capability_binding_${hostBinding.status}`,
          });
          return {
            status: 'conflict',
            reason: `host capability binding is ${hostBinding.status}${'reason' in hostBinding ? `: ${hostBinding.reason}` : ''}`,
          };
        }

        let invoked: { frame: WorkCallFrame; output: unknown };
        try {
          invoked = await invokeResolvedCarrier(
            normalizedInput,
            request.runContext,
            request.details as { toolCall?: { callId?: string; id?: string } } | undefined,
            true,
          );
        } catch (error) {
          settlePreparationRefusalIfOpen({
            request,
            acceptedTaskId,
            reason: 'work_call_preparation_threw',
          });
          return {
            status: 'conflict',
            reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240),
          };
        }

        const resolved = invoked.frame.preparation?.resolved;
        if (!resolved || !isResolvedDispatchPreparedWithoutExecution(invoked.output)) {
          settlePreparationRefusalIfOpen({
            request,
            acceptedTaskId,
            frame: invoked.frame,
            reason: 'work_call_preparation_refused',
          });
          return { status: 'refused', output: renderPreparationRefusal(invoked.output) };
        }

        const logicalState = logicalCallAuthorityState({
          sessionId: request.sessionId,
          sourceUserSeq: request.sourceUserSeq,
          acceptedTaskId,
          logicalToolCallId: request.logicalToolCallId,
        });
        const durableHostBinding = loadHostCallCapabilityBinding({
          db: openEventLog(),
          sessionId: request.sessionId,
          sourceUserSeq: request.sourceUserSeq,
          logicalToolCallId: request.logicalToolCallId,
        });
        const durableWorkBinding = loadExpectedWorkCallBindingState({
          sessionId: request.sessionId,
          sourceUserSeq: request.sourceUserSeq,
          logicalToolCallId: request.logicalToolCallId,
        });
        const physical = openEventLog().prepare(`
          SELECT COUNT(*) AS n FROM physical_dispatches
           WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
        `).get(
          request.sessionId,
          request.sourceUserSeq,
          request.logicalToolCallId,
        ) as { n: number };
        const bindingMatches = durableWorkBinding.status === 'ok'
          && JSON.stringify(durableWorkBinding.binding) === JSON.stringify(resolved.binding);
        if (
          logicalState.status !== 'open'
          || durableHostBinding.status !== 'ok'
          || !bindingMatches
          || physical.n !== 0
        ) {
          settlePreparationRefusalIfOpen({
            request,
            acceptedTaskId,
            frame: invoked.frame,
            reason: 'prepared_authority_did_not_reopen_exactly',
          });
          return { status: 'conflict', reason: 'prepared work_call authority did not reopen exactly before consent' };
        }

        const preparation: PreparedHostWorkCallV1 = Object.freeze({
          version: 1,
          ...resolved,
          hostCapabilityBinding: clonePreparationValue(durableHostBinding.binding),
        });
        const candidate = Object.freeze({});
        preparedHostWorkCalls.set(candidate, preparation);
        return { status: 'prepared', preparation: candidate };
      });
    } catch (error) {
      return {
        status: 'conflict',
        reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240),
      };
    }
  };

  registerHostWorkCallPreparer(built as object, prepareForHostConsent);
  return requireHostPlan
    ? markHostPlanRequiredWorkCall(built as object) as Tool<RuntimeContextValue>
    : built;
}
