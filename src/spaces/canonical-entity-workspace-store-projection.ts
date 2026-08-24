import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import {
  canonicalEntityJson,
  canonicalEntitySha256,
  compareCanonicalEntityText,
  createEntityResolutionState,
  type CoverageDenominator,
} from '../execution/canonical-entity-resolution.js';
import {
  getCanonicalDataset,
  openCanonicalEntityStoreDb,
  summarizeStoredDatasetCoverage,
  type CanonicalDatasetRecordV1,
  type DurableCanonicalResolutionSummaryV1,
} from '../execution/canonical-entity-store.js';
import {
  adaptCanonicalEntityTruthToWorkspaceProjection,
  type CanonicalResolutionProjectionReceiptV1,
  type CanonicalResolutionProjectionSummaryV1,
  type CanonicalWorkspaceResolutionProjectionSummaryV1,
  type CanonicalWorkspaceProjectionIdentityV1,
  type DatasetCoverageProjectionReceiptV1,
  type DatasetCoverageProjectionSummaryV1,
  type WorkflowPartitionProjectionReceiptV1,
  type WorkflowRunProjectionReceiptV1,
} from './canonical-entity-workspace-projection.js';
import { ensureWorkspaceSchema } from './workspace-db-schema.js';
import { openWorkspaceDb } from './workspace-db.js';
import {
  getWorkflowSurfaceBinding,
  getWorkspaceRunProjection,
  putWorkspaceRunProjection,
} from './workflow-surface-binding-store.js';
import {
  buildWorkspaceRunProjection,
  canonicalWorkspaceProjectionJson,
  workspaceRunProjectionDigest,
  type WorkspaceProjectionFactV1,
  type WorkspaceRunProjectionSnapshotV1,
} from './workflow-surface-binding.js';

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/\-]{0,255}$/;
const MAX_PROJECTED_REFS = 256;
const MAX_SIDECAR_BYTES = 128 * 1024;
const QUARANTINE_REASONS = new Set([
  'exact_identifier_collision',
  'conflicting_exact_identifier',
  'ambiguous_candidates',
  'threshold_uncertainty',
  'canonical_id_collision',
]);
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

type ScheduleFactV1 = Extract<WorkspaceProjectionFactV1, { kind: 'schedule' }>;

export interface CanonicalDatasetProjectionAuthorityV1 {
  version: 1;
  contractDigest: string;
  resolutionRevision: number;
  resolutionRoot: string;
  coverageRevision: number;
  coverageRoot: string;
}

export interface CanonicalEntityBatchProjectionLineageV1 {
  version: 1;
  batchId: string;
  partitionId: string;
  attempt: number;
  sequence: number;
  ordinal: number;
}

export interface CanonicalCoverageProjectionPositionV1 {
  version: 1;
  sequence: number;
  ordinal: number;
}

export interface CanonicalEntityWorkspaceProjectionHeadV1 {
  version: 1;
  identity: CanonicalWorkspaceProjectionIdentityV1;
  bindingDigest: string;
  datasetAuthority: CanonicalDatasetProjectionAuthorityV1;
  canonicalSourceDigest: string;
  workspaceProjectionDigest: string;
  source: {
    resolutionBatchCount: number;
    recordArtifactRefCount: number;
    recordArtifactRefs: readonly string[];
  };
  records: {
    observationsCommitted: number;
    canonicalRecordsCreated: number;
    mergedObservations: number;
    replayedObservations: number;
    duplicateObservations: number;
  };
  provenance: {
    assertionCount: number;
    summedBatchOriginCount: number;
    summaryRefCount: number;
    summaryRefs: readonly string[];
  };
  quarantine: {
    observationCount: number;
    reasons: Readonly<Record<string, number>>;
    reviewRefCount: number;
    reviewRefs: readonly string[];
  };
  coverage: {
    status: DatasetCoverageProjectionSummaryV1['status'];
    sourceStatus: DatasetCoverageProjectionSummaryV1['sourceStatus'];
    partitionUniverse: DatasetCoverageProjectionSummaryV1['partitionUniverse'];
    declaredPartitions?: number;
    observedPartitions: number;
    observed: number;
    denominator: CoverageDenominator;
    exhaustion: DatasetCoverageProjectionSummaryV1['exhaustion'];
    reasons: readonly string[];
    evidenceRef: string;
  };
  projectedAt: string;
}

export interface ProjectCanonicalEntityStoreToWorkspaceInputV1 {
  version: 1;
  identity: CanonicalWorkspaceProjectionIdentityV1;
  expectedBindingDigest: string;
  expectedDatasetAuthority: CanonicalDatasetProjectionAuthorityV1;
  runReceipts: readonly WorkflowRunProjectionReceiptV1[];
  partitionReceipts: readonly WorkflowPartitionProjectionReceiptV1[];
  batchLineage: readonly CanonicalEntityBatchProjectionLineageV1[];
  coveragePosition: CanonicalCoverageProjectionPositionV1;
  /** Schedule facts are supplied by workflow authority; this adapter only visualizes them. */
  scheduleFacts?: readonly ScheduleFactV1[];
  expectedHeadDigest?: string;
  entityDb?: Database.Database;
  workspaceDb?: Database.Database;
}

export type CanonicalEntityWorkspaceProjectionFailureKind =
  | 'invalid'
  | 'identity_mismatch'
  | 'stale_source'
  | 'corrupt_source'
  | 'conflict';

export type ProjectCanonicalEntityStoreToWorkspaceResult =
  | {
      ok: true;
      inserted: boolean;
      head: CanonicalEntityWorkspaceProjectionHeadV1;
      headDigest: string;
      snapshot: WorkspaceRunProjectionSnapshotV1;
      projectionDigest: string;
    }
  | {
      ok: false;
      kind: CanonicalEntityWorkspaceProjectionFailureKind;
      errors: readonly string[];
    };

interface ProjectionHeadRow {
  binding_id: string;
  workflow_id: string;
  workspace_id: string;
  run_id: string;
  dataset_id: string;
  binding_digest: string;
  dataset_contract_digest: string;
  resolution_revision: number;
  resolution_root: string;
  coverage_revision: number;
  coverage_root: string;
  canonical_source_digest: string;
  workspace_projection_digest: string;
  head_digest: string;
  sidecar_json: string;
  projected_at: string;
}

interface ResolutionBatchRow {
  dataset_id: string;
  batch_id: string;
  batch_ordinal: number;
  input_digest: string;
  policy_digest: string;
  previous_digest: string;
  next_digest: string;
  summary_id: string;
  summary_json: string;
  committed_at: string;
}

interface ResolutionCountsRow {
  unique_observations: number;
  observations_committed: number;
  canonical_records_created: number;
  merged_observations: number;
  quarantined_observations: number;
  replayed_observations: number;
}

