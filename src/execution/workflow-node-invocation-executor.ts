import { createHash } from 'node:crypto';

import {
  compileWorkflowNodeInvocationArguments,
  resolveWorkflowNodeInvocation,
  verifyWorkflowNodeInvocationEvidence,
  type ResolvedWorkflowNodeInvocationV1,
  type WorkflowNodeArgumentRuntimeContext,
  type WorkflowNodeInvocationBlock,
  type WorkflowNodeInvocationBlockCode,
  type WorkflowNodeInvocationIdentityV1,
} from './workflow-node-invocation-admission.js';
import {
  workflowNodeInvocationEffectIsMutation,
  type WorkflowNodeInvocationEffectV1,
  type WorkflowNodeInvocationPlanV1,
} from '../memory/workflow-node-invocation-plan.js';
import type { HostCapabilityCatalogFactory } from '../runtime/harness/host-capability-catalog-factory.js';
import type { IndependentCapabilityObservation } from '../runtime/harness/independent-capability-observation.js';
import { canonicalArgumentDigestOf } from '../runtime/harness/resolved-call-authority.js';
import { projectProviderResultEvidenceView } from '../runtime/harness/result-facts.js';
import {
  armWorkflowV3CallAuthority,
  armWorkflowReadOnlyCallAuthority,
  evaluateWorkflowV3AutoConsent,
  WORKFLOW_V3_CALL_AUTHORITY_ENGINE_VERSION,
  type EvaluateWorkflowV3AutoConsentResult,
  type OneShotActivationAuthorization,
  type WorkflowV3AutoConsentArmInput,
  type WorkflowV3AutoConsentAuthorizationV1,
} from '../runtime/harness/accepted-turn-call-authority.js';
import {
  executeWorkflowReadOnlyCall,
  executeWorkflowV3Call,
  type ExecuteWorkflowCallKernelResult,
} from '../runtime/harness/workflow-read-only-call-kernel.js';
import {
  armWorkflowPaginatedReadAuthority,
  type WorkflowPaginatedAggregateReceipt,
} from '../runtime/harness/workflow-paginated-read-authority.js';
import { executeWorkflowPaginatedRead } from '../runtime/harness/workflow-paginated-read-kernel.js';
import {
  ClosedCanonicalJsonError,
  closedCanonicalJson,
  SEALED_CALL_CANONICAL_LIMITS,
  isClosedCanonicalJsonLimitError,
} from '../shared/closed-canonical-json.js';

/**
 * Exact durable identity of one workflow-node attempt.
 *
 * These fields mirror the versioned workflow read-authority roots. Nothing in
 * this identity is synthesized from a chat turn or a display/tool name.
 */
export type WorkflowNodeCallExecutionIdentityV1 = WorkflowNodeInvocationIdentityV1;
/** Read compatibility name retained for existing callers. */
export type WorkflowNodeReadExecutionIdentityV1 = WorkflowNodeCallExecutionIdentityV1;

export interface PreparedWorkflowNodeCallV1 {
  version: 1;
  identity: WorkflowNodeReadExecutionIdentityV1;
  requirementId: string;
  logicalCapabilityId: string;
  logicalCallId: string;
  operationId: string;
  capabilityId: string;
  manifestId: string;
  invocationPlanDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
  canonicalArgs: Readonly<Record<string, unknown>>;
  canonicalArgumentDigest: string;
  /** Digest emitted by the typed-source compiler before provider-argument
   * sealing. Retained so the authority adapter can prove both transformations. */
  sourceArgumentDigest: string;
  binding: Readonly<WorkflowNodeInvocationPlanV1['binding']>;
  liveIdentity: Readonly<ResolvedWorkflowNodeInvocationV1['liveIdentity']>;
  observation: Readonly<ResolvedWorkflowNodeInvocationV1['observation']>;
  evidence: Readonly<WorkflowNodeInvocationPlanV1['evidence']>;
  completeness: Readonly<WorkflowNodeInvocationPlanV1['completeness']>;
  continuation: Readonly<WorkflowNodeInvocationPlanV1['continuation']>;
}

/** Read compatibility name retained without changing the prepared bytes. */
export type PreparedWorkflowNodeReadV1 = PreparedWorkflowNodeCallV1;

/**
 * Provider-neutral semantic authority bound to one already-prepared workflow
 * call. This is the first workflow_v3 checkpoint, not a dispatch root: it
 * carries no invoke callback, canonical argument bytes, approval grant, or
 * accepted-source terminal authority. The opaque proof below is useful only
 * with the exact in-process PreparedWorkflowNodeCallV1 object that minted it.
 */
export interface WorkflowNodeCallAuthorityBindingV1 {
  version: 1;
  authorityKind: typeof PENDING_WORKFLOW_CALL_AUTHORITY_KIND;
  durability: 'process_checkpoint';
  executionState: 'not_armed';
  workflow: Readonly<WorkflowNodeCallExecutionIdentityV1>;
  call: Readonly<{
    logicalCallId: string;
    logicalCapabilityId: string;
    requirementId: string;
    invocationPlanDigest: string;
    canonicalArgumentDigest: string;
    sourceArgumentDigest: string;
    argsRedacted: true;
  }>;
  capability: Readonly<WorkflowNodeInvocationPlanV1['binding']>;
  obligation: Readonly<{
    requirementId: string;
    effect: WorkflowNodeInvocationEffectV1;
    evidence: WorkflowNodeInvocationPlanV1['evidence'];
    completeness: WorkflowNodeInvocationPlanV1['completeness'];
    continuation: WorkflowNodeInvocationPlanV1['continuation'];
    obligationDigest: string;
  }>;
  authorityBindingDigest: string;
}

