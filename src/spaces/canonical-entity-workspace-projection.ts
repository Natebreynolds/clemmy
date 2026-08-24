import { createHash } from 'node:crypto';

import {
  compareCanonicalEntityText,
  summarizeDatasetCoverage,
  upsertEntityObservationBatch,
  type CoverageDenominator,
  type CoverageStatus,
  type DatasetCoverageState,
  type EntityBatchUpsertResult,
  type EntityObservationInput,
  type EntityResolutionDecision,
  type EntityResolutionPolicy,
  type EntityResolutionState,
} from '../execution/canonical-entity-resolution.js';
import {
  buildWorkspaceRunProjection,
  canonicalWorkspaceProjectionJson,
  validateWorkflowSurfaceBinding,
  workflowSurfaceBindingDigest,
  type WorkflowSurfaceBindingV1,
  type WorkspaceCoverageStatus,
  type WorkspacePartitionState,
  type WorkspaceProjectionFactV1,
  type WorkspaceRunStatus,
} from './workflow-surface-binding.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/\-]{0,255}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_PROJECTED_REFS = 256;
const COVERAGE_REASONS = new Set([
  'partition_universe_not_closed',
  'dataset_denominator_not_exact',
  'required_partitions_unseen',
  'denominator_not_exact',
  'exhaustion_unknown',
  'partitions_not_exhausted',
  'dataset_partition_denominator_mismatch',
  'cursor_cycle_detected',
]);
const QUARANTINE_REASONS = new Set<QuarantineReason>([
  'exact_identifier_collision',
  'conflicting_exact_identifier',
  'ambiguous_candidates',
  'threshold_uncertainty',
  'canonical_id_collision',
]);

type QuarantineReason = Extract<
  EntityResolutionDecision,
  { decision: 'quarantine' }
>['reason'];

export type CanonicalWorkspaceProjectionErrorKind =
  | 'invalid_contract'
  | 'identity_mismatch'
  | 'corrupt_truth';

export class CanonicalWorkspaceProjectionError extends Error {
  constructor(
    public readonly kind: CanonicalWorkspaceProjectionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalWorkspaceProjectionError';
  }
}

export interface CanonicalResolutionProjectionSummaryV1 {
  version: 1;
  summaryId: string;
  batchId: string;
  previousResolutionStateDigest: string;
  nextResolutionStateDigest: string;
  uniqueObservationCount: number;
  observationsCommitted: number;
  canonicalRecordsCreated: number;
  mergedObservations: number;
  quarantinedObservations: number;
  replayedObservations: number;
  /** Semantic duplicate identities present in the supplied batch bytes. */
  duplicateObservationIdentities: number;
  /** Additive duplicates whose normalized observation was newly committed. */
  duplicateObservations: number;
  provenanceAssertions: number;
  provenanceOrigins: number;
  quarantineReasons: Readonly<Partial<Record<QuarantineReason, number>>>;
}

export interface DatasetCoverageProjectionSummaryV1 {
  version: 1;
  summaryId: string;
  datasetId: string;
  partitionUniverse: DatasetCoverageState['universe']['kind'];
  declaredPartitions?: number;
  declaredPartitionIndexDigest?: string;
  observedPartitions: number;
  observedPartitionIndexDigest: string;
  /** Projection-safe truth. A cursor cycle downgrades a source-complete summary. */
  status: CoverageStatus;
  sourceStatus: CoverageStatus;
  observed: number;
  denominator: CoverageDenominator;
  exhaustion: 'exhausted' | 'not_exhausted' | 'unknown';
  reasons: readonly string[];
}

export interface CanonicalWorkspaceProjectionIdentityV1 {
  version: 1;
  bindingId: string;
  workflowId: string;
  workspaceId: string;
  runId: string;
  datasetId: string;
}

interface PositionedReceiptV1 {
  receiptId: string;
  sequence: number;
  ordinal: number;
  at: string;
  identity: CanonicalWorkspaceProjectionIdentityV1;
}

export interface WorkflowRunProjectionReceiptV1 extends PositionedReceiptV1 {
  status: WorkspaceRunStatus;
}

export type WorkflowPartitionProjectionReceiptV1 =
  | (PositionedReceiptV1 & {
      kind: 'declared';
      partitionId: string;
    })
  | (PositionedReceiptV1 & {
      kind: 'status';
      partitionId: string;
      state: WorkspacePartitionState;
      attempt: number;
      failureRef?: string;
    });

export interface CanonicalResolutionProjectionReceiptV1 extends PositionedReceiptV1 {
  partitionId: string;
  attempt: number;
  summary: CanonicalResolutionProjectionSummaryV1;
  /** Root of normalized/paginated records; never an embedded record body. */
  artifactRef: string;
  /** Durable, bounded provenance summary or query handle. */
  provenanceSummaryRef: string;
  /** Required when this receipt added work to the review queue. */
  quarantineReviewRef?: string;
}

export interface DatasetCoverageProjectionReceiptV1 extends PositionedReceiptV1 {
  summary: DatasetCoverageProjectionSummaryV1;
  /** Validation-only membership proof; never copied into projected facts. */
  observedPartitionIds: readonly string[];
  evidenceRef: string;
}

export interface AdaptCanonicalEntityWorkspaceProjectionInputV1 {
  version: 1;
  binding: WorkflowSurfaceBindingV1;
  bindingDigest: string;
  identity: CanonicalWorkspaceProjectionIdentityV1;
  resolutionStateAnchorDigest: string;
  runReceipts: readonly WorkflowRunProjectionReceiptV1[];
  partitionReceipts: readonly WorkflowPartitionProjectionReceiptV1[];
  resolutionReceipts: readonly CanonicalResolutionProjectionReceiptV1[];
  coverageReceipt: DatasetCoverageProjectionReceiptV1;
}

export interface CanonicalWorkspaceResolutionProjectionSummaryV1 {
  initialStateDigest: string;
  finalStateDigest: string;
  batchCount: number;
  observationsCommitted: number;
  canonicalRecordsCreated: number;
  mergedObservations: number;
  quarantinedObservations: number;
  replayedObservations: number;
  duplicateObservations: number;
  provenanceAssertions: number;
  /** Sum of each batch's unique-origin cardinality; not a global cardinality claim. */
  summedBatchProvenanceOrigins: number;
  quarantineReasons: Readonly<Partial<Record<QuarantineReason, number>>>;
  quarantineReviewRefCount: number;
  quarantineReviewRefs: readonly string[];
}

export interface CanonicalEntityWorkspaceProjectionV1 {
  version: 1;
  identity: CanonicalWorkspaceProjectionIdentityV1;
  bindingDigest: string;
  sourceDigest: string;
  facts: readonly WorkspaceProjectionFactV1[];
  coverage: DatasetCoverageProjectionSummaryV1;
  resolution: CanonicalWorkspaceResolutionProjectionSummaryV1;
}