class ProjectionFailure extends Error {
  constructor(
    readonly kind: CanonicalEntityWorkspaceProjectionFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalEntityWorkspaceProjectionFailure';
  }
}

function fail(kind: CanonicalEntityWorkspaceProjectionFailureKind, message: string): never {
  throw new ProjectionFailure(kind, message);
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalWorkspaceProjectionJson(value), 'utf8')
    .digest('hex');
}

function prefixedDigest(prefix: string, value: unknown): string {
  return `${prefix}:${sha256(value)}`;
}

function exactDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('invalid', `${label} must be sha256 hex.`);
  return value;
}

function exactIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail('invalid', `${label} must be a canonical bounded identifier.`);
  }
  return value;
}

function exactCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail('invalid', `${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function exactIso(value: unknown, label: string): string {
  if (typeof value !== 'string') fail('invalid', `${label} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail('invalid', `${label} must be an exact ISO timestamp.`);
  }
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  if (left > Number.MAX_SAFE_INTEGER - right) fail('corrupt_source', `${label} exceeds safe integer range.`);
  return left + right;
}

function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('corrupt_source', `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort(compareCanonicalEntityText);
  const expected = [...keys].sort(compareCanonicalEntityText);
  if (canonicalEntityJson(actual) !== canonicalEntityJson(expected)) {
    fail('corrupt_source', `${label} has an unsupported shape.`);
  }
}

function validateDatasetAuthority(
  value: CanonicalDatasetProjectionAuthorityV1,
): CanonicalDatasetProjectionAuthorityV1 {
  exactKeys(value, [
    'version', 'contractDigest', 'resolutionRevision', 'resolutionRoot',
    'coverageRevision', 'coverageRoot',
  ], 'expectedDatasetAuthority');
  if (value.version !== 1) fail('invalid', 'expectedDatasetAuthority.version must be 1.');
  exactDigest(value.contractDigest, 'dataset contract digest');
  exactCount(value.resolutionRevision, 'resolution revision');
  exactDigest(value.resolutionRoot, 'resolution root');
  exactCount(value.coverageRevision, 'coverage revision');
  exactDigest(value.coverageRoot, 'coverage root');
  return value;
}

function authorityFromDataset(dataset: CanonicalDatasetRecordV1): CanonicalDatasetProjectionAuthorityV1 {
  return {
    version: 1,
    contractDigest: dataset.contractDigest,
    resolutionRevision: dataset.resolutionRevision,
    resolutionRoot: dataset.resolutionDigest,
    coverageRevision: dataset.coverageRevision,
    coverageRoot: dataset.coverageDigest,
  };
}

function sameAuthority(
  left: CanonicalDatasetProjectionAuthorityV1,
  right: CanonicalDatasetProjectionAuthorityV1,
): boolean {
  return canonicalEntityJson(left) === canonicalEntityJson(right);
}

function partitionIndexDigest(partitionIds: readonly string[]): string {
  return sha256({
    version: 1,
    partitionIds: [...partitionIds].sort(compareCanonicalEntityText),
  });
}

function parseStoredSummary(row: ResolutionBatchRow): DurableCanonicalResolutionSummaryV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.summary_json);
  } catch {
    fail('corrupt_source', `Resolution batch ${row.batch_id} has malformed summary JSON.`);
  }
  exactKeys(parsed, [
    'version', 'summaryId', 'batchId', 'previousAuthorityRoot', 'nextAuthorityRoot',
    'uniqueObservationCount', 'observationsCommitted', 'canonicalRecordsCreated',
    'mergedObservations', 'quarantinedObservations', 'replayedObservations',
    'duplicateObservationIdentities', 'duplicateObservations',
    'provenanceAssertions', 'provenanceOrigins', 'quarantineReasons',
  ], `resolution batch ${row.batch_id} summary`);
  return parsed as unknown as DurableCanonicalResolutionSummaryV1;
}

function deriveStoredBatchSummary(
  db: Database.Database,
  row: ResolutionBatchRow,
): DurableCanonicalResolutionSummaryV1 {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS unique_observations,
      COALESCE(SUM(CASE WHEN idempotent = 0 THEN 1 ELSE 0 END), 0) AS observations_committed,
      COALESCE(SUM(CASE WHEN idempotent = 0 AND decision_kind = 'distinct' THEN 1 ELSE 0 END), 0)
        AS canonical_records_created,
      COALESCE(SUM(CASE WHEN idempotent = 0 AND decision_kind = 'merge' THEN 1 ELSE 0 END), 0)
        AS merged_observations,
      COALESCE(SUM(CASE WHEN idempotent = 0 AND decision_kind = 'quarantine' THEN 1 ELSE 0 END), 0)
        AS quarantined_observations,
      COALESCE(SUM(CASE WHEN idempotent = 1 THEN 1 ELSE 0 END), 0) AS replayed_observations
    FROM canonical_resolution_batch_results
    WHERE dataset_id = ? AND batch_id = ?
  `).get(row.dataset_id, row.batch_id) as ResolutionCountsRow;
  const duplicates = db.prepare(`
    SELECT
      COUNT(*) AS identities,
      COALESCE(SUM(CASE WHEN result.idempotent = 0 THEN 1 ELSE 0 END), 0) AS committed
    FROM canonical_resolution_batch_duplicates duplicate
    JOIN canonical_resolution_batch_results result
      ON result.dataset_id = duplicate.dataset_id
      AND result.batch_id = duplicate.batch_id
      AND result.observation_id = duplicate.observation_id
    WHERE duplicate.dataset_id = ? AND duplicate.batch_id = ?
  `).get(row.dataset_id, row.batch_id) as { identities: number; committed: number };
  const provenanceAssertions = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM canonical_resolution_batch_results result
    JOIN canonical_observation_fields field
      ON field.dataset_id = result.dataset_id AND field.observation_id = result.observation_id
    WHERE result.dataset_id = ? AND result.batch_id = ? AND result.idempotent = 0
  `).get(row.dataset_id, row.batch_id) as { count: number }).count;
  const provenanceOrigins = (db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT field.provenance_source_id, field.provenance_record_id
      FROM canonical_resolution_batch_results result
      JOIN canonical_observation_fields field
        ON field.dataset_id = result.dataset_id AND field.observation_id = result.observation_id
      WHERE result.dataset_id = ? AND result.batch_id = ? AND result.idempotent = 0
      GROUP BY field.provenance_source_id, field.provenance_record_id
    )
  `).get(row.dataset_id, row.batch_id) as { count: number }).count;
  const reasonRows = db.prepare(`
    SELECT decision.quarantine_reason AS reason, COUNT(*) AS count
    FROM canonical_resolution_batch_results result
    JOIN canonical_decisions decision
      ON decision.dataset_id = result.dataset_id AND decision.observation_id = result.observation_id
    WHERE result.dataset_id = ? AND result.batch_id = ?
      AND result.idempotent = 0 AND result.decision_kind = 'quarantine'
    GROUP BY decision.quarantine_reason
    ORDER BY decision.quarantine_reason
  `).all(row.dataset_id, row.batch_id) as Array<{ reason: string; count: number }>;
  const quarantineReasons: Record<string, number> = {};
  for (const reason of reasonRows) {
    if (!QUARANTINE_REASONS.has(reason.reason)) {
      fail('corrupt_source', `Resolution batch ${row.batch_id} has an unsupported quarantine reason.`);
    }
    quarantineReasons[reason.reason] = exactCount(reason.count, `quarantine reason ${reason.reason}`);
  }
  const content = {
    version: 1 as const,
    batchId: row.batch_id,
    previousAuthorityRoot: row.previous_digest,
    nextAuthorityRoot: row.next_digest,
    uniqueObservationCount: exactCount(counts.unique_observations, 'unique observations'),
    observationsCommitted: exactCount(counts.observations_committed, 'observations committed'),
    canonicalRecordsCreated: exactCount(counts.canonical_records_created, 'canonical records created'),
    mergedObservations: exactCount(counts.merged_observations, 'merged observations'),
    quarantinedObservations: exactCount(counts.quarantined_observations, 'quarantined observations'),
    replayedObservations: exactCount(counts.replayed_observations, 'replayed observations'),
    duplicateObservationIdentities: exactCount(duplicates.identities, 'duplicate identities'),
    duplicateObservations: exactCount(duplicates.committed, 'duplicate observations'),
    provenanceAssertions: exactCount(provenanceAssertions, 'provenance assertions'),
    provenanceOrigins: exactCount(provenanceOrigins, 'provenance origins'),
    quarantineReasons,
  };
  const summary: DurableCanonicalResolutionSummaryV1 = {
    ...content,
    summaryId: `canonical-resolution-store-summary:v1:${canonicalEntitySha256(content)}`,
  };
  const stored = parseStoredSummary(row);
  if (row.summary_id !== summary.summaryId
    || canonicalEntityJson(stored) !== canonicalEntityJson(summary)) {
    fail('corrupt_source', `Resolution batch ${row.batch_id} summary is not derivable from normalized rows.`);
  }
  return summary;
}

