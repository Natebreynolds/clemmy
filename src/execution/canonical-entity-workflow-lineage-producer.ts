import {
  canonicalEntityJson,
  canonicalEntitySha256,
  createEntityObservation,
  type EntityObservationInput,
  type EntityResolutionPolicy,
} from './canonical-entity-resolution.js';
import {
  appendCanonicalCoveragePage,
  commitCanonicalEntityBatch,
  createCanonicalDataset,
  getCanonicalDataset,
  summarizeStoredDatasetCoverage,
  type DurableCanonicalResolutionBatchReceiptV1,
} from './canonical-entity-store.js';
import {
  parseWorkflowNodeInvocationPlan,
  type WorkflowNodeInvocationPlanV1,
} from '../memory/workflow-node-invocation-plan.js';
import {
  parseWorkflowCanonicalEntityResultProjection,
  type WorkflowCanonicalEntityFieldProjectionV1,
  type WorkflowCanonicalEntityNormalizerV1,
  type WorkflowCanonicalEntityResultProjection,
} from '../memory/workflow-result-projection-contract.js';
import {
  redeemVerifiedClosedWorkflowReadResult,
  redeemVerifiedFailedWorkflowReadResult,
  type VerifiedClosedWorkflowReadResultV1,
  type VerifiedFailedWorkflowReadResultV1,
  type VerifiedWorkflowReadPageV1,
  type WorkflowReadResultLineageV1,
} from './workflow-read-result-redemption.js';
import {
  listWorkflowSurfaceBindingsForWorkflow,
} from '../spaces/workflow-surface-binding-store.js';
import { projectProviderResultEvidenceView } from '../runtime/harness/result-facts.js';
import {
  canonicalEntityWorkspaceSelectionDigest,
  parseCanonicalEntityWorkspaceBindingApproval,
  type CanonicalEntityWorkspaceBindingApprovalV1,
} from '../spaces/canonical-entity-workspace-binding-contract.js';
import { spaceStore } from '../spaces/store.js';
import {
  loadCanonicalEntityWorkflowLineageReceipt,
  putCanonicalEntityWorkflowLineageReceipt,
} from '../spaces/canonical-entity-workflow-lineage-store.js';
import type {
  CanonicalEntityWorkflowFailedPartitionAuthorityV1,
  CanonicalEntityWorkflowProjectionClaim,
  CanonicalEntityWorkflowProjectionRequestV1,
} from '../spaces/canonical-entity-workflow-finalizer.js';
import { canonicalEntityWorkflowFailedPartitionAuthorityDigest } from '../spaces/canonical-entity-workflow-finalizer.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface CanonicalEntityWorkflowResultRootV1 {
  version: 1;
  executionKind: 'single_read' | 'paginated_read';
  activationId: string;
  lineage: WorkflowReadResultLineageV1;
  workspaceBinding?: CanonicalEntityWorkspaceBindingApprovalV1;
}

export interface CanonicalEntityWorkflowLineageProducerHooksV1 {
  afterDataset?: () => void;
  afterBatch?: (pageOrdinal: number) => void;
  afterCoverage?: (pageOrdinal: number) => void;
  beforeReceipt?: () => void;
  afterReceipt?: () => void;
}

export type ProduceCanonicalEntityWorkflowLineageResultV1 =
  | { status: 'not_applicable' }
  | {
      status: 'ready' | 'replayed';
      claim: CanonicalEntityWorkflowProjectionClaim;
      finishedAt: string;
      datasetId: string;
      observationCount: number;
      pageCount: number;
    }
  | {
      status: 'blocked';
      code:
        | 'result_projection_invalid'
        | 'workflow_result_authority_unavailable'
        | 'workspace_binding_missing'
        | 'workspace_binding_ambiguous'
        | 'workspace_binding_drifted'
        | 'result_projection_bounds_exceeded'
        | 'result_records_invalid'
        | 'canonical_dataset_conflict'
        | 'canonical_batch_conflict'
        | 'canonical_coverage_conflict'
        | 'canonical_coverage_incomplete'
        | 'lineage_receipt_conflict';
      reason: string;
    };