export type AdaptCanonicalEntityWorkspaceProjectionResult =
  | { ok: true; value: CanonicalEntityWorkspaceProjectionV1 }
  | {
      ok: false;
      kind: CanonicalWorkspaceProjectionErrorKind;
      errors: readonly string[];
    };

function fail(
  kind: CanonicalWorkspaceProjectionErrorKind,
  message: string,
): never {
  throw new CanonicalWorkspaceProjectionError(kind, message);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalWorkspaceProjectionJson(value), 'utf8')
    .digest('hex');
}

function summaryId(prefix: string, value: unknown): string {
  return `${prefix}:${sha256(value)}`;
}

function partitionIdentityDigest(partitionIds: readonly string[]): string {
  return sha256({
    version: 1,
    partitionIds: [...partitionIds].sort(compareCanonicalEntityText),
  });
}

function requireIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail('invalid_contract', `${label} must be a canonical non-blank identifier.`);
  }
}

function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    fail('invalid_contract', `${label} must be a sha256 digest.`);
  }
}

function requireCount(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail('invalid_contract', `${label} must be a non-negative safe integer.`);
  }
}

function addCount(left: number, right: number, label: string): number {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    fail('corrupt_truth', `${label} exceeds the safe integer range.`);
  }
  return left + right;
}

function requireIso(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') fail('invalid_contract', `${label} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail('invalid_contract', `${label} must be an exact ISO timestamp.`);
  }
}

function requireExactKeys(value: object, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail('corrupt_truth', `${label} contains unknown field ${key}.`);
  }
}

function sortedCountRecord<K extends string>(
  values: Iterable<readonly [K, number]>,
): Readonly<Record<K, number>> {
  const result = {} as Record<K, number>;
  for (const [key, count] of [...values]
    .sort(([left], [right]) => compareCanonicalEntityText(left, right))) {
    result[key] = count;
  }
  return result;
}

function quarantineCounts(): Map<QuarantineReason, number> {
  return new Map<QuarantineReason, number>();
}

function resolutionSummaryContent(
  summary: Omit<CanonicalResolutionProjectionSummaryV1, 'summaryId'>,
): Omit<CanonicalResolutionProjectionSummaryV1, 'summaryId'> {
  return summary;
}

export function canonicalEntityResolutionStateDigest(
  state: EntityResolutionState,
): string {
  if (!state || state.version !== 1) {
    fail('corrupt_truth', 'Canonical entity state must use version 1.');
  }
  return sha256({ version: 1, state });
}

function sortedKeys(value: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(value).sort(compareCanonicalEntityText);
}

function assertBatchStateTransition(
  previousState: EntityResolutionState,
  batch: EntityBatchUpsertResult,
): void {
  if (!batch || !batch.state || batch.state.version !== 1
    || !Array.isArray(batch.results) || !Array.isArray(batch.duplicateObservationIds)) {
    fail('corrupt_truth', 'Canonical batch result is structurally incomplete.');
  }
  if (!previousState || previousState.version !== 1) {
    fail('corrupt_truth', 'Canonical batch previous state must use version 1.');
  }

  for (const [observationId, observation] of Object.entries(previousState.observations)) {
    const retained = batch.state.observations[observationId];
    if (!retained || canonicalWorkspaceProjectionJson(retained)
      !== canonicalWorkspaceProjectionJson(observation)) {
      fail('corrupt_truth', `Batch ${batch.batchId} rewrote or removed prior observation truth.`);
    }
  }
  for (const [observationId, decision] of Object.entries(previousState.decisions)) {
    const retained = batch.state.decisions[observationId];
    if (!retained || canonicalWorkspaceProjectionJson(retained)
      !== canonicalWorkspaceProjectionJson(decision)) {
      fail('corrupt_truth', `Batch ${batch.batchId} rewrote or removed a prior decision.`);
    }
  }
  for (const canonicalId of Object.keys(previousState.records)) {
    if (!batch.state.records[canonicalId]) {
      fail('corrupt_truth', `Batch ${batch.batchId} evicted a prior canonical record.`);
    }
  }

  const resultIds: string[] = [];
  const expectedRecordIds = new Set(Object.keys(previousState.records));
  for (const [index, result] of batch.results.entries()) {
    if (typeof result.idempotent !== 'boolean' || !result.decision) {
      fail('corrupt_truth', `Batch ${batch.batchId} result ${index} is malformed.`);
    }
    const observationId = result.decision.observationId;
    requireIdentifier(observationId, `results[${index}].observationId`);
    if (index > 0 && observationId <= resultIds[index - 1]!) {
      fail('corrupt_truth', `Batch ${batch.batchId} results are not a sorted semantic set.`);
    }
    resultIds.push(observationId);
    const retainedObservation = batch.state.observations[observationId];
    const retainedDecision = batch.state.decisions[observationId];
    if (!retainedObservation || !retainedDecision
      || canonicalWorkspaceProjectionJson(retainedDecision)
        !== canonicalWorkspaceProjectionJson(result.decision)) {
      fail('corrupt_truth', `Batch ${batch.batchId} result lacks matching retained authority.`);
    }
    const existed = previousState.observations[observationId] !== undefined;
    if (result.idempotent !== existed) {
      fail('corrupt_truth', `Batch ${batch.batchId} misclassified an observation transition.`);
    }
    if (result.decision.decision !== 'quarantine') {
      expectedRecordIds.add(result.decision.canonicalId);
      const record = batch.state.records[result.decision.canonicalId];
      if (!record || !record.observationIds.includes(observationId)) {
        fail('corrupt_truth', `Batch ${batch.batchId} lacks its decided canonical record.`);
      }
    }
  }

  const expectedObservationIds = [...new Set([
    ...Object.keys(previousState.observations),
    ...resultIds,
  ])].sort(compareCanonicalEntityText);
  if (canonicalWorkspaceProjectionJson(sortedKeys(batch.state.observations))
      !== canonicalWorkspaceProjectionJson(expectedObservationIds)
    || canonicalWorkspaceProjectionJson(sortedKeys(batch.state.decisions))
      !== canonicalWorkspaceProjectionJson(expectedObservationIds)
    || canonicalWorkspaceProjectionJson(sortedKeys(batch.state.records))
      !== canonicalWorkspaceProjectionJson([...expectedRecordIds].sort(compareCanonicalEntityText))) {
    fail('corrupt_truth', `Batch ${batch.batchId} state contains changes outside its declared results.`);
  }

  let previousDuplicate = '';
  for (const [index, observationId] of batch.duplicateObservationIds.entries()) {
    requireIdentifier(observationId, `duplicateObservationIds[${index}]`);
    if (!resultIds.includes(observationId)) {
      fail('corrupt_truth', `Batch ${batch.batchId} names a duplicate outside its result set.`);
    }
    if (previousDuplicate && observationId <= previousDuplicate) {
      fail('corrupt_truth', `Batch ${batch.batchId} duplicate identities are not sorted and unique.`);
    }
    previousDuplicate = observationId;
  }
}