/** Process-opaque proof. Public fields are diagnostics only; a clone, JSON
 * round trip, or lookalike object has no authority. */
export interface WorkflowNodeCallAuthorityProof {
  readonly kind: 'workflow_v3_call_authority_proof';
  readonly authorityBindingDigest: string;
  readonly logicalCallId: string;
}

export type BindPreparedWorkflowNodeCallAuthorityResult =
  | {
      ok: true;
      binding: Readonly<WorkflowNodeCallAuthorityBindingV1>;
      proof: WorkflowNodeCallAuthorityProof;
    }
  | {
      ok: false;
      reason: 'prepared_call_not_authentic';
    };

export type WorkflowNodeReadPreparationBlockCode =
  | WorkflowNodeInvocationBlockCode
  | 'execution_identity_invalid'
  | 'invocation_plan_digest_mismatch'
  | 'argument_source_missing'
  | 'argument_source_type_mismatch'
  | 'canonical_arguments_invalid'
  | 'canonical_arguments_too_large'
  | 'host_continuation_cursor_supplied';

export interface WorkflowNodeReadPreparationBlock {
  code: WorkflowNodeReadPreparationBlockCode;
  message: string;
  argument?: string;
}

export type PrepareWorkflowNodeReadResult =
  | {
      ok: true;
      prepared: PreparedWorkflowNodeReadV1;
      /** Runtime catalog handle. It is not authority and is intentionally not
       * embedded in the content-addressed prepared contract. */
      resolved: ResolvedWorkflowNodeInvocationV1;
    }
  | {
      ok: false;
      status: 'blocked';
      phase: 'pre_crossing';
      provenNoCrossing: true;
      block: WorkflowNodeReadPreparationBlock;
    };

export const PENDING_WORKFLOW_CALL_AUTHORITY_KIND = 'workflow_v3_call' as const;

/**
 * The exact authority/consent/recovery contract that v60 must satisfy before a
 * prepared non-read call can become executable. This object is preparation
 * state only: it is never a runner terminal, approval prompt, or permission to
 * dispatch.
 */
export interface WorkflowNodeCallAuthorityRequirementV1 {
  version: 1;
  authorityKind: typeof PENDING_WORKFLOW_CALL_AUTHORITY_KIND;
  effect: Exclude<WorkflowNodeInvocationEffectV1, 'read' | 'compute'>;
  mutating: boolean;
  consent:
    | 'none'
    | 'evaluate_exact_call'
    | 'exact_user_grant';
  recovery: Readonly<{
    notStarted: 'resume';
    possiblyStarted: 'hold_no_redispatch' | 'reconcile_never_blind_retry';
    settled: 'replay_exact_settlement';
  }>;
}

/** @internal Activation/compiler seam. Production runners must continue using
 * executeWorkflowNodeRead until workflow_v3_call is durable. */
export type PrepareWorkflowNodeCallResult =
  | {
      kind: 'ready';
      effect: 'read';
      prepared: PreparedWorkflowNodeCallV1;
      resolved: ResolvedWorkflowNodeInvocationV1;
    }
  | {
      kind: 'authority_checkpoint';
      effect: Exclude<WorkflowNodeInvocationEffectV1, 'read' | 'compute'>;
      prepared: PreparedWorkflowNodeCallV1;
      resolved: ResolvedWorkflowNodeInvocationV1;
      requirement: Readonly<WorkflowNodeCallAuthorityRequirementV1>;
      authority: Readonly<WorkflowNodeCallAuthorityBindingV1>;
      proof: WorkflowNodeCallAuthorityProof;
      /** A checkpoint cannot cross a provider port. Runner integration must
       * first add the durable v3 activation/consent/recovery adapter. */
      executable: false;
    }
  | {
      kind: 'blocked';
      preparation: Extract<PrepareWorkflowNodeReadResult, { ok: false }>;
    };

export type ExecuteWorkflowNodeReadResult =
  | Extract<PrepareWorkflowNodeReadResult, { ok: false }>
  | {
      ok: true;
      status: 'completed' | 'replayed';
      executionKind: 'single_read';
      prepared: PreparedWorkflowNodeReadV1;
      activationId: string;
      authorityRootId: string;
      logicalCallId: string;
      physicalDispatchId?: string;
      resultHandleId?: string;
      result: unknown;
    }
  | {
      ok: true;
      status: 'completed' | 'replayed';
      executionKind: 'paginated_read';
      prepared: PreparedWorkflowNodeReadV1;
      activationId: string;
      authorityRootId: string;
      aggregate: WorkflowPaginatedAggregateReceipt;
      result: WorkflowPaginatedAggregateReceipt;
    }
  | {
      ok: false;
      status: 'blocked' | 'failed' | 'incomplete' | 'partial';
      phase: 'authority' | 'kernel' | 'evidence';
      provenNoCrossing: boolean;
      block: {
        code:
          | 'workflow_call_authority_arm_failed'
          | 'workflow_call_blocked'
          | 'workflow_call_failed'
          | 'workflow_evidence_incomplete'
          | 'workflow_collection_partial';
        message: string;
      };
      prepared: PreparedWorkflowNodeReadV1;
      activationId?: string;
      result?: unknown;
      aggregate?: WorkflowPaginatedAggregateReceipt;
      evidenceReasons?: string[];
    };

const SHA256_RE = /^[a-f0-9]{64}$/;
const EXACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;


function sealedCallTooLargeMessage(value: unknown): string {
  let approximateBytes = -1;
  try {
    approximateBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    // unmeasurable; the message still names the bound
  }
  return `Compiled canonical arguments exceed the sealed-call limit (${approximateBytes >= 0 ? `${approximateBytes} bytes` : 'unmeasurable size'}; limit ${SEALED_CALL_CANONICAL_LIMITS.maxTotalBytes} bytes / ${SEALED_CALL_CANONICAL_LIMITS.maxNodes} nodes).`;
}

