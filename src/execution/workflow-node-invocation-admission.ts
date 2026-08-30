import { createHash } from 'node:crypto';

import {
  parseWorkflowNodeInvocationPlan,
  workflowNodeReviewedLiteralDigest,
  type WorkflowNodeArgumentSourceV1,
  type WorkflowNodeCapabilityFingerprintV1,
  type WorkflowNodeInvocationPlanV1,
  type WorkflowNodeInvocationValueTypeV1,
} from '../memory/workflow-node-invocation-plan.js';
import {
  canonicalCatalogIdentityOf,
  peekHostCapabilityCatalogFactory,
  type CanonicalCatalogIdentityV1,
  type HostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from '../runtime/harness/host-capability-catalog-factory.js';
import {
  independentlyObserveCapability,
  observationIsFresh,
  type IndependentCapabilityObservation,
} from '../runtime/harness/independent-capability-observation.js';
import { capabilityManifestDigest, currentCapabilityManifest } from '../runtime/harness/capability-manifest.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import { workflowCapabilityDigest } from './workflow-capability-digest.js';

export type WorkflowNodeInvocationBlockCode =
  | 'cancelled'
  | 'invocation_identity_invalid'
  | 'invocation_plan_invalid'
  | 'invocation_plan_digest_mismatch'
  | 'live_catalog_unavailable'
  | 'capability_missing'
  | 'capability_ambiguous'
  | 'successor_not_recorded'
  | 'successor_lineage_mismatch'
  | 'operation_drift'
  | 'schema_drift'
  | 'account_drift'
  | 'effect_drift'
  | 'port_drift'
  | 'manifest_drift'
  | 'live_observation_missing'
  | 'live_observation_stale'
  | 'live_observation_drift'
  | 'compute_contract_unrepresented'
  | 'continuation_runtime_unrepresented'
  | 'workflow_activation_lineage_unrepresented';

export interface WorkflowNodeInvocationBlock {
  code: WorkflowNodeInvocationBlockCode;
  message: string;
}

export interface WorkflowNodeInvocationIdentityV1 {
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  runId: string;
  runOccurrenceId: string;
  nodeId: string;
  nodeAttempt: number;
  invocationPlanDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
}

export interface ResolvedWorkflowNodeInvocationV1 {
  plan: WorkflowNodeInvocationPlanV1;
  identity: WorkflowNodeInvocationIdentityV1;
  capability: RegisteredHostCapability;
  liveIdentity: CanonicalCatalogIdentityV1;
  observation: IndependentCapabilityObservation;
  /** Describes why the one effective `plan.binding` is trusted. It never
   * selects between two dispatch candidates. */
  bindingRole: 'approved_binding' | 'approved_successor';
}

export type ResolveWorkflowNodeInvocationResult =
  | { ok: true; resolved: ResolvedWorkflowNodeInvocationV1 }
  | { ok: false; block: WorkflowNodeInvocationBlock };

export type AdmitWorkflowNodeInvocationResult =
  | {
    status: 'blocked';
    block: WorkflowNodeInvocationBlock;
    resolved?: ResolvedWorkflowNodeInvocationV1;
  };

export interface WorkflowNodeArgumentRuntimeContext {
  workflowInputs: Record<string, unknown>;
  stepOutputs: Record<string, unknown>;
  partitionItem?: unknown;
  /** Host-owned overlay from the prior settled page. Never sourced from the
   * workflow definition, its inputs, or the caller. */
  continuationCursor?: unknown;
}

export type CompileWorkflowNodeArgumentsResult =
  | { ok: true; args: Record<string, unknown>; argumentDigest: string }
  | {
      ok: false;
      reason: 'missing_source' | 'type_mismatch' | 'invalid_plan' | 'invalid_runtime_value';
      argument?: string;
    };

export interface WorkflowNodeEvidenceVerdict {
  complete: boolean;
  reasons: string[];
  continuationRequired: boolean;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const EXACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function block(code: WorkflowNodeInvocationBlockCode, message: string): ResolveWorkflowNodeInvocationResult {
  return { ok: false, block: { code, message } };
}

function pathValue(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current = value;
  for (const token of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    const prototype = Object.getPrototypeOf(current);
    if (
      (Array.isArray(current) && prototype !== Array.prototype)
      || (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null)
    ) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, token);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
    current = descriptor.value;
  }
  return current;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined;
}

function nonEmpty(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value) && typeof value === 'object' && Object.keys(value as object).length > 0;
}