interface PreparedPage {
  page: VerifiedWorkflowReadPageV1;
  observations: EntityObservationInput[];
  observationIds: string[];
  coverageItemIds: string[];
}

interface PathNode {
  terminal: boolean;
  children: Map<string | number, PathNode>;
}

function block(
  code: Extract<ProduceCanonicalEntityWorkflowLineageResultV1, { status: 'blocked' }>['code'],
  reason: string,
): ProduceCanonicalEntityWorkflowLineageResultV1 {
  return { status: 'blocked', code, reason: reason.replace(/\s+/g, ' ').trim().slice(0, 500) };
}

function exactIso(value: string): boolean {
  return ISO_RE.test(value) && new Date(value).toISOString() === value;
}

function pathSegments(path: string): Array<string | number> | null {
  const segments: Array<string | number> = [];
  let cursor = 0;
  while (cursor < path.length) {
    const name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(path.slice(cursor));
    if (!name) return null;
    segments.push(name[0]);
    cursor += name[0].length;
    while (path[cursor] === '[') {
      const index = /^\[(0|[1-9]\d*)\]/.exec(path.slice(cursor));
      if (!index) return null;
      segments.push(Number(index[1]));
      cursor += index[0].length;
    }
    if (cursor === path.length) break;
    if (path[cursor] !== '.') return null;
    cursor += 1;
  }
  return segments;
}

function valueAtPath(value: unknown, path: string): unknown {
  const segments = pathSegments(path);
  if (!segments) return undefined;
  let current = value;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) return undefined;
      current = current[segment];
    } else {
      if (!current || typeof current !== 'object' || Array.isArray(current)
        || !Object.hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function addPath(root: PathNode, path: string): void {
  let node = root;
  for (const segment of pathSegments(path) ?? []) {
    let child = node.children.get(segment);
    if (!child) {
      child = { terminal: false, children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
  }
  node.terminal = true;
}

function shapeCovered(value: unknown, node: PathNode): boolean {
  if (node.terminal) return true;
  if (Array.isArray(value)) {
    return value.every((entry, index) => {
      const child = node.children.get(index);
      return Boolean(child && shapeCovered(entry, child));
    });
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).every(([key, entry]) => {
      const child = node.children.get(key);
      return Boolean(child && shapeCovered(entry, child));
    });
  }
  return node.children.size === 0;
}

function recordShape(projection: WorkflowCanonicalEntityResultProjection): PathNode {
  const root: PathNode = { terminal: false, children: new Map() };
  for (const mapping of projection.fields) addPath(root, mapping.recordPath);
  addPath(root, projection.sourceRecord.idPath);
  if (projection.sourceRecord.revisionPath) addPath(root, projection.sourceRecord.revisionPath);
  if (projection.sourceRecord.observedAt.kind === 'record_path') {
    addPath(root, projection.sourceRecord.observedAt.path);
  }
  return root;
}

function typeMatches(value: unknown, mapping: WorkflowCanonicalEntityFieldProjectionV1): boolean {
  switch (mapping.type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'timestamp': return typeof value === 'string' && exactIso(value);
    case 'object': return Boolean(value && typeof value === 'object' && !Array.isArray(value));
    case 'array': return Array.isArray(value);
  }
}

function sourceIdentity(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.normalize('NFC');
    return normalized.length > 0 && normalized === normalized.trim() && normalized.length <= 1_024
      ? normalized
      : null;
  }
  return typeof value === 'number' && Number.isFinite(value)
    ? canonicalEntityJson(value)
    : null;
}

function normalizeIdentityValue(
  value: unknown,
  normalizers: readonly WorkflowCanonicalEntityNormalizerV1[],
): string | null {
  let current = typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? canonicalEntityJson(value)
      : null;
  if (current === null) return null;
  const requested = new Set(normalizers);
  if (requested.has('unicode_nfkc')) current = current.normalize('NFKC');
  if (requested.has('trim')) current = current.trim();
  if (requested.has('case_fold')) current = current.toLowerCase();
  if (requested.has('numeric')) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(current)) return null;
    const numeric = Number(current);
    if (!Number.isFinite(numeric)) return null;
    current = canonicalEntityJson(numeric);
  }
  return current.length > 0 ? current : null;
}

