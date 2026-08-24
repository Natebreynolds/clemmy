import {
  canonicalEntityJson,
} from '../execution/canonical-entity-resolution.js';
import {
  canonicalEntityWorkflowLineageReceiptDigest,
  durableCanonicalEntityWorkflowLineageCompositor,
} from './canonical-entity-workflow-lineage-store.js';
export { canonicalEntityWorkflowLineageReceiptDigest } from './canonical-entity-workflow-lineage-store.js';
import type { WorkflowTerminalOutcome } from '../execution/workflow-terminal-outcome.js';
import {
  projectCanonicalEntityStoreToWorkspace,
  type ProjectCanonicalEntityStoreToWorkspaceInputV1,
  type ProjectCanonicalEntityStoreToWorkspaceResult,
} from './canonical-entity-workspace-store-projection.js';
import type { CanonicalWorkspaceProjectionIdentityV1 } from './canonical-entity-workspace-projection.js';
import {
  getWorkflowSurfaceBinding,
  listWorkflowSurfaceBindingsForWorkflow,
} from './workflow-surface-binding-store.js';
import type { WorkflowSurfaceBindingV1 } from './workflow-surface-binding.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/\-]{0,255}$/;
const DIGEST = /^[a-f0-9]{64}$/;

type StoredBinding = WorkflowSurfaceBindingV1 & { digest: string };

/**
 * A runner-owned pointer to a separate durable lineage receipt. The pointer
 * carries no entity rows, provider payload, schedule, or executable command.
 * Presence is not authority: the exact receipt and current binding are
 * revalidated before the canonical projector is called.
 */
export interface CanonicalEntityWorkflowProjectionClaimV1 {
  version: 1;
  receiptId: string;
  receiptDigest: string;
  identity: CanonicalWorkspaceProjectionIdentityV1;
  bindingDigest: string;
}

export type CanonicalEntityWorkflowProjectionRequestV1 = Omit<
  ProjectCanonicalEntityStoreToWorkspaceInputV1,
  'scheduleFacts' | 'entityDb' | 'workspaceDb'
>;

export interface CanonicalEntityWorkflowLineageReceiptV1 {
  version: 1;
  receiptId: string;
  request: CanonicalEntityWorkflowProjectionRequestV1;
  receiptDigest: string;
}

export type CanonicalEntityWorkflowLineageResolutionV1 =
  | { status: 'ready'; receipt: CanonicalEntityWorkflowLineageReceiptV1 }
  | { status: 'blocked'; kind: 'missing' | 'unavailable' | 'ambiguous' | 'stale' };

/**
 * Trusted compositor boundary. Its job is to load an already-durable exact
 * entity-store/workflow lineage receipt. It may not infer lineage from output,
 * prose, tool names, catalog order, or a Space binding.
 */
export interface CanonicalEntityWorkflowLineageCompositorV1 {
  resolve(
    claim: CanonicalEntityWorkflowProjectionClaimV1,
  ): CanonicalEntityWorkflowLineageResolutionV1;
}

/** Explicit blocker retained for tests and dependency-injected deployments. */
export const unavailableCanonicalEntityWorkflowLineageCompositor: CanonicalEntityWorkflowLineageCompositorV1 = {
  resolve: () => ({ status: 'blocked', kind: 'unavailable' }),
};

export interface FinalizeCanonicalEntityWorkflowCompletionInputV1 {
  version: 1;
  runId: string;
  workflowId: string;
  status?: string;
  terminalOutcome?: WorkflowTerminalOutcome;
  finishedAt?: string;
  needsAttention?: boolean;
  claim?: unknown;
}

export type CanonicalEntityWorkflowFinalizationBlockCode =
  | 'completion_identity_invalid'
  | 'run_not_cleanly_completed'
  | 'canonical_entity_lineage_unrepresented'
  | 'canonical_entity_lineage_claim_invalid'
  | 'workspace_binding_missing'
  | 'workspace_binding_retired'
  | 'workspace_binding_drifted'
  | 'canonical_entity_lineage_missing'
  | 'canonical_entity_lineage_unavailable'
  | 'canonical_entity_lineage_ambiguous'
  | 'canonical_entity_lineage_stale'
  | 'canonical_entity_lineage_receipt_invalid'
  | 'workflow_completion_receipt_missing'
  | 'canonical_entity_projection_invalid'
  | 'canonical_entity_projection_identity_mismatch'
  | 'canonical_entity_projection_stale_source'
  | 'canonical_entity_projection_corrupt_source'
  | 'canonical_entity_projection_conflict';

export type FinalizeCanonicalEntityWorkflowCompletionResultV1 =
  | {
      status: 'not_applicable';
      code: 'no_workspace_binding';
      runId: string;
      workflowId: string;
    }
  | {
      status: 'blocked';
      code: CanonicalEntityWorkflowFinalizationBlockCode;
      runId: string;
      workflowId: string;
      bindingId?: string;
    }
  | {
      status: 'projected' | 'replayed';
      runId: string;
      workflowId: string;
      bindingId: string;
      workspaceId: string;
      datasetId: string;
      headDigest: string;
      projectionDigest: string;
      coverage: {
        status: 'complete' | 'partial' | 'unknown';
        complete: boolean;
        observedPartitions: number;
        exhaustion: 'exhausted' | 'not_exhausted' | 'unknown';
        reasons: readonly string[];
      };
      records: {
        observationsCommitted: number;
        canonicalRecordsCreated: number;
        duplicateObservations: number;
      };
    };