function projectionResolutionSummary(
  summary: DurableCanonicalResolutionSummaryV1,
): CanonicalResolutionProjectionSummaryV1 {
  const content = {
    version: 1 as const,
    batchId: summary.batchId,
    previousResolutionStateDigest: summary.previousAuthorityRoot,
    nextResolutionStateDigest: summary.nextAuthorityRoot,
    uniqueObservationCount: summary.uniqueObservationCount,
    observationsCommitted: summary.observationsCommitted,
    canonicalRecordsCreated: summary.canonicalRecordsCreated,
    mergedObservations: summary.mergedObservations,
    quarantinedObservations: summary.quarantinedObservations,
    replayedObservations: summary.replayedObservations,
    duplicateObservationIdentities: summary.duplicateObservationIdentities,
    duplicateObservations: summary.duplicateObservations,
    provenanceAssertions: summary.provenanceAssertions,
    provenanceOrigins: summary.provenanceOrigins,
    quarantineReasons: summary.quarantineReasons,
  };
  return {
    ...content,
    summaryId: prefixedDigest('canonical-resolution-projection:v1', content),
  };
}

function sourceStatusForCoverage(input: {
  status: DatasetCoverageProjectionSummaryV1['status'];
  cursorCycleDetected: boolean;
  reasons: readonly string[];
  dataset: CanonicalDatasetRecordV1;
  observed: number;
  observedPartitionIds: readonly string[];
}): DatasetCoverageProjectionSummaryV1['sourceStatus'] {
  if (!input.cursorCycleDetected) return input.status;
  const nonCycleReasons = input.reasons.filter((reason) => reason !== 'cursor_cycle_detected');
  if (input.dataset.universe.kind === 'closed'
    && input.dataset.denominator.kind === 'exact'
    && input.observed === input.dataset.denominator.total
    && input.observedPartitionIds.length === input.dataset.universe.partitionIds.length
    && partitionIndexDigest(input.observedPartitionIds)
      === partitionIndexDigest(input.dataset.universe.partitionIds)
    && nonCycleReasons.length === 0) {
    return 'complete';
  }
  return input.status;
}

function coverageProjectionSummary(input: {
  dataset: CanonicalDatasetRecordV1;
  observedPartitionIds: readonly string[];
  summary: NonNullable<ReturnType<typeof summarizeStoredDatasetCoverage>>;
}): DatasetCoverageProjectionSummaryV1 {
  const reasons = [...input.summary.reasons].sort(compareCanonicalEntityText);
  for (const reason of reasons) {
    if (!COVERAGE_REASONS.has(reason)) fail('corrupt_source', `Unsupported coverage reason ${reason}.`);
  }
  const content = {
    version: 1 as const,
    datasetId: input.dataset.datasetId,
    partitionUniverse: input.dataset.universe.kind,
    ...(input.dataset.universe.kind === 'closed'
      ? {
          declaredPartitions: input.dataset.universe.partitionIds.length,
          declaredPartitionIndexDigest: partitionIndexDigest(input.dataset.universe.partitionIds),
        }
      : {}),
    observedPartitions: input.observedPartitionIds.length,
    observedPartitionIndexDigest: partitionIndexDigest(input.observedPartitionIds),
    status: input.summary.status,
    sourceStatus: sourceStatusForCoverage({
      status: input.summary.status,
      cursorCycleDetected: input.summary.cursorCycleDetected,
      reasons,
      dataset: input.dataset,
      observed: input.summary.observed,
      observedPartitionIds: input.observedPartitionIds,
    }),
    observed: input.summary.observed,
    denominator: input.summary.denominator,
    exhaustion: input.summary.exhaustion,
    reasons,
  };
  return {
    ...content,
    summaryId: prefixedDigest('dataset-coverage-projection:v1', content),
  };
}

function ref(prefix: string, value: unknown): string {
  return `${prefix}:v1:${sha256(value)}`;
}

