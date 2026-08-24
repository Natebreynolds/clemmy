import { createHash } from 'node:crypto';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/\-]{0,255}$/;
const MAX_SUMMARY_REFS = 256;

export interface WorkflowSurfaceBindingV1 {
  version: 1;
  bindingId: string;
  workflowId: string;
  workspaceId: string;
  revision: number;
  role: 'primary' | 'supporting';
  projectionVersion: 1;
  scheduleAuthority: 'workflow';
  state: 'active' | 'paused' | 'retired';
  createdAt: string;
  updatedAt: string;
}

export type WorkspacePartitionState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'blocked';

export interface WorkspacePartitionProjectionV1 {
  version: 1;
  partitionId: string;
  state: WorkspacePartitionState;
  attempt: number;
  observationsCommitted: number;
  canonicalRecords: number;
  duplicateObservations: number;
  failureRef?: string;
  updatedAt: string;
}

export type WorkspaceRunStatus =
  | 'queued'
  | 'running'
  | 'held'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkspaceCoverageStatus =
  | 'not_started'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'complete';

/**
 * A bounded visual summary. Large partition and record sets never live in this
 * JSON document; they are normalized and paginated by the Workspace store.
 * Every value is rebuilt from durable workflow facts, so a Space cannot become
 * a second scheduler or execution authority.
 */
export interface WorkspaceRunProjectionV1 {
  version: 1;
  bindingId: string;
  workflowId: string;
  workspaceId: string;
  runId?: string;
  runStatus?: WorkspaceRunStatus;
  schedule: {
    authority: 'workflow';
    enabled: boolean;
    nextOccurrenceAt?: string;
  };
  coverage: {
    status: WorkspaceCoverageStatus;
    declaredPartitions?: number;
    completedPartitions: number;
    skippedPartitions: number;
    failedPartitions: number;
    blockedPartitions: number;
    runningPartitions: number;
    pendingPartitions: number;
    partitionIndexDigest: string;
    evidenceRefCount: number;
    evidenceRefs: string[];
  };
  records: {
    observationsCommitted: number;
    canonicalRecords: number;
    duplicateObservations: number;
    artifactRefCount: number;
    artifactRefs: string[];
  };
  provenanceSummaryRefCount: number;
  provenanceSummaryRefs: string[];
  updatedAt: string;
}

export interface WorkspaceRunProjectionSnapshotV1 {
  projection: WorkspaceRunProjectionV1;
  partitions: WorkspacePartitionProjectionV1[];
}

interface FactBase {
  factId: string;
  /** Durable source-event ordering. `ordinal` permits several derived facts
   * from one workflow event without letting wall-clock ties choose causality. */
  sequence: number;
  ordinal: number;
  at: string;
}

export type WorkspaceProjectionFactV1 =
  | (FactBase & {
      kind: 'run_status';
      runId: string;
      status: WorkspaceRunStatus;
    })
  | (FactBase & {
      kind: 'schedule';
      enabled: boolean;
      nextOccurrenceAt?: string;
    })
  | (FactBase & {
      kind: 'partition_declared';
      partitionId: string;
    })
  | (FactBase & {
      kind: 'partition_status';
      partitionId: string;
      state: WorkspacePartitionState;
      attempt: number;
      failureRef?: string;
    })
  | (FactBase & {
      kind: 'record_batch_committed';
      partitionId: string;
      observationCount: number;
      canonicalRecordCount: number;
      duplicateObservationCount?: number;
      artifactRef?: string;
      provenanceSummaryRef?: string;
    })
  | (FactBase & {
      kind: 'coverage_evidence';
      status: Exclude<WorkspaceCoverageStatus, 'not_started'>;
      declaredPartitions?: number;
      evidenceRef: string;
    });

export interface ContractValidation {
  ok: boolean;
  errors: string[];
}