const preparedWorkflowNodeCallAuthorities = new WeakMap<
  object,
  Readonly<WorkflowNodeCallAuthorityBindingV1>
>();
const workflowNodeCallAuthorityProofs = new WeakMap<
  object,
  Readonly<{
    prepared: PreparedWorkflowNodeCallV1;
    binding: Readonly<WorkflowNodeCallAuthorityBindingV1>;
  }>
>();

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function block(
  code: WorkflowNodeReadPreparationBlockCode,
  message: string,
  argument?: string,
): PrepareWorkflowNodeReadResult {
  return {
    ok: false,
    status: 'blocked',
    phase: 'pre_crossing',
    provenNoCrossing: true,
    block: { code, message, ...(argument ? { argument } : {}) },
  };
}

function exactId(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && EXACT_ID_RE.test(value);
}

function exactExecutionIdentity(value: WorkflowNodeReadExecutionIdentityV1): boolean {
  return exactId(value.workflowId)
    && Number.isInteger(value.workflowRevision)
    && value.workflowRevision > 0
    && SHA256_RE.test(value.workflowDigest)
    && exactId(value.runId)
    && exactId(value.runOccurrenceId)
    && exactId(value.nodeId)
    && Number.isInteger(value.nodeAttempt)
    && value.nodeAttempt > 0
    && SHA256_RE.test(value.invocationPlanDigest)
    && SHA256_RE.test(value.bindingSnapshotDigest)
    && SHA256_RE.test(value.controlDigest);
}

function freezeCanonical<T extends CanonicalJson>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const child of value) freezeCanonical(child);
    return Object.freeze(value) as T;
  }
  for (const child of Object.values(value)) freezeCanonical(child);
  return Object.freeze(value) as T;
}

function freezeClone<T>(value: T): Readonly<T> {
  return freezeCanonical(JSON.parse(closedCanonicalJson(value, SEALED_CALL_CANONICAL_LIMITS)) as CanonicalJson) as Readonly<T>;
}

function canonicalDigest(value: unknown): string {
  return sha256(closedCanonicalJson(value, SEALED_CALL_CANONICAL_LIMITS));
}

function workflowNodeCallAuthorityBindingOf(
  prepared: PreparedWorkflowNodeCallV1,
): Readonly<WorkflowNodeCallAuthorityBindingV1> {
  const obligationBase = {
    requirementId: prepared.requirementId,
    effect: prepared.binding.effect,
    evidence: prepared.evidence,
    completeness: prepared.completeness,
    continuation: prepared.continuation,
  };
  const obligationDigest = canonicalDigest({
    domain: 'workflow-v3-call-obligation',
    version: 1,
    ...obligationBase,
  });
  const material = {
    version: 1 as const,
    authorityKind: PENDING_WORKFLOW_CALL_AUTHORITY_KIND,
    durability: 'process_checkpoint' as const,
    executionState: 'not_armed' as const,
    workflow: prepared.identity,
    call: {
      logicalCallId: prepared.logicalCallId,
      logicalCapabilityId: prepared.logicalCapabilityId,
      requirementId: prepared.requirementId,
      invocationPlanDigest: prepared.invocationPlanDigest,
      canonicalArgumentDigest: prepared.canonicalArgumentDigest,
      sourceArgumentDigest: prepared.sourceArgumentDigest,
      argsRedacted: true as const,
    },
    capability: prepared.binding,
    obligation: {
      ...obligationBase,
      obligationDigest,
    },
  };
  const authorityBindingDigest = canonicalDigest({
    domain: 'workflow-v3-call-authority-binding',
    ...material,
  });
  return freezeClone({ ...material, authorityBindingDigest }) as Readonly<WorkflowNodeCallAuthorityBindingV1>;
}

function rememberPreparedWorkflowNodeCall(prepared: PreparedWorkflowNodeCallV1): void {
  preparedWorkflowNodeCallAuthorities.set(
    prepared as object,
    workflowNodeCallAuthorityBindingOf(prepared),
  );
}

/** Mint a process-opaque workflow_v3 checkpoint for one authentic prepared
 * call. This never arms durable execution and never calls a capability port. */
export function bindPreparedWorkflowNodeCallAuthority(
  prepared: PreparedWorkflowNodeCallV1,
): BindPreparedWorkflowNodeCallAuthorityResult {
  const binding = prepared && typeof prepared === 'object'
    ? preparedWorkflowNodeCallAuthorities.get(prepared as object)
    : undefined;
  if (!binding) return { ok: false, reason: 'prepared_call_not_authentic' };
  const proof = Object.freeze<WorkflowNodeCallAuthorityProof>({
    kind: 'workflow_v3_call_authority_proof',
    authorityBindingDigest: binding.authorityBindingDigest,
    logicalCallId: binding.call.logicalCallId,
  });
  workflowNodeCallAuthorityProofs.set(proof as object, Object.freeze({ prepared, binding }));
  return { ok: true, binding, proof };
}

/** Narrow authenticity probe for the future durable authority adapter. It
 * intentionally reveals no argument bytes or invoke handle. */
export function workflowNodeCallAuthorityProofOwnsPrepared(
  proof: WorkflowNodeCallAuthorityProof,
  prepared: PreparedWorkflowNodeCallV1,
): boolean {
  const owned = proof && typeof proof === 'object'
    ? workflowNodeCallAuthorityProofs.get(proof as object)
    : undefined;
  return Boolean(
    owned
    && owned.prepared === prepared
    && owned.binding === preparedWorkflowNodeCallAuthorities.get(prepared as object)
    && proof.kind === 'workflow_v3_call_authority_proof'
    && proof.authorityBindingDigest === owned.binding.authorityBindingDigest
    && proof.logicalCallId === owned.binding.call.logicalCallId,
  );
}