function prepareObservation(input: {
  projection: WorkflowCanonicalEntityResultProjection;
  record: Record<string, unknown>;
  page: VerifiedWorkflowReadPageV1;
  activationDigest: string;
}): EntityObservationInput | null {
  const recordId = sourceIdentity(valueAtPath(input.record, input.projection.sourceRecord.idPath));
  if (!recordId) return null;
  const revisionValue = input.projection.sourceRecord.revisionPath
    ? valueAtPath(input.record, input.projection.sourceRecord.revisionPath)
    : undefined;
  const revision = revisionValue === undefined ? undefined : sourceIdentity(revisionValue);
  if (revisionValue !== undefined && !revision) return null;
  const observedAt = input.projection.sourceRecord.observedAt.kind === 'page_settled_at'
    ? input.page.settledAt
    : valueAtPath(input.record, input.projection.sourceRecord.observedAt.path);
  if (typeof observedAt !== 'string' || !exactIso(observedAt)) return null;
  const sourceId = `workflow-result:${canonicalEntitySha256({
    version: 1,
    activationDigest: input.activationDigest,
    projectionDigest: input.projection.projectionDigest,
  })}`;
  const fields: Record<string, EntityObservationInput['fields'][string]> = {};
  const values = new Map<string, unknown>();
  for (const mapping of input.projection.fields) {
    const value = valueAtPath(input.record, mapping.recordPath);
    if (value === undefined) {
      if (mapping.required) return null;
      continue;
    }
    if (!typeMatches(value, mapping)) return null;
    try { canonicalEntityJson(value); } catch { return null; }
    values.set(mapping.field, value);
    fields[mapping.field] = {
      value,
      provenance: { sourceId, recordId, path: mapping.recordPath },
      confidence: mapping.confidence,
      observedAt,
    };
  }
  const exactIdentifiers: Array<{ namespace: string; value: string }> = [];
  const compoundSignals: NonNullable<EntityObservationInput['compoundSignals']>[number][] = [];
  for (const rule of input.projection.identityRules) {
    const normalized: string[] = [];
    for (const field of rule.fields) {
      if (!values.has(field)) {
        normalized.length = 0;
        break;
      }
      const value = normalizeIdentityValue(values.get(field), rule.normalizers);
      if (value === null) return null;
      normalized.push(value);
    }
    if (normalized.length === rule.fields.length) {
      if (!('kind' in rule)) {
        exactIdentifiers.push({
          namespace: rule.exactIdentifierNamespace,
          value: canonicalEntitySha256({ version: 1, ruleId: rule.ruleId, values: normalized }),
        });
      } else if (rule.kind === 'exact_identifier') {
        exactIdentifiers.push({
          namespace: rule.namespace,
          value: canonicalEntitySha256({ version: 2, ruleId: rule.ruleId, values: normalized }),
        });
      } else {
        compoundSignals.push({
          name: rule.signalName,
          components: Object.fromEntries(rule.fields.map((field, index) => [
            field,
            normalized[index]!,
          ])),
        });
      }
    }
  }
  if (exactIdentifiers.length === 0 && compoundSignals.length === 0) return null;
  return {
    entityKind: input.projection.entityKind,
    origin: { sourceId, recordId, ...(revision ? { revision } : {}) },
    observedAt,
    fields,
    exactIdentifiers,
    compoundSignals,
  };
}