/**
 * Reduce one canonical batch result to additive counts and opaque identities.
 * No entity, field value, canonical record, observation ID, or source-local
 * identity crosses into the result.
 */
export function summarizeCanonicalResolutionBatchForWorkspace(
  batch: EntityBatchUpsertResult,
  previousState: EntityResolutionState,
  sourceInputs: readonly EntityObservationInput[],
  policy: EntityResolutionPolicy,
): CanonicalResolutionProjectionSummaryV1 {
  requireIdentifier(batch.batchId, 'batchId');
  const independentlyDerived = upsertEntityObservationBatch(previousState, sourceInputs, policy);
  if (canonicalWorkspaceProjectionJson(independentlyDerived)
      !== canonicalWorkspaceProjectionJson(batch)) {
    fail('corrupt_truth', `Batch ${batch.batchId} does not match its deterministic source transition.`);
  }
  assertBatchStateTransition(previousState, batch);
  const seenObservations = new Set<string>();
  const newlyCommittedObservations = new Set<string>();
  const reasons = quarantineCounts();
  const origins = new Set<string>();
  let observationsCommitted = 0;
  let canonicalRecordsCreated = 0;
  let mergedObservations = 0;
  let quarantinedObservations = 0;
  let replayedObservations = 0;
  let provenanceAssertions = 0;

  for (const [index, result] of batch.results.entries()) {
    const observationId = result.decision.observationId;
    requireIdentifier(observationId, `results[${index}].observationId`);
    if (seenObservations.has(observationId)) {
      fail('corrupt_truth', `Batch ${batch.batchId} repeats one normalized observation result.`);
    }
    seenObservations.add(observationId);
    if (result.idempotent) {
      replayedObservations = addCount(replayedObservations, 1, 'batch replayedObservations');
      continue;
    }
    const observation = batch.state.observations[observationId];
    if (!observation) {
      fail('corrupt_truth', `Batch ${batch.batchId} is missing retained observation authority.`);
    }
    observationsCommitted = addCount(observationsCommitted, 1, 'batch observationsCommitted');
    newlyCommittedObservations.add(observationId);
    for (const field of Object.values(observation.fields)) {
      provenanceAssertions = addCount(provenanceAssertions, 1, 'batch provenanceAssertions');
      origins.add(canonicalWorkspaceProjectionJson([
        field.provenance.sourceId,
        field.provenance.recordId,
      ]));
    }
    if (result.decision.decision === 'distinct') {
      canonicalRecordsCreated = addCount(canonicalRecordsCreated, 1, 'batch canonicalRecordsCreated');
    } else if (result.decision.decision === 'merge') {
      mergedObservations = addCount(mergedObservations, 1, 'batch mergedObservations');
    } else {
      quarantinedObservations = addCount(
        quarantinedObservations,
        1,
        'batch quarantinedObservations',
      );
      reasons.set(
        result.decision.reason,
        addCount(reasons.get(result.decision.reason) ?? 0, 1, 'batch quarantine reason'),
      );
    }
  }

  const duplicateObservationIdentities = batch.duplicateObservationIds.length;
  const duplicateObservations = batch.duplicateObservationIds.filter((observationId) => (
    newlyCommittedObservations.has(observationId)
  )).length;
  const content = resolutionSummaryContent({
    version: 1,
    batchId: batch.batchId,
    previousResolutionStateDigest: canonicalEntityResolutionStateDigest(previousState),
    nextResolutionStateDigest: canonicalEntityResolutionStateDigest(batch.state),
    uniqueObservationCount: batch.results.length,
    observationsCommitted,
    canonicalRecordsCreated,
    mergedObservations,
    quarantinedObservations,
    replayedObservations,
    duplicateObservationIdentities,
    // Only newly committed duplicate identities are an additive projection
    // delta. Replaying a batch must not increment Workspace counts.
    duplicateObservations,
    provenanceAssertions,
    provenanceOrigins: origins.size,
    quarantineReasons: sortedCountRecord(reasons),
  });
  return deepFreeze({
    ...content,
    summaryId: summaryId('canonical-resolution-projection:v1', content),
  });
}

function coverageHasCursorCycle(state: DatasetCoverageState): boolean {
  for (const partition of Object.values(state.partitions)) {
    const seen = new Set<string>();
    for (const page of partition.pages) {
      if (page.inputCursor !== null) seen.add(page.inputCursor);
      if (page.outputCursor !== null) {
        if (seen.has(page.outputCursor)) return true;
        seen.add(page.outputCursor);
      }
    }
  }
  return false;
}

function coverageSummaryContent(
  summary: Omit<DatasetCoverageProjectionSummaryV1, 'summaryId'>,
): Omit<DatasetCoverageProjectionSummaryV1, 'summaryId'> {
  return summary;
}

/** Build a bounded coverage truth object without partition IDs, item IDs, or pages. */
export function summarizeDatasetCoverageForWorkspace(
  state: DatasetCoverageState,
): DatasetCoverageProjectionSummaryV1 {
  const source = summarizeDatasetCoverage(state);
  const cursorCycle = coverageHasCursorCycle(state);
  const reasons = [...new Set([
    ...source.reasons,
    ...(cursorCycle ? ['cursor_cycle_detected'] : []),
  ])].sort(compareCanonicalEntityText);
  const content = coverageSummaryContent({
    version: 1,
    datasetId: state.datasetId,
    partitionUniverse: state.universe.kind,
    ...(state.universe.kind === 'closed'
      ? {
          declaredPartitions: state.universe.partitionIds.length,
          declaredPartitionIndexDigest: partitionIdentityDigest(state.universe.partitionIds),
        }
      : {}),
    observedPartitions: Object.keys(state.partitions).length,
    observedPartitionIndexDigest: partitionIdentityDigest(Object.keys(state.partitions)),
    status: cursorCycle && source.status === 'complete' ? 'unknown' : source.status,
    sourceStatus: source.status,
    observed: source.observed,
    denominator: source.denominator,
    exhaustion: cursorCycle ? 'unknown' : source.exhaustion,
    reasons,
  });
  return deepFreeze({
    ...content,
    summaryId: summaryId('dataset-coverage-projection:v1', content),
  });
}

function validateIdentity(identity: CanonicalWorkspaceProjectionIdentityV1, label: string): void {
  requireExactKeys(
    identity,
    ['version', 'bindingId', 'workflowId', 'workspaceId', 'runId', 'datasetId'],
    label,
  );
  if (identity.version !== 1) fail('invalid_contract', `${label}.version must be 1.`);
  requireIdentifier(identity.bindingId, `${label}.bindingId`);
  requireIdentifier(identity.workflowId, `${label}.workflowId`);
  requireIdentifier(identity.workspaceId, `${label}.workspaceId`);
  requireIdentifier(identity.runId, `${label}.runId`);
  requireIdentifier(identity.datasetId, `${label}.datasetId`);
}