export interface CanonicalEntityWorkflowFinalizerDependencies {
  listBindingsForWorkflow(workflowId: string): readonly StoredBinding[];
  getBinding(bindingId: string): StoredBinding | null;
  compositor: CanonicalEntityWorkflowLineageCompositorV1;
  project(
    request: CanonicalEntityWorkflowProjectionRequestV1,
  ): ProjectCanonicalEntityStoreToWorkspaceResult;
}

const productionDependencies: CanonicalEntityWorkflowFinalizerDependencies = {
  listBindingsForWorkflow: (workflowId) => listWorkflowSurfaceBindingsForWorkflow(workflowId),
  getBinding: (bindingId) => getWorkflowSurfaceBinding(bindingId),
  compositor: durableCanonicalEntityWorkflowLineageCompositor,
  project: (request) => projectCanonicalEntityStoreToWorkspace(request),
};

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function exactIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function validIdentity(value: unknown): value is CanonicalWorkspaceProjectionIdentityV1 {
  if (!exactKeys(value, [
    'version', 'bindingId', 'workflowId', 'workspaceId', 'runId', 'datasetId',
  ])) return false;
  return value.version === 1
    && identifier(value.bindingId)
    && identifier(value.workflowId)
    && identifier(value.workspaceId)
    && identifier(value.runId)
    && identifier(value.datasetId);
}

function parseClaim(value: unknown): CanonicalEntityWorkflowProjectionClaimV1 | null {
  if (!exactKeys(value, [
    'version', 'receiptId', 'receiptDigest', 'identity', 'bindingDigest',
  ])) return null;
  if (value.version !== 1
    || !identifier(value.receiptId)
    || !digest(value.receiptDigest)
    || !validIdentity(value.identity)
    || !digest(value.bindingDigest)) return null;
  return value as unknown as CanonicalEntityWorkflowProjectionClaimV1;
}

function block(
  input: Pick<FinalizeCanonicalEntityWorkflowCompletionInputV1, 'runId' | 'workflowId'>,
  code: CanonicalEntityWorkflowFinalizationBlockCode,
  bindingId?: string,
): FinalizeCanonicalEntityWorkflowCompletionResultV1 {
  return {
    status: 'blocked',
    code,
    runId: input.runId,
    workflowId: input.workflowId,
    ...(bindingId ? { bindingId } : {}),
  };
}

function projectionFailureCode(
  kind: Extract<ProjectCanonicalEntityStoreToWorkspaceResult, { ok: false }>['kind'],
): CanonicalEntityWorkflowFinalizationBlockCode {
  switch (kind) {
    case 'invalid': return 'canonical_entity_projection_invalid';
    case 'identity_mismatch': return 'canonical_entity_projection_identity_mismatch';
    case 'stale_source': return 'canonical_entity_projection_stale_source';
    case 'corrupt_source': return 'canonical_entity_projection_corrupt_source';
    case 'conflict': return 'canonical_entity_projection_conflict';
  }
}

function validResolvedReceipt(
  receipt: CanonicalEntityWorkflowLineageReceiptV1,
  claim: CanonicalEntityWorkflowProjectionClaimV1,
): receipt is CanonicalEntityWorkflowLineageReceiptV1 {
  if (!exactKeys(receipt, ['version', 'receiptId', 'request', 'receiptDigest'])
    || receipt.version !== 1
    || receipt.receiptId !== claim.receiptId
    || receipt.receiptDigest !== claim.receiptDigest
    || !digest(receipt.receiptDigest)
    || !exactKeys(receipt.request, [
      'version', 'identity', 'expectedBindingDigest', 'expectedDatasetAuthority',
      'runReceipts', 'partitionReceipts', 'batchLineage', 'coveragePosition',
    ], ['expectedHeadDigest'])
    || receipt.request.version !== 1
    || !validIdentity(receipt.request.identity)
    || canonicalEntityJson(receipt.request.identity) !== canonicalEntityJson(claim.identity)
    || receipt.request.expectedBindingDigest !== claim.bindingDigest) return false;
  try {
    return canonicalEntityWorkflowLineageReceiptDigest({
      version: 1,
      receiptId: receipt.receiptId,
      request: receipt.request,
    }) === receipt.receiptDigest;
  } catch {
    return false;
  }
}

function hasExactCompletedReceipt(
  request: CanonicalEntityWorkflowProjectionRequestV1,
  identity: CanonicalWorkspaceProjectionIdentityV1,
  finishedAt: string,
): boolean {
  if (!Array.isArray(request.runReceipts)) return false;
  return request.runReceipts.some((receipt) => {
    try {
      return exactKeys(receipt, [
        'receiptId', 'sequence', 'ordinal', 'at', 'identity', 'status',
      ])
        && receipt.status === 'completed'
        && receipt.at === finishedAt
        && canonicalEntityJson(receipt.identity) === canonicalEntityJson(identity);
    } catch {
      return false;
    }
  });
}