function validateLineage(
  rows: readonly ResolutionBatchRow[],
  lineage: readonly CanonicalEntityBatchProjectionLineageV1[],
): Map<string, CanonicalEntityBatchProjectionLineageV1> {
  if (!Array.isArray(lineage)) fail('invalid', 'batchLineage must be an array.');
  const byBatch = new Map<string, CanonicalEntityBatchProjectionLineageV1>();
  for (const [index, entry] of lineage.entries()) {
    exactKeys(entry, [
      'version', 'batchId', 'partitionId', 'attempt', 'sequence', 'ordinal',
    ], `batchLineage[${index}]`);
    if (entry.version !== 1) fail('invalid', `batchLineage[${index}].version must be 1.`);
    const batchId = exactIdentifier(entry.batchId, `batchLineage[${index}].batchId`);
    exactIdentifier(entry.partitionId, `batchLineage[${index}].partitionId`);
    exactCount(entry.attempt, `batchLineage[${index}].attempt`);
    exactCount(entry.sequence, `batchLineage[${index}].sequence`);
    exactCount(entry.ordinal, `batchLineage[${index}].ordinal`);
    if (byBatch.has(batchId)) fail('invalid', `Batch ${batchId} has duplicate lineage.`);
    byBatch.set(batchId, entry as unknown as CanonicalEntityBatchProjectionLineageV1);
  }
  if (byBatch.size !== rows.length
    || rows.some((row) => !byBatch.has(row.batch_id))) {
    fail('identity_mismatch', 'Batch lineage must name every retained resolution batch exactly once.');
  }
  let priorSequence = -1;
  let priorOrdinal = -1;
  for (const row of rows) {
    const entry = byBatch.get(row.batch_id)!;
    if (entry.sequence < priorSequence
      || (entry.sequence === priorSequence && entry.ordinal <= priorOrdinal)) {
      fail('invalid', 'Batch lineage positions must follow resolution authority order.');
    }
    priorSequence = entry.sequence;
    priorOrdinal = entry.ordinal;
  }
  return byBatch;
}

interface EntityProjectionTruth {
  dataset: CanonicalDatasetRecordV1;
  resolutionAnchor: string;
  resolutionReceipts: CanonicalResolutionProjectionReceiptV1[];
  coverageReceipt: DatasetCoverageProjectionReceiptV1;
}

function readEntityProjectionTruth(
  input: ProjectCanonicalEntityStoreToWorkspaceInputV1,
  db: Database.Database,
): EntityProjectionTruth {
  const dataset = getCanonicalDataset(input.identity.datasetId, db);
  if (!dataset) fail('stale_source', `Dataset ${input.identity.datasetId} does not exist.`);
  const authority = authorityFromDataset(dataset);
  if (!sameAuthority(authority, input.expectedDatasetAuthority)) {
    fail('stale_source', 'Canonical dataset authority changed after it was reviewed.');
  }
  const rows = db.prepare(`
    SELECT * FROM canonical_resolution_batches
    WHERE dataset_id = ? ORDER BY batch_ordinal
  `).all(dataset.datasetId) as ResolutionBatchRow[];
  if (rows.length !== dataset.resolutionRevision) {
    fail('corrupt_source', 'Resolution revision does not match the normalized batch ledger.');
  }
  const initialRoot = canonicalEntitySha256({ version: 1, state: createEntityResolutionState() });
  let root = initialRoot;
  for (const [index, row] of rows.entries()) {
    if (row.dataset_id !== dataset.datasetId
      || row.batch_ordinal !== index + 1
      || row.previous_digest !== root
      || !DIGEST.test(row.next_digest)
      || !DIGEST.test(row.input_digest)
      || !IDENTIFIER.test(row.policy_digest)) {
      fail('corrupt_source', `Resolution batch ordinal ${index + 1} breaks the authority chain.`);
    }
    root = row.next_digest;
  }
  if (root !== dataset.resolutionDigest) {
    fail('corrupt_source', 'Resolution ledger head does not match the dataset authority root.');
  }
  const lineage = validateLineage(rows, input.batchLineage);
  const resolutionReceipts = rows.map((row) => {
    const summary = projectionResolutionSummary(deriveStoredBatchSummary(db, row));
    const link = lineage.get(row.batch_id)!;
    const artifactRef = ref('canonical-record-batch', {
      datasetId: dataset.datasetId,
      batchOrdinal: row.batch_ordinal,
      batchId: row.batch_id,
      authorityRoot: row.next_digest,
    });
    const provenanceSummaryRef = ref('canonical-provenance-summary', {
      datasetId: dataset.datasetId,
      batchOrdinal: row.batch_ordinal,
      batchId: row.batch_id,
      authorityRoot: row.next_digest,
    });
    const quarantineReviewRef = summary.quarantinedObservations > 0
      ? ref('canonical-quarantine-review', {
          datasetId: dataset.datasetId,
          batchOrdinal: row.batch_ordinal,
          batchId: row.batch_id,
          authorityRoot: row.next_digest,
        })
      : undefined;
    return {
      receiptId: ref('canonical-resolution-receipt', {
        datasetId: dataset.datasetId,
        batchId: row.batch_id,
        authorityRoot: row.next_digest,
      }),
      sequence: link.sequence,
      ordinal: link.ordinal,
      at: exactIso(row.committed_at, `resolution batch ${row.batch_id} committedAt`),
      identity: input.identity,
      partitionId: link.partitionId,
      attempt: link.attempt,
      summary,
      artifactRef,
      provenanceSummaryRef,
      ...(quarantineReviewRef ? { quarantineReviewRef } : {}),
    } satisfies CanonicalResolutionProjectionReceiptV1;
  });
  const storedCoverage = summarizeStoredDatasetCoverage(dataset.datasetId, db);
  if (!storedCoverage
    || storedCoverage.coverageRevision !== dataset.coverageRevision
    || storedCoverage.coverageDigest !== dataset.coverageDigest) {
    fail('corrupt_source', 'Coverage summary does not match the dataset authority root.');
  }
  const observedPartitionIds = (db.prepare(`
    SELECT partition_id FROM canonical_coverage_partitions
    WHERE dataset_id = ? ORDER BY partition_id
  `).all(dataset.datasetId) as Array<{ partition_id: string }>).map((row) => row.partition_id);
  if (observedPartitionIds.length !== storedCoverage.observedPartitions) {
    fail('corrupt_source', 'Coverage partition count does not match normalized rows.');
  }
  const coverageSummary = coverageProjectionSummary({
    dataset,
    observedPartitionIds,
    summary: storedCoverage,
  });
  exactKeys(input.coveragePosition, ['version', 'sequence', 'ordinal'], 'coveragePosition');
  if (input.coveragePosition.version !== 1) fail('invalid', 'coveragePosition.version must be 1.');
  const sequence = exactCount(input.coveragePosition.sequence, 'coveragePosition.sequence');
  const ordinal = exactCount(input.coveragePosition.ordinal, 'coveragePosition.ordinal');
  const evidenceRef = ref('canonical-coverage-evidence', {
    datasetId: dataset.datasetId,
    coverageRevision: dataset.coverageRevision,
    coverageRoot: dataset.coverageDigest,
  });
  return {
    dataset,
    resolutionAnchor: initialRoot,
    resolutionReceipts,
    coverageReceipt: {
      receiptId: ref('canonical-coverage-receipt', {
        datasetId: dataset.datasetId,
        coverageRevision: dataset.coverageRevision,
        coverageRoot: dataset.coverageDigest,
      }),
      sequence,
      ordinal,
      at: dataset.updatedAt,
      identity: input.identity,
      summary: coverageSummary,
      observedPartitionIds,
      evidenceRef,
    },
  };
}