function assertSameIdentity(
  expected: CanonicalWorkspaceProjectionIdentityV1,
  actual: CanonicalWorkspaceProjectionIdentityV1,
  label: string,
): void {
  validateIdentity(actual, `${label}.identity`);
  if (canonicalWorkspaceProjectionJson(expected) !== canonicalWorkspaceProjectionJson(actual)) {
    fail('identity_mismatch', `${label} does not belong to the selected binding/run/dataset identity.`);
  }
}

function validatePositionedReceipt(
  receipt: PositionedReceiptV1,
  identity: CanonicalWorkspaceProjectionIdentityV1,
  label: string,
): void {
  requireIdentifier(receipt.receiptId, `${label}.receiptId`);
  requireCount(receipt.sequence, `${label}.sequence`);
  requireCount(receipt.ordinal, `${label}.ordinal`);
  requireIso(receipt.at, `${label}.at`);
  assertSameIdentity(identity, receipt.identity, label);
}

function validateResolutionSummary(summary: CanonicalResolutionProjectionSummaryV1): void {
  requireExactKeys(summary, [
    'version', 'summaryId', 'batchId', 'previousResolutionStateDigest',
    'nextResolutionStateDigest', 'uniqueObservationCount',
    'observationsCommitted', 'canonicalRecordsCreated', 'mergedObservations',
    'quarantinedObservations', 'replayedObservations',
    'duplicateObservationIdentities', 'duplicateObservations',
    'provenanceAssertions', 'provenanceOrigins', 'quarantineReasons',
  ], 'resolution summary');
  if (summary.version !== 1) fail('invalid_contract', 'Resolution summary version must be 1.');
  requireIdentifier(summary.summaryId, 'resolution summaryId');
  requireIdentifier(summary.batchId, 'resolution batchId');
  requireDigest(summary.previousResolutionStateDigest, 'resolution previous state digest');
  requireDigest(summary.nextResolutionStateDigest, 'resolution next state digest');
  for (const field of [
    'uniqueObservationCount', 'observationsCommitted', 'canonicalRecordsCreated',
    'mergedObservations', 'quarantinedObservations', 'replayedObservations',
    'duplicateObservationIdentities', 'duplicateObservations',
    'provenanceAssertions', 'provenanceOrigins',
  ] as const) requireCount(summary[field], `resolution ${field}`);
  const expectedCommitted = addCount(
    addCount(
      summary.canonicalRecordsCreated,
      summary.mergedObservations,
      'resolution committed-decision count',
    ),
    summary.quarantinedObservations,
    'resolution committed-decision count',
  );
  const expectedUnique = addCount(
    summary.observationsCommitted,
    summary.replayedObservations,
    'resolution unique observation count',
  );
  if (summary.observationsCommitted !== expectedCommitted
    || summary.uniqueObservationCount !== expectedUnique
    || summary.duplicateObservationIdentities > summary.uniqueObservationCount
    || summary.duplicateObservations > summary.duplicateObservationIdentities
    || summary.duplicateObservations > summary.observationsCommitted
    || summary.provenanceOrigins > summary.provenanceAssertions) {
    fail('corrupt_truth', `Resolution summary ${summary.summaryId} has contradictory counts.`);
  }
  if ((summary.observationsCommitted === 0)
      !== (summary.previousResolutionStateDigest === summary.nextResolutionStateDigest)) {
    fail('corrupt_truth', `Resolution summary ${summary.summaryId} contradicts its state transition.`);
  }
  if (!summary.quarantineReasons || typeof summary.quarantineReasons !== 'object'
    || Array.isArray(summary.quarantineReasons)) {
    fail('corrupt_truth', 'Resolution quarantine reasons must be a count record.');
  }
  let quarantines = 0;
  let previous = '';
  for (const [reason, count] of Object.entries(summary.quarantineReasons)) {
    if (!QUARANTINE_REASONS.has(reason as QuarantineReason)) {
      fail('corrupt_truth', `Resolution quarantine reason ${reason} is unsupported.`);
    }
    requireCount(count, `quarantine reason ${reason}`);
    if (previous && reason <= previous) {
      fail('corrupt_truth', 'Resolution quarantine reasons must be sorted and unique.');
    }
    previous = reason;
    quarantines = addCount(quarantines, count, 'resolution quarantine reason total');
  }
  if (quarantines !== summary.quarantinedObservations) {
    fail('corrupt_truth', 'Resolution quarantine reason counts do not match the total.');
  }
  const { summaryId: _summaryId, ...content } = summary;
  if (summary.summaryId !== summaryId('canonical-resolution-projection:v1', content)) {
    fail('corrupt_truth', `Resolution summary ${summary.summaryId} failed its content digest.`);
  }
}

function validateDenominator(denominator: CoverageDenominator): void {
  if (!denominator || typeof denominator !== 'object') {
    fail('corrupt_truth', 'Coverage denominator must be typed.');
  }
  if (denominator.kind === 'exact') {
    requireExactKeys(denominator, ['kind', 'total'], 'coverage exact denominator');
    requireCount(denominator.total, 'coverage exact denominator');
  } else if (denominator.kind === 'lower_bound') {
    requireExactKeys(denominator, ['kind', 'atLeast'], 'coverage lower-bound denominator');
    requireCount(denominator.atLeast, 'coverage lower-bound denominator');
  } else if (denominator.kind === 'unknown') {
    requireExactKeys(denominator, ['kind'], 'coverage unknown denominator');
  } else {
    fail('corrupt_truth', 'Coverage denominator kind is unsupported.');
  }
}