/**
 * Finalize only a clean runner-owned completion through exact durable lineage.
 * The function intentionally accepts no step output or provider response, and
 * it reconstructs the projector request without scheduleFacts or DB handles.
 */
export function finalizeCanonicalEntityWorkflowCompletion(
  input: FinalizeCanonicalEntityWorkflowCompletionInputV1,
  dependencies: Partial<CanonicalEntityWorkflowFinalizerDependencies> = {},
): FinalizeCanonicalEntityWorkflowCompletionResultV1 {
  const deps = { ...productionDependencies, ...dependencies };
  if (input.version !== 1 || !identifier(input.runId) || !identifier(input.workflowId)) {
    return block(input, 'completion_identity_invalid');
  }

  let bindings: readonly StoredBinding[];
  try {
    bindings = deps.listBindingsForWorkflow(input.workflowId);
  } catch {
    return block(input, 'workspace_binding_missing');
  }
  const visibleBindings = bindings.filter((binding) => binding.state !== 'retired');
  const claim = parseClaim(input.claim);
  if (input.claim === undefined && visibleBindings.length === 0) {
    return {
      status: 'not_applicable',
      code: 'no_workspace_binding',
      runId: input.runId,
      workflowId: input.workflowId,
    };
  }
  if (input.status !== 'completed'
    || input.terminalOutcome !== 'succeeded'
    || input.needsAttention === true
    || !exactIso(input.finishedAt)) {
    return block(input, 'run_not_cleanly_completed', claim?.identity.bindingId);
  }
  if (input.claim === undefined) {
    return block(input, 'canonical_entity_lineage_unrepresented');
  }
  if (!claim) return block(input, 'canonical_entity_lineage_claim_invalid');
  const { identity } = claim;
  if (identity.runId !== input.runId || identity.workflowId !== input.workflowId) {
    return block(input, 'canonical_entity_lineage_claim_invalid', identity.bindingId);
  }

  let binding: StoredBinding | null;
  try {
    binding = deps.getBinding(identity.bindingId);
  } catch {
    binding = null;
  }
  if (!binding
    || binding.workflowId !== identity.workflowId
    || binding.workspaceId !== identity.workspaceId) {
    return block(input, 'workspace_binding_missing', identity.bindingId);
  }
  if (binding.state === 'retired') {
    return block(input, 'workspace_binding_retired', identity.bindingId);
  }
  if (binding.digest !== claim.bindingDigest) {
    return block(input, 'workspace_binding_drifted', identity.bindingId);
  }

  let resolved: CanonicalEntityWorkflowLineageResolutionV1;
  try {
    resolved = deps.compositor.resolve(claim);
  } catch {
    resolved = { status: 'blocked', kind: 'unavailable' };
  }
  if (resolved.status === 'blocked') {
    return block(input, `canonical_entity_lineage_${resolved.kind}`, identity.bindingId);
  }
  if (!validResolvedReceipt(resolved.receipt, claim)) {
    return block(input, 'canonical_entity_lineage_receipt_invalid', identity.bindingId);
  }
  if (!hasExactCompletedReceipt(resolved.receipt.request, identity, input.finishedAt!)) {
    return block(input, 'workflow_completion_receipt_missing', identity.bindingId);
  }

  const source = resolved.receipt.request;
  const request: CanonicalEntityWorkflowProjectionRequestV1 = {
    version: 1,
    identity: source.identity,
    expectedBindingDigest: source.expectedBindingDigest,
    expectedDatasetAuthority: source.expectedDatasetAuthority,
    runReceipts: source.runReceipts,
    partitionReceipts: source.partitionReceipts,
    batchLineage: source.batchLineage,
    coveragePosition: source.coveragePosition,
    ...(source.expectedHeadDigest !== undefined
      ? { expectedHeadDigest: source.expectedHeadDigest }
      : {}),
  };
  const projected = deps.project(request);
  if (!projected.ok) {
    return block(input, projectionFailureCode(projected.kind), identity.bindingId);
  }
  const coverage = projected.head.coverage;
  return {
    status: projected.inserted ? 'projected' : 'replayed',
    runId: input.runId,
    workflowId: input.workflowId,
    bindingId: identity.bindingId,
    workspaceId: identity.workspaceId,
    datasetId: identity.datasetId,
    headDigest: projected.headDigest,
    projectionDigest: projected.projectionDigest,
    coverage: {
      status: coverage.status,
      complete: coverage.status === 'complete',
      observedPartitions: coverage.observedPartitions,
      exhaustion: coverage.exhaustion,
      reasons: [...coverage.reasons],
    },
    records: {
      observationsCommitted: projected.head.records.observationsCommitted,
      canonicalRecordsCreated: projected.head.records.canonicalRecordsCreated,
      duplicateObservations: projected.head.records.duplicateObservations,
    },
  };
}