function sortedRefs(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCanonicalEntityText);
}

function buildHead(input: {
  identity: CanonicalWorkspaceProjectionIdentityV1;
  bindingDigest: string;
  authority: CanonicalDatasetProjectionAuthorityV1;
  canonicalSourceDigest: string;
  snapshot: WorkspaceRunProjectionSnapshotV1;
  resolution: CanonicalWorkspaceResolutionProjectionSummaryV1;
  coverage: DatasetCoverageProjectionSummaryV1;
  resolutionReceipts: readonly CanonicalResolutionProjectionReceiptV1[];
  evidenceRef: string;
}): CanonicalEntityWorkspaceProjectionHeadV1 {
  const artifactRefs = sortedRefs(input.resolutionReceipts.map((receipt) => receipt.artifactRef));
  const provenanceRefs = sortedRefs(
    input.resolutionReceipts.map((receipt) => receipt.provenanceSummaryRef),
  );
  const head: CanonicalEntityWorkspaceProjectionHeadV1 = {
    version: 1,
    identity: { ...input.identity },
    bindingDigest: input.bindingDigest,
    datasetAuthority: { ...input.authority },
    canonicalSourceDigest: input.canonicalSourceDigest,
    workspaceProjectionDigest: workspaceRunProjectionDigest(input.snapshot.projection),
    source: {
      resolutionBatchCount: input.resolution.batchCount,
      recordArtifactRefCount: artifactRefs.length,
      recordArtifactRefs: artifactRefs.slice(0, MAX_PROJECTED_REFS),
    },
    records: {
      observationsCommitted: input.resolution.observationsCommitted,
      canonicalRecordsCreated: input.resolution.canonicalRecordsCreated,
      mergedObservations: input.resolution.mergedObservations,
      replayedObservations: input.resolution.replayedObservations,
      duplicateObservations: input.resolution.duplicateObservations,
    },
    provenance: {
      assertionCount: input.resolution.provenanceAssertions,
      summedBatchOriginCount: input.resolution.summedBatchProvenanceOrigins,
      summaryRefCount: provenanceRefs.length,
      summaryRefs: provenanceRefs.slice(0, MAX_PROJECTED_REFS),
    },
    quarantine: {
      observationCount: input.resolution.quarantinedObservations,
      reasons: input.resolution.quarantineReasons,
      reviewRefCount: input.resolution.quarantineReviewRefCount,
      reviewRefs: [...input.resolution.quarantineReviewRefs],
    },
    coverage: {
      status: input.coverage.status,
      sourceStatus: input.coverage.sourceStatus,
      partitionUniverse: input.coverage.partitionUniverse,
      ...(input.coverage.declaredPartitions !== undefined
        ? { declaredPartitions: input.coverage.declaredPartitions }
        : {}),
      observedPartitions: input.coverage.observedPartitions,
      observed: input.coverage.observed,
      denominator: input.coverage.denominator,
      exhaustion: input.coverage.exhaustion,
      reasons: [...input.coverage.reasons],
      evidenceRef: input.evidenceRef,
    },
    projectedAt: input.snapshot.projection.updatedAt,
  };
  const bytes = Buffer.byteLength(canonicalEntityJson(head), 'utf8');
  if (bytes > MAX_SIDECAR_BYTES) fail('invalid', `Canonical projection sidecar exceeds ${MAX_SIDECAR_BYTES} bytes.`);
  return head;
}

function rowForHead(db: Database.Database, bindingId: string): ProjectionHeadRow | undefined {
  return db.prepare(`
    SELECT * FROM workspace_canonical_entity_projection_heads
    WHERE binding_id = ? LIMIT 1
  `).get(bindingId) as ProjectionHeadRow | undefined;
}

function exactKeysWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('corrupt_source', `${label} must be an object.`);
  }
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))
    || actual.some((key) => !allowed.has(key))) {
    fail('corrupt_source', `${label} has an unsupported shape.`);
  }
}

function validateBoundedRefs(value: unknown, count: number, label: string): void {
  if (!Array.isArray(value) || value.length !== Math.min(count, MAX_PROJECTED_REFS)) {
    fail('corrupt_source', `${label} does not match its exact reference count.`);
  }
  let prior = '';
  for (const [index, candidate] of value.entries()) {
    const current = exactIdentifier(candidate, `${label}[${index}]`);
    if (prior && current <= prior) fail('corrupt_source', `${label} must be sorted and unique.`);
    prior = current;
  }
}

function validateDenominator(value: unknown): asserts value is CoverageDenominator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('corrupt_source', 'Coverage denominator must be typed.');
  }
  const denominator = value as Record<string, unknown>;
  if (denominator.kind === 'exact') {
    exactKeys(denominator, ['kind', 'total'], 'coverage exact denominator');
    exactCount(denominator.total, 'coverage exact denominator total');
  } else if (denominator.kind === 'lower_bound') {
    exactKeys(denominator, ['kind', 'atLeast'], 'coverage lower-bound denominator');
    exactCount(denominator.atLeast, 'coverage lower-bound denominator value');
  } else if (denominator.kind === 'unknown') {
    exactKeys(denominator, ['kind'], 'coverage unknown denominator');
  } else {
    fail('corrupt_source', 'Coverage denominator kind is unsupported.');
  }
}

function validateCoverageReasons(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > COVERAGE_REASONS.size) {
    fail('corrupt_source', 'Coverage reasons exceed the bounded vocabulary.');
  }
  let prior = '';
  for (const candidate of value) {
    if (typeof candidate !== 'string'
      || !COVERAGE_REASONS.has(candidate)
      || (prior && candidate <= prior)) {
      fail('corrupt_source', 'Coverage reasons are unsupported or unsorted.');
    }
    prior = candidate;
  }
}