function valueFitsType(value: unknown, expected: WorkflowNodeInvocationValueTypeV1): boolean {
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  return typeof value === expected;
}

function resolveSource(
  source: WorkflowNodeArgumentSourceV1,
  context: WorkflowNodeArgumentRuntimeContext,
): unknown {
  if (source.kind === 'workflow_input') return ownValue(context.workflowInputs, source.key);
  if (source.kind === 'upstream_output') {
    return pathValue(ownValue(context.stepOutputs, source.stepId), source.path);
  }
  if (source.kind === 'partition_item') return pathValue(context.partitionItem, source.path);
  if (source.kind === 'continuation_cursor') return context.continuationCursor;
  if (
    source.valueDigest !== workflowNodeReviewedLiteralDigest(source.value)
    || !SHA256_RE.test(source.reviewDigest)
  ) return undefined;
  return structuredClone(source.value);
}

/** Compile arguments only at admission. The returned bytes are intentionally
 * not written back into WorkflowDefinition or WorkflowNodeInvocationPlan. */
export function compileWorkflowNodeInvocationArguments(
  value: unknown,
  context: WorkflowNodeArgumentRuntimeContext,
): CompileWorkflowNodeArgumentsResult {
  const parsed = parseWorkflowNodeInvocationPlan(value);
  if (!parsed.ok) return { ok: false, reason: 'invalid_plan' };
  const args: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(parsed.plan.arguments)
    .sort(([left], [right]) => left.localeCompare(right))) {
    const resolved = resolveSource(binding.source, context);
    if (resolved === undefined || resolved === null) {
      if (binding.required) return { ok: false, reason: 'missing_source', argument: name };
      continue;
    }
    if (!valueFitsType(resolved, binding.type)) {
      return { ok: false, reason: 'type_mismatch', argument: name };
    }
    args[name] = resolved;
  }
  try {
    return {
      ok: true,
      args,
      argumentDigest: sha256(closedCanonicalJson({
        domain: 'workflow-node-provider-arguments',
        version: 1,
        args,
      }, {
        maxDepth: 32,
        maxNodes: 20_000,
        // This pre-kernel digest boundary is bounded independently. The
        // executor applies the stricter 64KB sealed-call ceiling and returns
        // canonical_arguments_too_large before authority arming.
        maxStringBytes: 256_000,
        maxTotalBytes: 256_000,
      })),
    };
  } catch {
    return { ok: false, reason: 'invalid_runtime_value' };
  }
}

export function verifyWorkflowNodeInvocationEvidence(
  value: unknown,
  rawPlan: unknown,
): WorkflowNodeEvidenceVerdict {
  const parsed = parseWorkflowNodeInvocationPlan(rawPlan);
  if (!parsed.ok) {
    return { complete: false, reasons: ['invocation_plan_invalid'], continuationRequired: false };
  }
  const { evidence, completeness, continuation } = parsed.plan;
  const reasons: string[] = [];
  for (const path of evidence.requiredPaths) {
    if (pathValue(value, path) === undefined) reasons.push(`required_path_missing:${path}`);
  }
  for (const path of evidence.nonEmptyPaths) {
    if (!nonEmpty(pathValue(value, path))) reasons.push(`non_empty_path_failed:${path}`);
  }
  for (const [path, minimum] of Object.entries(evidence.minItems)) {
    const found = pathValue(value, path);
    if (!Array.isArray(found) || found.length < minimum) reasons.push(`min_items_failed:${path}`);
  }
  for (const path of completeness.evidencePaths) {
    if (!nonEmpty(pathValue(value, path))) reasons.push(`completeness_evidence_missing:${path}`);
  }
  if (completeness.kind === 'finite_exhaustive' && pathValue(value, completeness.exhaustedPath) !== true) {
    reasons.push(`exhaustion_not_proven:${completeness.exhaustedPath}`);
  }
  if (completeness.kind === 'per_run_boundary' && pathValue(value, completeness.boundaryPath) !== true) {
    reasons.push(`run_boundary_not_proven:${completeness.boundaryPath}`);
  }
  const continuationRequired = continuation.kind === 'cursor'
    && pathValue(value, continuation.exhaustedPath) !== true;
  if (continuationRequired) reasons.push('continuation_required');
  return { complete: reasons.length === 0, reasons, continuationRequired };
}