export function validateWorkflowSurfaceBinding(value: unknown): ContractValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return invalid('binding must be an object');
  rejectUnknownKeys(value, [
    'version', 'bindingId', 'workflowId', 'workspaceId', 'revision', 'role',
    'projectionVersion', 'scheduleAuthority', 'state', 'createdAt', 'updatedAt',
  ], 'binding', errors);
  if (value.version !== 1) errors.push('version must be 1');
  requireIdentifier(value.bindingId, 'bindingId', errors);
  requireIdentifier(value.workflowId, 'workflowId', errors);
  requireIdentifier(value.workspaceId, 'workspaceId', errors);
  requirePositiveInteger(value.revision, 'revision', errors);
  if (value.role !== 'primary' && value.role !== 'supporting') {
    errors.push('role must be primary or supporting');
  }
  if (value.projectionVersion !== 1) errors.push('projectionVersion must be 1');
  if (value.scheduleAuthority !== 'workflow') errors.push('scheduleAuthority must be workflow');
  if (!['active', 'paused', 'retired'].includes(String(value.state))) {
    errors.push('state must be active, paused, or retired');
  }
  requireIso(value.createdAt, 'createdAt', errors);
  requireIso(value.updatedAt, 'updatedAt', errors);
  if (isIso(value.createdAt) && isIso(value.updatedAt) && value.updatedAt < value.createdAt) {
    errors.push('updatedAt cannot precede createdAt');
  }
  return { ok: errors.length === 0, errors };
}

export function validateWorkspaceRunProjection(value: unknown): ContractValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return invalid('projection must be an object');
  rejectUnknownKeys(value, [
    'version', 'bindingId', 'workflowId', 'workspaceId', 'runId', 'runStatus',
    'schedule', 'coverage', 'records', 'provenanceSummaryRefCount',
    'provenanceSummaryRefs', 'updatedAt',
  ], 'projection', errors);
  if (value.version !== 1) errors.push('version must be 1');
  requireIdentifier(value.bindingId, 'bindingId', errors);
  requireIdentifier(value.workflowId, 'workflowId', errors);
  requireIdentifier(value.workspaceId, 'workspaceId', errors);
  if (value.runId !== undefined) requireIdentifier(value.runId, 'runId', errors);
  if (value.runStatus !== undefined && !RUN_STATUSES.has(String(value.runStatus))) {
    errors.push('runStatus is invalid');
  }
  requireIso(value.updatedAt, 'updatedAt', errors);
  validateSchedule(value.schedule, errors);
  validateCoverage(value.coverage, errors);
  validateRecords(value.records, errors);
  requireNonNegativeInteger(value.provenanceSummaryRefCount, 'provenanceSummaryRefCount', errors);
  validateRefSample(
    value.provenanceSummaryRefs,
    value.provenanceSummaryRefCount,
    'provenanceSummaryRefs',
    errors,
  );
  return { ok: errors.length === 0, errors };
}

export function validateWorkspacePartitionProjection(value: unknown): ContractValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return invalid('partition projection must be an object');
  rejectUnknownKeys(value, [
    'version', 'partitionId', 'state', 'attempt', 'observationsCommitted',
    'canonicalRecords', 'duplicateObservations', 'failureRef', 'updatedAt',
  ], 'partition', errors);
  if (value.version !== 1) errors.push('partition version must be 1');
  requireIdentifier(value.partitionId, 'partitionId', errors);
  if (!PARTITION_STATES.has(String(value.state))) errors.push('partition state is invalid');
  requireNonNegativeInteger(value.attempt, 'attempt', errors);
  requireNonNegativeInteger(value.observationsCommitted, 'observationsCommitted', errors);
  requireNonNegativeInteger(value.canonicalRecords, 'canonicalRecords', errors);
  requireNonNegativeInteger(value.duplicateObservations, 'duplicateObservations', errors);
  if (value.failureRef !== undefined) requireIdentifier(value.failureRef, 'failureRef', errors);
  requireIso(value.updatedAt, 'updatedAt', errors);
  return { ok: errors.length === 0, errors };
}