function validateHeadShape(value: unknown): asserts value is CanonicalEntityWorkspaceProjectionHeadV1 {
  exactKeys(value, [
    'version', 'identity', 'bindingDigest', 'datasetAuthority',
    'canonicalSourceDigest', 'workspaceProjectionDigest', 'source', 'records',
    'provenance', 'quarantine', 'coverage', 'projectedAt',
  ], 'canonical entity Workspace projection head');
  if (value.version !== 1) fail('corrupt_source', 'Projection head version must be 1.');
  exactKeys(value.identity, ['version', 'bindingId', 'workflowId', 'workspaceId', 'runId', 'datasetId'], 'projection identity');
  if (value.identity.version !== 1) fail('corrupt_source', 'Projection identity version must be 1.');
  for (const field of ['bindingId', 'workflowId', 'workspaceId', 'runId', 'datasetId'] as const) {
    exactIdentifier(value.identity[field], `projection identity ${field}`);
  }
  exactKeys(value.datasetAuthority, [
    'version', 'contractDigest', 'resolutionRevision', 'resolutionRoot',
    'coverageRevision', 'coverageRoot',
  ], 'projection dataset authority');
  validateDatasetAuthority(value.datasetAuthority as unknown as CanonicalDatasetProjectionAuthorityV1);
  exactDigest(value.bindingDigest, 'head binding digest');
  exactDigest(value.canonicalSourceDigest, 'head source digest');
  exactDigest(value.workspaceProjectionDigest, 'head projection digest');
  exactKeys(value.source, [
    'resolutionBatchCount', 'recordArtifactRefCount', 'recordArtifactRefs',
  ], 'projection source summary');
  const batchCount = exactCount(value.source.resolutionBatchCount, 'source resolutionBatchCount');
  const artifactRefCount = exactCount(value.source.recordArtifactRefCount, 'source recordArtifactRefCount');
  validateBoundedRefs(value.source.recordArtifactRefs, artifactRefCount, 'source recordArtifactRefs');
  if (artifactRefCount !== batchCount) {
    fail('corrupt_source', 'Every projected resolution batch must have one record artifact reference.');
  }
  exactKeys(value.records, [
    'observationsCommitted', 'canonicalRecordsCreated', 'mergedObservations',
    'replayedObservations', 'duplicateObservations',
  ], 'projection record summary');
  const observationsCommitted = exactCount(
    value.records.observationsCommitted,
    'records observationsCommitted',
  );
  const canonicalRecordsCreated = exactCount(
    value.records.canonicalRecordsCreated,
    'records canonicalRecordsCreated',
  );
  const mergedObservations = exactCount(value.records.mergedObservations, 'records mergedObservations');
  exactCount(value.records.replayedObservations, 'records replayedObservations');
  const duplicateObservations = exactCount(
    value.records.duplicateObservations,
    'records duplicateObservations',
  );
  exactKeys(value.provenance, [
    'assertionCount', 'summedBatchOriginCount', 'summaryRefCount', 'summaryRefs',
  ], 'projection provenance summary');
  exactCount(value.provenance.assertionCount, 'provenance assertionCount');
  exactCount(value.provenance.summedBatchOriginCount, 'provenance summedBatchOriginCount');
  const provenanceRefCount = exactCount(value.provenance.summaryRefCount, 'provenance summaryRefCount');
  validateBoundedRefs(value.provenance.summaryRefs, provenanceRefCount, 'provenance summaryRefs');
  if (provenanceRefCount !== batchCount) {
    fail('corrupt_source', 'Every projected resolution batch must have one provenance summary reference.');
  }
  exactKeys(value.quarantine, [
    'observationCount', 'reasons', 'reviewRefCount', 'reviewRefs',
  ], 'projection quarantine summary');
  const quarantineCount = exactCount(value.quarantine.observationCount, 'quarantine observationCount');
  if (!value.quarantine.reasons
    || typeof value.quarantine.reasons !== 'object'
    || Array.isArray(value.quarantine.reasons)) {
    fail('corrupt_source', 'Projection quarantine reasons must be a count record.');
  }
  const quarantineReasons = value.quarantine.reasons as Record<string, unknown>;
  let reasonTotal = 0;
  let priorReason = '';
  for (const [reason, count] of Object.entries(quarantineReasons)) {
    if (!QUARANTINE_REASONS.has(reason) || (priorReason && reason <= priorReason)) {
      fail('corrupt_source', 'Projection quarantine reasons are unsupported or unsorted.');
    }
    reasonTotal = safeAdd(reasonTotal, exactCount(count, `quarantine reason ${reason}`), 'quarantine reasons');
    priorReason = reason;
  }
  if (reasonTotal !== quarantineCount
    || observationsCommitted !== safeAdd(
      safeAdd(canonicalRecordsCreated, mergedObservations, 'record decision total'),
      quarantineCount,
      'record decision total',
    )
    || duplicateObservations > observationsCommitted) {
    fail('corrupt_source', 'Projection record or quarantine totals contradict one another.');
  }
  const reviewRefCount = exactCount(value.quarantine.reviewRefCount, 'quarantine reviewRefCount');
  validateBoundedRefs(value.quarantine.reviewRefs, reviewRefCount, 'quarantine reviewRefs');
  if ((quarantineCount === 0) !== (reviewRefCount === 0) || reviewRefCount > batchCount) {
    fail('corrupt_source', 'Projection quarantine references contradict its review count.');
  }
  exactKeysWithOptional(value.coverage, [
    'status', 'sourceStatus', 'partitionUniverse', 'observedPartitions',
    'observed', 'denominator', 'exhaustion', 'reasons', 'evidenceRef',
  ], ['declaredPartitions'], 'projection coverage summary');
  if (!['complete', 'partial', 'unknown'].includes(String(value.coverage.status))
    || !['complete', 'partial', 'unknown'].includes(String(value.coverage.sourceStatus))
    || !['closed', 'open', 'unknown'].includes(String(value.coverage.partitionUniverse))
    || !['exhausted', 'not_exhausted', 'unknown'].includes(String(value.coverage.exhaustion))) {
    fail('corrupt_source', 'Projection coverage enum is unsupported.');
  }
  const observedPartitions = exactCount(value.coverage.observedPartitions, 'coverage observedPartitions');
  const observed = exactCount(value.coverage.observed, 'coverage observed');
  validateDenominator(value.coverage.denominator);
  if (value.coverage.partitionUniverse === 'closed') {
    const declared = exactCount(value.coverage.declaredPartitions, 'coverage declaredPartitions');
    if (observedPartitions > declared) fail('corrupt_source', 'Coverage observed too many partitions.');
  } else if (value.coverage.declaredPartitions !== undefined) {
    fail('corrupt_source', 'Only a closed coverage universe can declare its partition count.');
  }
  validateCoverageReasons(value.coverage.reasons);
  exactIdentifier(value.coverage.evidenceRef, 'coverage evidenceRef');
  if (value.coverage.denominator.kind === 'exact' && observed > value.coverage.denominator.total) {
    fail('corrupt_source', 'Coverage exceeds its exact denominator.');
  }
  if (value.coverage.status === 'complete'
    && (value.coverage.sourceStatus !== 'complete'
      || value.coverage.partitionUniverse !== 'closed'
      || value.coverage.denominator.kind !== 'exact'
      || value.coverage.exhaustion !== 'exhausted'
      || value.coverage.reasons.length !== 0
      || value.coverage.observed !== value.coverage.denominator.total
      || value.coverage.observedPartitions !== value.coverage.declaredPartitions)) {
    fail('corrupt_source', 'Complete projection coverage contradicts its bounded source truth.');
  }
  exactIso(value.projectedAt, 'head projectedAt');
  canonicalEntityJson(value);
}