function workflowV3ArmInputForPrepared(input: {
  sessionId: string;
  prepared: PreparedWorkflowNodeCallV1;
  authority: Readonly<WorkflowNodeCallAuthorityBindingV1>;
}): WorkflowV3AutoConsentArmInput {
  const prepared = input.prepared;
  return {
    sessionId: input.sessionId,
    workflowId: prepared.identity.workflowId,
    workflowRevision: prepared.identity.workflowRevision,
    workflowDigest: prepared.identity.workflowDigest,
    runId: prepared.identity.runId,
    runOccurrenceId: prepared.identity.runOccurrenceId,
    nodeId: prepared.identity.nodeId,
    nodeAttempt: prepared.identity.nodeAttempt,
    invocationPlanDigest: prepared.invocationPlanDigest,
    bindingSnapshotDigest: prepared.bindingSnapshotDigest,
    controlDigest: prepared.controlDigest,
    logicalCallId: prepared.logicalCallId,
    authorityBindingDigest: input.authority.authorityBindingDigest,
    requirementId: prepared.requirementId,
    logicalCapabilityId: prepared.logicalCapabilityId,
    canonicalArgumentDigest: prepared.canonicalArgumentDigest,
    sourceArgumentDigest: prepared.sourceArgumentDigest,
    obligationDigest: input.authority.obligation.obligationDigest,
    binding: {
      capabilityId: prepared.binding.capabilityId,
      manifestId: prepared.binding.manifestId,
      manifestDigest: prepared.binding.manifestDigest,
      operationId: prepared.binding.operationId,
      operationVersion: prepared.binding.operationVersion,
      schemaDigest: prepared.binding.schemaDigest,
      providerVersion: prepared.binding.providerVersion,
      liveFingerprint: prepared.binding.liveFingerprint,
      accountId: prepared.binding.accountId,
      effect: prepared.binding.effect as WorkflowV3AutoConsentArmInput['binding']['effect'],
      invokePortId: prepared.binding.invokePortId,
      argumentCompiler: { ...prepared.binding.argumentCompiler },
    },
  };
}

/** Project one authentic prepared v3 call through canonical Auto. The risk
 * evaluator reopens the current catalog/manifest/schema itself; callers get
 * an opaque authorization only for exact ordinary/reversible work. */
export function evaluatePreparedWorkflowNodeCallAutoConsent(input: {
  sessionId: string;
  prepared: PreparedWorkflowNodeCallV1;
  proof: WorkflowNodeCallAuthorityProof;
  inputSchema: unknown;
}): EvaluateWorkflowV3AutoConsentResult {
  if (!workflowNodeCallAuthorityProofOwnsPrepared(input.proof, input.prepared)) {
    return { status: 'conflict', reason: 'prepared call is not authentic' };
  }
  const authority = preparedWorkflowNodeCallAuthorities.get(input.prepared as object);
  if (
    !authority
    || authority.authorityBindingDigest !== input.proof.authorityBindingDigest
    || authority.call.logicalCallId !== input.proof.logicalCallId
  ) return { status: 'conflict', reason: 'prepared call lost its exact authority binding' };
  if (
    input.prepared.binding.effect === 'read'
    || input.prepared.binding.effect === 'compute'
    || input.prepared.binding.effect === 'host_only'
  ) return { status: 'conflict', reason: 'canonical Auto v3 evaluation requires a mutating call' };
  return evaluateWorkflowV3AutoConsent({
    authority: workflowV3ArmInputForPrepared({
      sessionId: input.sessionId,
      prepared: input.prepared,
      authority,
    }),
    inputSchema: input.inputSchema,
    args: input.prepared.canonicalArgs as Record<string, unknown>,
  });
}

export type ActivatePreparedWorkflowNodeCallResult =
  | {
      status: 'armed' | 'existing';
      activationId: string;
      authorityRootId: string;
      authorityBindingDigest: string;
      executable: true;
    }
  | {
      status: 'existing_closed';
      activationId: string;
      authorityRootId: string;
      authorityBindingDigest: string;
      executable: false;
    }
  | {
      status: 'blocked' | 'conflict' | 'missing' | 'storage_error';
      reason: string;
      executable: false;
    };

export interface WorkflowV3CallConsentRequestV1 {
  version: 1;
  sessionBound: true;
  tool: typeof WORKFLOW_V3_CALL_AUTHORITY_ENGINE_VERSION;
  args: Readonly<{
    authorityBindingDigest: string;
    operationId: string;
    accountId: string;
    effect: Exclude<WorkflowNodeInvocationEffectV1, 'read' | 'compute' | 'host_only'>;
    canonicalArgumentDigest: string;
  }>;
  resumeKey: string;
}

/** Derive the one and only registry payload accepted by the durable v3 arm.
 * The opaque proof check prevents a runner from manufacturing consent bytes
 * from a cloned/forged checkpoint. Host-only calls deliberately have no human
 * consent request; every mutating/admin effect does. */