export function validateWorkspaceRunProjectionSnapshot(value: unknown): ContractValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return invalid('projection snapshot must be an object');
  rejectUnknownKeys(value, ['projection', 'partitions'], 'snapshot', errors);
  errors.push(...validateWorkspaceRunProjection(value.projection).errors);
  if (!Array.isArray(value.partitions)) {
    errors.push('partitions must be an array');
    return { ok: false, errors };
  }
  const ids = new Set<string>();
  let previous = '';
  for (const [index, partition] of value.partitions.entries()) {
    const validated = validateWorkspacePartitionProjection(partition);
    errors.push(...validated.errors.map((error) => `partitions[${index}]: ${error}`));
    if (!isRecord(partition) || typeof partition.partitionId !== 'string') continue;
    if (ids.has(partition.partitionId)) errors.push(`duplicate partitionId ${partition.partitionId}`);
    ids.add(partition.partitionId);
    if (previous && partition.partitionId <= previous) errors.push('partitions must be sorted by partitionId');
    previous = partition.partitionId;
  }
  if (isRecord(value.projection) && isRecord(value.projection.coverage)) {
    const coverage = value.projection.coverage;
    if (coverage.partitionIndexDigest !== partitionIndexDigest(value.partitions as WorkspacePartitionProjectionV1[])) {
      errors.push('partitionIndexDigest does not match partitions');
    }
    const counts = partitionCounts(value.partitions as WorkspacePartitionProjectionV1[]);
    for (const [field, actual] of Object.entries(counts)) {
      if (coverage[field] !== actual) errors.push(`coverage.${field} does not match partitions`);
    }
    if (coverage.status === 'complete') {
      if (!Number.isSafeInteger(coverage.declaredPartitions)) {
        errors.push('complete coverage requires an explicit declared partition count');
      } else if (coverage.declaredPartitions !== value.partitions.length) {
        errors.push('complete coverage denominator does not match partition index');
      }
      if (
        counts.failedPartitions !== 0
        || counts.blockedPartitions !== 0
        || counts.runningPartitions !== 0
        || counts.pendingPartitions !== 0
        || counts.completedPartitions + counts.skippedPartitions !== value.partitions.length
      ) {
        errors.push('complete coverage contradicts durable partition state');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function buildWorkspaceRunProjection(
  binding: WorkflowSurfaceBindingV1,
  facts: WorkspaceProjectionFactV1[],
): WorkspaceRunProjectionSnapshotV1 {
  const bindingValidation = validateWorkflowSurfaceBinding(binding);
  if (!bindingValidation.ok) throw new Error(bindingValidation.errors.join('; '));

  const uniqueFacts = new Map<string, WorkspaceProjectionFactV1>();
  const occupiedPositions = new Map<string, string>();
  for (const fact of facts) {
    const factErrors = validateFact(fact);
    if (factErrors.length > 0) throw new Error(factErrors.join('; '));
    const previous = uniqueFacts.get(fact.factId);
    if (previous && canonicalJson(previous) !== canonicalJson(fact)) {
      throw new Error(`factId ${fact.factId} was reused with different bytes`);
    }
    const position = `${fact.sequence}:${fact.ordinal}`;
    const occupant = occupiedPositions.get(position);
    if (occupant && occupant !== fact.factId) {
      throw new Error(`projection fact position ${position} is claimed by multiple facts`);
    }
    occupiedPositions.set(position, fact.factId);
    uniqueFacts.set(fact.factId, fact);
  }
  const ordered = [...uniqueFacts.values()].sort(
    (a, b) => a.sequence - b.sequence || a.ordinal - b.ordinal || a.factId.localeCompare(b.factId),
  );

  let runId: string | undefined;
  let runStatus: WorkspaceRunStatus | undefined;
  let scheduleEnabled = false;
  let nextOccurrenceAt: string | undefined;
  let coverageStatus: WorkspaceCoverageStatus = 'not_started';
  let declaredPartitions: number | undefined;
  const coverageRefs = new Set<string>();
  const artifactRefs = new Set<string>();
  const provenanceRefs = new Set<string>();
  const partitions = new Map<string, WorkspacePartitionProjectionV1>();
  let updatedAt = binding.updatedAt;

  for (const fact of ordered) {
    if (fact.at > updatedAt) updatedAt = fact.at;
    switch (fact.kind) {
      case 'run_status':
        runId = fact.runId;
        runStatus = fact.status;
        break;
      case 'schedule':
        scheduleEnabled = fact.enabled;
        nextOccurrenceAt = fact.enabled ? fact.nextOccurrenceAt : undefined;
        break;
      case 'partition_declared': {
        const previous = partitions.get(fact.partitionId);
        if (!previous) {
          partitions.set(fact.partitionId, {
            version: 1,
            partitionId: fact.partitionId,
            state: 'pending',
            attempt: 0,
            observationsCommitted: 0,
            canonicalRecords: 0,
            duplicateObservations: 0,
            updatedAt: fact.at,
          });
        }
        break;
      }
      case 'partition_status': {
        const previous = requireDeclaredPartition(partitions, fact.partitionId);
        if (fact.attempt < previous.attempt) throw new Error(`partition ${fact.partitionId} attempt moved backwards`);
        const { failureRef: _previousFailureRef, ...withoutFailure } = previous;
        partitions.set(fact.partitionId, {
          ...withoutFailure,
          state: fact.state,
          attempt: fact.attempt,
          ...(fact.failureRef ? { failureRef: fact.failureRef } : {}),
          updatedAt: fact.at > previous.updatedAt ? fact.at : previous.updatedAt,
        });
        break;
      }
      case 'record_batch_committed': {
        const previous = requireDeclaredPartition(partitions, fact.partitionId);
        partitions.set(fact.partitionId, {
          ...previous,
          observationsCommitted: safeCountSum(
            previous.observationsCommitted,
            fact.observationCount,
            `partition ${fact.partitionId} observationsCommitted`,
          ),
          canonicalRecords: safeCountSum(
            previous.canonicalRecords,
            fact.canonicalRecordCount,
            `partition ${fact.partitionId} canonicalRecords`,
          ),
          duplicateObservations: safeCountSum(
            previous.duplicateObservations,
            fact.duplicateObservationCount ?? 0,
            `partition ${fact.partitionId} duplicateObservations`,
          ),
          updatedAt: fact.at > previous.updatedAt ? fact.at : previous.updatedAt,
        });
        if (fact.artifactRef) artifactRefs.add(fact.artifactRef);
        if (fact.provenanceSummaryRef) provenanceRefs.add(fact.provenanceSummaryRef);
        break;
      }
      case 'coverage_evidence':
        coverageStatus = fact.status;
        declaredPartitions = fact.declaredPartitions;
        coverageRefs.add(fact.evidenceRef);
        break;
    }
  }

  const normalizedPartitions = [...partitions.values()].sort((a, b) =>
    a.partitionId.localeCompare(b.partitionId));
  const counts = partitionCounts(normalizedPartitions);
  if (coverageStatus === 'not_started' && normalizedPartitions.length > 0) coverageStatus = 'partial';
  if (coverageStatus === 'complete') {
    if (!Number.isSafeInteger(declaredPartitions)) {
      throw new Error('complete coverage requires an explicit declared partition count');
    }
    if (
      declaredPartitions !== normalizedPartitions.length
      || counts.failedPartitions !== 0
      || counts.blockedPartitions !== 0
      || counts.runningPartitions !== 0
      || counts.pendingPartitions !== 0
      || counts.completedPartitions + counts.skippedPartitions !== normalizedPartitions.length
    ) {
      throw new Error('complete coverage contradicts durable partition state');
    }
  }

  const observationsCommitted = normalizedPartitions.reduce(
    (sum, partition) => safeCountSum(
      sum,
      partition.observationsCommitted,
      'projection observationsCommitted',
    ), 0);
  const canonicalRecords = normalizedPartitions.reduce(
    (sum, partition) => safeCountSum(
      sum,
      partition.canonicalRecords,
      'projection canonicalRecords',
    ), 0);
  const duplicateObservations = normalizedPartitions.reduce(
    (sum, partition) => safeCountSum(
      sum,
      partition.duplicateObservations,
      'projection duplicateObservations',
    ), 0);
  const sortedCoverageRefs = [...coverageRefs].sort();
  const sortedArtifactRefs = [...artifactRefs].sort();
  const sortedProvenanceRefs = [...provenanceRefs].sort();

  const projection: WorkspaceRunProjectionV1 = {
    version: 1,
    bindingId: binding.bindingId,
    workflowId: binding.workflowId,
    workspaceId: binding.workspaceId,
    ...(runId ? { runId } : {}),
    ...(runStatus ? { runStatus } : {}),
    schedule: {
      authority: 'workflow',
      enabled: scheduleEnabled,
      ...(nextOccurrenceAt ? { nextOccurrenceAt } : {}),
    },
    coverage: {
      status: coverageStatus,
      ...(declaredPartitions !== undefined ? { declaredPartitions } : {}),
      ...counts,
      partitionIndexDigest: partitionIndexDigest(normalizedPartitions),
      evidenceRefCount: sortedCoverageRefs.length,
      evidenceRefs: sortedCoverageRefs.slice(0, MAX_SUMMARY_REFS),
    },
    records: {
      observationsCommitted,
      canonicalRecords,
      duplicateObservations,
      artifactRefCount: sortedArtifactRefs.length,
      artifactRefs: sortedArtifactRefs.slice(0, MAX_SUMMARY_REFS),
    },
    provenanceSummaryRefCount: sortedProvenanceRefs.length,
    provenanceSummaryRefs: sortedProvenanceRefs.slice(0, MAX_SUMMARY_REFS),
    updatedAt,
  };
  const snapshot = { projection, partitions: normalizedPartitions };
  const validated = validateWorkspaceRunProjectionSnapshot(snapshot);
  if (!validated.ok) throw new Error(validated.errors.join('; '));
  return snapshot;
}

export function workflowSurfaceBindingDigest(binding: WorkflowSurfaceBindingV1): string {
  return sha256(canonicalJson(binding));
}

export function workspaceRunProjectionDigest(projection: WorkspaceRunProjectionV1): string {
  return sha256(canonicalJson(projection));
}

export function workspaceRunProjectionSnapshotDigest(
  snapshot: WorkspaceRunProjectionSnapshotV1,
): string {
  return sha256(canonicalJson(snapshot));
}

export function partitionIndexDigest(partitions: WorkspacePartitionProjectionV1[]): string {
  return sha256(canonicalJson(partitions));
}

export function canonicalWorkspaceProjectionJson(value: unknown): string {
  return canonicalJson(value);
}

function validateFact(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['fact must be an object'];
  requireIdentifier(value.factId, 'factId', errors);
  requireNonNegativeInteger(value.sequence, 'sequence', errors);
  requireNonNegativeInteger(value.ordinal, 'ordinal', errors);
  requireIso(value.at, 'at', errors);
  if (typeof value.kind !== 'string') return [...errors, 'fact kind is required'];
  const common = ['kind', 'factId', 'sequence', 'ordinal', 'at'];
  switch (value.kind) {
    case 'run_status':
      rejectUnknownKeys(value, [...common, 'runId', 'status'], 'fact', errors);
      requireIdentifier(value.runId, 'runId', errors);
      if (!RUN_STATUSES.has(String(value.status))) errors.push('run status is invalid');
      break;
    case 'schedule':
      rejectUnknownKeys(value, [...common, 'enabled', 'nextOccurrenceAt'], 'fact', errors);
      if (typeof value.enabled !== 'boolean') errors.push('schedule enabled must be boolean');
      if (value.nextOccurrenceAt !== undefined) requireIso(value.nextOccurrenceAt, 'nextOccurrenceAt', errors);
      if (value.enabled === false && value.nextOccurrenceAt !== undefined) {
        errors.push('disabled schedule cannot claim a next occurrence');
      }
      break;
    case 'partition_declared':
      rejectUnknownKeys(value, [...common, 'partitionId'], 'fact', errors);
      requireIdentifier(value.partitionId, 'partitionId', errors);
      break;
    case 'partition_status':
      rejectUnknownKeys(value, [...common, 'partitionId', 'state', 'attempt', 'failureRef'], 'fact', errors);
      requireIdentifier(value.partitionId, 'partitionId', errors);
      if (!PARTITION_STATES.has(String(value.state))) errors.push('partition state is invalid');
      requireNonNegativeInteger(value.attempt, 'attempt', errors);
      if (value.failureRef !== undefined) requireIdentifier(value.failureRef, 'failureRef', errors);
      break;
    case 'record_batch_committed':
      rejectUnknownKeys(value, [
        ...common, 'partitionId', 'observationCount', 'canonicalRecordCount',
        'duplicateObservationCount', 'artifactRef', 'provenanceSummaryRef',
      ], 'fact', errors);
      requireIdentifier(value.partitionId, 'partitionId', errors);
      requireNonNegativeInteger(value.observationCount, 'observationCount', errors);
      requireNonNegativeInteger(value.canonicalRecordCount, 'canonicalRecordCount', errors);
      if (value.duplicateObservationCount !== undefined) {
        requireNonNegativeInteger(value.duplicateObservationCount, 'duplicateObservationCount', errors);
      }
      if (value.artifactRef !== undefined) requireIdentifier(value.artifactRef, 'artifactRef', errors);
      if (value.provenanceSummaryRef !== undefined) {
        requireIdentifier(value.provenanceSummaryRef, 'provenanceSummaryRef', errors);
      }
      break;
    case 'coverage_evidence':
      rejectUnknownKeys(value, [...common, 'status', 'declaredPartitions', 'evidenceRef'], 'fact', errors);
      if (!COVERAGE_EVIDENCE_STATUSES.has(String(value.status))) errors.push('coverage status is invalid');
      if (value.declaredPartitions !== undefined) {
        requireNonNegativeInteger(value.declaredPartitions, 'declaredPartitions', errors);
      }
      requireIdentifier(value.evidenceRef, 'evidenceRef', errors);
      break;
    default:
      errors.push(`unsupported fact kind ${value.kind}`);
  }
  return errors;
}

function validateSchedule(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('schedule must be an object');
    return;
  }
  rejectUnknownKeys(value, ['authority', 'enabled', 'nextOccurrenceAt'], 'schedule', errors);
  if (value.authority !== 'workflow') errors.push('schedule authority must be workflow');
  if (typeof value.enabled !== 'boolean') errors.push('schedule enabled must be boolean');
  if (value.nextOccurrenceAt !== undefined) requireIso(value.nextOccurrenceAt, 'schedule.nextOccurrenceAt', errors);
  if (value.enabled === false && value.nextOccurrenceAt !== undefined) {
    errors.push('disabled schedule cannot claim a next occurrence');
  }
}

function validateCoverage(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('coverage must be an object');
    return;
  }
  rejectUnknownKeys(value, [
    'status', 'declaredPartitions', 'completedPartitions', 'skippedPartitions',
    'failedPartitions', 'blockedPartitions', 'runningPartitions', 'pendingPartitions',
    'partitionIndexDigest', 'evidenceRefCount', 'evidenceRefs',
  ], 'coverage', errors);
  if (!COVERAGE_STATUSES.has(String(value.status))) errors.push('coverage status is invalid');
  if (value.declaredPartitions !== undefined) {
    requireNonNegativeInteger(value.declaredPartitions, 'coverage.declaredPartitions', errors);
  }
  for (const field of [
    'completedPartitions', 'skippedPartitions', 'failedPartitions', 'blockedPartitions',
    'runningPartitions', 'pendingPartitions', 'evidenceRefCount',
  ]) requireNonNegativeInteger(value[field], `coverage.${field}`, errors);
  requireDigest(value.partitionIndexDigest, 'coverage.partitionIndexDigest', errors);
  validateRefSample(value.evidenceRefs, value.evidenceRefCount, 'coverage.evidenceRefs', errors);
}

function validateRecords(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('records must be an object');
    return;
  }
  rejectUnknownKeys(value, [
    'observationsCommitted', 'canonicalRecords', 'duplicateObservations',
    'artifactRefCount', 'artifactRefs',
  ], 'records', errors);
  for (const field of [
    'observationsCommitted', 'canonicalRecords', 'duplicateObservations', 'artifactRefCount',
  ]) requireNonNegativeInteger(value[field], `records.${field}`, errors);
  validateRefSample(value.artifactRefs, value.artifactRefCount, 'records.artifactRefs', errors);
}