function preparePages(input: {
  redeemed: VerifiedClosedWorkflowReadResultV1 | VerifiedFailedWorkflowReadResultV1;
  projection: WorkflowCanonicalEntityResultProjection;
}): PreparedPage[] | null {
  const shape = recordShape(input.projection);
  let totalBytes = 0;
  let totalRecords = 0;
  const pages: PreparedPage[] = [];
  for (const page of input.redeemed.pages) {
    totalBytes += page.rawByteCount;
    if (page.rawByteCount > input.projection.bounds.maxPageBytes
      || totalBytes > input.projection.bounds.maxTotalBytes) return null;
    const evidenceView = projectProviderResultEvidenceView(page.rawPayload);
    if (evidenceView.kind !== 'provider_payload') return null;
    const records = valueAtPath(evidenceView.payload, input.projection.recordsPath);
    if (!Array.isArray(records)
      || records.length !== page.itemCount
      || records.length > input.projection.bounds.maxRecordsPerPage) return null;
    totalRecords += records.length;
    if (totalRecords > input.projection.bounds.maxRecords) return null;
    const observations: EntityObservationInput[] = [];
    const observationIds: string[] = [];
    const coverageItemIds: string[] = [];
    for (const [recordOrdinal, recordValue] of records.entries()) {
      if (!recordValue || typeof recordValue !== 'object' || Array.isArray(recordValue)) return null;
      let recordBytes: number;
      try { recordBytes = Buffer.byteLength(canonicalEntityJson(recordValue), 'utf8'); } catch { return null; }
      if (recordBytes > input.projection.bounds.maxRecordBytes
        || !shapeCovered(recordValue, shape)) return null;
      const observation = prepareObservation({
        projection: input.projection,
        record: recordValue as Record<string, unknown>,
        page,
        activationDigest: input.redeemed.activationDigest,
      });
      if (!observation) return null;
      observations.push(observation);
      observationIds.push(createEntityObservation(observation).observationId);
      coverageItemIds.push(`source-occurrence:${canonicalEntitySha256({
        version: 1,
        pageReceiptDigest: page.pageReceiptDigest,
        recordOrdinal,
      })}`);
    }
    pages.push({ page, observations, observationIds, coverageItemIds });
  }
  return pages;
}

function claimFrom(input: {
  receiptId: string;
  receiptDigest: string;
  identity: CanonicalEntityWorkflowProjectionClaim['identity'];
  bindingDigest: string;
  terminalOutcomeAuthority?: CanonicalEntityWorkflowFailedPartitionAuthorityV1;
}): CanonicalEntityWorkflowProjectionClaim {
  return input.terminalOutcomeAuthority
    ? {
        version: 2,
        receiptId: input.receiptId,
        receiptDigest: input.receiptDigest,
        identity: input.identity,
        bindingDigest: input.bindingDigest,
        terminalOutcomeAuthorityDigest: canonicalEntityWorkflowFailedPartitionAuthorityDigest(
          input.terminalOutcomeAuthority,
        ),
      }
    : { version: 1, ...input };
}

function terminalAt(request: CanonicalEntityWorkflowProjectionRequestV1): string | null {
  const receipt = request.runReceipts.find((candidate) => (
    candidate.status === 'completed' || candidate.status === 'failed'
  ));
  return receipt && exactIso(receipt.at) ? receipt.at : null;
}