export function workflowV3CallConsentRequest(input: {
  prepared: PreparedWorkflowNodeCallV1;
  proof: WorkflowNodeCallAuthorityProof;
}):
  | { ok: true; request: Readonly<WorkflowV3CallConsentRequestV1> }
  | { ok: false; reason: 'prepared_call_not_authentic' | 'workflow_v3_call_does_not_require_consent' } {
  if (!workflowNodeCallAuthorityProofOwnsPrepared(input.proof, input.prepared)) {
    return { ok: false, reason: 'prepared_call_not_authentic' };
  }
  const effect = input.prepared.binding.effect;
  if (effect === 'read' || effect === 'compute' || effect === 'host_only') {
    return { ok: false, reason: 'workflow_v3_call_does_not_require_consent' };
  }
  const args = Object.freeze({
    authorityBindingDigest: input.proof.authorityBindingDigest,
    operationId: input.prepared.binding.operationId,
    accountId: input.prepared.binding.accountId,
    effect,
    canonicalArgumentDigest: input.prepared.canonicalArgumentDigest,
  });
  return {
    ok: true,
    request: Object.freeze({
      version: 1 as const,
      sessionBound: true as const,
      tool: WORKFLOW_V3_CALL_AUTHORITY_ENGINE_VERSION,
      args,
      resumeKey: `workflow-v3:${input.prepared.logicalCallId}`,
    }),
  };
}

/** Convert exactly one authentic process checkpoint into its durable v3 root.
 * Structural clones fail before SQLite. Until a richer risk evaluator is
 * represented, every mutating effect requires one exact registry approval;
 * its CAS is owned by the same transaction as activation/binding/root. */
export function activatePreparedWorkflowNodeCall(input: {
  sessionId: string;
  prepared: PreparedWorkflowNodeCallV1;
  proof: WorkflowNodeCallAuthorityProof;
  oneShotActivationAuthorization?: OneShotActivationAuthorization;
  autoConsentAuthorization?: WorkflowV3AutoConsentAuthorizationV1;
}): ActivatePreparedWorkflowNodeCallResult {
  if (!workflowNodeCallAuthorityProofOwnsPrepared(input.proof, input.prepared)) {
    return { status: 'blocked', reason: 'prepared_call_not_authentic', executable: false };
  }
  const authority = preparedWorkflowNodeCallAuthorities.get(input.prepared as object);
  if (
    !authority
    || authority.authorityBindingDigest !== input.proof.authorityBindingDigest
    || authority.call.logicalCallId !== input.proof.logicalCallId
  ) return { status: 'blocked', reason: 'prepared_call_not_authentic', executable: false };
  const effect = input.prepared.binding.effect;
  if (effect === 'read' || effect === 'compute') {
    return { status: 'blocked', reason: 'workflow_v3_requires_non_read_checkpoint', executable: false };
  }
  if (
    (effect === 'local_write' || effect === 'external_write' || effect === 'admin')
    && !input.oneShotActivationAuthorization
    && !input.autoConsentAuthorization
  ) {
    return { status: 'blocked', reason: 'exact_one_shot_authorization_required', executable: false };
  }
  if (input.oneShotActivationAuthorization && input.autoConsentAuthorization) {
    return { status: 'blocked', reason: 'conflicting_exact_authorizations', executable: false };
  }
  const armed = armWorkflowV3CallAuthority({
    ...workflowV3ArmInputForPrepared({
      sessionId: input.sessionId,
      prepared: input.prepared,
      authority,
    }),
    ...(input.oneShotActivationAuthorization
      ? { oneShotActivationAuthorization: input.oneShotActivationAuthorization }
      : {}),
    ...(input.autoConsentAuthorization
      ? { autoConsentAuthorization: input.autoConsentAuthorization }
      : {}),
  });
  if ('ref' in armed) {
    return {
      status: armed.status,
      activationId: armed.ref.activationId,
      authorityRootId: armed.ref.authorityRootId,
      authorityBindingDigest: authority.authorityBindingDigest,
      executable: armed.status !== 'existing_closed',
    } as ActivatePreparedWorkflowNodeCallResult;
  }
  return {
    status: armed.status === 'closed' ? 'conflict' : armed.status,
    reason: armed.reason,
    executable: false,
  };
}

/** Public v3 execution adapter. It owns no alternate executor: all work enters
 * the existing one-call workflow kernel under the durable activation id. */