function validateRefSample(
  value: unknown,
  count: unknown,
  field: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  if (value.length > MAX_SUMMARY_REFS) errors.push(`${field} exceeds the bounded sample size`);
  if (Number.isSafeInteger(count) && value.length > Number(count)) {
    errors.push(`${field} cannot exceed its total count`);
  }
  let previous = '';
  for (const ref of value) {
    requireIdentifier(ref, field, errors);
    if (typeof ref !== 'string') continue;
    if (previous && ref <= previous) errors.push(`${field} must be unique and sorted`);
    previous = ref;
  }
}

function partitionCounts(partitions: WorkspacePartitionProjectionV1[]): {
  completedPartitions: number;
  skippedPartitions: number;
  failedPartitions: number;
  blockedPartitions: number;
  runningPartitions: number;
  pendingPartitions: number;
} {
  const counts = {
    completedPartitions: 0,
    skippedPartitions: 0,
    failedPartitions: 0,
    blockedPartitions: 0,
    runningPartitions: 0,
    pendingPartitions: 0,
  };
  for (const partition of partitions) {
    const field = `${partition.state}Partitions` as keyof typeof counts;
    counts[field] += 1;
  }
  return counts;
}

function requireDeclaredPartition(
  partitions: Map<string, WorkspacePartitionProjectionV1>,
  partitionId: string,
): WorkspacePartitionProjectionV1 {
  const partition = partitions.get(partitionId);
  if (!partition) throw new Error(`partition ${partitionId} was not declared`);
  return partition;
}