function validateCoverageSummary(summary: DatasetCoverageProjectionSummaryV1): void {
  requireExactKeys(summary, [
    'version', 'summaryId', 'datasetId', 'partitionUniverse', 'declaredPartitions',
    'declaredPartitionIndexDigest', 'observedPartitions',
    'observedPartitionIndexDigest', 'status', 'sourceStatus', 'observed',
    'denominator', 'exhaustion', 'reasons',
  ], 'coverage summary');
  if (summary.version !== 1) fail('invalid_contract', 'Coverage summary version must be 1.');
  requireIdentifier(summary.summaryId, 'coverage summaryId');
  requireIdentifier(summary.datasetId, 'coverage datasetId');
  if (!['closed', 'open', 'unknown'].includes(summary.partitionUniverse)) {
    fail('corrupt_truth', 'Coverage partition universe is unsupported.');
  }
  if (!['complete', 'partial', 'unknown'].includes(summary.status)
    || !['complete', 'partial', 'unknown'].includes(summary.sourceStatus)) {
    fail('corrupt_truth', 'Coverage status is unsupported.');
  }
  if (!['exhausted', 'not_exhausted', 'unknown'].includes(summary.exhaustion)) {
    fail('corrupt_truth', 'Coverage exhaustion is unsupported.');
  }
  requireCount(summary.observedPartitions, 'coverage observedPartitions');
  requireDigest(summary.observedPartitionIndexDigest, 'coverage observedPartitionIndexDigest');
  requireCount(summary.observed, 'coverage observed');
  validateDenominator(summary.denominator);
  if (summary.partitionUniverse === 'closed') {
    requireCount(summary.declaredPartitions, 'coverage declaredPartitions');
    requireDigest(summary.declaredPartitionIndexDigest, 'coverage declaredPartitionIndexDigest');
    if (summary.observedPartitions > summary.declaredPartitions) {
      fail('corrupt_truth', 'Closed coverage observed more partitions than its declared universe.');
    }
  } else if (summary.declaredPartitions !== undefined) {
    fail('corrupt_truth', 'Open or unknown coverage cannot declare a universal partition count.');
  } else if (summary.declaredPartitionIndexDigest !== undefined) {
    fail('corrupt_truth', 'Open or unknown coverage cannot claim a closed partition index digest.');
  }
  if (!Array.isArray(summary.reasons)) fail('corrupt_truth', 'Coverage reasons must be an array.');
  if (summary.reasons.length > COVERAGE_REASONS.size) {
    fail('corrupt_truth', 'Coverage reasons exceed the bounded version-1 vocabulary.');
  }
  let previous = '';
  for (const reason of summary.reasons) {
    if (!COVERAGE_REASONS.has(reason)) {
      fail('corrupt_truth', `Coverage reason ${String(reason)} is unsupported.`);
    }
    if (previous && reason <= previous) fail('corrupt_truth', 'Coverage reasons must be sorted and unique.');
    previous = reason;
  }
  if (summary.status === 'complete') {
    if (summary.sourceStatus !== 'complete'
      || summary.partitionUniverse !== 'closed'
      || summary.denominator.kind !== 'exact'
      || summary.exhaustion !== 'exhausted'
      || summary.reasons.length > 0
      || summary.observed !== summary.denominator.total
      || summary.observedPartitions !== summary.declaredPartitions
      || summary.observedPartitionIndexDigest !== summary.declaredPartitionIndexDigest) {
      fail('corrupt_truth', 'Complete coverage contradicts its bounded source truth.');
    }
  }
  if (summary.denominator.kind === 'exact' && summary.observed > summary.denominator.total) {
    fail('corrupt_truth', 'Coverage observed count exceeds its exact denominator.');
  }
  if (summary.sourceStatus === 'complete') {
    if (summary.partitionUniverse !== 'closed'
      || summary.denominator.kind !== 'exact'
      || summary.observed !== summary.denominator.total
      || summary.observedPartitions !== summary.declaredPartitions
      || summary.observedPartitionIndexDigest !== summary.declaredPartitionIndexDigest) {
      fail('corrupt_truth', 'Source-complete coverage contradicts its partition or denominator truth.');
    }
    if (summary.status !== 'complete' && (summary.status !== 'unknown'
      || summary.exhaustion !== 'unknown'
      || summary.reasons.length !== 1
      || summary.reasons[0] !== 'cursor_cycle_detected')) {
      fail('corrupt_truth', 'A source-complete summary may only be downgraded for a cursor cycle.');
    }
  }
  const { summaryId: _summaryId, ...content } = summary;
  if (summary.summaryId !== summaryId('dataset-coverage-projection:v1', content)) {
    fail('corrupt_truth', `Coverage summary ${summary.summaryId} failed its content digest.`);
  }
}

function factId(kind: WorkspaceProjectionFactV1['kind'], receiptId: string): string {
  return `workspace-fact:${sha256({ version: 1, kind, receiptId })}`;
}

function factBase(
  kind: WorkspaceProjectionFactV1['kind'],
  receipt: PositionedReceiptV1,
): Pick<WorkspaceProjectionFactV1, 'factId' | 'sequence' | 'ordinal' | 'at'> {
  return {
    factId: factId(kind, receipt.receiptId),
    sequence: receipt.sequence,
    ordinal: receipt.ordinal,
    at: receipt.at,
  };
}

function receiptBytes(receipt: PositionedReceiptV1): string {
  return canonicalWorkspaceProjectionJson(receipt);
}

function compareReceiptPosition(left: PositionedReceiptV1, right: PositionedReceiptV1): number {
  return left.sequence - right.sequence || left.ordinal - right.ordinal;
}

function runStatusBefore(
  receipts: readonly WorkflowRunProjectionReceiptV1[],
  position: PositionedReceiptV1,
): WorkspaceRunStatus | undefined {
  let status: WorkspaceRunStatus | undefined;
  for (const receipt of receipts) {
    if (compareReceiptPosition(receipt, position) >= 0) break;
    status = receipt.status;
  }
  return status;
}

function validateRunLifecycle(
  receipts: readonly WorkflowRunProjectionReceiptV1[],
  dataReceipts: readonly PositionedReceiptV1[],
): void {
  const first = receipts[0]!;
  if (dataReceipts.some((receipt) => compareReceiptPosition(receipt, first) <= 0)) {
    fail('corrupt_truth', 'Workflow run authority must precede every projected data receipt.');
  }
  const terminal = new Set<WorkspaceRunStatus>(['completed', 'failed', 'cancelled']);
  for (let index = 1; index < receipts.length; index += 1) {
    const previous = receipts[index - 1]!.status;
    const current = receipts[index]!.status;
    if (terminal.has(previous) && current !== previous) {
      fail('corrupt_truth', `Workflow run regressed from terminal ${previous} to ${current}.`);
    }
  }
  for (const receipt of dataReceipts) {
    if (runStatusBefore(receipts, receipt) !== 'running') {
      fail(
        'corrupt_truth',
        `Projected data receipt ${receipt.receiptId} is outside active workflow run authority.`,
      );
    }
  }
}

function validatePartitionLifecycle(
  partitionId: string,
  declaration: Extract<WorkflowPartitionProjectionReceiptV1, { kind: 'declared' }>,
  statuses: readonly Extract<WorkflowPartitionProjectionReceiptV1, { kind: 'status' }>[],
): void {
  let attempt = 0;
  let state: WorkspacePartitionState = 'pending';
  const terminal = new Set<WorkspacePartitionState>(['completed', 'skipped', 'failed']);
  for (const receipt of statuses) {
    if (compareReceiptPosition(receipt, declaration) <= 0) {
      fail('corrupt_truth', `Partition ${partitionId} changed state before its declaration.`);
    }
    if (receipt.attempt < attempt || receipt.attempt > attempt + 1) {
      fail('corrupt_truth', `Partition ${partitionId} has a non-contiguous attempt transition.`);
    }
    if (receipt.attempt === attempt) {
      if (terminal.has(state) && receipt.state !== state) {
        fail('corrupt_truth', `Partition ${partitionId} regressed after terminal ${state}.`);
      }
      if (state !== 'pending' && receipt.state === 'pending') {
        fail('corrupt_truth', `Partition ${partitionId} regressed to pending within one attempt.`);
      }
    } else {
      if (receipt.state !== 'pending' && receipt.state !== 'running') {
        fail('corrupt_truth', `Partition ${partitionId} retry must begin pending or running.`);
      }
      if (attempt > 0 && state !== 'failed' && state !== 'blocked') {
        fail(
          'corrupt_truth',
          `Partition ${partitionId} cannot begin a new attempt after ${state}.`,
        );
      }
    }
    attempt = receipt.attempt;
    state = receipt.state;
  }
}