function identityBlock(
  expected: WorkflowNodeCapabilityFingerprintV1,
  actual: CanonicalCatalogIdentityV1,
): WorkflowNodeInvocationBlock | null {
  if (
    actual.capabilityId !== expected.capabilityId
    || actual.manifestId !== expected.manifestId
  ) return { code: 'manifest_drift', message: 'Live manifest/capability identity differs from the plan.' };
  if (actual.operationId !== expected.operationId || actual.schemaVersion !== expected.operationVersion) {
    return { code: 'operation_drift', message: 'Live operation identity/version differs from the plan.' };
  }
  if (
    workflowCapabilityDigest(actual.schemaDigest) !== expected.schemaDigest
    || actual.providerVersion !== expected.providerVersion
    || workflowCapabilityDigest(actual.liveFingerprint) !== expected.liveFingerprint
  ) return { code: 'schema_drift', message: 'Live schema/provider fingerprint differs from the plan.' };
  if (actual.account !== expected.accountId) {
    return { code: 'account_drift', message: 'Live account identity differs from the plan.' };
  }
  if (actual.effect !== expected.effect) {
    return { code: 'effect_drift', message: 'Live effect differs from the plan.' };
  }
  if (
    actual.invokePortId !== expected.invokePortId
    || actual.argumentCompiler.id !== expected.argumentCompiler.id
    || actual.argumentCompiler.version !== expected.argumentCompiler.version
  ) return { code: 'port_drift', message: 'Live invoke/compiler identity differs from the plan.' };
  if (actual.manifestDigest !== expected.manifestDigest) {
    return { code: 'manifest_drift', message: 'Live manifest digest differs from the plan.' };
  }
  return null;
}

function successorCandidates(
  entries: readonly RegisteredHostCapability[],
  plan: WorkflowNodeInvocationPlanV1,
): RegisteredHostCapability[] {
  const predecessorIds = new Set([
    plan.logicalCapabilityId,
    plan.binding.capabilityId,
    plan.binding.manifestId,
  ]);
  return entries.filter((entry) => {
    const lineage = entry.delegatedFrom ?? entry.manifest?.delegatedFrom;
    return typeof lineage === 'string' && predecessorIds.has(lineage);
  });
}

function exactIdentity(identity: WorkflowNodeInvocationIdentityV1): boolean {
  return EXACT_ID_RE.test(identity.workflowId)
    && Number.isInteger(identity.workflowRevision)
    && identity.workflowRevision > 0
    && SHA256_RE.test(identity.workflowDigest)
    && EXACT_ID_RE.test(identity.runId)
    && EXACT_ID_RE.test(identity.runOccurrenceId)
    && EXACT_ID_RE.test(identity.nodeId)
    && Number.isInteger(identity.nodeAttempt)
    && identity.nodeAttempt > 0
    && SHA256_RE.test(identity.invocationPlanDigest)
    && SHA256_RE.test(identity.bindingSnapshotDigest)
    && SHA256_RE.test(identity.controlDigest);
}