function headFromRow(row: ProjectionHeadRow): {
  head: CanonicalEntityWorkspaceProjectionHeadV1;
  headDigest: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.sidecar_json);
  } catch {
    fail('corrupt_source', 'Stored canonical projection sidecar is malformed.');
  }
  validateHeadShape(parsed);
  const digest = canonicalEntitySha256(parsed);
  if (digest !== row.head_digest
    || parsed.identity.bindingId !== row.binding_id
    || parsed.identity.workflowId !== row.workflow_id
    || parsed.identity.workspaceId !== row.workspace_id
    || parsed.identity.runId !== row.run_id
    || parsed.identity.datasetId !== row.dataset_id
    || parsed.bindingDigest !== row.binding_digest
    || parsed.datasetAuthority.contractDigest !== row.dataset_contract_digest
    || parsed.datasetAuthority.resolutionRevision !== row.resolution_revision
    || parsed.datasetAuthority.resolutionRoot !== row.resolution_root
    || parsed.datasetAuthority.coverageRevision !== row.coverage_revision
    || parsed.datasetAuthority.coverageRoot !== row.coverage_root
    || parsed.canonicalSourceDigest !== row.canonical_source_digest
    || parsed.workspaceProjectionDigest !== row.workspace_projection_digest
    || parsed.projectedAt !== row.projected_at) {
    fail('corrupt_source', 'Stored canonical projection columns contradict their typed sidecar.');
  }
  return { head: parsed, headDigest: digest };
}

export function getCanonicalEntityWorkspaceProjectionHead(
  bindingId: string,
  db: Database.Database = openWorkspaceDb(),
): (CanonicalEntityWorkspaceProjectionHeadV1 & { headDigest: string }) | null {
  ensureWorkspaceSchema(db);
  const exact = exactIdentifier(bindingId, 'bindingId');
  const row = rowForHead(db, exact);
  if (!row) return null;
  const binding = getWorkflowSurfaceBinding(exact, db);
  const projection = getWorkspaceRunProjection(exact, db);
  if (!binding || !projection
    || binding.state === 'retired'
    || binding.digest !== row.binding_digest
    || projection.digest !== row.workspace_projection_digest) return null;
  const stored = headFromRow(row);
  const { head } = stored;
  if (projection.projection.bindingId !== head.identity.bindingId
    || projection.projection.workflowId !== head.identity.workflowId
    || projection.projection.workspaceId !== head.identity.workspaceId
    || projection.projection.runId !== head.identity.runId
    || projection.projection.records.observationsCommitted !== head.records.observationsCommitted
    || projection.projection.records.canonicalRecords !== head.records.canonicalRecordsCreated
    || projection.projection.records.duplicateObservations !== head.records.duplicateObservations
    || projection.projection.records.artifactRefCount !== head.source.recordArtifactRefCount
    || projection.projection.provenanceSummaryRefCount !== head.provenance.summaryRefCount
    || projection.projection.coverage.evidenceRefCount !== 1
    || projection.projection.coverage.evidenceRefs[0] !== head.coverage.evidenceRef
    || (head.coverage.declaredPartitions !== undefined
      && projection.projection.coverage.declaredPartitions !== head.coverage.declaredPartitions)
    || (head.coverage.status === 'complete'
      ? projection.projection.coverage.status !== 'complete'
      : projection.projection.coverage.status === 'complete')) {
    fail('corrupt_source', 'Workspace projection contradicts its canonical entity sidecar.');
  }
  return { ...stored.head, headDigest: stored.headDigest };
}