function orderedUniqueReceipts<T extends PositionedReceiptV1>(
  receipts: readonly T[],
): T[] {
  const byId = new Map<string, T>();
  const byPosition = new Map<string, string>();
  for (const receipt of receipts) {
    const prior = byId.get(receipt.receiptId);
    if (prior && receiptBytes(prior) !== receiptBytes(receipt)) {
      fail('corrupt_truth', `Receipt ${receipt.receiptId} was reused with different bytes.`);
    }
    const position = `${receipt.sequence}:${receipt.ordinal}`;
    const occupant = byPosition.get(position);
    if (occupant && occupant !== receipt.receiptId) {
      fail('corrupt_truth', `Receipt position ${position} is owned by multiple receipts.`);
    }
    byPosition.set(position, receipt.receiptId);
    byId.set(receipt.receiptId, receipt);
  }
  return [...byId.values()].sort((left, right) => (
    left.sequence - right.sequence
    || left.ordinal - right.ordinal
    || compareCanonicalEntityText(left.receiptId, right.receiptId)
  ));
}

function aggregateResolution(
  receipts: readonly CanonicalResolutionProjectionReceiptV1[],
  initialStateDigest: string,
): CanonicalWorkspaceResolutionProjectionSummaryV1 {
  requireDigest(initialStateDigest, 'resolutionStateAnchorDigest');
  const reasons = quarantineCounts();
  const reviewRefs = new Set<string>();
  let observationsCommitted = 0;
  let canonicalRecordsCreated = 0;
  let mergedObservations = 0;
  let quarantinedObservations = 0;
  let replayedObservations = 0;
  let duplicateObservations = 0;
  let provenanceAssertions = 0;
  let summedBatchProvenanceOrigins = 0;
  let finalStateDigest = initialStateDigest;
  for (const receipt of receipts) {
    const summary = receipt.summary;
    if (summary.previousResolutionStateDigest !== finalStateDigest) {
      fail(
        'corrupt_truth',
        `Resolution batch ${summary.batchId} does not continue the prior canonical state.`,
      );
    }
    finalStateDigest = summary.nextResolutionStateDigest;
    observationsCommitted = addCount(
      observationsCommitted,
      summary.observationsCommitted,
      'aggregate observationsCommitted',
    );
    canonicalRecordsCreated = addCount(
      canonicalRecordsCreated,
      summary.canonicalRecordsCreated,
      'aggregate canonicalRecordsCreated',
    );
    mergedObservations = addCount(
      mergedObservations,
      summary.mergedObservations,
      'aggregate mergedObservations',
    );
    quarantinedObservations = addCount(
      quarantinedObservations,
      summary.quarantinedObservations,
      'aggregate quarantinedObservations',
    );
    replayedObservations = addCount(
      replayedObservations,
      summary.replayedObservations,
      'aggregate replayedObservations',
    );
    duplicateObservations = addCount(
      duplicateObservations,
      summary.duplicateObservations,
      'aggregate duplicateObservations',
    );
    provenanceAssertions = addCount(
      provenanceAssertions,
      summary.provenanceAssertions,
      'aggregate provenanceAssertions',
    );
    summedBatchProvenanceOrigins = addCount(
      summedBatchProvenanceOrigins,
      summary.provenanceOrigins,
      'aggregate summedBatchProvenanceOrigins',
    );
    for (const [reason, count] of Object.entries(summary.quarantineReasons) as Array<[QuarantineReason, number]>) {
      reasons.set(
        reason,
        addCount(reasons.get(reason) ?? 0, count, `aggregate quarantine reason ${reason}`),
      );
    }
    if (receipt.quarantineReviewRef) reviewRefs.add(receipt.quarantineReviewRef);
  }
  const sortedReviewRefs = [...reviewRefs].sort(compareCanonicalEntityText);
  return deepFreeze({
    initialStateDigest,
    finalStateDigest,
    batchCount: receipts.length,
    observationsCommitted,
    canonicalRecordsCreated,
    mergedObservations,
    quarantinedObservations,
    replayedObservations,
    duplicateObservations,
    provenanceAssertions,
    summedBatchProvenanceOrigins,
    quarantineReasons: sortedCountRecord(reasons),
    quarantineReviewRefCount: sortedReviewRefs.length,
    quarantineReviewRefs: sortedReviewRefs.slice(0, MAX_PROJECTED_REFS),
  });
}

function projectionCoverageStatus(
  coverage: DatasetCoverageProjectionSummaryV1,
  partitions: readonly WorkflowPartitionProjectionReceiptV1[],
): Exclude<WorkspaceCoverageStatus, 'not_started'> {
  const latest = new Map<string, Extract<WorkflowPartitionProjectionReceiptV1, { kind: 'status' }>>();
  for (const receipt of partitions) {
    if (receipt.kind !== 'status') continue;
    latest.set(receipt.partitionId, receipt);
  }
  if ([...latest.values()].some((receipt) => receipt.state === 'failed')) return 'failed';
  if ([...latest.values()].some((receipt) => receipt.state === 'blocked')) return 'blocked';
  return coverage.status === 'complete' ? 'complete' : 'partial';
}