export async function executeActivatedWorkflowNodeCall(input: {
  activationId: string;
  invocationPlan: unknown;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ExecuteWorkflowCallKernelResult> {
  return executeWorkflowV3Call(input);
}

function logicalCallIdOf(input: {
  identity: WorkflowNodeReadExecutionIdentityV1;
  plan: WorkflowNodeInvocationPlanV1;
  canonicalArgumentDigest: string;
}): string {
  const digest = sha256(JSON.stringify({
    domain: 'workflow-node-logical-call',
    version: 1,
    workflowId: input.identity.workflowId,
    workflowRevision: input.identity.workflowRevision,
    workflowDigest: input.identity.workflowDigest,
    runId: input.identity.runId,
    runOccurrenceId: input.identity.runOccurrenceId,
    nodeId: input.identity.nodeId,
    nodeAttempt: input.identity.nodeAttempt,
    invocationPlanDigest: input.identity.invocationPlanDigest,
    bindingSnapshotDigest: input.identity.bindingSnapshotDigest,
    controlDigest: input.identity.controlDigest,
    requirementId: input.plan.requirementId,
    logicalCapabilityId: input.plan.logicalCapabilityId,
    capabilityId: input.plan.binding.capabilityId,
    manifestId: input.plan.binding.manifestId,
    operationId: input.plan.binding.operationId,
    canonicalArgumentDigest: input.canonicalArgumentDigest,
  }));
  return `workflow-logical:${digest}`;
}

function admissionBlock(value: WorkflowNodeInvocationBlock): PrepareWorkflowNodeReadResult {
  return block(value.code, value.message);
}

/**
 * Resolve and freeze one exact provider-neutral call at the last safe point
 * before the shared logical/physical kernel. This function performs no I/O
 * crossing and never calls the catalog entry's invoke function.
 */
function prepareWorkflowNodeCallBinding(
  input: {
    plan: unknown;
    identity: WorkflowNodeReadExecutionIdentityV1;
    arguments: WorkflowNodeArgumentRuntimeContext;
    cancelled?: boolean;
    signal?: AbortSignal;
    catalogFactory?: HostCapabilityCatalogFactory | null;
    observe?: (operationId: string, accountId: string) => IndependentCapabilityObservation | null;
    now?: number;
  },
): PrepareWorkflowNodeReadResult {
  if (input.cancelled || input.signal?.aborted) {
    return block('cancelled', 'Workflow node was cancelled before capability admission.');
  }
  if (!exactExecutionIdentity(input.identity)) {
    return block('execution_identity_invalid', 'Workflow/revision/run/occurrence/node/attempt authority identity is incomplete.');
  }
  if (
    !input.plan
    || typeof input.plan !== 'object'
    || (input.plan as { bindingDigest?: unknown }).bindingDigest !== input.identity.invocationPlanDigest
  ) {
    return block(
      'invocation_plan_digest_mismatch',
      'The workflow authority identity does not bind the exact invocation plan revision.',
    );
  }

  const resolved = resolveWorkflowNodeInvocation({
    plan: input.plan,
    identity: input.identity,
    cancelled: input.cancelled || input.signal?.aborted,
    catalogFactory: input.catalogFactory,
    observe: input.observe,
    now: input.now,
  });
  if (!resolved.ok) return admissionBlock(resolved.block);

  if (
    resolved.resolved.plan.continuation.kind === 'cursor'
    && input.arguments.continuationCursor !== undefined
  ) {
    return block(
      'host_continuation_cursor_supplied',
      'The cursor is host-owned and may only come from the preceding settled page.',
    );
  }

  const compiled = compileWorkflowNodeInvocationArguments(resolved.resolved.plan, input.arguments);
  if (!compiled.ok) {
    if (compiled.reason === 'missing_source') {
      return block('argument_source_missing', 'A required typed argument source is unavailable.', compiled.argument);
    }
    if (compiled.reason === 'type_mismatch') {
      return block('argument_source_type_mismatch', 'A typed argument source has the wrong runtime type.', compiled.argument);
    }
    if (compiled.reason === 'too_large') {
      return block('canonical_arguments_too_large', sealedCallTooLargeMessage(input.arguments));
    }
    if (compiled.reason === 'invalid_runtime_value') {
      return block('canonical_arguments_invalid', 'A typed argument source is not exact plain JSON.');
    }
    return block('invocation_plan_invalid', 'The invocation plan became invalid during argument compilation.');
  }

  let canonicalArgs: Readonly<Record<string, unknown>>;
  let canonicalBytes: string;
  try {
    canonicalBytes = closedCanonicalJson(compiled.args, SEALED_CALL_CANONICAL_LIMITS);
    const canonical = JSON.parse(canonicalBytes) as CanonicalJson;
    if (!canonical || Array.isArray(canonical) || typeof canonical !== 'object') {
      return block('canonical_arguments_invalid', 'Compiled arguments are not a canonical JSON object.');
    }
    canonicalArgs = freezeCanonical(canonical) as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (isClosedCanonicalJsonLimitError(error)) {
      return block('canonical_arguments_too_large', sealedCallTooLargeMessage(compiled.args));
    }
    return block(
      'canonical_arguments_invalid',
      error instanceof Error ? error.message : 'Compiled arguments are not canonical JSON.',
    );
  }

  const canonicalArgumentDigest = canonicalArgumentDigestOf(canonicalArgs as Record<string, unknown>);
  const plan = resolved.resolved.plan;
  const identity = freezeClone({ ...input.identity }) as WorkflowNodeReadExecutionIdentityV1;
  const prepared: PreparedWorkflowNodeReadV1 = Object.freeze({
    version: 1 as const,
    identity,
    requirementId: plan.requirementId,
    logicalCapabilityId: plan.logicalCapabilityId,
    logicalCallId: logicalCallIdOf({ identity, plan, canonicalArgumentDigest }),
    operationId: plan.binding.operationId,
    capabilityId: plan.binding.capabilityId,
    manifestId: plan.binding.manifestId,
    invocationPlanDigest: identity.invocationPlanDigest,
    bindingSnapshotDigest: identity.bindingSnapshotDigest,
    controlDigest: identity.controlDigest,
    canonicalArgs,
    canonicalArgumentDigest,
    sourceArgumentDigest: compiled.argumentDigest,
    binding: freezeClone(plan.binding),
    liveIdentity: freezeClone(resolved.resolved.liveIdentity),
    observation: freezeClone(resolved.resolved.observation),
    evidence: freezeClone(plan.evidence),
    completeness: freezeClone(plan.completeness),
    continuation: freezeClone(plan.continuation),
  });
  rememberPreparedWorkflowNodeCall(prepared);
  return { ok: true, prepared, resolved: resolved.resolved };
}

function workflowNodeCallAuthorityRequirement(
  effect: Exclude<WorkflowNodeInvocationEffectV1, 'read' | 'compute'>,
): Readonly<WorkflowNodeCallAuthorityRequirementV1> {
  const mutating = workflowNodeInvocationEffectIsMutation(effect);
  const recovery = Object.freeze({
    notStarted: 'resume' as const,
    possiblyStarted: mutating
      ? 'reconcile_never_blind_retry' as const
      : 'hold_no_redispatch' as const,
    settled: 'replay_exact_settlement' as const,
  });
  return Object.freeze({
    version: 1 as const,
    authorityKind: PENDING_WORKFLOW_CALL_AUTHORITY_KIND,
    effect,
    mutating,
    consent: effect === 'admin'
      ? 'exact_user_grant' as const
      : mutating
        ? 'evaluate_exact_call' as const
        : 'none' as const,
    recovery,
  });
}

/**
 * Resolve and seal an exact workflow call without arming authority or crossing
 * a capability port. Non-read calls deliberately stop in a typed preparation
 * checkpoint. The checkpoint is exact and opaque, but deliberately
 * non-executable until a durable activation/consent/recovery adapter is wired;
 * callers must not project it as a user-facing failure or success.
 */
export function prepareWorkflowNodeCall(
  input: Parameters<typeof prepareWorkflowNodeCallBinding>[0],
): PrepareWorkflowNodeCallResult {
  const candidate = prepareWorkflowNodeCallBinding(input);
  if (!candidate.ok) return { kind: 'blocked', preparation: candidate };
  const effect = candidate.resolved.plan.binding.effect;
  if (effect === 'read') {
    return {
      kind: 'ready',
      effect,
      prepared: candidate.prepared,
      resolved: candidate.resolved,
    };
  }
  // Compute is refused by resolveWorkflowNodeInvocation until a provider-
  // neutral purity contract exists, so it cannot reach this branch.
  if (effect === 'compute') {
    return {
      kind: 'blocked',
      preparation: block(
        'compute_contract_unrepresented',
        'The current manifest has no provider-neutral purity contract that distinguishes attested compute from opaque execution.',
      ) as Extract<PrepareWorkflowNodeReadResult, { ok: false }>,
    };
  }
  const authority = bindPreparedWorkflowNodeCallAuthority(candidate.prepared);
  if (!authority.ok) {
    return {
      kind: 'blocked',
      preparation: block(
        'workflow_activation_lineage_unrepresented',
        'The prepared workflow call lost its opaque authority provenance.',
      ) as Extract<PrepareWorkflowNodeReadResult, { ok: false }>,
    };
  }
  return {
    kind: 'authority_checkpoint',
    effect,
    prepared: candidate.prepared,
    resolved: candidate.resolved,
    requirement: workflowNodeCallAuthorityRequirement(effect),
    authority: authority.binding,
    proof: authority.proof,
    executable: false,
  };
}

/** Existing read-only public contract. Read inputs retain the same prepared
 * object and discriminated result bytes as before the generic seam existed. */
export function prepareWorkflowNodeRead(
  input: Parameters<typeof prepareWorkflowNodeCallBinding>[0],
): PrepareWorkflowNodeReadResult {
  const candidate = prepareWorkflowNodeCallBinding(input);
  if (!candidate.ok) return candidate;
  if (candidate.resolved.plan.binding.effect !== 'read') {
    return block(
      'invocation_plan_invalid',
      'Workflow read preparation requires an exact read invocation plan.',
    );
  }
  return candidate;
}

type ExecuteWorkflowNodeReadInput = Parameters<typeof prepareWorkflowNodeRead>[0] & {
  sessionId: string;
  /** Optional canonical approval-registry grant. The authority layer consumes
   * it atomically with the durable workflow activation. */
  oneShotActivationAuthorization?: OneShotActivationAuthorization;
};

export async function executeWorkflowNodeRead(
  input: ExecuteWorkflowNodeReadInput,
): Promise<ExecuteWorkflowNodeReadResult> {
  const prepared = prepareWorkflowNodeRead(input);
  if (!prepared.ok) return prepared;
  return executePreparedWorkflowNodeCall(input, prepared);
}

/** Shared executor seam after provider-neutral preparation. The only installed
 * authority adapter remains read-only; non-read preparation can never reach
 * this function until workflow_v3_call is added. */
async function executePreparedWorkflowNodeCall(
  input: ExecuteWorkflowNodeReadInput,
  prepared: Extract<PrepareWorkflowNodeReadResult, { ok: true }>,
): Promise<ExecuteWorkflowNodeReadResult> {
  if (input.signal?.aborted) {
    return {
      ok: false,
      status: 'blocked',
      phase: 'authority',
      provenNoCrossing: true,
      block: { code: 'workflow_call_blocked', message: 'Workflow node was cancelled before authority arming.' },
      prepared: prepared.prepared,
    };
  }
  if (prepared.resolved.plan.continuation.kind === 'cursor') {
    const armed = armWorkflowPaginatedReadAuthority({
      sessionId: input.sessionId,
      workflowId: prepared.prepared.identity.workflowId,
      workflowRevision: prepared.prepared.identity.workflowRevision,
      workflowDigest: prepared.prepared.identity.workflowDigest,
      runId: prepared.prepared.identity.runId,
      runOccurrenceId: prepared.prepared.identity.runOccurrenceId,
      nodeId: prepared.prepared.identity.nodeId,
      nodeAttempt: prepared.prepared.identity.nodeAttempt,
      invocationPlan: prepared.resolved.plan,
      bindingSnapshotDigest: prepared.prepared.bindingSnapshotDigest,
      controlDigest: prepared.prepared.controlDigest,
      ...(input.oneShotActivationAuthorization
        ? { oneShotActivationAuthorization: input.oneShotActivationAuthorization }
        : {}),
    });
    if ('reason' in armed) {
      return {
        ok: false,
        status: 'blocked',
        phase: 'authority',
        provenNoCrossing: true,
        block: {
          code: 'workflow_call_authority_arm_failed',
          message: armed.reason,
        },
        prepared: prepared.prepared,
      };
    }
    const paginated = await executeWorkflowPaginatedRead({
      activationId: armed.ref.activationId,
      invocationPlan: prepared.resolved.plan,
      baseArgs: prepared.prepared.canonicalArgs as Record<string, unknown>,
      signal: input.signal,
    });
    if (paginated.status === 'partial') {
      return {
        ok: false,
        status: 'partial',
        phase: 'kernel',
        provenNoCrossing: false,
        block: {
          code: 'workflow_collection_partial',
          message: paginated.reason,
        },
        prepared: prepared.prepared,
        activationId: paginated.activationId,
        aggregate: paginated.aggregate,
        result: paginated.aggregate,
      };
    }
    if (paginated.status === 'blocked' || paginated.status === 'failed') {
      return {
        ok: false,
        status: paginated.status,
        phase: 'kernel',
        provenNoCrossing: paginated.zeroBody,
        block: {
          code: paginated.status === 'failed' ? 'workflow_call_failed' : 'workflow_call_blocked',
          message: paginated.reason,
        },
        prepared: prepared.prepared,
        activationId: paginated.activationId,
        ...(paginated.aggregate ? { aggregate: paginated.aggregate, result: paginated.aggregate } : {}),
      };
    }
    const aggregate = paginated.aggregate;
    if (!aggregate) {
      return {
        ok: false,
        status: 'incomplete',
        phase: 'evidence',
        provenNoCrossing: false,
        block: {
          code: 'workflow_evidence_incomplete',
          message: 'Paginated read returned no canonical aggregate receipt.',
        },
        prepared: prepared.prepared,
        activationId: paginated.activationId,
        evidenceReasons: ['aggregate_receipt_missing'],
      };
    }
    if (
      aggregate.outcome !== 'complete'
      || aggregate.coverageState !== 'complete'
      || aggregate.finalExhaustedTruth !== 'true'
    ) {
      return {
        ok: false,
        status: 'incomplete',
        phase: 'evidence',
        provenNoCrossing: false,
        block: {
          code: 'workflow_evidence_incomplete',
          message: 'Paginated read closed without exact exhaustive aggregate truth.',
        },
        prepared: prepared.prepared,
        activationId: paginated.activationId,
        aggregate,
        result: aggregate,
        evidenceReasons: ['aggregate_exhaustion_not_proven'],
      };
    }
    return {
      ok: true,
      status: paginated.status,
      executionKind: 'paginated_read',
      prepared: prepared.prepared,
      activationId: paginated.activationId,
      authorityRootId: aggregate.authorityRootId,
      aggregate,
      result: aggregate,
    };
  }
  const armed = armWorkflowReadOnlyCallAuthority({
    sessionId: input.sessionId,
    workflowId: prepared.prepared.identity.workflowId,
    workflowRevision: prepared.prepared.identity.workflowRevision,
    workflowDigest: prepared.prepared.identity.workflowDigest,
    runId: prepared.prepared.identity.runId,
    runOccurrenceId: prepared.prepared.identity.runOccurrenceId,
    nodeId: prepared.prepared.identity.nodeId,
    nodeAttempt: prepared.prepared.identity.nodeAttempt,
    invocationPlanDigest: prepared.prepared.invocationPlanDigest,
    bindingSnapshotDigest: prepared.prepared.bindingSnapshotDigest,
    controlDigest: prepared.prepared.controlDigest,
    logicalCallId: prepared.prepared.logicalCallId,
    ...(input.oneShotActivationAuthorization
      ? { oneShotActivationAuthorization: input.oneShotActivationAuthorization }
      : {}),
  });
  if ('reason' in armed) {
    return {
      ok: false,
      status: 'blocked',
      phase: 'authority',
      provenNoCrossing: true,
      block: {
        code: 'workflow_call_authority_arm_failed',
        message: armed.reason,
      },
      prepared: prepared.prepared,
    };
  }

  const kernel = await executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: prepared.resolved.plan,
    args: prepared.prepared.canonicalArgs as Record<string, unknown>,
    signal: input.signal,
  });
  if ('reason' in kernel) {
    return {
      ok: false,
      status: kernel.status,
      phase: 'kernel',
      provenNoCrossing: kernel.zeroBody,
      block: {
        code: kernel.status === 'failed' ? 'workflow_call_failed' : 'workflow_call_blocked',
        message: kernel.reason,
      },
      prepared: prepared.prepared,
      activationId: kernel.activationId,
    };
  }

  const evidenceView = projectProviderResultEvidenceView(kernel.result);
  const evidence = verifyWorkflowNodeInvocationEvidence(
    evidenceView.kind === 'provider_payload' ? evidenceView.payload : undefined,
    prepared.resolved.plan,
  );
  if (!evidence.complete) {
    return {
      ok: false,
      status: 'incomplete',
      phase: 'evidence',
      provenNoCrossing: false,
      block: {
        code: 'workflow_evidence_incomplete',
        message: `Workflow read settled, but its exact evidence/completeness contract failed: ${evidence.reasons.join(', ')}.`,
      },
      prepared: prepared.prepared,
      activationId: kernel.activationId,
      result: kernel.result,
      evidenceReasons: [...evidence.reasons],
    };
  }

  return {
    ok: true,
    status: kernel.status,
    executionKind: 'single_read',
    prepared: prepared.prepared,
    activationId: kernel.activationId,
    authorityRootId: kernel.authorityRootId,
    logicalCallId: kernel.logicalCallId,
    ...('physicalDispatchId' in kernel ? { physicalDispatchId: kernel.physicalDispatchId } : {}),
    ...('resultHandleId' in kernel ? { resultHandleId: kernel.resultHandleId } : {}),
    // The step receives the SAME value its evidence was just verified against:
    // the provider payload (sealed-invoke and MCP envelopes unwrapped). The
    // durable result handle still retains the raw envelope. Handing the step
    // the envelope made every declared output contract unsatisfiable for a
    // reviewed-CLI read — evidence passed on `stdout` while the contract
    // failed "missing required output key stdout" on {result, complete}
    // (Friday dashboard, 2026-09-02).
    result: evidenceView.kind === 'provider_payload' ? evidenceView.payload : kernel.result,
  };
}