function insertOrUpdateHead(input: {
  db: Database.Database;
  head: CanonicalEntityWorkspaceProjectionHeadV1;
  headDigest: string;
  prior?: ProjectionHeadRow;
}): boolean {
  const { db, head, headDigest, prior } = input;
  const json = canonicalEntityJson(head);
  if (!prior) {
    db.prepare(`
      INSERT INTO workspace_canonical_entity_projection_heads (
        binding_id, workflow_id, workspace_id, run_id, dataset_id,
        binding_digest, dataset_contract_digest, resolution_revision,
        resolution_root, coverage_revision, coverage_root,
        canonical_source_digest, workspace_projection_digest, head_digest,
        sidecar_json, projected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      head.identity.bindingId,
      head.identity.workflowId,
      head.identity.workspaceId,
      head.identity.runId,
      head.identity.datasetId,
      head.bindingDigest,
      head.datasetAuthority.contractDigest,
      head.datasetAuthority.resolutionRevision,
      head.datasetAuthority.resolutionRoot,
      head.datasetAuthority.coverageRevision,
      head.datasetAuthority.coverageRoot,
      head.canonicalSourceDigest,
      head.workspaceProjectionDigest,
      headDigest,
      json,
      head.projectedAt,
    );
    return true;
  }
  if (prior.head_digest === headDigest) return false;
  const changed = db.prepare(`
    UPDATE workspace_canonical_entity_projection_heads
    SET workflow_id = ?, workspace_id = ?, run_id = ?, dataset_id = ?,
        binding_digest = ?, dataset_contract_digest = ?, resolution_revision = ?,
        resolution_root = ?, coverage_revision = ?, coverage_root = ?,
        canonical_source_digest = ?, workspace_projection_digest = ?,
        head_digest = ?, sidecar_json = ?, projected_at = ?
    WHERE binding_id = ? AND head_digest = ?
  `).run(
    head.identity.workflowId,
    head.identity.workspaceId,
    head.identity.runId,
    head.identity.datasetId,
    head.bindingDigest,
    head.datasetAuthority.contractDigest,
    head.datasetAuthority.resolutionRevision,
    head.datasetAuthority.resolutionRoot,
    head.datasetAuthority.coverageRevision,
    head.datasetAuthority.coverageRoot,
    head.canonicalSourceDigest,
    head.workspaceProjectionDigest,
    headDigest,
    json,
    head.projectedAt,
    head.identity.bindingId,
    prior.head_digest,
  );
  if (changed.changes !== 1) fail('conflict', 'Canonical projection head compare-and-swap lost.');
  return true;
}

function validateInput(input: ProjectCanonicalEntityStoreToWorkspaceInputV1): void {
  if (!input || typeof input !== 'object') fail('invalid', 'Projection input must be an object.');
  if (input.version !== 1) fail('invalid', 'Projection input version must be 1.');
  exactDigest(input.expectedBindingDigest, 'expectedBindingDigest');
  validateDatasetAuthority(input.expectedDatasetAuthority);
  if (input.expectedHeadDigest !== undefined) exactDigest(input.expectedHeadDigest, 'expectedHeadDigest');
  if (!Array.isArray(input.runReceipts) || !Array.isArray(input.partitionReceipts)) {
    fail('invalid', 'Workflow run and partition receipts must be arrays.');
  }
  if (input.scheduleFacts !== undefined && !Array.isArray(input.scheduleFacts)) {
    fail('invalid', 'scheduleFacts must be an array.');
  }
  for (const fact of input.scheduleFacts ?? []) {
    if (!fact || fact.kind !== 'schedule') fail('invalid', 'Only workflow-owned schedule facts are accepted.');
  }
}

function commitWorkspaceProjection(input: {
  request: ProjectCanonicalEntityStoreToWorkspaceInputV1;
  db: Database.Database;
  snapshot: WorkspaceRunProjectionSnapshotV1;
  head: CanonicalEntityWorkspaceProjectionHeadV1;
  headDigest: string;
}): { inserted: boolean; projectionDigest: string } {
  const { request, db, snapshot, head, headDigest } = input;
  const commit = db.transaction(() => {
    const binding = getWorkflowSurfaceBinding(request.identity.bindingId, db);
    if (!binding
      || binding.digest !== request.expectedBindingDigest
      || binding.workflowId !== request.identity.workflowId
      || binding.workspaceId !== request.identity.workspaceId
      || binding.state === 'retired') {
      fail('conflict', 'Workflow-to-Workspace binding changed before projection commit.');
    }
    const priorRow = rowForHead(db, request.identity.bindingId);
    const prior = priorRow ? headFromRow(priorRow) : undefined;
    const priorIsCurrent = priorRow?.binding_digest === binding.digest;
    if (priorIsCurrent && priorRow!.head_digest !== headDigest
      && request.expectedHeadDigest !== priorRow!.head_digest) {
      fail('conflict', 'Canonical projection head compare-and-swap precondition does not match.');
    }
    if (!priorRow && request.expectedHeadDigest !== undefined) {
      fail('conflict', 'A new canonical projection head cannot have an expected predecessor.');
    }
    if (priorIsCurrent && prior
      && prior.head.identity.datasetId === head.identity.datasetId
      && (head.datasetAuthority.resolutionRevision < prior.head.datasetAuthority.resolutionRevision
        || head.datasetAuthority.coverageRevision < prior.head.datasetAuthority.coverageRevision)) {
      fail('stale_source', 'Canonical projection cannot move a dataset authority revision backwards.');
    }
    const rawProjection = db.prepare(`
      SELECT projection_digest FROM workspace_run_projections
      WHERE binding_id = ? LIMIT 1
    `).get(request.identity.bindingId) as { projection_digest: string } | undefined;
    const storedProjection = putWorkspaceRunProjection({
      db,
      snapshot,
      bindingDigest: binding.digest,
      ...(rawProjection ? { expectedProjectionDigest: rawProjection.projection_digest } : {}),
    });
    if (!storedProjection.ok) {
      fail('conflict', storedProjection.errors.join('; '));
    }
    const headInserted = insertOrUpdateHead({
      db,
      head,
      headDigest,
      prior: priorRow,
    });
    return {
      inserted: storedProjection.inserted || headInserted,
      projectionDigest: storedProjection.digest,
    };
  });
  return commit.immediate();
}

/**
 * Materialize one exact canonical-entity authority snapshot into a read-only
 * Workspace projection. The entity DB is held under BEGIN IMMEDIATE until the
 * Workspace CAS commits, so the source roots cannot advance between review
 * and projection. No schedule, trigger, retry, or execution state is written.
 */
export function projectCanonicalEntityStoreToWorkspace(
  input: ProjectCanonicalEntityStoreToWorkspaceInputV1,
): ProjectCanonicalEntityStoreToWorkspaceResult {
  try {
    validateInput(input);
    const entityDb = input.entityDb ?? openCanonicalEntityStoreDb();
    const workspaceDb = input.workspaceDb ?? openWorkspaceDb();
    ensureWorkspaceSchema(workspaceDb);
    // Initialize/validate a caller-supplied entity handle before taking the
    // cross-store lock; the exact authority is read again inside it.
    getCanonicalDataset(input.identity.datasetId, entityDb);
    const project = entityDb.transaction((): ProjectCanonicalEntityStoreToWorkspaceResult => {
      const storedBinding = getWorkflowSurfaceBinding(input.identity.bindingId, workspaceDb);
      if (!storedBinding
        || storedBinding.digest !== input.expectedBindingDigest
        || storedBinding.workflowId !== input.identity.workflowId
        || storedBinding.workspaceId !== input.identity.workspaceId
        || storedBinding.state === 'retired') {
        fail('identity_mismatch', 'Projection identity does not match the exact active binding revision.');
      }
      const { digest: bindingDigest, ...binding } = storedBinding;
      const truth = readEntityProjectionTruth(input, entityDb);
      const adapted = adaptCanonicalEntityTruthToWorkspaceProjection({
        version: 1,
        binding,
        bindingDigest,
        identity: input.identity,
        resolutionStateAnchorDigest: truth.resolutionAnchor,
        runReceipts: input.runReceipts,
        partitionReceipts: input.partitionReceipts,
        resolutionReceipts: truth.resolutionReceipts,
        coverageReceipt: truth.coverageReceipt,
      });
      if (!adapted.ok) {
        const kind = adapted.kind === 'identity_mismatch' ? 'identity_mismatch'
          : adapted.kind === 'invalid_contract' ? 'invalid'
            : 'corrupt_source';
        return { ok: false, kind, errors: adapted.errors };
      }
      const snapshot = buildWorkspaceRunProjection(binding, [
        ...adapted.value.facts,
        ...(input.scheduleFacts ?? []),
      ]);
      const head = buildHead({
        identity: input.identity,
        bindingDigest,
        authority: authorityFromDataset(truth.dataset),
        canonicalSourceDigest: adapted.value.sourceDigest,
        snapshot,
        resolution: adapted.value.resolution,
        coverage: adapted.value.coverage,
        resolutionReceipts: truth.resolutionReceipts,
        evidenceRef: truth.coverageReceipt.evidenceRef,
      });
      const headDigest = canonicalEntitySha256(head);
      const stored = commitWorkspaceProjection({
        request: input,
        db: workspaceDb,
        snapshot,
        head,
        headDigest,
      });
      return {
        ok: true,
        inserted: stored.inserted,
        head,
        headDigest,
        snapshot,
        projectionDigest: stored.projectionDigest,
      };
    });
    return project.immediate();
  } catch (error) {
    if (error instanceof ProjectionFailure) {
      return { ok: false, kind: error.kind, errors: [error.message] };
    }
    return {
      ok: false,
      kind: 'corrupt_source',
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