function adaptOrThrow(
  input: AdaptCanonicalEntityWorkspaceProjectionInputV1,
): CanonicalEntityWorkspaceProjectionV1 {
  requireExactKeys(input, [
    'version', 'binding', 'bindingDigest', 'identity', 'resolutionStateAnchorDigest',
    'runReceipts', 'partitionReceipts', 'resolutionReceipts',
    'coverageReceipt',
  ], 'adapter input');
  if (input.version !== 1) fail('invalid_contract', 'Adapter input version must be 1.');
  const bindingValidation = validateWorkflowSurfaceBinding(input.binding);
  if (!bindingValidation.ok) fail('invalid_contract', bindingValidation.errors.join('; '));
  requireDigest(input.bindingDigest, 'bindingDigest');
  const actualBindingDigest = workflowSurfaceBindingDigest(input.binding);
  if (input.bindingDigest !== actualBindingDigest) {
    fail('identity_mismatch', 'Binding digest does not match the exact binding revision.');
  }
  validateIdentity(input.identity, 'identity');
  requireDigest(input.resolutionStateAnchorDigest, 'resolutionStateAnchorDigest');
  if (input.identity.bindingId !== input.binding.bindingId
    || input.identity.workflowId !== input.binding.workflowId
    || input.identity.workspaceId !== input.binding.workspaceId) {
    fail('identity_mismatch', 'Projection identity does not match the selected binding.');
  }

  if (!Array.isArray(input.runReceipts) || input.runReceipts.length === 0) {
    fail('invalid_contract', 'At least one workflow run receipt is required.');
  }
  if (!Array.isArray(input.partitionReceipts) || !Array.isArray(input.resolutionReceipts)) {
    fail('invalid_contract', 'Partition and resolution receipts must be arrays.');
  }

  const allReceipts: PositionedReceiptV1[] = [
    ...input.runReceipts,
    ...input.partitionReceipts,
    ...input.resolutionReceipts,
    input.coverageReceipt,
  ];
  for (const [index, receipt] of allReceipts.entries()) {
    validatePositionedReceipt(receipt, input.identity, `receipts[${index}]`);
  }
  // One durable position is one source event/derived ordinal across every fact kind.
  const sourceReceipts = orderedUniqueReceipts(allReceipts);

  const runReceipts = orderedUniqueReceipts(input.runReceipts);
  for (const receipt of runReceipts) {
    requireExactKeys(receipt, [
      'receiptId', 'sequence', 'ordinal', 'at', 'identity', 'status',
    ], `run receipt ${receipt.receiptId}`);
    if (!['queued', 'running', 'held', 'blocked', 'completed', 'failed', 'cancelled']
      .includes(receipt.status)) {
      fail('invalid_contract', `Run receipt ${receipt.receiptId} has an invalid status.`);
    }
  }

  const partitionReceipts = orderedUniqueReceipts(input.partitionReceipts);
  const declared = new Map<
    string,
    Extract<WorkflowPartitionProjectionReceiptV1, { kind: 'declared' }>
  >();
  for (const receipt of partitionReceipts) {
    requireIdentifier(receipt.partitionId, `partition receipt ${receipt.receiptId}.partitionId`);
    if (receipt.kind === 'declared') {
      requireExactKeys(receipt, [
        'receiptId', 'sequence', 'ordinal', 'at', 'identity', 'kind', 'partitionId',
      ], `partition receipt ${receipt.receiptId}`);
      const prior = declared.get(receipt.partitionId);
      if (prior && prior.receiptId !== receipt.receiptId) {
        fail('corrupt_truth', `Partition ${receipt.partitionId} has multiple declaration receipts.`);
      }
      declared.set(receipt.partitionId, receipt);
      continue;
    }
    if (receipt.kind !== 'status') {
      fail('invalid_contract', `Partition receipt ${receipt.receiptId} has an invalid kind.`);
    }
    requireExactKeys(receipt, [
      'receiptId', 'sequence', 'ordinal', 'at', 'identity', 'kind', 'partitionId',
      'state', 'attempt', 'failureRef',
    ], `partition receipt ${receipt.receiptId}`);
    if (!['pending', 'running', 'completed', 'skipped', 'failed', 'blocked'].includes(receipt.state)) {
      fail('invalid_contract', `Partition receipt ${receipt.receiptId} has an invalid state.`);
    }
    requireCount(receipt.attempt, `partition receipt ${receipt.receiptId}.attempt`);
    if (receipt.failureRef !== undefined) {
      requireIdentifier(receipt.failureRef, `partition receipt ${receipt.receiptId}.failureRef`);
    }
  }
  for (const [partitionId, declaration] of declared) {
    const statuses = partitionReceipts.filter((receipt): receipt is Extract<
      WorkflowPartitionProjectionReceiptV1,
      { kind: 'status' }
    > => receipt.kind === 'status' && receipt.partitionId === partitionId);
    validatePartitionLifecycle(partitionId, declaration, statuses);
  }
  for (const receipt of partitionReceipts) {
    if (receipt.kind === 'status' && !declared.has(receipt.partitionId)) {
      fail('corrupt_truth', `Partition ${receipt.partitionId} changed state without a declaration receipt.`);
    }
  }

  const resolutionReceipts = orderedUniqueReceipts(input.resolutionReceipts);
  const batches = new Map<string, string>();
  for (const receipt of resolutionReceipts) {
    requireExactKeys(receipt, [
      'receiptId', 'sequence', 'ordinal', 'at', 'identity', 'partitionId', 'attempt', 'summary',
      'artifactRef', 'provenanceSummaryRef', 'quarantineReviewRef',
    ], `resolution receipt ${receipt.receiptId}`);
    requireIdentifier(receipt.partitionId, `resolution receipt ${receipt.receiptId}.partitionId`);
    requireCount(receipt.attempt, `resolution receipt ${receipt.receiptId}.attempt`);
    const declaration = declared.get(receipt.partitionId);
    if (!declaration) {
      fail('corrupt_truth', `Resolution batch ${receipt.summary.batchId} targets an undeclared partition.`);
    }
    validateResolutionSummary(receipt.summary);
    if (compareReceiptPosition(receipt, declaration) <= 0) {
      fail('corrupt_truth', `Resolution batch ${receipt.summary.batchId} precedes its partition declaration.`);
    }
    const latestPartitionStatus = partitionReceipts
      .filter((candidate): candidate is Extract<
        WorkflowPartitionProjectionReceiptV1,
        { kind: 'status' }
      > => candidate.kind === 'status'
        && candidate.partitionId === receipt.partitionId
        && compareReceiptPosition(candidate, receipt) < 0)
      .at(-1);
    if (!latestPartitionStatus
      || latestPartitionStatus.state !== 'running'
      || latestPartitionStatus.attempt !== receipt.attempt) {
      fail(
        'corrupt_truth',
        `Resolution batch ${receipt.summary.batchId} is outside its active partition attempt.`,
      );
    }
    if (runStatusBefore(runReceipts, receipt) !== 'running') {
      fail('corrupt_truth', `Resolution batch ${receipt.summary.batchId} is outside an active run.`);
    }
    const prior = batches.get(receipt.summary.batchId);
    if (prior && prior !== receipt.receiptId) {
      fail('corrupt_truth', `Resolution batch ${receipt.summary.batchId} has multiple durable receipts.`);
    }
    batches.set(receipt.summary.batchId, receipt.receiptId);
    requireIdentifier(receipt.artifactRef, `resolution receipt ${receipt.receiptId}.artifactRef`);
    requireIdentifier(
      receipt.provenanceSummaryRef,
      `resolution receipt ${receipt.receiptId}.provenanceSummaryRef`,
    );
    if (receipt.summary.quarantinedObservations > 0 && !receipt.quarantineReviewRef) {
      fail('corrupt_truth', `Resolution batch ${receipt.summary.batchId} lacks a quarantine review reference.`);
    }
    if (receipt.summary.quarantinedObservations === 0 && receipt.quarantineReviewRef !== undefined) {
      fail('corrupt_truth', `Resolution batch ${receipt.summary.batchId} claims review work without quarantine.`);
    }
    if (receipt.quarantineReviewRef !== undefined) {
      requireIdentifier(
        receipt.quarantineReviewRef,
        `resolution receipt ${receipt.receiptId}.quarantineReviewRef`,
      );
    }
  }

  const coverageReceipt = input.coverageReceipt;
  requireExactKeys(coverageReceipt, [
    'receiptId', 'sequence', 'ordinal', 'at', 'identity', 'summary',
    'observedPartitionIds', 'evidenceRef',
  ], `coverage receipt ${coverageReceipt.receiptId}`);
  validateCoverageSummary(coverageReceipt.summary);
  if (coverageReceipt.summary.datasetId !== input.identity.datasetId) {
    fail('identity_mismatch', 'Coverage summary belongs to a different dataset.');
  }
  requireIdentifier(coverageReceipt.evidenceRef, 'coverageReceipt.evidenceRef');
  if (!Array.isArray(coverageReceipt.observedPartitionIds)) {
    fail('corrupt_truth', 'Coverage observedPartitionIds must be an array.');
  }
  let priorObserved = '';
  for (const [index, partitionId] of coverageReceipt.observedPartitionIds.entries()) {
    requireIdentifier(partitionId, `coverage observedPartitionIds[${index}]`);
    if (priorObserved && partitionId <= priorObserved) {
      fail('corrupt_truth', 'Coverage observed partition identities must be sorted and unique.');
    }
    if (!declared.has(partitionId)) {
      fail('identity_mismatch', `Coverage observed undeclared partition ${partitionId}.`);
    }
    priorObserved = partitionId;
  }
  if (coverageReceipt.observedPartitionIds.length
      !== coverageReceipt.summary.observedPartitions
    || partitionIdentityDigest(coverageReceipt.observedPartitionIds)
      !== coverageReceipt.summary.observedPartitionIndexDigest) {
    fail('corrupt_truth', 'Coverage observed partition membership contradicts its summary.');
  }
  if (coverageReceipt.summary.partitionUniverse === 'closed'
    && coverageReceipt.summary.declaredPartitions !== declared.size) {
    fail('corrupt_truth', 'Closed coverage partition count does not match workflow declarations.');
  }
  if (coverageReceipt.summary.partitionUniverse === 'closed'
    && coverageReceipt.summary.declaredPartitionIndexDigest
      !== partitionIdentityDigest([...declared.keys()])) {
    fail('identity_mismatch', 'Coverage and workflow declarations name different partition universes.');
  }
  validateRunLifecycle(
    runReceipts,
    [...partitionReceipts, ...resolutionReceipts, coverageReceipt],
  );
  const dataReceipts = [...partitionReceipts, ...resolutionReceipts]
    .sort(compareReceiptPosition);
  const latestDataPosition = dataReceipts.at(-1);
  if (latestDataPosition && (
    coverageReceipt.sequence < latestDataPosition.sequence
    || (coverageReceipt.sequence === latestDataPosition.sequence
      && coverageReceipt.ordinal <= latestDataPosition.ordinal)
  )) {
    fail('corrupt_truth', 'Coverage evidence must follow the partition and resolution facts it summarizes.');
  }

  // Prove every additive total is representable before constructing facts or
  // asking the Workspace reducer to sum the same deltas.
  const resolution = aggregateResolution(
    resolutionReceipts,
    input.resolutionStateAnchorDigest,
  );

  const facts: WorkspaceProjectionFactV1[] = [];
  for (const receipt of runReceipts) {
    facts.push({
      ...factBase('run_status', receipt),
      kind: 'run_status',
      runId: input.identity.runId,
      status: receipt.status,
    });
  }
  for (const receipt of partitionReceipts) {
    if (receipt.kind === 'declared') {
      facts.push({
        ...factBase('partition_declared', receipt),
        kind: 'partition_declared',
        partitionId: receipt.partitionId,
      });
    } else {
      facts.push({
        ...factBase('partition_status', receipt),
        kind: 'partition_status',
        partitionId: receipt.partitionId,
        state: receipt.state,
        attempt: receipt.attempt,
        ...(receipt.failureRef ? { failureRef: receipt.failureRef } : {}),
      });
    }
  }
  for (const receipt of resolutionReceipts) {
    facts.push({
      ...factBase('record_batch_committed', receipt),
      kind: 'record_batch_committed',
      partitionId: receipt.partitionId,
      observationCount: receipt.summary.observationsCommitted,
      canonicalRecordCount: receipt.summary.canonicalRecordsCreated,
      duplicateObservationCount: receipt.summary.duplicateObservations,
      artifactRef: receipt.artifactRef,
      provenanceSummaryRef: receipt.provenanceSummaryRef,
    });
  }
  facts.push({
    ...factBase('coverage_evidence', coverageReceipt),
    kind: 'coverage_evidence',
    status: projectionCoverageStatus(coverageReceipt.summary, partitionReceipts),
    ...(coverageReceipt.summary.partitionUniverse === 'closed'
      ? { declaredPartitions: coverageReceipt.summary.declaredPartitions }
      : {}),
    evidenceRef: coverageReceipt.evidenceRef,
  });
  facts.sort((left, right) => (
    left.sequence - right.sequence
    || left.ordinal - right.ordinal
    || compareCanonicalEntityText(left.factId, right.factId)
  ));

  try {
    // Validate the entity/workflow fact subset against the Workspace reducer.
    // The adapter deliberately does not return a committable snapshot: its
    // caller must compose independent workflow-owned schedule truth first.
    buildWorkspaceRunProjection(input.binding, facts);
  } catch (error) {
    fail(
      'corrupt_truth',
      `Workspace projection rejected the durable facts: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sourceDigest = sha256({
    version: 1,
    identity: input.identity,
    bindingDigest: input.bindingDigest,
    facts,
    coverage: coverageReceipt.summary,
    resolution,
    sourceReceiptDigests: sourceReceipts.map((receipt) => sha256(receipt)),
  });
  return deepFreeze({
    version: 1,
    identity: { ...input.identity },
    bindingDigest: input.bindingDigest,
    sourceDigest,
    facts,
    coverage: structuredClone(coverageReceipt.summary),
    resolution,
  });
}

/**
 * Pure projection adapter. It never persists, schedules, retries, or executes.
 * It emits no schedule fact and no committable snapshot. A workflow-owned
 * compositor may add its schedule facts, reduce the full set, and only then
 * commit through the Workspace CAS against the current binding revision.
 */
export function adaptCanonicalEntityTruthToWorkspaceProjection(
  input: AdaptCanonicalEntityWorkspaceProjectionInputV1,
): AdaptCanonicalEntityWorkspaceProjectionResult {
  try {
    return { ok: true, value: adaptOrThrow(input) };
  } catch (error) {
    if (error instanceof CanonicalWorkspaceProjectionError) {
      return { ok: false, kind: error.kind, errors: [error.message] };
    }
    return {
      ok: false,
      kind: 'corrupt_truth',
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