export function produceCanonicalEntityWorkflowLineage(input: {
  version: 1;
  root: CanonicalEntityWorkflowResultRootV1;
  invocationPlan: unknown;
  startedAt: string;
  proposedFinishedAt: string;
  hooks?: CanonicalEntityWorkflowLineageProducerHooksV1;
}): ProduceCanonicalEntityWorkflowLineageResultV1 {
  const parsedPlan = parseWorkflowNodeInvocationPlan(input.invocationPlan);
  if (!parsedPlan.ok) return block('result_projection_invalid', parsedPlan.errors.join(' '));
  const plan: WorkflowNodeInvocationPlanV1 = parsedPlan.plan;
  if (!plan.resultProjection) return { status: 'not_applicable' };
  const parsedProjection = parseWorkflowCanonicalEntityResultProjection(plan.resultProjection);
  if (!parsedProjection.ok) return block('result_projection_invalid', parsedProjection.errors.join(' '));
  const projection = parsedProjection.contract;
  const parsedWorkspaceBinding = parseCanonicalEntityWorkspaceBindingApproval(input.root.workspaceBinding);
  if (
    input.version !== 1
    || input.root.version !== 1
    || input.root.lineage.invocationPlanDigest !== plan.bindingDigest
    || projection.bounds.maxPages !== (plan.continuation.kind === 'cursor' ? plan.continuation.maxPages : 1)
    || !exactIso(input.startedAt)
    || !exactIso(input.proposedFinishedAt)
    || !parsedWorkspaceBinding.ok
  ) return block('result_projection_invalid', 'producer input does not bind the exact plan, continuation, or run timestamps');
  const reviewedWorkspaceBinding = parsedWorkspaceBinding.approval;
  if (reviewedWorkspaceBinding.binding.workflowId !== input.root.lineage.workflowId) {
    return block('workspace_binding_drifted', 'reviewed Workspace binding names a different workflow');
  }
  const bindings = listWorkflowSurfaceBindingsForWorkflow(input.root.lineage.workflowId)
    .filter((binding) => binding.state !== 'retired');
  if (bindings.length === 0) return block('workspace_binding_missing', 'dataset projection requires one exact non-retired Workspace binding');
  if (bindings.length !== 1) return block('workspace_binding_ambiguous', 'dataset projection found more than one non-retired Workspace binding');
  const binding = bindings[0]!;
  const { digest: _bindingDigest, ...bindingContract } = binding;
  const workspace = spaceStore.get(reviewedWorkspaceBinding.selection.workspaceId);
  if (
    binding.bindingId !== reviewedWorkspaceBinding.binding.bindingId
    || binding.digest !== reviewedWorkspaceBinding.bindingDigest
    || canonicalEntityJson(bindingContract) !== canonicalEntityJson(reviewedWorkspaceBinding.binding)
    || !workspace
    || workspace.version !== reviewedWorkspaceBinding.selection.expectedWorkspaceRevision
    || canonicalEntityWorkspaceSelectionDigest(workspace)
      !== reviewedWorkspaceBinding.selection.expectedWorkspaceDigest
  ) return block('workspace_binding_drifted', 'current Workspace or binding bytes drifted from the reviewed approval');
  const closed = redeemVerifiedClosedWorkflowReadResult({
    executionKind: input.root.executionKind,
    activationId: input.root.activationId,
    lineage: input.root.lineage,
  });
  let redeemed: VerifiedClosedWorkflowReadResultV1 | VerifiedFailedWorkflowReadResultV1;
  if (closed.ok) {
    redeemed = closed.value;
  } else if (projection.version === 2
    && projection.partition.outcomeAuthority.acceptedTerminalStates.some((state) => state === 'failed')) {
    const failed = redeemVerifiedFailedWorkflowReadResult({
      executionKind: input.root.executionKind,
      activationId: input.root.activationId,
      lineage: input.root.lineage,
    });
    if (!failed.ok) return block('workflow_result_authority_unavailable', failed.reason);
    redeemed = failed.value;
  } else {
    return block('workflow_result_authority_unavailable', closed.reason);
  }
  const failedOutcome = redeemed.complete === false;
  if (
    redeemed.pages.length < 1
    || redeemed.pages.length > projection.bounds.maxPages
    || (failedOutcome
      ? redeemed.pages.some((page) => page.exhausted)
      : redeemed.pages.at(-1)?.exhausted !== true
        || redeemed.pages.slice(0, -1).some((page) => page.exhausted))
  ) return block('result_projection_bounds_exceeded', 'closed read page count or exhaustion contradicts the reviewed projection');
  const pages = preparePages({ redeemed, projection });
  if (!pages) return block('result_records_invalid', 'retained page records violate the reviewed path, closed shape, type, identity, or byte bounds');
  const observationCount = pages.reduce((total, page) => total + page.observations.length, 0);
  const datasetId = `canonical-dataset:${canonicalEntitySha256({
    version: 1,
    workflowId: input.root.lineage.workflowId,
    runId: input.root.lineage.runId,
    activationDigest: redeemed.activationDigest,
    projectionDigest: projection.projectionDigest,
  })}`;
  const partitionId = `workflow-run:${canonicalEntitySha256({
    version: 1,
    workflowId: input.root.lineage.workflowId,
    runId: input.root.lineage.runId,
    activationDigest: redeemed.activationDigest,
  })}`;
  const terminalOutcomeAuthority: CanonicalEntityWorkflowFailedPartitionAuthorityV1 | undefined = redeemed.complete === false
    ? {
        version: 1,
        kind: 'failed_paginated_read',
        projectionDigest: projection.projectionDigest,
        executionKind: 'paginated_read',
        activationId: redeemed.activationId,
        lineage: { ...input.root.lineage },
        aggregateReceiptId: redeemed.failure.aggregateReceiptId,
        aggregateReceiptDigest: redeemed.failure.aggregateReceiptDigest,
        failureReason: redeemed.failure.kind,
        partitionId,
        failureRef: `workflow-read-failure:${redeemed.failure.aggregateReceiptDigest}`,
      }
    : undefined;
  const created = createCanonicalDataset({
    datasetId,
    universe: { kind: 'closed', partitionIds: [partitionId] },
    denominator: projection.partition.denominator === 'unknown'
      ? { kind: 'unknown' }
      : { kind: 'exact', total: observationCount },
    createdAt: redeemed.pages[0]!.settledAt,
  });
  if (!created.ok) return block('canonical_dataset_conflict', created.message);
  input.hooks?.afterDataset?.();

  const batchReceiptsById = new Map<string, DurableCanonicalResolutionBatchReceiptV1>();
  for (const [pageIndex, prepared] of pages.entries()) {
    const current = getCanonicalDataset(datasetId);
    if (!current) return block('canonical_dataset_conflict', 'canonical dataset disappeared before batch commit');
    const batch = commitCanonicalEntityBatch({
      datasetId,
      expectedResolutionRevision: current.resolutionRevision,
      expectedResolutionDigest: current.resolutionDigest,
      observations: prepared.observations,
      policy: projection.resolutionPolicy as EntityResolutionPolicy,
      committedAt: prepared.page.settledAt,
    });
    if (!batch.ok) return block('canonical_batch_conflict', batch.message);
    const retainedBatch = batchReceiptsById.get(batch.value.batchId);
    if (retainedBatch && canonicalEntityJson(retainedBatch) !== canonicalEntityJson(batch.value)) {
      return block('canonical_batch_conflict', 'one semantic batch identity resolved to contradictory retained receipts');
    }
    if (!retainedBatch) batchReceiptsById.set(batch.value.batchId, batch.value);
    input.hooks?.afterBatch?.(pageIndex);
  }

  for (const [pageIndex, prepared] of pages.entries()) {
    const current = getCanonicalDataset(datasetId);
    if (!current) return block('canonical_dataset_conflict', 'canonical dataset disappeared before coverage commit');
    const last = pageIndex === pages.length - 1;
    const coverage = appendCanonicalCoveragePage({
      datasetId,
      expectedCoverageRevision: current.coverageRevision,
      expectedCoverageDigest: current.coverageDigest,
      page: {
        partitionId,
        inputCursor: prepared.page.inputCursorDigest
          ? `cursor:${prepared.page.inputCursorDigest}`
          : null,
        outputCursor: !failedOutcome && last ? null : prepared.page.nextCursorDigest
          ? `cursor:${prepared.page.nextCursorDigest}`
          : null,
        exhaustion: !failedOutcome && last ? 'exhausted' : 'more',
        denominator: projection.partition.denominator === 'unknown'
          ? { kind: 'unknown' }
          : { kind: 'exact', total: observationCount },
        itemIds: prepared.coverageItemIds,
      },
      committedAt: prepared.page.settledAt,
    });
    if (!coverage.ok || coverage.value.cursorCycleDetected) {
      return block('canonical_coverage_conflict', coverage.ok
        ? 'canonical coverage detected a cursor cycle'
        : coverage.message);
    }
    input.hooks?.afterCoverage?.(pageIndex);
  }

  const dataset = getCanonicalDataset(datasetId);
  const coverage = summarizeStoredDatasetCoverage(datasetId);
  if (!dataset || !coverage
    || coverage.cursorCycleDetected
    || coverage.observed !== observationCount
    || (projection.partition.denominator === 'settled_record_count'
      && (coverage.status !== 'complete' || coverage.exhaustion !== 'exhausted'))
    || (projection.partition.denominator === 'unknown'
      && (coverage.status === 'complete' || coverage.denominator.kind !== 'unknown'))) {
    return block('canonical_coverage_incomplete', 'canonical coverage contradicts the reviewed denominator or settled result truth');
  }
  const identity = {
    version: 1 as const,
    bindingId: binding.bindingId,
    workflowId: input.root.lineage.workflowId,
    workspaceId: binding.workspaceId,
    runId: input.root.lineage.runId,
    datasetId,
  };
  const receiptId = `canonical-workflow-lineage:${canonicalEntitySha256({
    version: 1,
    identity,
    bindingDigest: binding.digest,
    projectionDigest: projection.projectionDigest,
    activationDigest: redeemed.activationDigest,
    aggregateReceiptDigest: redeemed.aggregateReceiptDigest ?? null,
    terminalOutcome: failedOutcome ? 'failed' : 'completed',
    datasetAuthority: {
      contractDigest: dataset.contractDigest,
      resolutionRevision: dataset.resolutionRevision,
      resolutionRoot: dataset.resolutionDigest,
      coverageRevision: dataset.coverageRevision,
      coverageRoot: dataset.coverageDigest,
    },
  })}`;
  const retained = loadCanonicalEntityWorkflowLineageReceipt(receiptId);
  if (retained) {
    const retainedFinishedAt = terminalAt(retained.request);
    if (!retainedFinishedAt
      || retained.request.expectedBindingDigest !== binding.digest
      || canonicalEntityJson(retained.request.terminalOutcomeAuthority ?? null)
        !== canonicalEntityJson(terminalOutcomeAuthority ?? null)
      || canonicalEntityJson(retained.request.identity) !== canonicalEntityJson(identity)
      || canonicalEntityJson(retained.request.expectedDatasetAuthority) !== canonicalEntityJson({
        version: 1,
        contractDigest: dataset.contractDigest,
        resolutionRevision: dataset.resolutionRevision,
        resolutionRoot: dataset.resolutionDigest,
        coverageRevision: dataset.coverageRevision,
        coverageRoot: dataset.coverageDigest,
      })) return block('lineage_receipt_conflict', 'retained lineage receipt is stale or contradictory');
    return {
      status: 'replayed',
      claim: claimFrom({
        receiptId,
        receiptDigest: retained.receiptDigest,
        identity,
        bindingDigest: binding.digest,
        ...(retained.request.terminalOutcomeAuthority
          ? { terminalOutcomeAuthority: retained.request.terminalOutcomeAuthority }
          : {}),
      }),
      finishedAt: retainedFinishedAt,
      datasetId,
      observationCount,
      pageCount: pages.length,
    };
  }

  // Batch identity is the semantic observation set plus policy, not the page.
  // Repeated or empty pages can therefore replay one retained batch. Project
  // each canonical batch authority exactly once in first-page order.
  const batchReceipts = [...batchReceiptsById.values()];
  const batchLineage = batchReceipts.map((receipt, index) => ({
    version: 1 as const,
    batchId: receipt.batchId,
    partitionId,
    attempt: 1,
    sequence: index + 2,
    ordinal: 0,
  }));
  const terminalRunStatus = failedOutcome ? 'failed' as const : 'completed' as const;
  const terminalPartitionState = failedOutcome ? 'failed' as const : 'completed' as const;
  const request: CanonicalEntityWorkflowProjectionRequestV1 = {
    version: 1,
    identity,
    expectedBindingDigest: binding.digest,
    expectedDatasetAuthority: {
      version: 1,
      contractDigest: dataset.contractDigest,
      resolutionRevision: dataset.resolutionRevision,
      resolutionRoot: dataset.resolutionDigest,
      coverageRevision: dataset.coverageRevision,
      coverageRoot: dataset.coverageDigest,
    },
    runReceipts: [{
      receiptId: `workflow-run-receipt:${canonicalEntitySha256({ version: 1, identity, status: 'running', at: input.startedAt })}`,
      sequence: 1,
      ordinal: 0,
      at: input.startedAt,
      identity,
      status: 'running',
    }, {
      receiptId: `workflow-run-receipt:${canonicalEntitySha256({ version: 1, identity, status: terminalRunStatus, at: input.proposedFinishedAt })}`,
      sequence: batchReceipts.length + 3,
      ordinal: 0,
      at: input.proposedFinishedAt,
      identity,
      status: terminalRunStatus,
    }],
    partitionReceipts: [{
      receiptId: `workflow-partition-receipt:${canonicalEntitySha256({ version: 1, identity, partitionId, kind: 'declared' })}`,
      sequence: 1,
      ordinal: 1,
      at: input.startedAt,
      identity,
      kind: 'declared',
      partitionId,
    }, {
      receiptId: `workflow-partition-receipt:${canonicalEntitySha256({ version: 1, identity, partitionId, state: 'running' })}`,
      sequence: 1,
      ordinal: 2,
      at: input.startedAt,
      identity,
      kind: 'status',
      partitionId,
      state: 'running',
      attempt: 1,
    }, {
      receiptId: `workflow-partition-receipt:${canonicalEntitySha256({
        version: 1,
        identity,
        partitionId,
        state: terminalPartitionState,
        failureRef: terminalOutcomeAuthority?.failureRef ?? null,
      })}`,
      sequence: batchReceipts.length + 2,
      ordinal: 1,
      at: input.proposedFinishedAt,
      identity,
      kind: 'status',
      partitionId,
      state: terminalPartitionState,
      attempt: 1,
      ...(terminalOutcomeAuthority ? { failureRef: terminalOutcomeAuthority.failureRef } : {}),
    }],
    batchLineage,
    coveragePosition: {
      version: 1,
      sequence: batchReceipts.length + 2,
      ordinal: 2,
    },
    ...(terminalOutcomeAuthority ? { terminalOutcomeAuthority } : {}),
  };
  input.hooks?.beforeReceipt?.();
  const stored = putCanonicalEntityWorkflowLineageReceipt({ receiptId, request });
  if (!stored.ok) return block('lineage_receipt_conflict', stored.reason);
  input.hooks?.afterReceipt?.();
  return {
    status: stored.inserted ? 'ready' : 'replayed',
    claim: claimFrom({
      receiptId,
      receiptDigest: stored.receipt.receiptDigest,
      identity,
      bindingDigest: binding.digest,
      ...(terminalOutcomeAuthority ? { terminalOutcomeAuthority } : {}),
    }),
    finishedAt: input.proposedFinishedAt,
    datasetId,
    observationCount,
    pageCount: pages.length,
  };
}