function safeCountSum(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return total;
}

function requireIdentifier(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    errors.push(`${field} must be a canonical non-blank identifier`);
  }
}

function requireDigest(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    errors.push(`${field} must be a sha256 digest`);
  }
}

function requireIso(value: unknown, field: string, errors: string[]): void {
  if (!isIso(value)) errors.push(`${field} must be an ISO timestamp`);
}

function isIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function requirePositiveInteger(value: unknown, field: string, errors: string[]): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) errors.push(`${field} must be a positive integer`);
}

function requireNonNegativeInteger(value: unknown, field: string, errors: string[]): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) errors.push(`${field} must be a non-negative integer`);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
  errors: string[],
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) errors.push(`${label} contains unknown field ${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(error: string): ContractValidation {
  return { ok: false, errors: [error] };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) sorted[key] = sortJson(value[key]);
  }
  return sorted;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const RUN_STATUSES: ReadonlySet<string> = new Set([
  'queued', 'running', 'held', 'blocked', 'completed', 'failed', 'cancelled',
]);
const PARTITION_STATES: ReadonlySet<string> = new Set([
  'pending', 'running', 'completed', 'skipped', 'failed', 'blocked',
]);
const COVERAGE_STATUSES: ReadonlySet<string> = new Set([
  'not_started', 'partial', 'blocked', 'failed', 'complete',
]);
const COVERAGE_EVIDENCE_STATUSES: ReadonlySet<string> = new Set([
  'partial', 'blocked', 'failed', 'complete',
]);