export function resolveWorkflowNodeInvocation(
  input: {
    plan: unknown;
    identity: WorkflowNodeInvocationIdentityV1;
    cancelled?: boolean;
    catalogFactory?: HostCapabilityCatalogFactory | null;
    observe?: (operationId: string, accountId: string) => IndependentCapabilityObservation | null;
    now?: number;
  },
): ResolveWorkflowNodeInvocationResult {
  if (input.cancelled) return block('cancelled', 'Workflow node was cancelled before capability admission.');
  if (!exactIdentity(input.identity)) {
    return block('invocation_identity_invalid', 'Workflow revision/run/node/attempt identity is incomplete.');
  }
  const parsed = parseWorkflowNodeInvocationPlan(input.plan);
  if (!parsed.ok) return block('invocation_plan_invalid', parsed.errors.join(' '));
  const plan = parsed.plan;
  if (plan.bindingDigest !== input.identity.invocationPlanDigest) {
    return block(
      'invocation_plan_digest_mismatch',
      'Workflow activation identity does not bind this exact invocation plan.',
    );
  }
  if (plan.binding.effect === 'compute') {
    return block(
      'compute_contract_unrepresented',
      'The current manifest has no provider-neutral purity contract that distinguishes attested compute from opaque execution.',
    );
  }
  // Read and mutation effects follow the same exact catalog/manifest/live-
  // observation resolution. Resolution is deliberately not execution
  // authority: the executor exposes non-read results only as typed
  // preparation until workflow_v3_call exists.
  if (
    plan.continuation.kind === 'cursor'
    && plan.completeness.kind !== 'finite_exhaustive'
  ) {
    return block(
      'continuation_runtime_unrepresented',
      'Cursor continuation requires an exact finite-exhaustive completeness contract.',
    );
  }
  const factory = input.catalogFactory ?? peekHostCapabilityCatalogFactory();
  if (!factory) return block('live_catalog_unavailable', 'No live host capability catalog is installed.');
  const entries = factory.snapshot();
  const exact = entries.filter((entry) => entry.capabilityId === plan.binding.capabilityId);
  let selected: RegisteredHostCapability;
  if (exact.length > 1) {
    return block('capability_ambiguous', 'The exact capability identity appears more than once in the live catalog.');
  }
  if (exact.length === 1) {
    selected = exact[0];
  } else {
    const candidates = successorCandidates(entries, plan);
    if (candidates.length === 0) return block('capability_missing', 'The exact capability and any attested successor are absent.');
    if (candidates.length > 1) {
      return block('capability_ambiguous', 'More than one live capability claims successor lineage; no candidate was selected.');
    }
    return block(
      'successor_not_recorded',
      `A unique successor "${candidates[0].capabilityId}" exists, but the effective binding in this plan revision still names "${plan.binding.capabilityId}".`,
    );
  }
  const expected = plan.binding;
  if (plan.predecessor) {
    const lineage = selected.delegatedFrom ?? selected.manifest?.delegatedFrom;
    if (
      lineage !== plan.predecessor.capabilityId
      && lineage !== plan.predecessor.manifestId
      && lineage !== plan.logicalCapabilityId
    ) return block('successor_lineage_mismatch', 'Effective binding does not attest its recorded predecessor lineage.');
  }
  const liveIdentity = canonicalCatalogIdentityOf(selected);
  if (!liveIdentity || !selected.manifest || !currentCapabilityManifest(selected.manifest)) {
    return block('manifest_drift', 'The selected live catalog entry has no current trusted manifest.');
  }
  if (capabilityManifestDigest(selected.manifest) !== liveIdentity.manifestDigest) {
    return block('manifest_drift', 'The selected live manifest digest does not recompute.');
  }
  const drift = identityBlock(expected, liveIdentity);
  if (drift) return { ok: false, block: drift };

  const observe = input.observe ?? independentlyObserveCapability;
  const observation = observe(expected.operationId, expected.accountId);
  if (!observation || observation.origin !== 'independent') {
    return block('live_observation_missing', 'Independent crossing-time capability observation is unavailable.');
  }
  if (!observationIsFresh(observation, input.now ?? Date.now())) {
    return block('live_observation_stale', 'Independent capability observation is stale.');
  }
  if (
    observation.operationId !== expected.operationId
    || observation.operationVersion !== expected.operationVersion
    || observation.providerVersion !== expected.providerVersion
    || workflowCapabilityDigest(observation.definitionFingerprint) !== expected.liveFingerprint
    || observation.accountId !== expected.accountId
  ) return block('live_observation_drift', 'Independent capability observation differs from the exact plan.');

  return {
    ok: true,
    resolved: {
      plan,
      identity: { ...input.identity },
      capability: selected,
      liveIdentity,
      observation,
      bindingRole: plan.predecessor ? 'approved_successor' : 'approved_binding',
    },
  };
}

/**
 * Resolution-only compatibility seam. The shared kernel now has a workflow
 * authority kind, but this older API carries no durable session, approved
 * activation lineage, or exact logical-call identity. Invoking from here would
 * bypass that root, so callers must use executeWorkflowNodeRead instead.
 */
export function admitWorkflowNodeInvocation(
  input: Parameters<typeof resolveWorkflowNodeInvocation>[0],
): AdmitWorkflowNodeInvocationResult {
  const resolved = resolveWorkflowNodeInvocation(input);
  if (!resolved.ok) return { status: 'blocked', block: resolved.block };
  return {
    status: 'blocked',
    resolved: resolved.resolved,
    block: {
      code: 'workflow_activation_lineage_unrepresented',
      message: 'This admission call has no durable workflow session or approved activation lineage for the shared workflow_v1_read_only root.',
    },
  };
}
