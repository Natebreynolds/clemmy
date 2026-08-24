/**
 * Durable, normalized authority for canonical entity resolution and dataset coverage.
 *
 * Resolution remains owned by canonical-entity-resolution.ts. This module narrows
 * candidates with SQL, reconstructs only that bounded subset, asks the pure engine
 * for the decision, and persists the exact transition under BEGIN IMMEDIATE + CAS.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { BASE_DIR } from '../config.js';
import {
  createDatasetCoverageState,
  canonicalEntityJson,
  canonicalEntitySha256,
  compareCanonicalEntityText,
  isCanonicalEntityText,
  createEntityObservation,
  createEntityResolutionState,
  createEntityResolutionPolicySnapshot,
  createCoveragePage,
  upsertEntityObservation,
  upsertEntityObservationBatch,
  type CanonicalEntityField,
  type CanonicalEntityRecord,
  type CanonicalFieldEvidence,
  type CanonicalJson,
  type CoverageDenominator,
  type CoveragePage,
  type CoveragePageInput,
  type CoverageStatus,
  type DatasetCoverageSummary,
  type EntityAuditFieldChange,
  type EntityObservation,
  type EntityObservationInput,
  type EntityResolutionAuditEntry,
  type EntityResolutionDecision,
  type EntityResolutionPolicy,
  type EntityResolutionPolicySnapshot,
  type EntityResolutionState,
  type ExactEntityIdentifier,
  type NormalizedCompoundSignal,
  type PartitionUniverse,
  type ResolutionCandidateScore,
} from './canonical-entity-resolution.js';
import { initializeCanonicalEntityStoreSchema } from './canonical-entity-store-schema.js';

function canonicalJson(value: unknown): string {
  return canonicalEntityJson(value);
}

function hash(value: unknown): string {
  return canonicalEntitySha256(value);
}

function prefixedHash(prefix: string, value: unknown): string {
  return `${prefix}:${hash(value)}`;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `${label} contains malformed JSON.`);
  }
}

function exactIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || value.length > 1_024 || !isCanonicalEntityText(value)) {
    throw new CanonicalEntityStoreIntegrityError('invalid', `${label} must be a bounded exact identifier.`);
  }
  return value;
}

function exactIso(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new CanonicalEntityStoreIntegrityError('invalid', `${label} must be an ISO timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new CanonicalEntityStoreIntegrityError('invalid', `${label} must be an exact ISO timestamp.`);
  }
  return value;
}

function checkedCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `${label} is not a non-negative safe integer.`);
  }
  return Number(value);
}

function checkedAdd(left: number, right: number, label: string): number {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `${label} exceeds Number.MAX_SAFE_INTEGER.`);
  }
  return left + right;
}

function sameBytes(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function requireExactObjectKeys(value: unknown, expected: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `${label} is not an object.`);
  }
  const actual = Object.keys(value).sort(compareCanonicalEntityText);
  const required = [...expected].sort(compareCanonicalEntityText);
  if (!sameBytes(actual, required)) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `${label} has an unsupported object shape.`);
  }
}

function denominatorColumns(denominator: CoverageDenominator): [string, number | null] {
  if (denominator.kind === 'exact') return ['exact', denominator.total];
  if (denominator.kind === 'lower_bound') return ['lower_bound', denominator.atLeast];
  return ['unknown', null];
}

function denominatorFromColumns(kind: string, value: number | null, label: string): CoverageDenominator {
  if (kind === 'exact') return { kind, total: checkedCount(value, `${label}.total`) };
  if (kind === 'lower_bound') return { kind, atLeast: checkedCount(value, `${label}.atLeast`) };
  if (kind === 'unknown' && value === null) return { kind };
  throw new CanonicalEntityStoreIntegrityError('corrupt', `${label} has contradictory columns.`);
}

export type CanonicalEntityStoreFailureKind =
  | 'not_found'
  | 'cas_mismatch'
  | 'conflict'
  | 'coverage_rejected';

export class CanonicalEntityStoreIntegrityError extends Error {
  constructor(
    public readonly code: 'invalid' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalEntityStoreIntegrityError';
  }
}

export interface CanonicalDatasetRecordV1 {
  readonly version: 1;
  readonly datasetId: string;
  readonly contractDigest: string;
  readonly universe: PartitionUniverse;
  readonly denominator: CoverageDenominator;
  readonly resolutionRevision: number;
  readonly resolutionDigest: string;
  readonly coverageRevision: number;
  readonly coverageDigest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DurableCanonicalResolutionSummaryV1 {
  readonly version: 1;
  readonly summaryId: string;
  readonly batchId: string;
  /** Authenticated normalized-store transition root; never mislabeled as a full in-memory state digest. */
  readonly previousAuthorityRoot: string;
  readonly nextAuthorityRoot: string;
  readonly uniqueObservationCount: number;
  readonly observationsCommitted: number;
  readonly canonicalRecordsCreated: number;
  readonly mergedObservations: number;
  readonly quarantinedObservations: number;
  readonly replayedObservations: number;
  readonly duplicateObservationIdentities: number;
  readonly duplicateObservations: number;
  readonly provenanceAssertions: number;
  readonly provenanceOrigins: number;
  readonly quarantineReasons: Readonly<Record<string, number>>;
}

export interface DurableCanonicalResolutionBatchReceiptV1 {
  readonly version: 1;
  readonly datasetId: string;
  readonly batchId: string;
  readonly batchOrdinal: number;
  readonly inputDigest: string;
  readonly policyDigest: string;
  readonly summary: DurableCanonicalResolutionSummaryV1;
  readonly committedAt: string;
  readonly candidateRecordsLoaded: number;
  readonly results: readonly {
    readonly observationId: string;
    readonly idempotent: boolean;
    readonly decision: EntityResolutionDecision;
  }[];
}

export type CanonicalEntityStoreWrite<T> =
  | { readonly ok: true; readonly inserted: boolean; readonly value: T }
  | {
    readonly ok: false;
    readonly kind: CanonicalEntityStoreFailureKind;
    readonly message: string;
    readonly current?: CanonicalDatasetRecordV1;
  };

interface DatasetRow {
  dataset_id: string;
  contract_digest: string;
  universe_kind: 'closed' | 'open' | 'unknown';
  denominator_kind: 'exact' | 'lower_bound' | 'unknown';
  denominator_value: number | null;
  resolution_revision: number;
  resolution_digest: string;
  coverage_revision: number;
  coverage_digest: string;
  coverage_item_count: number;
  coverage_minimum_count: number;
  created_at: string;
  updated_at: string;
}

let defaultHandle: Database.Database | null = null;
let defaultHandlePath = '';
const configuredDatabases = new WeakSet<Database.Database>();

function configureDatabase(db: Database.Database): void {
  if (configuredDatabases.has(db)) return;
  db.pragma('foreign_keys = ON');
  initializeCanonicalEntityStoreSchema(db);
  configuredDatabases.add(db);
}

export function openCanonicalEntityStoreDb(): Database.Database {
  const directory = path.join(BASE_DIR, 'state', 'canonical-entities');
  const filename = path.join(directory, 'canonical-entities.db');
  if (defaultHandle && defaultHandlePath === filename) return defaultHandle;
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  defaultHandle = new Database(filename);
  defaultHandlePath = filename;
  defaultHandle.pragma('journal_mode = WAL');
  defaultHandle.pragma('synchronous = NORMAL');
  defaultHandle.pragma('busy_timeout = 10000');
  configureDatabase(defaultHandle);
  return defaultHandle;
}

export function closeCanonicalEntityStoreForTests(): void {
  defaultHandle?.close();
  defaultHandle = null;
  defaultHandlePath = '';
}

function databaseOrDefault(db?: Database.Database): Database.Database {
  const selected = db ?? openCanonicalEntityStoreDb();
  configureDatabase(selected);
  return selected;
}

function readSnapshot<T>(db: Database.Database, read: () => T): T {
  if (db.inTransaction) return read();
  return db.transaction(read).deferred();
}

function rowForDataset(db: Database.Database, datasetId: string): DatasetRow | undefined {
  return db.prepare('SELECT * FROM canonical_datasets WHERE dataset_id = ? LIMIT 1')
    .get(datasetId) as DatasetRow | undefined;
}

function declaredPartitions(db: Database.Database, datasetId: string): string[] {
  return (db.prepare(`
    SELECT partition_id
    FROM canonical_dataset_declared_partitions
    WHERE dataset_id = ?
    ORDER BY partition_id
  `).all(datasetId) as Array<{ partition_id: string }>).map((row) => row.partition_id);
}

function datasetFromRow(db: Database.Database, row: DatasetRow): CanonicalDatasetRecordV1 {
  const datasetId = exactIdentifier(row.dataset_id, 'stored datasetId');
  const universe: PartitionUniverse = row.universe_kind === 'closed'
    ? { kind: 'closed', partitionIds: declaredPartitions(db, datasetId) }
    : { kind: row.universe_kind };
  const denominator = denominatorFromColumns(
    row.denominator_kind,
    row.denominator_value,
    'stored dataset denominator',
  );
  const normalized = createDatasetCoverageState(datasetId, universe, denominator);
  const contractDigest = hash({
    version: 1,
    datasetId: normalized.datasetId,
    universe: normalized.universe,
    denominator: normalized.denominator,
  });
  if (contractDigest !== row.contract_digest) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${datasetId} contract digest does not match normalized rows.`);
  }
  if (!/^[a-f0-9]{64}$/.test(row.resolution_digest)
    || !/^[a-f0-9]{64}$/.test(row.coverage_digest)) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${datasetId} has an invalid authority digest.`);
  }
  const coverageItemCount = checkedCount(row.coverage_item_count, 'coverage item count');
  const coverageMinimumCount = checkedCount(row.coverage_minimum_count, 'coverage minimum count');
  if (normalized.denominator.kind === 'exact'
    && (coverageItemCount > normalized.denominator.total
      || coverageMinimumCount > normalized.denominator.total)) {
    throw new CanonicalEntityStoreIntegrityError(
      'corrupt',
      `Dataset ${datasetId} coverage counters exceed its exact denominator.`,
    );
  }
  return {
    version: 1,
    datasetId,
    contractDigest,
    universe: normalized.universe,
    denominator: normalized.denominator,
    resolutionRevision: checkedCount(row.resolution_revision, 'resolution revision'),
    resolutionDigest: row.resolution_digest,
    coverageRevision: checkedCount(row.coverage_revision, 'coverage revision'),
    coverageDigest: row.coverage_digest,
    createdAt: exactIso(row.created_at, 'dataset createdAt'),
    updatedAt: exactIso(row.updated_at, 'dataset updatedAt'),
  };
}

export function getCanonicalDataset(
  datasetId: string,
  db: Database.Database = openCanonicalEntityStoreDb(),
): CanonicalDatasetRecordV1 | null {
  const selected = databaseOrDefault(db);
  const exact = exactIdentifier(datasetId, 'datasetId');
  return readSnapshot(selected, () => {
    const row = rowForDataset(selected, exact);
    return row ? datasetFromRow(selected, row) : null;
  });
}

export function createCanonicalDataset(input: {
  datasetId: string;
  universe: PartitionUniverse;
  denominator: CoverageDenominator;
  createdAt?: string;
  db?: Database.Database;
}): CanonicalEntityStoreWrite<CanonicalDatasetRecordV1> {
  const db = databaseOrDefault(input.db);
  const normalized = createDatasetCoverageState(input.datasetId, input.universe, input.denominator);
  const createdAt = exactIso(input.createdAt ?? new Date().toISOString(), 'createdAt');
  const contract = {
    version: 1 as const,
    datasetId: normalized.datasetId,
    universe: normalized.universe,
    denominator: normalized.denominator,
  };
  const contractDigest = hash(contract);
  const emptyResolutionDigest = hash({ version: 1, state: createEntityResolutionState() });
  const emptyCoverageDigest = hash({ version: 1, state: normalized });
  const commit = db.transaction((): CanonicalEntityStoreWrite<CanonicalDatasetRecordV1> => {
    const existing = rowForDataset(db, normalized.datasetId);
    if (existing) {
      const current = datasetFromRow(db, existing);
      if (current.contractDigest !== contractDigest) {
        return { ok: false, kind: 'conflict', message: 'Dataset identity is already bound to a different contract.', current };
      }
      return { ok: true, inserted: false, value: current };
    }
    const [denominatorKind, denominatorValue] = denominatorColumns(normalized.denominator);
    db.prepare(`
      INSERT INTO canonical_datasets (
        dataset_id, contract_digest, universe_kind, denominator_kind, denominator_value,
        resolution_revision, resolution_digest, coverage_revision, coverage_digest,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)
    `).run(
      normalized.datasetId,
      contractDigest,
      normalized.universe.kind,
      denominatorKind,
      denominatorValue,
      emptyResolutionDigest,
      emptyCoverageDigest,
      createdAt,
      createdAt,
    );
    if (normalized.universe.kind === 'closed') {
      const insertPartition = db.prepare(`
        INSERT INTO canonical_dataset_declared_partitions (dataset_id, partition_id)
        VALUES (?, ?)
      `);
      for (const partitionId of normalized.universe.partitionIds) {
        insertPartition.run(normalized.datasetId, partitionId);
      }
    }
    const row = rowForDataset(db, normalized.datasetId)!;
    return { ok: true, inserted: true, value: datasetFromRow(db, row) };
  });
  return commit.immediate();
}

interface ObservationRow {
  dataset_id: string;
  observation_id: string;
  observation_digest: string;
  entity_kind: string;
  source_id: string;
  source_record_id: string;
  source_revision: string | null;
  observed_at: string;
  created_revision: number;
}

interface PolicyRow {
  policy_digest: string;
  policy_id: string;
  policy_json: string;
}

interface RecordRow {
  dataset_id: string;
  canonical_id: string;
  record_digest: string;
  entity_kind: string;
  created_at: string;
  updated_at: string;
  record_revision: number;
  created_revision: number;
}

function loadPolicySnapshot(
  db: Database.Database,
  datasetId: string,
  policyDigest: string,
): EntityResolutionPolicySnapshot {
  const row = db.prepare(`
    SELECT policy_digest, policy_id, policy_json
    FROM canonical_resolution_policies
    WHERE dataset_id = ? AND policy_digest = ?
    LIMIT 1
  `).get(datasetId, policyDigest) as PolicyRow | undefined;
  if (!row) throw new CanonicalEntityStoreIntegrityError('corrupt', `Missing retained policy ${policyDigest}.`);
  const policy = parseJson<EntityResolutionPolicySnapshot>(row.policy_json, `policy ${policyDigest}`);
  requireExactObjectKeys(policy, [
    'policyId', 'policyDigest', 'mergeThreshold', 'distinctThreshold', 'ambiguityMargin',
    'defaultExactIdentifierMatch', 'exactIdentifierMatches',
    'defaultCompoundSignalMatch', 'compoundSignalMatches',
    'exclusiveIdentifierNamespaces',
  ], `policy ${policyDigest}`);
  const content = {
    policyId: policy.policyId,
    mergeThreshold: policy.mergeThreshold,
    distinctThreshold: policy.distinctThreshold,
    ambiguityMargin: policy.ambiguityMargin,
    defaultExactIdentifierMatch: policy.defaultExactIdentifierMatch,
    exactIdentifierMatches: policy.exactIdentifierMatches,
    defaultCompoundSignalMatch: policy.defaultCompoundSignalMatch,
    compoundSignalMatches: policy.compoundSignalMatches,
    exclusiveIdentifierNamespaces: policy.exclusiveIdentifierNamespaces,
  };
  const expectedDigest = prefixedHash('entity-resolution-policy:v1', content);
  if (row.policy_id !== policy.policyId || row.policy_digest !== policy.policyDigest
    || expectedDigest !== policy.policyDigest || canonicalJson(policy) !== row.policy_json) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Policy ${policyDigest} failed canonical integrity checks.`);
  }
  return policy;
}

function policyInput(snapshot: EntityResolutionPolicySnapshot): EntityResolutionPolicy {
  return {
    policyId: snapshot.policyId,
    mergeThreshold: snapshot.mergeThreshold,
    distinctThreshold: snapshot.distinctThreshold,
    ambiguityMargin: snapshot.ambiguityMargin,
    weights: {
      defaultExactIdentifierMatch: snapshot.defaultExactIdentifierMatch,
      exactIdentifierMatches: snapshot.exactIdentifierMatches,
      defaultCompoundSignalMatch: snapshot.defaultCompoundSignalMatch,
      compoundSignalMatches: snapshot.compoundSignalMatches,
    },
    exclusiveIdentifierNamespaces: snapshot.exclusiveIdentifierNamespaces,
  };
}

function loadObservation(
  db: Database.Database,
  datasetId: string,
  observationId: string,
): EntityObservation | null {
  const row = db.prepare(`
    SELECT * FROM canonical_observations
    WHERE dataset_id = ? AND observation_id = ? LIMIT 1
  `).get(datasetId, observationId) as ObservationRow | undefined;
  if (!row) return null;
  const fieldRows = db.prepare(`
    SELECT * FROM canonical_observation_fields
    WHERE dataset_id = ? AND observation_id = ?
    ORDER BY field_name
  `).all(datasetId, observationId) as Array<{
    field_name: string;
    value_json: string;
    provenance_source_id: string;
    provenance_record_id: string;
    provenance_path: string | null;
    confidence: number;
    observed_at: string;
  }>;
  const exactRows = db.prepare(`
    SELECT namespace, value FROM canonical_observation_exact_identifiers
    WHERE dataset_id = ? AND observation_id = ?
  `).all(datasetId, observationId) as Array<{ namespace: string; value: string }>;
  const signalRows = db.prepare(`
    SELECT signal_name, fingerprint FROM canonical_observation_compound_signals
    WHERE dataset_id = ? AND observation_id = ?
  `).all(datasetId, observationId) as Array<{ signal_name: string; fingerprint: string }>;
  const fields: Record<string, EntityObservationInput['fields'][string]> = {};
  for (const field of fieldRows) {
    fields[field.field_name] = {
      value: parseJson<CanonicalJson>(field.value_json, `observation ${observationId} field ${field.field_name}`),
      provenance: {
        sourceId: field.provenance_source_id,
        recordId: field.provenance_record_id,
        ...(field.provenance_path === null ? {} : { path: field.provenance_path }),
      },
      confidence: field.confidence,
      observedAt: field.observed_at,
    };
  }
  const signals = signalRows.map((signal) => {
    const components = db.prepare(`
      SELECT component_name, component_value
      FROM canonical_observation_compound_components
      WHERE dataset_id = ? AND observation_id = ? AND fingerprint = ?
      ORDER BY component_name
    `).all(datasetId, observationId, signal.fingerprint) as Array<{
      component_name: string;
      component_value: string;
    }>;
    return {
      name: signal.signal_name,
      components: Object.fromEntries(components.map((component) => [component.component_name, component.component_value])),
    };
  });
  const observation = createEntityObservation({
    entityKind: row.entity_kind,
    origin: {
      sourceId: row.source_id,
      recordId: row.source_record_id,
      ...(row.source_revision === null ? {} : { revision: row.source_revision }),
    },
    observedAt: row.observed_at,
    fields,
    exactIdentifiers: exactRows,
    compoundSignals: signals,
  });
  if (observation.observationId !== row.observation_id
    || hash(observation) !== row.observation_digest) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Observation ${observationId} failed normalized integrity checks.`);
  }
  return observation;
}

function loadCandidates(
  db: Database.Database,
  datasetId: string,
  observationId: string,
): ResolutionCandidateScore[] {
  const rows = db.prepare(`
    SELECT rank, canonical_id, score
    FROM canonical_decision_candidates
    WHERE dataset_id = ? AND observation_id = ?
    ORDER BY rank
  `).all(datasetId, observationId) as Array<{ rank: number; canonical_id: string; score: number }>;
  return rows.map((row, expectedRank) => {
    if (row.rank !== expectedRank) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Decision ${observationId} candidate ranks are not contiguous.`);
    }
    const exact = (db.prepare(`
      SELECT match_id FROM canonical_candidate_exact_matches
      WHERE dataset_id = ? AND observation_id = ? AND candidate_rank = ?
      ORDER BY match_id
    `).all(datasetId, observationId, row.rank) as Array<{ match_id: string }>).map((entry) => entry.match_id);
    const compound = (db.prepare(`
      SELECT fingerprint FROM canonical_candidate_compound_matches
      WHERE dataset_id = ? AND observation_id = ? AND candidate_rank = ?
      ORDER BY fingerprint
    `).all(datasetId, observationId, row.rank) as Array<{ fingerprint: string }>).map((entry) => entry.fingerprint);
    const conflicts = (db.prepare(`
      SELECT namespace FROM canonical_candidate_exact_conflicts
      WHERE dataset_id = ? AND observation_id = ? AND candidate_rank = ?
      ORDER BY namespace
    `).all(datasetId, observationId, row.rank) as Array<{ namespace: string }>).map((entry) => entry.namespace);
    return {
      canonicalId: row.canonical_id,
      score: row.score,
      matchedExactIdentifiers: exact,
      matchedCompoundSignals: compound,
      conflictingExactNamespaces: conflicts,
    };
  });
}

function loadDecision(
  db: Database.Database,
  datasetId: string,
  observationId: string,
): EntityResolutionDecision | null {
  const row = db.prepare(`
    SELECT * FROM canonical_decisions
    WHERE dataset_id = ? AND observation_id = ? LIMIT 1
  `).get(datasetId, observationId) as {
    decision_digest: string;
    decision_kind: 'merge' | 'distinct' | 'quarantine';
    canonical_id: string | null;
    quarantine_id: string | null;
    policy_id: string;
    policy_digest: string;
    score: number | null;
    audit_id: string | null;
    quarantine_reason: Extract<EntityResolutionDecision, { decision: 'quarantine' }>['reason'] | null;
  } | undefined;
  if (!row) return null;
  const policy = loadPolicySnapshot(db, datasetId, row.policy_digest);
  const candidates = loadCandidates(db, datasetId, observationId);
  let decision: EntityResolutionDecision;
  if (row.decision_kind === 'quarantine') {
    if (!row.quarantine_id || !row.quarantine_reason || row.canonical_id !== null
      || row.score !== null || row.audit_id !== null) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Quarantine decision ${observationId} has contradictory columns.`);
    }
    decision = {
      decision: 'quarantine', observationId, quarantineId: row.quarantine_id,
      policyId: row.policy_id, policyDigest: row.policy_digest, policy,
      reason: row.quarantine_reason, candidates,
    };
  } else {
    if (!row.canonical_id || row.score === null || !row.audit_id
      || row.quarantine_id !== null || row.quarantine_reason !== null) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution decision ${observationId} has contradictory columns.`);
    }
    decision = {
      decision: row.decision_kind,
      observationId,
      canonicalId: row.canonical_id,
      policyId: row.policy_id,
      policyDigest: row.policy_digest,
      policy,
      score: row.score,
      candidates,
      auditId: row.audit_id,
    };
  }
  if (policy.policyId !== row.policy_id || hash(decision) !== row.decision_digest) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Decision ${observationId} failed normalized integrity checks.`);
  }
  const authorities = db.prepare(`
    SELECT result.decision_digest, result.decision_kind, result.canonical_id,
      batch.batch_id, batch.batch_ordinal, batch.committed_at
    FROM canonical_resolution_batch_results AS result
      INDEXED BY canonical_resolution_results_by_observation
    JOIN canonical_resolution_batches AS batch
      ON batch.dataset_id = result.dataset_id AND batch.batch_id = result.batch_id
    WHERE result.dataset_id = ? AND result.observation_id = ? AND result.idempotent = 0
    ORDER BY batch.batch_ordinal
  `).all(datasetId, observationId) as Array<{
    decision_digest: string;
    decision_kind: EntityResolutionDecision['decision'];
    canonical_id: string | null;
    batch_id: string;
    batch_ordinal: number;
    committed_at: string;
  }>;
  if (authorities.length !== 1) {
    throw new CanonicalEntityStoreIntegrityError(
      'corrupt',
      `Decision ${observationId} is not bound to exactly one committed transition.`,
    );
  }
  const authority = authorities[0]!;
  const canonicalId = decision.decision === 'quarantine' ? null : decision.canonicalId;
  if (authority.decision_digest !== row.decision_digest
    || authority.decision_kind !== decision.decision
    || authority.canonical_id !== canonicalId) {
    throw new CanonicalEntityStoreIntegrityError(
      'corrupt',
      `Decision ${observationId} disagrees with its committed transition.`,
    );
  }
  const quarantine = db.prepare(`
    SELECT quarantine_id, observation_id, reason, policy_digest, created_at, created_revision
    FROM canonical_quarantine
    WHERE dataset_id = ? AND observation_id = ? LIMIT 1
  `).get(datasetId, observationId) as {
    quarantine_id: string;
    observation_id: string;
    reason: Extract<EntityResolutionDecision, { decision: 'quarantine' }>['reason'];
    policy_digest: string;
    created_at: string;
    created_revision: number;
  } | undefined;
  if (decision.decision === 'quarantine') {
    if (!quarantine
      || quarantine.quarantine_id !== decision.quarantineId
      || quarantine.observation_id !== observationId
      || quarantine.reason !== decision.reason
      || quarantine.policy_digest !== decision.policyDigest
      || exactIso(quarantine.created_at, 'quarantine createdAt')
        !== exactIso(authority.committed_at, 'quarantine batch committedAt')
      || checkedCount(quarantine.created_revision, 'quarantine created revision')
        !== checkedCount(authority.batch_ordinal, 'quarantine batch ordinal')) {
      throw new CanonicalEntityStoreIntegrityError(
        'corrupt',
        `Quarantine decision ${observationId} has incomplete creation authority.`,
      );
    }
  } else if (quarantine) {
    throw new CanonicalEntityStoreIntegrityError(
      'corrupt',
      `Non-quarantine decision ${observationId} has a quarantine materialization.`,
    );
  }
  return decision;
}

function loadRecord(
  db: Database.Database,
  datasetId: string,
  canonicalId: string,
  pendingCreationRevision?: number,
): CanonicalEntityRecord | null {
  const row = db.prepare(`
    SELECT * FROM canonical_records
    WHERE dataset_id = ? AND canonical_id = ? LIMIT 1
  `).get(datasetId, canonicalId) as RecordRow | undefined;
  if (!row) return null;
  const observationIds = (db.prepare(`
    SELECT observation_id FROM canonical_record_observations
    WHERE dataset_id = ? AND canonical_id = ?
    ORDER BY observation_id
  `).all(datasetId, canonicalId) as Array<{ observation_id: string }>).map((entry) => entry.observation_id);
  const exactIdentifiers = (db.prepare(`
    SELECT namespace, value FROM canonical_record_exact_identifiers
    WHERE dataset_id = ? AND canonical_id = ?
  `).all(datasetId, canonicalId) as ExactEntityIdentifier[])
    .sort((left, right) => compareCanonicalEntityText(canonicalJson(left), canonicalJson(right)));
  const signalRows = db.prepare(`
    SELECT signal_name, fingerprint FROM canonical_record_compound_signals
    WHERE dataset_id = ? AND canonical_id = ?
  `).all(datasetId, canonicalId) as Array<{ signal_name: string; fingerprint: string }>;
  const compoundSignals: NormalizedCompoundSignal[] = signalRows.map((signal) => {
    const components = db.prepare(`
      SELECT component_name, component_value
      FROM canonical_record_compound_components
      WHERE dataset_id = ? AND canonical_id = ? AND fingerprint = ?
      ORDER BY component_name
    `).all(datasetId, canonicalId, signal.fingerprint) as Array<{
      component_name: string;
      component_value: string;
    }>;
    const normalized: NormalizedCompoundSignal = {
      name: signal.signal_name,
      components: Object.fromEntries(components.map((entry) => [entry.component_name, entry.component_value])),
      fingerprint: signal.fingerprint,
    };
    const expectedFingerprint = prefixedHash('compound-signal:v1', {
      name: normalized.name,
      components: normalized.components,
    });
    if (expectedFingerprint !== normalized.fingerprint) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Record ${canonicalId} has a malformed compound signal.`);
    }
    return normalized;
  }).sort((left, right) => compareCanonicalEntityText(left.fingerprint, right.fingerprint));

  const fieldRows = db.prepare(`
    SELECT field_name, selected_evidence_id, conflicting
    FROM canonical_fields
    WHERE dataset_id = ? AND canonical_id = ?
    ORDER BY field_name
  `).all(datasetId, canonicalId) as Array<{
    field_name: string;
    selected_evidence_id: string;
    conflicting: number;
  }>;
  const fields: Record<string, CanonicalEntityField> = {};
  for (const field of fieldRows) {
    if (field.conflicting !== 0 && field.conflicting !== 1) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Record ${canonicalId} field ${field.field_name} has an invalid conflict flag.`);
    }
    const evidenceRows = db.prepare(`
      SELECT e.evidence_id, e.observation_id,
        f.value_json, f.provenance_source_id, f.provenance_record_id,
        f.provenance_path, f.confidence, f.observed_at
      FROM canonical_field_evidence e
      JOIN canonical_observation_fields f
        ON f.dataset_id = e.dataset_id
       AND f.observation_id = e.observation_id
       AND f.field_name = e.field_name
      WHERE e.dataset_id = ? AND e.canonical_id = ? AND e.field_name = ?
    `).all(datasetId, canonicalId, field.field_name) as Array<{
      evidence_id: string;
      observation_id: string;
      value_json: string;
      provenance_source_id: string;
      provenance_record_id: string;
      provenance_path: string | null;
      confidence: number;
      observed_at: string;
    }>;
    const evidence: CanonicalFieldEvidence[] = evidenceRows.map((entry) => ({
      evidenceId: entry.evidence_id,
      observationId: entry.observation_id,
      field: field.field_name,
      value: parseJson<CanonicalJson>(entry.value_json, `evidence ${entry.evidence_id}`),
      provenance: {
        sourceId: entry.provenance_source_id,
        recordId: entry.provenance_record_id,
        ...(entry.provenance_path === null ? {} : { path: entry.provenance_path }),
      },
      confidence: entry.confidence,
      observedAt: entry.observed_at,
    })).sort((left, right) => compareCanonicalEntityText(left.evidenceId, right.evidenceId));
    if (!evidence.some((entry) => entry.evidenceId === field.selected_evidence_id)) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Record ${canonicalId} field ${field.field_name} selects missing evidence.`);
    }
    fields[field.field_name] = {
      name: field.field_name,
      selectedEvidenceId: field.selected_evidence_id,
      evidence,
      conflicting: field.conflicting === 1,
    };
  }

  const auditRows = db.prepare(`
    SELECT * FROM canonical_audits
    WHERE dataset_id = ? AND canonical_id = ?
    ORDER BY audit_ordinal
  `).all(datasetId, canonicalId) as Array<{
    audit_id: string;
    audit_digest: string;
    audit_ordinal: number;
    observation_id: string;
    action: 'create' | 'merge';
    observed_at: string;
    policy_id: string;
    policy_digest: string;
    score: number;
  }>;
  const audit: EntityResolutionAuditEntry[] = auditRows.map((entry, index) => {
    if (entry.audit_ordinal !== index + 1) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Record ${canonicalId} audit ordinals are not contiguous.`);
    }
    const policy = loadPolicySnapshot(db, datasetId, entry.policy_digest);
    const candidates = loadCandidates(db, datasetId, entry.observation_id);
    const changes = db.prepare(`
      SELECT * FROM canonical_audit_field_changes
      WHERE dataset_id = ? AND audit_id = ?
      ORDER BY field_name
    `).all(datasetId, entry.audit_id) as Array<{
      field_name: string;
      canonical_id: string;
      added_evidence_id: string;
      previous_evidence_id: string | null;
      selected_evidence_id: string;
      conflicting: number;
    }>;
    const fieldChanges: EntityAuditFieldChange[] = changes.map((change) => {
      if (change.canonical_id !== canonicalId || (change.conflicting !== 0 && change.conflicting !== 1)) {
        throw new CanonicalEntityStoreIntegrityError('corrupt', `Audit ${entry.audit_id} has a mismatched field change.`);
      }
      return {
        field: change.field_name,
        addedEvidenceId: change.added_evidence_id,
        ...(change.previous_evidence_id === null ? {} : { previousSelectedEvidenceId: change.previous_evidence_id }),
        selectedEvidenceId: change.selected_evidence_id,
        conflicting: change.conflicting === 1,
      };
    });
    const result: EntityResolutionAuditEntry = {
      auditId: entry.audit_id,
      action: entry.action,
      canonicalId,
      observationId: entry.observation_id,
      observedAt: entry.observed_at,
      policyId: entry.policy_id,
      policyDigest: entry.policy_digest,
      policy,
      score: entry.score,
      candidates,
      fieldChanges,
    };
    if (policy.policyId !== entry.policy_id || hash(result) !== entry.audit_digest) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Audit ${entry.audit_id} failed normalized integrity checks.`);
    }
    return result;
  });
  const record: CanonicalEntityRecord = {
    version: 1,
    canonicalId: row.canonical_id,
    entityKind: row.entity_kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    observationIds,
    exactIdentifiers,
    compoundSignals,
    fields,
    audit,
  };
  if (hash(record) !== row.record_digest) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Canonical record ${canonicalId} failed normalized integrity checks.`);
  }
  const creationAuthorities = db.prepare(`
    SELECT result.observation_id, batch.batch_ordinal
    FROM canonical_resolution_batch_results AS result
      INDEXED BY canonical_resolution_results_by_canonical
    JOIN canonical_resolution_batches AS batch
      ON batch.dataset_id = result.dataset_id AND batch.batch_id = result.batch_id
    WHERE result.dataset_id = ? AND result.canonical_id = ?
      AND result.decision_kind = 'distinct' AND result.idempotent = 0
    ORDER BY batch.batch_ordinal
  `).all(datasetId, canonicalId) as Array<{
    observation_id: string;
    batch_ordinal: number;
  }>;
  if (creationAuthorities.length === 0
    && pendingCreationRevision !== undefined
    && checkedCount(row.created_revision, 'pending record created revision') === pendingCreationRevision) {
    return record;
  }
  const creation = creationAuthorities[0];
  if (creationAuthorities.length !== 1
    || !creation
    || checkedCount(row.created_revision, 'record created revision')
      !== checkedCount(creation.batch_ordinal, 'record creation batch ordinal')
    || record.audit[0]?.action !== 'create'
    || record.audit[0]?.observationId !== creation.observation_id) {
    throw new CanonicalEntityStoreIntegrityError(
      'corrupt',
      `Canonical record ${canonicalId} has incomplete creation authority.`,
    );
  }
  return record;
}

export function getCanonicalObservation(
  datasetId: string,
  observationId: string,
  db: Database.Database = openCanonicalEntityStoreDb(),
): EntityObservation | null {
  const selected = databaseOrDefault(db);
  return readSnapshot(selected, () => loadObservation(
    selected,
    exactIdentifier(datasetId, 'datasetId'),
    exactIdentifier(observationId, 'observationId'),
  ));
}

export function getCanonicalDecision(
  datasetId: string,
  observationId: string,
  db: Database.Database = openCanonicalEntityStoreDb(),
): EntityResolutionDecision | null {
  const selected = databaseOrDefault(db);
  return readSnapshot(selected, () => loadDecision(
    selected,
    exactIdentifier(datasetId, 'datasetId'),
    exactIdentifier(observationId, 'observationId'),
  ));
}

export function getCanonicalRecord(
  datasetId: string,
  canonicalId: string,
  db: Database.Database = openCanonicalEntityStoreDb(),
): CanonicalEntityRecord | null {
  const selected = databaseOrDefault(db);
  return readSnapshot(selected, () => loadRecord(
    selected,
    exactIdentifier(datasetId, 'datasetId'),
    exactIdentifier(canonicalId, 'canonicalId'),
  ));
}

function candidateIdsForObservation(
  db: Database.Database,
  datasetId: string,
  observation: EntityObservation,
): string[] {
  const candidateIds = new Set<string>();
  const exactStatement = db.prepare(`
    SELECT i.canonical_id
    FROM canonical_record_exact_identifiers i
    JOIN canonical_records r
      ON r.dataset_id = i.dataset_id AND r.canonical_id = i.canonical_id
    WHERE i.dataset_id = ? AND i.namespace = ? AND i.value = ?
    ORDER BY i.canonical_id
  `);
  const exactAuthorityStatement = db.prepare(`
    SELECT DISTINCT membership.canonical_id
    FROM canonical_record_observations AS membership
      INDEXED BY canonical_record_observations_by_observation
    JOIN canonical_observation_exact_identifiers AS identifier
      INDEXED BY canonical_observation_exact_candidate_lookup
      ON identifier.dataset_id = membership.dataset_id
      AND identifier.observation_id = membership.observation_id
    WHERE membership.dataset_id = ? AND identifier.namespace = ? AND identifier.value = ?
    ORDER BY membership.canonical_id
  `);
  for (const identifier of observation.exactIdentifiers) {
    const indexed = (exactStatement.all(
      datasetId,
      identifier.namespace,
      identifier.value,
    ) as Array<{ canonical_id: string }>).map((row) => row.canonical_id);
    const authoritative = (exactAuthorityStatement.all(
      datasetId,
      identifier.namespace,
      identifier.value,
    ) as Array<{ canonical_id: string }>).map((row) => row.canonical_id);
    if (!sameBytes(indexed, authoritative)) {
      throw new CanonicalEntityStoreIntegrityError(
        'corrupt',
        `Exact candidate index disagrees with normalized evidence for ${identifier.namespace}.`,
      );
    }
    for (const canonicalId of authoritative) candidateIds.add(canonicalId);
  }
  const compoundStatement = db.prepare(`
    SELECT s.canonical_id
    FROM canonical_record_compound_signals s
    JOIN canonical_records r
      ON r.dataset_id = s.dataset_id AND r.canonical_id = s.canonical_id
    WHERE s.dataset_id = ? AND s.fingerprint = ?
    ORDER BY s.canonical_id
  `);
  const compoundAuthorityStatement = db.prepare(`
    SELECT DISTINCT membership.canonical_id
    FROM canonical_record_observations AS membership
      INDEXED BY canonical_record_observations_by_observation
    JOIN canonical_observation_compound_signals AS signal
      INDEXED BY canonical_observation_compound_candidate_lookup
      ON signal.dataset_id = membership.dataset_id
      AND signal.observation_id = membership.observation_id
    WHERE membership.dataset_id = ? AND signal.fingerprint = ?
    ORDER BY membership.canonical_id
  `);
  for (const signal of observation.compoundSignals) {
    const indexed = (compoundStatement.all(
      datasetId,
      signal.fingerprint,
    ) as Array<{ canonical_id: string }>).map((row) => row.canonical_id);
    const authoritative = (compoundAuthorityStatement.all(
      datasetId,
      signal.fingerprint,
    ) as Array<{ canonical_id: string }>).map((row) => row.canonical_id);
    if (!sameBytes(indexed, authoritative)) {
      throw new CanonicalEntityStoreIntegrityError(
        'corrupt',
        `Compound candidate index disagrees with normalized evidence for ${signal.fingerprint}.`,
      );
    }
    for (const canonicalId of authoritative) candidateIds.add(canonicalId);
  }
  return [...candidateIds].sort(compareCanonicalEntityText);
}

/** SQL-only candidate narrowing; this never loads a full dataset state. */
export function findCanonicalEntityCandidateIds(input: {
  datasetId: string;
  observation: EntityObservationInput;
  db?: Database.Database;
}): readonly string[] {
  const db = databaseOrDefault(input.db);
  const datasetId = exactIdentifier(input.datasetId, 'datasetId');
  if (!rowForDataset(db, datasetId)) return [];
  return candidateIdsForObservation(db, datasetId, createEntityObservation(input.observation));
}

function storePolicy(
  db: Database.Database,
  datasetId: string,
  snapshot: EntityResolutionPolicySnapshot,
): void {
  const json = canonicalJson(snapshot);
  const existing = db.prepare(`
    SELECT policy_digest, policy_id, policy_json
    FROM canonical_resolution_policies
    WHERE dataset_id = ? AND policy_digest = ? LIMIT 1
  `).get(datasetId, snapshot.policyDigest) as PolicyRow | undefined;
  if (existing) {
    if (existing.policy_id !== snapshot.policyId || existing.policy_json !== json) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Policy ${snapshot.policyDigest} is already bound to different bytes.`);
    }
    return;
  }
  db.prepare(`
    INSERT INTO canonical_resolution_policies (
      dataset_id, policy_digest, policy_id, policy_json
    ) VALUES (?, ?, ?, ?)
  `).run(datasetId, snapshot.policyDigest, snapshot.policyId, json);
}

function storeObservation(
  db: Database.Database,
  datasetId: string,
  observation: EntityObservation,
  createdRevision: number,
): void {
  const existing = loadObservation(db, datasetId, observation.observationId);
  if (existing) {
    if (!sameBytes(existing, observation)) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Observation ${observation.observationId} is bound to different bytes.`);
    }
    return;
  }
  db.prepare(`
    INSERT INTO canonical_observations (
      dataset_id, observation_id, observation_digest, entity_kind,
      source_id, source_record_id, source_revision, observed_at
      , created_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    datasetId,
    observation.observationId,
    hash(observation),
    observation.entityKind,
    observation.origin.sourceId,
    observation.origin.recordId,
    observation.origin.revision ?? null,
    observation.observedAt,
    createdRevision,
  );
  const insertField = db.prepare(`
    INSERT INTO canonical_observation_fields (
      dataset_id, observation_id, field_name, value_json,
      provenance_source_id, provenance_record_id, provenance_path,
      confidence, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [name, field] of Object.entries(observation.fields)) {
    insertField.run(
      datasetId, observation.observationId, name, canonicalJson(field.value),
      field.provenance.sourceId, field.provenance.recordId, field.provenance.path ?? null,
      field.confidence, field.observedAt,
    );
  }
  const insertIdentifier = db.prepare(`
    INSERT INTO canonical_observation_exact_identifiers (
      dataset_id, observation_id, namespace, value
    ) VALUES (?, ?, ?, ?)
  `);
  for (const identifier of observation.exactIdentifiers) {
    insertIdentifier.run(datasetId, observation.observationId, identifier.namespace, identifier.value);
  }
  const insertSignal = db.prepare(`
    INSERT INTO canonical_observation_compound_signals (
      dataset_id, observation_id, signal_name, fingerprint
    ) VALUES (?, ?, ?, ?)
  `);
  const insertComponent = db.prepare(`
    INSERT INTO canonical_observation_compound_components (
      dataset_id, observation_id, fingerprint, component_name, component_value
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const signal of observation.compoundSignals) {
    insertSignal.run(datasetId, observation.observationId, signal.name, signal.fingerprint);
    for (const [name, value] of Object.entries(signal.components)) {
      insertComponent.run(datasetId, observation.observationId, signal.fingerprint, name, value);
    }
  }
}

function storeCandidates(
  db: Database.Database,
  datasetId: string,
  observationId: string,
  candidates: readonly ResolutionCandidateScore[],
): void {
  const insertCandidate = db.prepare(`
    INSERT INTO canonical_decision_candidates (
      dataset_id, observation_id, rank, canonical_id, score
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertExact = db.prepare(`
    INSERT INTO canonical_candidate_exact_matches (
      dataset_id, observation_id, candidate_rank, match_id
    ) VALUES (?, ?, ?, ?)
  `);
  const insertCompound = db.prepare(`
    INSERT INTO canonical_candidate_compound_matches (
      dataset_id, observation_id, candidate_rank, fingerprint
    ) VALUES (?, ?, ?, ?)
  `);
  const insertConflict = db.prepare(`
    INSERT INTO canonical_candidate_exact_conflicts (
      dataset_id, observation_id, candidate_rank, namespace
    ) VALUES (?, ?, ?, ?)
  `);
  for (const [rank, candidate] of candidates.entries()) {
    insertCandidate.run(datasetId, observationId, rank, candidate.canonicalId, candidate.score);
    for (const match of candidate.matchedExactIdentifiers) insertExact.run(datasetId, observationId, rank, match);
    for (const fingerprint of candidate.matchedCompoundSignals) insertCompound.run(datasetId, observationId, rank, fingerprint);
    for (const namespace of candidate.conflictingExactNamespaces) insertConflict.run(datasetId, observationId, rank, namespace);
  }
}

function storeDecision(
  db: Database.Database,
  datasetId: string,
  decision: EntityResolutionDecision,
  committedAt: string,
  createdRevision: number,
): void {
  const existing = loadDecision(db, datasetId, decision.observationId);
  if (existing) {
    if (!sameBytes(existing, decision)) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Decision ${decision.observationId} is bound to different bytes.`);
    }
    return;
  }
  storePolicy(db, datasetId, decision.policy);
  db.prepare(`
    INSERT INTO canonical_decisions (
      dataset_id, observation_id, decision_digest, decision_kind,
      canonical_id, quarantine_id, policy_id, policy_digest, score,
      audit_id, quarantine_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    datasetId,
    decision.observationId,
    hash(decision),
    decision.decision,
    decision.decision === 'quarantine' ? null : decision.canonicalId,
    decision.decision === 'quarantine' ? decision.quarantineId : null,
    decision.policyId,
    decision.policyDigest,
    decision.decision === 'quarantine' ? null : decision.score,
    decision.decision === 'quarantine' ? null : decision.auditId,
    decision.decision === 'quarantine' ? decision.reason : null,
  );
  storeCandidates(db, datasetId, decision.observationId, decision.candidates);
  if (decision.decision === 'quarantine') {
    db.prepare(`
      INSERT INTO canonical_quarantine (
        dataset_id, quarantine_id, observation_id, reason, policy_digest, created_at,
        created_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      datasetId,
      decision.quarantineId,
      decision.observationId,
      decision.reason,
      decision.policyDigest,
      committedAt,
      createdRevision,
    );
  }
}

function storeRecord(
  db: Database.Database,
  datasetId: string,
  record: CanonicalEntityRecord,
  resolutionRevision: number,
): void {
  const existingRow = db.prepare(`
    SELECT * FROM canonical_records
    WHERE dataset_id = ? AND canonical_id = ? LIMIT 1
  `).get(datasetId, record.canonicalId) as RecordRow | undefined;
  if (!existingRow) {
    db.prepare(`
      INSERT INTO canonical_records (
        dataset_id, canonical_id, record_digest, entity_kind, created_at, updated_at
        , record_revision, created_revision
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      datasetId, record.canonicalId, hash(record), record.entityKind,
      record.createdAt, record.updatedAt,
      resolutionRevision,
    );
  } else {
    const previous = loadRecord(db, datasetId, record.canonicalId, resolutionRevision)!;
    if (previous.entityKind !== record.entityKind
      || !record.observationIds.every((id) => previous.observationIds.includes(id) || id === record.audit.at(-1)?.observationId)
      || record.audit.length < previous.audit.length
      || !sameBytes(record.audit.slice(0, previous.audit.length), previous.audit)) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Canonical record ${record.canonicalId} attempted a non-append transition.`);
    }
    const update = db.prepare(`
      UPDATE canonical_records
      SET record_digest = ?, created_at = ?, updated_at = ?, record_revision = record_revision + 1
      WHERE dataset_id = ? AND canonical_id = ? AND record_digest = ?
    `).run(
      hash(record), record.createdAt, record.updatedAt,
      datasetId, record.canonicalId, existingRow.record_digest,
    );
    if (update.changes !== 1) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Canonical record ${record.canonicalId} CAS update failed.`);
    }
  }

  const insertObservation = db.prepare(`
    INSERT OR IGNORE INTO canonical_record_observations (
      dataset_id, canonical_id, observation_id
    ) VALUES (?, ?, ?)
  `);
  for (const observationId of record.observationIds) {
    insertObservation.run(datasetId, record.canonicalId, observationId);
  }
  const insertIdentifier = db.prepare(`
    INSERT OR IGNORE INTO canonical_record_exact_identifiers (
      dataset_id, canonical_id, namespace, value
    ) VALUES (?, ?, ?, ?)
  `);
  for (const identifier of record.exactIdentifiers) {
    insertIdentifier.run(datasetId, record.canonicalId, identifier.namespace, identifier.value);
  }
  const insertSignal = db.prepare(`
    INSERT OR IGNORE INTO canonical_record_compound_signals (
      dataset_id, canonical_id, signal_name, fingerprint
    ) VALUES (?, ?, ?, ?)
  `);
  const insertComponent = db.prepare(`
    INSERT OR IGNORE INTO canonical_record_compound_components (
      dataset_id, canonical_id, fingerprint, component_name, component_value
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const signal of record.compoundSignals) {
    insertSignal.run(datasetId, record.canonicalId, signal.name, signal.fingerprint);
    for (const [name, value] of Object.entries(signal.components)) {
      insertComponent.run(datasetId, record.canonicalId, signal.fingerprint, name, value);
    }
  }
  const upsertField = db.prepare(`
    INSERT INTO canonical_fields (
      dataset_id, canonical_id, field_name, selected_evidence_id, conflicting
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(dataset_id, canonical_id, field_name) DO UPDATE SET
      selected_evidence_id = excluded.selected_evidence_id,
      conflicting = excluded.conflicting
  `);
  const insertEvidence = db.prepare(`
    INSERT OR IGNORE INTO canonical_field_evidence (
      dataset_id, canonical_id, field_name, evidence_id, observation_id
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const [name, field] of Object.entries(record.fields)) {
    upsertField.run(datasetId, record.canonicalId, name, field.selectedEvidenceId, field.conflicting ? 1 : 0);
    for (const evidence of field.evidence) {
      insertEvidence.run(
        datasetId, record.canonicalId, name, evidence.evidenceId, evidence.observationId,
      );
    }
  }
  const insertAudit = db.prepare(`
    INSERT OR IGNORE INTO canonical_audits (
      dataset_id, audit_id, audit_digest, canonical_id, audit_ordinal,
      observation_id, action, observed_at, policy_id, policy_digest, score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChange = db.prepare(`
    INSERT OR IGNORE INTO canonical_audit_field_changes (
      dataset_id, audit_id, field_name, added_evidence_id,
      canonical_id, previous_evidence_id, selected_evidence_id, conflicting
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [index, audit] of record.audit.entries()) {
    storePolicy(db, datasetId, audit.policy);
    insertAudit.run(
      datasetId, audit.auditId, hash(audit), record.canonicalId, index + 1,
      audit.observationId, audit.action, audit.observedAt,
      audit.policyId, audit.policyDigest, audit.score,
    );
    for (const change of audit.fieldChanges) {
      insertChange.run(
        datasetId, audit.auditId, change.field, change.addedEvidenceId, record.canonicalId,
        change.previousSelectedEvidenceId ?? null, change.selectedEvidenceId,
        change.conflicting ? 1 : 0,
      );
    }
  }
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

function validateStoredResolutionSummary(
  row: ResolutionBatchRow,
): DurableCanonicalResolutionSummaryV1 {
  const summary = parseJson<DurableCanonicalResolutionSummaryV1>(
    row.summary_json,
    `resolution batch ${row.batch_id} summary`,
  );
  requireExactObjectKeys(summary, [
    'version', 'summaryId', 'batchId', 'previousAuthorityRoot', 'nextAuthorityRoot',
    'uniqueObservationCount', 'observationsCommitted', 'canonicalRecordsCreated',
    'mergedObservations', 'quarantinedObservations', 'replayedObservations',
    'duplicateObservationIdentities', 'duplicateObservations',
    'provenanceAssertions', 'provenanceOrigins', 'quarantineReasons',
  ], `resolution batch ${row.batch_id} summary`);
  if (!summary.quarantineReasons || typeof summary.quarantineReasons !== 'object'
    || Array.isArray(summary.quarantineReasons)) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} has malformed quarantine reasons.`);
  }
  const content = {
    version: summary.version,
    batchId: summary.batchId,
    previousAuthorityRoot: summary.previousAuthorityRoot,
    nextAuthorityRoot: summary.nextAuthorityRoot,
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
  const expectedSummaryId = prefixedHash('canonical-resolution-store-summary:v1', content);
  for (const [label, value] of Object.entries({
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
  })) checkedCount(value, `stored summary ${label}`);
  const committedDecisions = checkedAdd(
    checkedAdd(summary.canonicalRecordsCreated, summary.mergedObservations, 'stored committed decisions'),
    summary.quarantinedObservations,
    'stored committed decisions',
  );
  if (summary.version !== 1
    || summary.summaryId !== expectedSummaryId
    || summary.summaryId !== row.summary_id
    || summary.batchId !== row.batch_id
    || summary.previousAuthorityRoot !== row.previous_digest
    || summary.nextAuthorityRoot !== row.next_digest
    || summary.observationsCommitted !== committedDecisions
    || summary.uniqueObservationCount !== checkedAdd(
      summary.observationsCommitted,
      summary.replayedObservations,
      'stored unique observation count',
    )
    || summary.duplicateObservations > summary.duplicateObservationIdentities
    || summary.duplicateObservations > summary.observationsCommitted
    || summary.provenanceOrigins > summary.provenanceAssertions
    || canonicalJson(summary) !== row.summary_json) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} has a corrupt summary.`);
  }
  const quarantineReasonAllowlist = new Set([
    'exact_identifier_collision', 'conflicting_exact_identifier', 'ambiguous_candidates',
    'threshold_uncertainty', 'canonical_id_collision',
  ]);
  if (Object.keys(summary.quarantineReasons).some((reason) => !quarantineReasonAllowlist.has(reason))) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} has an unsupported quarantine reason.`);
  }
  const quarantineTotal = Object.values(summary.quarantineReasons).reduce(
    (total, count) => checkedAdd(total, checkedCount(count, 'quarantine reason count'), 'quarantine reason total'),
    0,
  );
  if (quarantineTotal !== summary.quarantinedObservations) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} has contradictory quarantine counts.`);
  }
  return summary;
}

function loadResolutionBatchReceipt(
  db: Database.Database,
  row: ResolutionBatchRow,
  candidateRecordsLoaded = 0,
): DurableCanonicalResolutionBatchReceiptV1 {
  const summary = validateStoredResolutionSummary(row);
  loadPolicySnapshot(db, row.dataset_id, row.policy_digest);
  const resultRows = db.prepare(`
    SELECT result_ordinal, observation_id, idempotent,
      observation_digest, decision_digest, decision_kind,
      canonical_id, transition_record_digest
    FROM canonical_resolution_batch_results
    WHERE dataset_id = ? AND batch_id = ?
    ORDER BY result_ordinal
  `).all(row.dataset_id, row.batch_id) as Array<{
    result_ordinal: number;
    observation_id: string;
    idempotent: number;
    observation_digest: string;
    decision_digest: string;
    decision_kind: EntityResolutionDecision['decision'];
    canonical_id: string | null;
    transition_record_digest: string | null;
  }>;
  if (resultRows.length !== summary.uniqueObservationCount) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} has an incomplete result set.`);
  }
  const retainedResults = resultRows.map((result, index) => {
    if (result.result_ordinal !== index || (result.idempotent !== 0 && result.idempotent !== 1)) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} result order is corrupt.`);
    }
    const observation = loadObservation(db, row.dataset_id, result.observation_id);
    const decision = loadDecision(db, row.dataset_id, result.observation_id);
    if (!observation || !decision) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} references missing durable authority.`);
    }
    const canonicalId = decision.decision === 'quarantine' ? null : decision.canonicalId;
    if (hash(observation) !== result.observation_digest
      || hash(decision) !== result.decision_digest
      || decision.decision !== result.decision_kind
      || canonicalId !== result.canonical_id
      || (result.idempotent === 1 && result.transition_record_digest !== null)
      || (result.idempotent === 0 && decision.decision !== 'quarantine'
        && !/^[a-f0-9]{64}$/.test(result.transition_record_digest ?? ''))
      || (decision.decision === 'quarantine' && result.transition_record_digest !== null)) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} has a forged transition leaf.`);
    }
    return {
      observationId: observation.observationId,
      observation,
      idempotent: result.idempotent === 1,
      decision,
      transitionRecordDigest: result.transition_record_digest,
    };
  });
  for (let index = 1; index < retainedResults.length; index += 1) {
    if (retainedResults[index - 1]!.observationId >= retainedResults[index]!.observationId) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} results are not a sorted semantic set.`);
    }
  }
  const duplicateObservationIds = (db.prepare(`
    SELECT observation_id
    FROM canonical_resolution_batch_duplicates
    WHERE dataset_id = ? AND batch_id = ?
    ORDER BY observation_id
  `).all(row.dataset_id, row.batch_id) as Array<{ observation_id: string }>).map((entry) => entry.observation_id);
  const resultById = new Map(retainedResults.map((result) => [result.observationId, result]));
  if (duplicateObservationIds.some((observationId) => !resultById.has(observationId))) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} has a duplicate outside its result set.`);
  }
  const expectedBatchId = prefixedHash('entity-resolution-batch:v1', {
    observationIds: retainedResults.map((result) => result.observationId),
    policyDigest: row.policy_digest,
  });
  const expectedInputDigest = hash({
    version: 1,
    datasetId: row.dataset_id,
    observations: retainedResults.map((result) => result.observation),
    duplicateObservationIds,
    policyDigest: row.policy_digest,
  });
  if (expectedBatchId !== row.batch_id || expectedInputDigest !== row.input_digest) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} input authority cannot be reconstructed.`);
  }

  let observationsCommitted = 0;
  let canonicalRecordsCreated = 0;
  let mergedObservations = 0;
  let quarantinedObservations = 0;
  let replayedObservations = 0;
  let provenanceAssertions = 0;
  const provenanceOrigins = new Set<string>();
  const quarantineReasons = new Map<string, number>();
  for (const result of retainedResults) {
    if (result.idempotent) {
      replayedObservations = checkedAdd(replayedObservations, 1, 'stored replayed observations');
      continue;
    }
    observationsCommitted = checkedAdd(observationsCommitted, 1, 'stored committed observations');
    for (const field of Object.values(result.observation.fields)) {
      provenanceAssertions = checkedAdd(provenanceAssertions, 1, 'stored provenance assertions');
      provenanceOrigins.add(canonicalJson([field.provenance.sourceId, field.provenance.recordId]));
    }
    if (result.decision.decision === 'distinct') {
      canonicalRecordsCreated = checkedAdd(canonicalRecordsCreated, 1, 'stored created records');
    } else if (result.decision.decision === 'merge') {
      mergedObservations = checkedAdd(mergedObservations, 1, 'stored merged observations');
    } else {
      quarantinedObservations = checkedAdd(quarantinedObservations, 1, 'stored quarantined observations');
      quarantineReasons.set(
        result.decision.reason,
        checkedAdd(quarantineReasons.get(result.decision.reason) ?? 0, 1, 'stored quarantine reason'),
      );
    }
  }
  const duplicateObservations = duplicateObservationIds.filter((observationId) => (
    resultById.get(observationId)?.idempotent === false
  )).length;
  if (summary.uniqueObservationCount !== retainedResults.length
    || summary.observationsCommitted !== observationsCommitted
    || summary.canonicalRecordsCreated !== canonicalRecordsCreated
    || summary.mergedObservations !== mergedObservations
    || summary.quarantinedObservations !== quarantinedObservations
    || summary.replayedObservations !== replayedObservations
    || summary.duplicateObservationIdentities !== duplicateObservationIds.length
    || summary.duplicateObservations !== duplicateObservations
    || summary.provenanceAssertions !== provenanceAssertions
    || summary.provenanceOrigins !== provenanceOrigins.size
    || !sameBytes(summary.quarantineReasons, sortedCountRecord(quarantineReasons))) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} summary is not derivable from normalized receipts.`);
  }
  const expectedNextRoot = observationsCommitted === 0
    ? row.previous_digest
    : hash({
        version: 1,
        previousAuthorityRoot: row.previous_digest,
        datasetId: row.dataset_id,
        batchId: row.batch_id,
        inputDigest: row.input_digest,
        policyDigest: row.policy_digest,
        transitions: retainedResults.filter((result) => !result.idempotent).map((result) => ({
          observationId: result.observationId,
          decisionDigest: hash(result.decision),
          recordDigest: result.transitionRecordDigest,
        })),
      });
  if (expectedNextRoot !== row.next_digest) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Resolution batch ${row.batch_id} authority root is not derivable from its transition leaves.`);
  }
  const results = retainedResults.map(({ observationId, idempotent, decision }) => ({
    observationId,
    idempotent,
    decision,
  }));
  return {
    version: 1,
    datasetId: row.dataset_id,
    batchId: row.batch_id,
    batchOrdinal: checkedCount(row.batch_ordinal, 'batch ordinal'),
    inputDigest: row.input_digest,
    policyDigest: row.policy_digest,
    summary,
    committedAt: exactIso(row.committed_at, 'batch committedAt'),
    candidateRecordsLoaded,
    results,
  };
}

function resolutionBatchRow(
  db: Database.Database,
  datasetId: string,
  batchId: string,
): ResolutionBatchRow | undefined {
  return db.prepare(`
    SELECT * FROM canonical_resolution_batches
    WHERE dataset_id = ? AND batch_id = ? LIMIT 1
  `).get(datasetId, batchId) as ResolutionBatchRow | undefined;
}

function validateResolutionLedger(
  db: Database.Database,
  dataset: CanonicalDatasetRecordV1,
  deep = false,
): void {
  const stats = db.prepare(`
    SELECT COUNT(*) AS count, MIN(batch_ordinal) AS minimum, MAX(batch_ordinal) AS maximum
    FROM canonical_resolution_batches
    WHERE dataset_id = ?
  `).get(dataset.datasetId) as { count: number; minimum: number | null; maximum: number | null };
  if (stats.count !== dataset.resolutionRevision
    || (stats.count > 0 && (stats.minimum !== 1 || stats.maximum !== stats.count))) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} resolution revision does not match its batch ledger.`);
  }
  const initialRoot = hash({ version: 1, state: createEntityResolutionState() });
  if (stats.count === 0) {
    if (dataset.resolutionDigest !== initialRoot) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} empty resolution head is invalid.`);
    }
    return;
  }
  const latest = db.prepare(`
    SELECT * FROM canonical_resolution_batches
    WHERE dataset_id = ? AND batch_ordinal = ? LIMIT 1
  `).get(dataset.datasetId, dataset.resolutionRevision) as ResolutionBatchRow | undefined;
  if (!latest || loadResolutionBatchReceipt(db, latest).summary.nextAuthorityRoot !== dataset.resolutionDigest) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} resolution head does not match its ledger.`);
  }
  if (!deep) return;
  const rows = db.prepare(`
    SELECT * FROM canonical_resolution_batches
    WHERE dataset_id = ?
    ORDER BY batch_ordinal
  `).all(dataset.datasetId) as ResolutionBatchRow[];
  let authorityRoot = initialRoot;
  for (const [index, row] of rows.entries()) {
    if (row.batch_ordinal !== index + 1 || row.previous_digest !== authorityRoot) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} resolution ledger is not contiguous.`);
    }
    const summary = loadResolutionBatchReceipt(db, row).summary;
    if (summary.nextAuthorityRoot !== row.next_digest) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} resolution ledger root is invalid.`);
    }
    authorityRoot = row.next_digest;
  }
  if (authorityRoot !== dataset.resolutionDigest) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} resolution head does not match its ledger.`);
  }
}

function sortedCountRecord(values: Map<string, number>): Readonly<Record<string, number>> {
  return Object.fromEntries([...values.entries()]
    .sort(([left], [right]) => compareCanonicalEntityText(left, right)));
}

/**
 * Commit one semantic observation set. Exact retry is checked before CAS; a
 * new transition requires both the reviewed revision and authority root.
 */
export function commitCanonicalEntityBatch(input: {
  datasetId: string;
  expectedResolutionRevision: number;
  expectedResolutionDigest: string;
  observations: readonly EntityObservationInput[];
  policy: EntityResolutionPolicy;
  committedAt?: string;
  db?: Database.Database;
}): CanonicalEntityStoreWrite<DurableCanonicalResolutionBatchReceiptV1> {
  const db = databaseOrDefault(input.db);
  const datasetId = exactIdentifier(input.datasetId, 'datasetId');
  const expectedRevision = checkedCount(input.expectedResolutionRevision, 'expectedResolutionRevision');
  if (!/^[a-f0-9]{64}$/.test(input.expectedResolutionDigest)) {
    throw new CanonicalEntityStoreIntegrityError('invalid', 'expectedResolutionDigest must be sha256 hex.');
  }
  if (!Array.isArray(input.observations)) {
    throw new CanonicalEntityStoreIntegrityError('invalid', 'observations must be an array.');
  }
  const committedAt = exactIso(input.committedAt ?? new Date().toISOString(), 'committedAt');
  const suppliedPolicy = createEntityResolutionPolicySnapshot(input.policy);
  const normalized = input.observations.map((source) => ({
    source,
    observation: createEntityObservation(source),
  }));
  const byId = new Map<string, { source: EntityObservationInput; observation: EntityObservation }>();
  const duplicates = new Set<string>();
  for (const entry of normalized) {
    if (byId.has(entry.observation.observationId)) duplicates.add(entry.observation.observationId);
    else byId.set(entry.observation.observationId, entry);
  }
  const ordered = [...byId.values()].sort((left, right) => (
    compareCanonicalEntityText(left.observation.observationId, right.observation.observationId)
  ));
  const dryBatch = upsertEntityObservationBatch(createEntityResolutionState(), input.observations, input.policy);
  const duplicateObservationIds = [...duplicates].sort(compareCanonicalEntityText);
  if (!sameBytes(dryBatch.duplicateObservationIds, duplicateObservationIds)) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', 'Pure batch duplicate normalization disagreed with durable normalization.');
  }
  const inputDigest = hash({
    version: 1,
    datasetId,
    observations: ordered.map((entry) => entry.observation),
    duplicateObservationIds,
    policyDigest: suppliedPolicy.policyDigest,
  });

  const commit = db.transaction((): CanonicalEntityStoreWrite<DurableCanonicalResolutionBatchReceiptV1> => {
    const row = rowForDataset(db, datasetId);
    if (!row) return { ok: false, kind: 'not_found', message: `Dataset ${datasetId} does not exist.` };
    const current = datasetFromRow(db, row);
    const existingBatch = resolutionBatchRow(db, datasetId, dryBatch.batchId);
    if (existingBatch) {
      if (existingBatch.input_digest !== inputDigest
        || existingBatch.policy_digest !== suppliedPolicy.policyDigest) {
        throw new CanonicalEntityStoreIntegrityError(
          'corrupt',
          `Resolution batch ${dryBatch.batchId} is already bound to different canonical input bytes.`,
        );
      }
      const receipt = loadResolutionBatchReceipt(db, existingBatch);
      validateResolutionLedger(db, current);
      return { ok: true, inserted: false, value: receipt };
    }
    if (current.resolutionRevision !== expectedRevision
      || current.resolutionDigest !== input.expectedResolutionDigest) {
      return {
        ok: false,
        kind: 'cas_mismatch',
        message: 'Resolution authority changed after the caller reviewed it.',
        current,
      };
    }
    validateResolutionLedger(db, current);
    const nextRevision = checkedAdd(current.resolutionRevision, 1, 'resolution revision');
    storePolicy(db, datasetId, suppliedPolicy);

    const results: Array<{
      observationId: string;
      idempotent: boolean;
      decision: EntityResolutionDecision;
      transitionRecordDigest?: string;
    }> = [];
    let candidateRecordsLoaded = 0;
    for (const entry of ordered) {
      const retainedObservation = loadObservation(db, datasetId, entry.observation.observationId);
      const retainedDecision = loadDecision(db, datasetId, entry.observation.observationId);
      if (retainedObservation || retainedDecision) {
        if (!retainedObservation || !retainedDecision || !sameBytes(retainedObservation, entry.observation)) {
          throw new CanonicalEntityStoreIntegrityError(
            'corrupt',
            `Observation ${entry.observation.observationId} has incomplete or conflicting retained authority.`,
          );
        }
        results.push({
          observationId: entry.observation.observationId,
          idempotent: true,
          decision: retainedDecision,
        });
        continue;
      }

      const candidateIds = candidateIdsForObservation(db, datasetId, entry.observation);
      const records: Record<string, CanonicalEntityRecord> = {};
      for (const canonicalId of candidateIds) {
        const record = loadRecord(db, datasetId, canonicalId, nextRevision);
        if (!record) {
          throw new CanonicalEntityStoreIntegrityError('corrupt', `Candidate index points to missing record ${canonicalId}.`);
        }
        records[canonicalId] = record;
      }
      candidateRecordsLoaded = checkedAdd(
        candidateRecordsLoaded,
        candidateIds.length,
        'candidateRecordsLoaded',
      );
      let result = upsertEntityObservation(
        { version: 1, records, observations: {}, decisions: {} },
        entry.source,
        input.policy,
      );
      if (result.decision.decision === 'distinct') {
        const collision = loadRecord(db, datasetId, result.decision.canonicalId, nextRevision);
        if (collision && !records[collision.canonicalId]) {
          records[collision.canonicalId] = collision;
          candidateRecordsLoaded = checkedAdd(candidateRecordsLoaded, 1, 'candidateRecordsLoaded');
          result = upsertEntityObservation(
            { version: 1, records, observations: {}, decisions: {} },
            entry.source,
            input.policy,
          );
        }
      }
      const durableObservation = result.state.observations[entry.observation.observationId];
      if (!durableObservation || !sameBytes(durableObservation, entry.observation)) {
        throw new CanonicalEntityStoreIntegrityError('corrupt', 'Pure resolution did not retain the normalized observation bytes.');
      }
      storeObservation(db, datasetId, durableObservation, nextRevision);
      let transitionRecordDigest: string | undefined;
      if (result.decision.decision !== 'quarantine') {
        const record = result.state.records[result.decision.canonicalId];
        if (!record || !record.observationIds.includes(durableObservation.observationId)) {
          throw new CanonicalEntityStoreIntegrityError('corrupt', 'Pure resolution omitted its decided canonical record.');
        }
        transitionRecordDigest = hash(record);
        storeRecord(db, datasetId, record, nextRevision);
      }
      storeDecision(db, datasetId, result.decision, committedAt, nextRevision);
      results.push({
        observationId: durableObservation.observationId,
        idempotent: false,
        decision: result.decision,
        ...(transitionRecordDigest ? { transitionRecordDigest } : {}),
      });
    }

    let observationsCommitted = 0;
    let canonicalRecordsCreated = 0;
    let mergedObservations = 0;
    let quarantinedObservations = 0;
    let replayedObservations = 0;
    let provenanceAssertions = 0;
    const provenanceOrigins = new Set<string>();
    const quarantineReasons = new Map<string, number>();
    const newlyCommitted = new Set<string>();
    for (const result of results) {
      if (result.idempotent) {
        replayedObservations = checkedAdd(replayedObservations, 1, 'replayedObservations');
        continue;
      }
      newlyCommitted.add(result.observationId);
      observationsCommitted = checkedAdd(observationsCommitted, 1, 'observationsCommitted');
      const observation = byId.get(result.observationId)!.observation;
      for (const field of Object.values(observation.fields)) {
        provenanceAssertions = checkedAdd(provenanceAssertions, 1, 'provenanceAssertions');
        provenanceOrigins.add(canonicalJson([field.provenance.sourceId, field.provenance.recordId]));
      }
      if (result.decision.decision === 'distinct') {
        canonicalRecordsCreated = checkedAdd(canonicalRecordsCreated, 1, 'canonicalRecordsCreated');
      } else if (result.decision.decision === 'merge') {
        mergedObservations = checkedAdd(mergedObservations, 1, 'mergedObservations');
      } else {
        quarantinedObservations = checkedAdd(quarantinedObservations, 1, 'quarantinedObservations');
        quarantineReasons.set(
          result.decision.reason,
          checkedAdd(quarantineReasons.get(result.decision.reason) ?? 0, 1, 'quarantine reason'),
        );
      }
    }
    const duplicateObservations = duplicateObservationIds.filter((id) => newlyCommitted.has(id)).length;
    const nextAuthorityRoot = observationsCommitted === 0
      ? current.resolutionDigest
      : hash({
          version: 1,
          previousAuthorityRoot: current.resolutionDigest,
          datasetId,
          batchId: dryBatch.batchId,
          inputDigest,
          policyDigest: suppliedPolicy.policyDigest,
          transitions: results.filter((result) => !result.idempotent).map((result) => ({
            observationId: result.observationId,
            decisionDigest: hash(result.decision),
            recordDigest: result.transitionRecordDigest ?? null,
          })),
        });
    const summaryContent = {
      version: 1 as const,
      batchId: dryBatch.batchId,
      previousAuthorityRoot: current.resolutionDigest,
      nextAuthorityRoot,
      uniqueObservationCount: results.length,
      observationsCommitted,
      canonicalRecordsCreated,
      mergedObservations,
      quarantinedObservations,
      replayedObservations,
      duplicateObservationIdentities: duplicateObservationIds.length,
      duplicateObservations,
      provenanceAssertions,
      provenanceOrigins: provenanceOrigins.size,
      quarantineReasons: sortedCountRecord(quarantineReasons),
    };
    const summary: DurableCanonicalResolutionSummaryV1 = {
      ...summaryContent,
      summaryId: prefixedHash('canonical-resolution-store-summary:v1', summaryContent),
    };
    const summaryJson = canonicalJson(summary);
    db.prepare(`
      INSERT INTO canonical_resolution_batches (
        dataset_id, batch_id, batch_ordinal, input_digest, policy_digest,
        previous_digest, next_digest, summary_id, summary_json, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      datasetId, dryBatch.batchId, nextRevision, inputDigest, suppliedPolicy.policyDigest,
      current.resolutionDigest, nextAuthorityRoot, summary.summaryId, summaryJson, committedAt,
    );
    const insertResult = db.prepare(`
      INSERT INTO canonical_resolution_batch_results (
        dataset_id, batch_id, result_ordinal, observation_id, idempotent,
        observation_digest, decision_digest, decision_kind, canonical_id,
        transition_record_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, result] of results.entries()) {
      const observation = byId.get(result.observationId)?.observation;
      if (!observation) {
        throw new CanonicalEntityStoreIntegrityError(
          'corrupt',
          `Resolution result ${result.observationId} has no normalized observation authority.`,
        );
      }
      insertResult.run(
        datasetId,
        dryBatch.batchId,
        index,
        result.observationId,
        result.idempotent ? 1 : 0,
        hash(observation),
        hash(result.decision),
        result.decision.decision,
        result.decision.decision === 'quarantine' ? null : result.decision.canonicalId,
        result.transitionRecordDigest ?? null,
      );
    }
    const insertDuplicate = db.prepare(`
      INSERT INTO canonical_resolution_batch_duplicates (
        dataset_id, batch_id, observation_id
      ) VALUES (?, ?, ?)
    `);
    for (const observationId of duplicateObservationIds) {
      insertDuplicate.run(datasetId, dryBatch.batchId, observationId);
    }
    const updatedAt = current.updatedAt > committedAt ? current.updatedAt : committedAt;
    const update = db.prepare(`
      UPDATE canonical_datasets
      SET resolution_revision = ?, resolution_digest = ?, updated_at = ?
      WHERE dataset_id = ? AND resolution_revision = ? AND resolution_digest = ?
    `).run(
      nextRevision, nextAuthorityRoot, updatedAt,
      datasetId, current.resolutionRevision, current.resolutionDigest,
    );
    if (update.changes !== 1) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', 'Resolution dataset CAS update failed inside its immediate transaction.');
    }
    const stored = resolutionBatchRow(db, datasetId, dryBatch.batchId)!;
    return {
      ok: true,
      inserted: true,
      value: loadResolutionBatchReceipt(db, stored, candidateRecordsLoaded),
    };
  });
  return commit.immediate();
}

export type CanonicalCoverageRejectionReason =
  | 'partition_outside_closed_universe'
  | 'cursor_discontinuity'
  | 'partition_already_exhausted'
  | 'denominator_contradiction'
  | 'coverage_count_contradiction'
  | 'item_partition_collision';

export interface DurableCanonicalCoveragePageReceiptV1 {
  readonly version: 1;
  readonly datasetId: string;
  readonly page: CoveragePage;
  readonly coverageOrdinal: number;
  readonly pageOrdinal: number;
  readonly previousAuthorityRoot: string;
  readonly nextAuthorityRoot: string;
  readonly previousItemCount: number;
  readonly nextItemCount: number;
  readonly previousMinimumCount: number;
  readonly nextMinimumCount: number;
  readonly cursorCycleDetected: boolean;
  readonly committedAt: string;
}

export type CanonicalCoveragePageWrite =
  | { readonly ok: true; readonly inserted: boolean; readonly value: DurableCanonicalCoveragePageReceiptV1 }
  | {
    readonly ok: false;
    readonly kind: 'not_found' | 'cas_mismatch' | 'coverage_rejected';
    readonly message: string;
    readonly reason?: CanonicalCoverageRejectionReason;
    readonly current?: CanonicalDatasetRecordV1;
  };

interface CoveragePartitionRow {
  dataset_id: string;
  partition_id: string;
  next_cursor: string | null;
  exhaustion: 'more' | 'exhausted' | 'unknown';
  denominator_kind: 'exact' | 'lower_bound' | 'unknown';
  denominator_value: number | null;
  status: CoverageStatus;
  page_count: number;
  item_count: number;
  updated_at: string;
}

interface CoveragePageRow {
  dataset_id: string;
  partition_id: string;
  page_id: string;
  coverage_ordinal: number;
  page_ordinal: number;
  input_cursor: string | null;
  output_cursor: string | null;
  exhaustion: 'more' | 'exhausted' | 'unknown';
  denominator_kind: 'exact' | 'lower_bound' | 'unknown';
  denominator_value: number | null;
  item_count: number;
  previous_item_count: number;
  next_item_count: number;
  previous_minimum_count: number;
  next_minimum_count: number;
  cursor_cycle_detected: number;
  previous_digest: string;
  next_digest: string;
  page_digest: string;
  committed_at: string;
}

function reconcileCoverageDenominator(
  current: CoverageDenominator | undefined,
  incoming: CoverageDenominator,
): CoverageDenominator | null {
  if (!current || current.kind === 'unknown') return incoming;
  if (incoming.kind === 'unknown') return current;
  if (current.kind === 'exact') {
    if (incoming.kind === 'exact') return current.total === incoming.total ? current : null;
    return incoming.atLeast <= current.total ? current : null;
  }
  if (incoming.kind === 'exact') return incoming.total >= current.atLeast ? incoming : null;
  return { kind: 'lower_bound', atLeast: Math.max(current.atLeast, incoming.atLeast) };
}

function coveragePartitionStatus(
  observed: number,
  denominator: CoverageDenominator,
  exhaustion: CoveragePage['exhaustion'],
): CoverageStatus | null {
  if (denominator.kind === 'exact' && observed > denominator.total) return null;
  if (exhaustion === 'exhausted') {
    if (denominator.kind !== 'exact') return 'unknown';
    return observed === denominator.total ? 'complete' : null;
  }
  if (exhaustion === 'more') return 'partial';
  if (denominator.kind === 'exact' && observed < denominator.total) return 'partial';
  if (denominator.kind === 'lower_bound' && observed < denominator.atLeast) return 'partial';
  return 'unknown';
}

function coverageDenominatorMinimum(denominator: CoverageDenominator): number {
  if (denominator.kind === 'exact') return denominator.total;
  if (denominator.kind === 'lower_bound') return denominator.atLeast;
  return 0;
}

function coveragePageRow(
  db: Database.Database,
  datasetId: string,
  partitionId: string,
  pageId: string,
): CoveragePageRow | undefined {
  return db.prepare(`
    SELECT * FROM canonical_coverage_pages
    WHERE dataset_id = ? AND partition_id = ? AND page_id = ? LIMIT 1
  `).get(datasetId, partitionId, pageId) as CoveragePageRow | undefined;
}

function loadCoveragePageReceipt(
  db: Database.Database,
  row: CoveragePageRow,
): DurableCanonicalCoveragePageReceiptV1 {
  const itemIds = (db.prepare(`
    SELECT item_id FROM canonical_coverage_page_items
    WHERE dataset_id = ? AND partition_id = ? AND page_id = ?
    ORDER BY item_id
  `).all(row.dataset_id, row.partition_id, row.page_id) as Array<{ item_id: string }>).map((entry) => entry.item_id);
  const page = createCoveragePage(row.dataset_id, {
    partitionId: row.partition_id,
    inputCursor: row.input_cursor,
    outputCursor: row.output_cursor,
    exhaustion: row.exhaustion,
    denominator: denominatorFromColumns(row.denominator_kind, row.denominator_value, `page ${row.page_id} denominator`),
    itemIds,
  });
  if (page.pageId !== row.page_id || hash(page) !== row.page_digest
    || itemIds.length !== checkedCount(row.item_count, `page ${row.page_id} item count`)
    || (row.cursor_cycle_detected !== 0 && row.cursor_cycle_detected !== 1)
    || !/^[a-f0-9]{64}$/.test(row.previous_digest)
    || !/^[a-f0-9]{64}$/.test(row.next_digest)) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Coverage page ${row.page_id} failed normalized integrity checks.`);
  }
  const itemAuthorities = db.prepare(`
    SELECT current.item_id, owner.partition_id AS owner_partition_id,
      owner.first_page_id, owner.first_seen_revision,
      MIN(authority_page.coverage_ordinal) AS earliest_revision
    FROM canonical_coverage_page_items AS current
    LEFT JOIN canonical_coverage_item_owners AS owner
      ON owner.dataset_id = current.dataset_id AND owner.item_id = current.item_id
    LEFT JOIN canonical_coverage_page_items AS occurrence
      ON occurrence.dataset_id = current.dataset_id AND occurrence.item_id = current.item_id
    LEFT JOIN canonical_coverage_pages AS authority_page
      ON authority_page.dataset_id = occurrence.dataset_id
      AND authority_page.partition_id = occurrence.partition_id
      AND authority_page.page_id = occurrence.page_id
    WHERE current.dataset_id = ? AND current.partition_id = ? AND current.page_id = ?
    GROUP BY current.item_id, owner.partition_id, owner.first_page_id, owner.first_seen_revision
    ORDER BY current.item_id
  `).all(row.dataset_id, row.partition_id, row.page_id) as Array<{
    item_id: string;
    owner_partition_id: string | null;
    first_page_id: string | null;
    first_seen_revision: number | null;
    earliest_revision: number | null;
  }>;
  if (itemAuthorities.length !== itemIds.length) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Coverage page ${row.page_id} has incomplete item authority.`);
  }
  for (const authority of itemAuthorities) {
    if (authority.owner_partition_id !== row.partition_id
      || checkedCount(authority.first_seen_revision, 'coverage item first revision')
        !== checkedCount(authority.earliest_revision, 'coverage item earliest revision')) {
      throw new CanonicalEntityStoreIntegrityError(
        'corrupt',
        `Coverage item ${authority.item_id} is not bound to its earliest partition occurrence.`,
      );
    }
  }
  if (row.output_cursor !== null) {
    const visit = db.prepare(`
      SELECT first_page_id, first_page_ordinal
      FROM canonical_coverage_cursor_visits
      WHERE dataset_id = ? AND partition_id = ? AND cursor = ? LIMIT 1
    `).get(row.dataset_id, row.partition_id, row.output_cursor) as {
      first_page_id: string;
      first_page_ordinal: number;
    } | undefined;
    const priorOccurrence = Boolean(db.prepare(`
      SELECT 1 FROM canonical_coverage_pages
      WHERE dataset_id = ? AND partition_id = ? AND output_cursor = ?
        AND page_ordinal < ? LIMIT 1
    `).get(row.dataset_id, row.partition_id, row.output_cursor, row.page_ordinal));
    if (!visit
      || priorOccurrence !== (row.cursor_cycle_detected === 1)
      || (priorOccurrence && visit.first_page_ordinal >= row.page_ordinal)
      || (!priorOccurrence
        && (visit.first_page_id !== row.page_id || visit.first_page_ordinal !== row.page_ordinal))) {
      throw new CanonicalEntityStoreIntegrityError(
        'corrupt',
        `Coverage page ${row.page_id} cursor authority is incomplete or contradictory.`,
      );
    }
  }
  const previousItemCount = checkedCount(row.previous_item_count, 'coverage previous item count');
  const nextItemCount = checkedCount(row.next_item_count, 'coverage next item count');
  const previousMinimumCount = checkedCount(
    row.previous_minimum_count,
    'coverage previous minimum count',
  );
  const nextMinimumCount = checkedCount(row.next_minimum_count, 'coverage next minimum count');
  const newlyOwned = checkedCount((db.prepare(`
    SELECT COUNT(*) AS count
    FROM canonical_coverage_item_owners INDEXED BY canonical_coverage_items_first_revision
    WHERE dataset_id = ? AND first_seen_revision = ?
  `).get(row.dataset_id, row.coverage_ordinal) as { count: number }).count, 'coverage newly owned items');
  if (nextItemCount !== checkedAdd(previousItemCount, newlyOwned, 'coverage next item count')
    || nextMinimumCount < previousMinimumCount) {
    throw new CanonicalEntityStoreIntegrityError(
      'corrupt',
      `Coverage page ${row.page_id} has contradictory dataset counters.`,
    );
  }
  const expectedRoot = hash({
    version: 1,
    previousAuthorityRoot: row.previous_digest,
    datasetId: row.dataset_id,
    coverageOrdinal: row.coverage_ordinal,
    pageDigest: row.page_digest,
    previousItemCount,
    nextItemCount,
    previousMinimumCount,
    nextMinimumCount,
    cursorCycleDetected: row.cursor_cycle_detected === 1,
  });
  if (expectedRoot !== row.next_digest) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Coverage page ${row.page_id} has an invalid authority root.`);
  }
  return {
    version: 1,
    datasetId: row.dataset_id,
    page,
    coverageOrdinal: checkedCount(row.coverage_ordinal, 'coverage ordinal'),
    pageOrdinal: checkedCount(row.page_ordinal, 'page ordinal'),
    previousAuthorityRoot: row.previous_digest,
    nextAuthorityRoot: row.next_digest,
    previousItemCount,
    nextItemCount,
    previousMinimumCount,
    nextMinimumCount,
    cursorCycleDetected: row.cursor_cycle_detected === 1,
    committedAt: exactIso(row.committed_at, 'page committedAt'),
  };
}

function loadCoveragePartition(
  db: Database.Database,
  datasetId: string,
  partitionId: string,
): CoveragePartitionRow | null {
  const row = db.prepare(`
    SELECT * FROM canonical_coverage_partitions
    WHERE dataset_id = ? AND partition_id = ? LIMIT 1
  `).get(datasetId, partitionId) as CoveragePartitionRow | undefined;
  if (!row) return null;
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM canonical_coverage_pages
        WHERE dataset_id = ? AND partition_id = ?) AS page_count,
      (SELECT COUNT(*) FROM canonical_coverage_item_owners
        WHERE dataset_id = ? AND partition_id = ?) AS item_count
  `).get(datasetId, partitionId, datasetId, partitionId) as { page_count: number; item_count: number };
  const pageCount = checkedCount(row.page_count, `partition ${partitionId} page count`);
  const itemCount = checkedCount(row.item_count, `partition ${partitionId} item count`);
  if (counts.page_count !== pageCount || counts.item_count !== itemCount || pageCount === 0) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Coverage partition ${partitionId} has contradictory cached counts.`);
  }
  const pages = db.prepare(`
    SELECT page_ordinal, output_cursor, exhaustion, denominator_kind, denominator_value
    FROM canonical_coverage_pages
    WHERE dataset_id = ? AND partition_id = ?
    ORDER BY page_ordinal
  `).all(datasetId, partitionId) as Array<{
    page_ordinal: number;
    output_cursor: string | null;
    exhaustion: CoveragePage['exhaustion'];
    denominator_kind: string;
    denominator_value: number | null;
  }>;
  let denominator: CoverageDenominator | undefined;
  for (const [index, page] of pages.entries()) {
    if (page.page_ordinal !== index + 1) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Coverage partition ${partitionId} page ordinals are not contiguous.`);
    }
    denominator = reconcileCoverageDenominator(
      denominator,
      denominatorFromColumns(page.denominator_kind, page.denominator_value, `partition ${partitionId} page denominator`),
    ) ?? undefined;
    if (!denominator) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Coverage partition ${partitionId} has contradictory retained denominators.`);
    }
  }
  const latest = pages.at(-1)!;
  const storedDenominator = denominatorFromColumns(
    row.denominator_kind,
    row.denominator_value,
    `partition ${partitionId} denominator`,
  );
  const status = coveragePartitionStatus(itemCount, storedDenominator, row.exhaustion);
  if (!sameBytes(storedDenominator, denominator)
    || row.next_cursor !== latest.output_cursor
    || row.exhaustion !== latest.exhaustion
    || status === null
    || status !== row.status) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Coverage partition ${partitionId} cached state is not derivable from its normalized rows.`);
  }
  exactIso(row.updated_at, `partition ${partitionId} updatedAt`);
  return row;
}

function validateCoverageLedger(
  db: Database.Database,
  dataset: CanonicalDatasetRecordV1,
  deep = false,
): void {
  const headRow = rowForDataset(db, dataset.datasetId);
  if (!headRow) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} coverage head is missing.`);
  }
  const headItemCount = checkedCount(headRow.coverage_item_count, 'coverage head item count');
  const headMinimumCount = checkedCount(headRow.coverage_minimum_count, 'coverage head minimum count');
  const stats = db.prepare(`
    SELECT COUNT(*) AS count, MIN(coverage_ordinal) AS minimum, MAX(coverage_ordinal) AS maximum
    FROM canonical_coverage_pages
    WHERE dataset_id = ?
  `).get(dataset.datasetId) as { count: number; minimum: number | null; maximum: number | null };
  if (stats.count !== dataset.coverageRevision
    || (stats.count > 0 && (stats.minimum !== 1 || stats.maximum !== stats.count))) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} coverage revision does not match its page ledger.`);
  }
  const initialRoot = hash({
    version: 1,
    state: createDatasetCoverageState(dataset.datasetId, dataset.universe, dataset.denominator),
  });
  if (stats.count === 0) {
    if (dataset.coverageDigest !== initialRoot || headItemCount !== 0 || headMinimumCount !== 0) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} empty coverage head is invalid.`);
    }
    return;
  }
  const latest = db.prepare(`
    SELECT * FROM canonical_coverage_pages
    WHERE dataset_id = ? AND coverage_ordinal = ? LIMIT 1
  `).get(dataset.datasetId, dataset.coverageRevision) as CoveragePageRow | undefined;
  const latestReceipt = latest ? loadCoveragePageReceipt(db, latest) : undefined;
  if (!latestReceipt
    || latestReceipt.nextAuthorityRoot !== dataset.coverageDigest
    || latestReceipt.nextItemCount !== headItemCount
    || latestReceipt.nextMinimumCount !== headMinimumCount) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} coverage head does not match its ledger.`);
  }
  if (!deep) return;
  const rows = db.prepare(`
    SELECT * FROM canonical_coverage_pages
    WHERE dataset_id = ?
    ORDER BY coverage_ordinal
  `).all(dataset.datasetId) as CoveragePageRow[];
  let authorityRoot = initialRoot;
  let itemCount = 0;
  let minimumCount = 0;
  const partitionDenominators = new Map<string, CoverageDenominator>();
  for (const [index, row] of rows.entries()) {
    if (row.coverage_ordinal !== index + 1 || row.previous_digest !== authorityRoot) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} coverage ledger is not contiguous.`);
    }
    const priorDenominator = partitionDenominators.get(row.partition_id);
    const nextDenominator = reconcileCoverageDenominator(
      priorDenominator,
      denominatorFromColumns(row.denominator_kind, row.denominator_value, 'coverage ledger denominator'),
    );
    if (!nextDenominator) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} coverage denominator chain is invalid.`);
    }
    const priorMinimum = coverageDenominatorMinimum(priorDenominator ?? { kind: 'unknown' });
    if (priorMinimum > minimumCount) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} coverage minimum chain is invalid.`);
    }
    const expectedMinimumCount = checkedAdd(
      minimumCount - priorMinimum,
      coverageDenominatorMinimum(nextDenominator),
      'coverage ledger minimum count',
    );
    const receipt = loadCoveragePageReceipt(db, row);
    if (receipt.previousItemCount !== itemCount
      || receipt.previousMinimumCount !== minimumCount
      || receipt.nextMinimumCount !== expectedMinimumCount) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} coverage counter chain is invalid.`);
    }
    const expectedRoot = hash({
      version: 1,
      previousAuthorityRoot: authorityRoot,
      datasetId: dataset.datasetId,
      coverageOrdinal: row.coverage_ordinal,
      pageDigest: row.page_digest,
      previousItemCount: receipt.previousItemCount,
      nextItemCount: receipt.nextItemCount,
      previousMinimumCount: receipt.previousMinimumCount,
      nextMinimumCount: receipt.nextMinimumCount,
      cursorCycleDetected: row.cursor_cycle_detected === 1,
    });
    if (expectedRoot !== row.next_digest) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} coverage root chain is invalid.`);
    }
    itemCount = receipt.nextItemCount;
    minimumCount = receipt.nextMinimumCount;
    partitionDenominators.set(row.partition_id, nextDenominator);
    authorityRoot = row.next_digest;
  }
  if (authorityRoot !== dataset.coverageDigest
    || itemCount !== headItemCount
    || minimumCount !== headMinimumCount) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${dataset.datasetId} coverage head does not match its ledger.`);
  }
}

function itemOwnersFor(
  db: Database.Database,
  datasetId: string,
  itemIds: readonly string[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (let offset = 0; offset < itemIds.length; offset += 400) {
    const chunk = itemIds.slice(offset, offset + 400);
    if (chunk.length === 0) continue;
    const ownerRows = db.prepare(`
      SELECT item_id, partition_id
      FROM canonical_coverage_item_owners
      WHERE dataset_id = ? AND item_id IN (${chunk.map(() => '?').join(',')})
    `).all(datasetId, ...chunk) as Array<{ item_id: string; partition_id: string }>;
    const membershipRows = db.prepare(`
      SELECT DISTINCT item_id, partition_id
      FROM canonical_coverage_page_items
      WHERE dataset_id = ? AND item_id IN (${chunk.map(() => '?').join(',')})
      ORDER BY item_id, partition_id
    `).all(datasetId, ...chunk) as Array<{ item_id: string; partition_id: string }>;
    const memberships = new Map<string, string>();
    for (const membership of membershipRows) {
      const prior = memberships.get(membership.item_id);
      if (prior && prior !== membership.partition_id) {
        throw new CanonicalEntityStoreIntegrityError(
          'corrupt',
          `Coverage item ${membership.item_id} appears in multiple partitions.`,
        );
      }
      memberships.set(membership.item_id, membership.partition_id);
    }
    for (const owner of ownerRows) {
      if (memberships.get(owner.item_id) !== owner.partition_id) {
        throw new CanonicalEntityStoreIntegrityError(
          'corrupt',
          `Coverage item ${owner.item_id} owner disagrees with page membership.`,
        );
      }
      owners.set(owner.item_id, owner.partition_id);
    }
    for (const [itemId] of memberships) {
      if (!owners.has(itemId)) {
        throw new CanonicalEntityStoreIntegrityError(
          'corrupt',
          `Coverage item ${itemId} has page membership without an owner.`,
        );
      }
    }
  }
  return owners;
}

export function appendCanonicalCoveragePage(input: {
  datasetId: string;
  expectedCoverageRevision: number;
  expectedCoverageDigest: string;
  page: CoveragePageInput;
  committedAt?: string;
  db?: Database.Database;
}): CanonicalCoveragePageWrite {
  const db = databaseOrDefault(input.db);
  const datasetId = exactIdentifier(input.datasetId, 'datasetId');
  const expectedRevision = checkedCount(input.expectedCoverageRevision, 'expectedCoverageRevision');
  if (!/^[a-f0-9]{64}$/.test(input.expectedCoverageDigest)) {
    throw new CanonicalEntityStoreIntegrityError('invalid', 'expectedCoverageDigest must be sha256 hex.');
  }
  const page = createCoveragePage(datasetId, input.page);
  exactIdentifier(page.partitionId, 'partitionId');
  if ((page.inputCursor !== null && page.inputCursor.length > 8_192)
    || (page.outputCursor !== null && page.outputCursor.length > 8_192)) {
    throw new CanonicalEntityStoreIntegrityError('invalid', 'Coverage cursors must be bounded opaque values.');
  }
  for (const [index, itemId] of page.itemIds.entries()) {
    exactIdentifier(itemId, `itemIds[${index}]`);
  }
  const committedAt = exactIso(input.committedAt ?? new Date().toISOString(), 'committedAt');
  const commit = db.transaction((): CanonicalCoveragePageWrite => {
    const datasetRow = rowForDataset(db, datasetId);
    if (!datasetRow) return { ok: false, kind: 'not_found', message: `Dataset ${datasetId} does not exist.` };
    const current = datasetFromRow(db, datasetRow);
    const existingPage = coveragePageRow(db, datasetId, page.partitionId, page.pageId);
    if (existingPage) {
      const receipt = loadCoveragePageReceipt(db, existingPage);
      if (!sameBytes(receipt.page, page)) {
        throw new CanonicalEntityStoreIntegrityError('corrupt', `Coverage page ${page.pageId} is bound to different bytes.`);
      }
      validateCoverageLedger(db, current);
      return { ok: true, inserted: false, value: receipt };
    }
    if (current.coverageRevision !== expectedRevision
      || current.coverageDigest !== input.expectedCoverageDigest) {
      return {
        ok: false,
        kind: 'cas_mismatch',
        message: 'Coverage authority changed after the caller reviewed it.',
        current,
      };
    }
    validateCoverageLedger(db, current);
    if (current.universe.kind === 'closed'
      && !current.universe.partitionIds.includes(page.partitionId)) {
      return {
        ok: false,
        kind: 'coverage_rejected',
        reason: 'partition_outside_closed_universe',
        message: `Partition ${page.partitionId} is outside the closed dataset universe.`,
        current,
      };
    }
    const partition = loadCoveragePartition(db, datasetId, page.partitionId);
    if (partition?.exhaustion === 'exhausted') {
      return { ok: false, kind: 'coverage_rejected', reason: 'partition_already_exhausted', message: 'Partition is already exhausted.', current };
    }
    if (partition?.exhaustion === 'unknown' && partition.next_cursor === null) {
      return { ok: false, kind: 'coverage_rejected', reason: 'cursor_discontinuity', message: 'Unknown exhaustion has no resumable cursor.', current };
    }
    const expectedCursor = partition?.next_cursor ?? null;
    if (page.inputCursor !== expectedCursor) {
      return { ok: false, kind: 'coverage_rejected', reason: 'cursor_discontinuity', message: 'Coverage input cursor does not match the retained continuation.', current };
    }
    const denominator = reconcileCoverageDenominator(
      partition
        ? denominatorFromColumns(partition.denominator_kind, partition.denominator_value, 'partition denominator')
        : undefined,
      page.denominator,
    );
    if (!denominator) {
      return { ok: false, kind: 'coverage_rejected', reason: 'denominator_contradiction', message: 'Coverage denominator contradicts retained truth.', current };
    }
    const owners = itemOwnersFor(db, datasetId, page.itemIds);
    for (const [itemId, owner] of owners) {
      if (owner !== page.partitionId) {
        return {
          ok: false,
          kind: 'coverage_rejected',
          reason: 'item_partition_collision',
          message: `Item ${itemId} is already owned by another partition.`,
          current,
        };
      }
    }
    const newItems = page.itemIds.filter((itemId) => !owners.has(itemId));
    const nextItemCount = checkedAdd(partition?.item_count ?? 0, newItems.length, 'partition item count');
    const status = coveragePartitionStatus(nextItemCount, denominator, page.exhaustion);
    if (!status) {
      return { ok: false, kind: 'coverage_rejected', reason: 'coverage_count_contradiction', message: 'Coverage item count contradicts its denominator.', current };
    }
    const nextDatasetItemCount = checkedAdd(
      checkedCount(datasetRow.coverage_item_count, 'dataset coverage item count'),
      newItems.length,
      'dataset coverage item count',
    );
    const priorMinimum = partition
      ? coverageDenominatorMinimum(denominatorFromColumns(
          partition.denominator_kind,
          partition.denominator_value,
          'prior partition denominator',
        ))
      : 0;
    const retainedMinimum = checkedCount(
      datasetRow.coverage_minimum_count,
      'dataset coverage minimum count',
    );
    if (priorMinimum > retainedMinimum) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', 'Dataset coverage minimum cache is contradictory.');
    }
    const nextDatasetMinimumCount = checkedAdd(
      retainedMinimum - priorMinimum,
      coverageDenominatorMinimum(denominator),
      'dataset coverage minimum count',
    );
    if (current.denominator.kind === 'exact'
      && nextDatasetItemCount > current.denominator.total) {
      return {
        ok: false,
        kind: 'coverage_rejected',
        reason: 'coverage_count_contradiction',
        message: 'Dataset item count would exceed its exact denominator.',
        current,
      };
    }
    if (current.denominator.kind === 'exact'
      && nextDatasetMinimumCount > current.denominator.total) {
      return {
        ok: false,
        kind: 'coverage_rejected',
        reason: 'denominator_contradiction',
        message: 'Partition denominators would exceed the dataset exact denominator.',
        current,
      };
    }
    const nextRevision = checkedAdd(current.coverageRevision, 1, 'coverage revision');
    const pageOrdinal = checkedAdd(partition?.page_count ?? 0, 1, 'partition page ordinal');
    const cursorCycle = page.outputCursor !== null && Boolean(db.prepare(`
      SELECT 1 FROM canonical_coverage_pages
      WHERE dataset_id = ? AND partition_id = ? AND output_cursor = ? LIMIT 1
    `).get(datasetId, page.partitionId, page.outputCursor));
    const pageDigest = hash(page);
    const nextAuthorityRoot = hash({
      version: 1,
      previousAuthorityRoot: current.coverageDigest,
      datasetId,
      coverageOrdinal: nextRevision,
      pageDigest,
      previousItemCount: datasetRow.coverage_item_count,
      nextItemCount: nextDatasetItemCount,
      previousMinimumCount: datasetRow.coverage_minimum_count,
      nextMinimumCount: nextDatasetMinimumCount,
      cursorCycleDetected: cursorCycle,
    });
    const [denominatorKind, denominatorValue] = denominatorColumns(denominator);
    if (!partition) {
      db.prepare(`
        INSERT INTO canonical_coverage_partitions (
          dataset_id, partition_id, next_cursor, exhaustion,
          denominator_kind, denominator_value, status,
          page_count, item_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        datasetId, page.partitionId, page.outputCursor, page.exhaustion,
        denominatorKind, denominatorValue, status, pageOrdinal, nextItemCount, committedAt,
      );
    }
    const [pageDenominatorKind, pageDenominatorValue] = denominatorColumns(page.denominator);
    db.prepare(`
      INSERT INTO canonical_coverage_pages (
        dataset_id, partition_id, page_id, coverage_ordinal, page_ordinal,
        input_cursor, output_cursor, exhaustion, denominator_kind, denominator_value,
        item_count, previous_item_count, next_item_count,
        previous_minimum_count, next_minimum_count,
        cursor_cycle_detected, previous_digest, next_digest,
        page_digest, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      datasetId, page.partitionId, page.pageId, nextRevision, pageOrdinal,
      page.inputCursor, page.outputCursor, page.exhaustion,
      pageDenominatorKind, pageDenominatorValue, page.itemIds.length,
      datasetRow.coverage_item_count, nextDatasetItemCount,
      datasetRow.coverage_minimum_count, nextDatasetMinimumCount,
      cursorCycle ? 1 : 0, current.coverageDigest, nextAuthorityRoot,
      pageDigest, committedAt,
    );
    const insertPageItem = db.prepare(`
      INSERT INTO canonical_coverage_page_items (
        dataset_id, partition_id, page_id, item_id
      ) VALUES (?, ?, ?, ?)
    `);
    for (const itemId of page.itemIds) insertPageItem.run(datasetId, page.partitionId, page.pageId, itemId);
    const insertOwner = db.prepare(`
      INSERT INTO canonical_coverage_item_owners (
        dataset_id, item_id, partition_id, first_page_id, first_seen_revision
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const itemId of newItems) {
      insertOwner.run(datasetId, itemId, page.partitionId, page.pageId, nextRevision);
    }
    if (page.outputCursor !== null && !cursorCycle) {
      db.prepare(`
        INSERT INTO canonical_coverage_cursor_visits (
          dataset_id, partition_id, cursor, first_page_id, first_page_ordinal
        ) VALUES (?, ?, ?, ?, ?)
      `).run(datasetId, page.partitionId, page.outputCursor, page.pageId, pageOrdinal);
    }
    if (partition) {
      db.prepare(`
        UPDATE canonical_coverage_partitions
        SET next_cursor = ?, exhaustion = ?, denominator_kind = ?, denominator_value = ?,
            status = ?, page_count = ?, item_count = ?, updated_at = ?
        WHERE dataset_id = ? AND partition_id = ?
      `).run(
        page.outputCursor, page.exhaustion, denominatorKind, denominatorValue,
        status, pageOrdinal, nextItemCount, committedAt,
        datasetId, page.partitionId,
      );
    }
    const updatedAt = current.updatedAt > committedAt ? current.updatedAt : committedAt;
    const update = db.prepare(`
      UPDATE canonical_datasets
      SET coverage_revision = ?, coverage_digest = ?, coverage_item_count = ?,
          coverage_minimum_count = ?, updated_at = ?
      WHERE dataset_id = ? AND coverage_revision = ? AND coverage_digest = ?
        AND coverage_item_count = ? AND coverage_minimum_count = ?
    `).run(
      nextRevision, nextAuthorityRoot, nextDatasetItemCount, nextDatasetMinimumCount, updatedAt,
      datasetId, current.coverageRevision, current.coverageDigest,
      datasetRow.coverage_item_count, datasetRow.coverage_minimum_count,
    );
    if (update.changes !== 1) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', 'Coverage dataset CAS update failed inside its immediate transaction.');
    }
    const retained = coveragePageRow(db, datasetId, page.partitionId, page.pageId)!;
    return { ok: true, inserted: true, value: loadCoveragePageReceipt(db, retained) };
  });
  return commit.immediate();
}

export interface StoredDatasetCoverageSummaryV1 extends DatasetCoverageSummary {
  readonly version: 1;
  readonly datasetId: string;
  readonly coverageRevision: number;
  readonly coverageDigest: string;
  readonly observedPartitions: number;
  readonly cursorCycleDetected: boolean;
}

function summarizeStoredDatasetCoverageInSnapshot(
  datasetId: string,
  db: Database.Database,
): StoredDatasetCoverageSummaryV1 | null {
  const exact = exactIdentifier(datasetId, 'datasetId');
  const row = rowForDataset(db, exact);
  if (!row) return null;
  const dataset = datasetFromRow(db, row);
  validateCoverageLedger(db, dataset);
  const partitionRows = db.prepare(`
    SELECT * FROM canonical_coverage_partitions
    WHERE dataset_id = ?
    ORDER BY partition_id
  `).all(exact) as CoveragePartitionRow[];
  const partitions = partitionRows.map((partition) => loadCoveragePartition(db, exact, partition.partition_id)!);
  let observed = 0;
  let partitionMinimumTotal = 0;
  for (const partition of partitions) {
    observed = checkedAdd(observed, partition.item_count, 'dataset observed item count');
    partitionMinimumTotal = checkedAdd(
      partitionMinimumTotal,
      coverageDenominatorMinimum(denominatorFromColumns(
        partition.denominator_kind,
        partition.denominator_value,
        `partition ${partition.partition_id} denominator`,
      )),
      'dataset partition minimum count',
    );
  }
  if (observed !== checkedCount(row.coverage_item_count, 'dataset coverage item count')
    || partitionMinimumTotal !== checkedCount(row.coverage_minimum_count, 'dataset coverage minimum count')) {
    throw new CanonicalEntityStoreIntegrityError(
      'corrupt',
      `Dataset ${exact} cached coverage counters are not derivable from normalized partitions.`,
    );
  }
  if (dataset.denominator.kind === 'exact'
    && (observed > dataset.denominator.total || partitionMinimumTotal > dataset.denominator.total)) {
    throw new CanonicalEntityStoreIntegrityError(
      'corrupt',
      `Dataset ${exact} coverage exceeds its exact denominator.`,
    );
  }
  const declaredIds = dataset.universe.kind === 'closed' ? dataset.universe.partitionIds : [];
  const observedIds = new Set(partitions.map((partition) => partition.partition_id));
  const missing = declaredIds.filter((partitionId) => !observedIds.has(partitionId));
  const reasons: string[] = [];
  if (dataset.universe.kind !== 'closed') reasons.push('partition_universe_not_closed');
  if (dataset.denominator.kind !== 'exact') reasons.push('dataset_denominator_not_exact');
  if (missing.length > 0) reasons.push('required_partitions_unseen');
  if (partitions.some((partition) => partition.denominator_kind !== 'exact')) reasons.push('denominator_not_exact');
  if (partitions.some((partition) => partition.exhaustion === 'unknown')) reasons.push('exhaustion_unknown');
  if (partitions.some((partition) => partition.exhaustion === 'more')) reasons.push('partitions_not_exhausted');
  const cursorCycleDetected = Boolean(db.prepare(`
    SELECT 1 FROM canonical_coverage_pages
    WHERE dataset_id = ? AND cursor_cycle_detected = 1 LIMIT 1
  `).get(exact));
  if (cursorCycleDetected) reasons.push('cursor_cycle_detected');

  const allExact = partitions.every((partition) => partition.denominator_kind === 'exact');
  let derivedExactTotal = 0;
  let lowerBound = 0;
  for (const partition of partitions) {
    const denominator = denominatorFromColumns(
      partition.denominator_kind,
      partition.denominator_value,
      `partition ${partition.partition_id} denominator`,
    );
    if (denominator.kind === 'exact') {
      derivedExactTotal = checkedAdd(derivedExactTotal, denominator.total, 'derived exact denominator');
      lowerBound = checkedAdd(lowerBound, denominator.total, 'derived lower bound');
    } else if (denominator.kind === 'lower_bound') {
      lowerBound = checkedAdd(lowerBound, denominator.atLeast, 'derived lower bound');
    } else {
      lowerBound = checkedAdd(lowerBound, partition.item_count, 'derived lower bound');
    }
  }
  const derivedDenominator: CoverageDenominator = allExact
    ? { kind: 'exact', total: derivedExactTotal }
    : partitions.some((partition) => partition.denominator_kind !== 'unknown')
      ? { kind: 'lower_bound', atLeast: lowerBound }
      : { kind: 'unknown' };
  const denominatorAgrees = dataset.denominator.kind === 'exact'
    && derivedDenominator.kind === 'exact'
    && dataset.denominator.total === derivedDenominator.total;
  if (missing.length === 0 && dataset.denominator.kind === 'exact'
    && derivedDenominator.kind === 'exact' && !denominatorAgrees) {
    reasons.push('dataset_partition_denominator_mismatch');
  }
  const sourceComplete = dataset.universe.kind === 'closed'
    && denominatorAgrees
    && missing.length === 0
    && declaredIds.every((partitionId) => (
      partitions.find((partition) => partition.partition_id === partitionId)?.status === 'complete'
    ));
  const knownIncomplete = missing.length > 0 || partitions.some((partition) => partition.status === 'partial');
  const status: CoverageStatus = sourceComplete
    ? (cursorCycleDetected ? 'unknown' : 'complete')
    : knownIncomplete ? 'partial' : 'unknown';
  const exhaustion: DatasetCoverageSummary['exhaustion'] = sourceComplete && !cursorCycleDetected
    ? 'exhausted'
    : cursorCycleDetected
      ? 'unknown'
      : partitions.some((partition) => partition.exhaustion === 'more') || missing.length > 0
        ? 'not_exhausted'
        : 'unknown';
  return {
    version: 1,
    datasetId: exact,
    coverageRevision: dataset.coverageRevision,
    coverageDigest: dataset.coverageDigest,
    observedPartitions: partitions.length,
    cursorCycleDetected,
    status,
    observed,
    denominator: dataset.denominator,
    exhaustion,
    reasons: [...new Set(reasons)].sort(compareCanonicalEntityText),
  };
}

export function summarizeStoredDatasetCoverage(
  datasetId: string,
  db: Database.Database = openCanonicalEntityStoreDb(),
): StoredDatasetCoverageSummaryV1 | null {
  const selected = databaseOrDefault(db);
  return readSnapshot(selected, () => summarizeStoredDatasetCoverageInSnapshot(datasetId, selected));
}

export interface CanonicalStorePage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly snapshotRevision: number;
  readonly snapshotDigest: string;
}

type CursorKind = 'records' | 'quarantine' | 'coverage_items' | 'coverage_pages';

interface StoreCursorV1 {
  readonly version: 1;
  readonly kind: CursorKind;
  readonly datasetId: string;
  readonly partitionId?: string;
  readonly after: readonly string[];
  readonly snapshotRevision: number;
  readonly snapshotDigest: string;
}

function encodeStoreCursor(cursor: StoreCursorV1): string {
  return Buffer.from(canonicalJson(cursor), 'utf8').toString('base64url');
}

function decodeStoreCursor(
  encoded: string,
  kind: CursorKind,
  datasetId: string,
  partitionId?: string,
): StoreCursorV1 {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > 8_192) {
    throw new CanonicalEntityStoreIntegrityError('invalid', 'Pagination cursor is not a bounded opaque token.');
  }
  let cursor: StoreCursorV1;
  try {
    cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StoreCursorV1;
  } catch {
    throw new CanonicalEntityStoreIntegrityError('invalid', 'Pagination cursor is malformed.');
  }
  if (cursor.version !== 1 || cursor.kind !== kind || cursor.datasetId !== datasetId
    || cursor.partitionId !== partitionId || !Array.isArray(cursor.after)
    || !cursor.after.every((value) => typeof value === 'string')
    || !Number.isSafeInteger(cursor.snapshotRevision) || cursor.snapshotRevision < 0
    || !/^[a-f0-9]{64}$/.test(cursor.snapshotDigest)) {
    throw new CanonicalEntityStoreIntegrityError('invalid', 'Pagination cursor does not match this query identity.');
  }
  return cursor;
}

function boundedPageLimit(limit?: number): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new CanonicalEntityStoreIntegrityError('invalid', 'Pagination limit must be a positive safe integer.');
  }
  return Math.min(limit, 500);
}

function assertResolutionSnapshot(
  db: Database.Database,
  dataset: CanonicalDatasetRecordV1,
  revision: number,
  digest: string,
): void {
  if (revision === dataset.resolutionRevision && digest === dataset.resolutionDigest) return;
  if (revision === 0) {
    const expected = hash({ version: 1, state: createEntityResolutionState() });
    if (digest === expected) return;
  } else {
    const row = db.prepare(`
      SELECT next_digest FROM canonical_resolution_batches
      WHERE dataset_id = ? AND batch_ordinal = ? LIMIT 1
    `).get(dataset.datasetId, revision) as { next_digest: string } | undefined;
    if (row?.next_digest === digest) return;
  }
  throw new CanonicalEntityStoreIntegrityError('corrupt', 'Pagination cursor names an unknown resolution authority root.');
}

function assertCoverageSnapshot(
  db: Database.Database,
  dataset: CanonicalDatasetRecordV1,
  revision: number,
  digest: string,
): void {
  if (revision === dataset.coverageRevision && digest === dataset.coverageDigest) return;
  if (revision === 0) {
    const expected = hash({
      version: 1,
      state: createDatasetCoverageState(dataset.datasetId, dataset.universe, dataset.denominator),
    });
    if (digest === expected) return;
  } else {
    const row = db.prepare(`
      SELECT next_digest FROM canonical_coverage_pages
      WHERE dataset_id = ? AND coverage_ordinal = ? LIMIT 1
    `).get(dataset.datasetId, revision) as { next_digest: string } | undefined;
    if (row?.next_digest === digest) return;
  }
  throw new CanonicalEntityStoreIntegrityError('corrupt', 'Pagination cursor names an unknown coverage authority root.');
}

function paginationDataset(db: Database.Database, datasetId: string): CanonicalDatasetRecordV1 {
  const row = rowForDataset(db, datasetId);
  if (!row) throw new CanonicalEntityStoreIntegrityError('invalid', `Dataset ${datasetId} does not exist.`);
  return datasetFromRow(db, row);
}

export function listCanonicalRecordIds(input: {
  datasetId: string;
  cursor?: string;
  limit?: number;
  db?: Database.Database;
}): CanonicalStorePage<string> {
  const db = databaseOrDefault(input.db);
  const datasetId = exactIdentifier(input.datasetId, 'datasetId');
  const dataset = paginationDataset(db, datasetId);
  const limit = boundedPageLimit(input.limit);
  const cursor = input.cursor
    ? decodeStoreCursor(input.cursor, 'records', datasetId)
    : {
        version: 1 as const,
        kind: 'records' as const,
        datasetId,
        after: [] as readonly string[],
        snapshotRevision: dataset.resolutionRevision,
        snapshotDigest: dataset.resolutionDigest,
      };
  assertResolutionSnapshot(db, dataset, cursor.snapshotRevision, cursor.snapshotDigest);
  const after = cursor.after[0] ?? '';
  const rows = db.prepare(`
    SELECT result.canonical_id, record.created_revision, batch.batch_ordinal
    FROM canonical_resolution_batch_results AS result
      INDEXED BY canonical_resolution_results_by_canonical
    JOIN canonical_resolution_batches AS batch
      ON batch.dataset_id = result.dataset_id AND batch.batch_id = result.batch_id
    JOIN canonical_records AS record
      ON record.dataset_id = result.dataset_id AND record.canonical_id = result.canonical_id
    WHERE result.dataset_id = ? AND result.decision_kind = 'distinct'
      AND result.idempotent = 0 AND batch.batch_ordinal <= ? AND result.canonical_id > ?
    ORDER BY result.canonical_id
    LIMIT ?
  `).all(datasetId, cursor.snapshotRevision, after, limit + 1) as Array<{
    canonical_id: string;
    created_revision: number;
    batch_ordinal: number;
  }>;
  for (const [index, row] of rows.entries()) {
    if (checkedCount(row.created_revision, 'record created revision')
        !== checkedCount(row.batch_ordinal, 'record creation batch ordinal')
      || (index > 0 && rows[index - 1]!.canonical_id === row.canonical_id)) {
      throw new CanonicalEntityStoreIntegrityError(
        'corrupt',
        `Canonical record ${row.canonical_id} has contradictory pagination authority.`,
      );
    }
  }
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => row.canonical_id);
  return {
    items,
    ...(hasMore && items.length > 0
      ? { nextCursor: encodeStoreCursor({ ...cursor, after: [items.at(-1)!] }) }
      : {}),
    snapshotRevision: cursor.snapshotRevision,
    snapshotDigest: cursor.snapshotDigest,
  };
}

export interface CanonicalQuarantineListItemV1 {
  readonly quarantineId: string;
  readonly observationId: string;
  readonly reason: Extract<EntityResolutionDecision, { decision: 'quarantine' }>['reason'];
  readonly policyDigest: string;
  readonly createdAt: string;
}

export function listCanonicalQuarantine(input: {
  datasetId: string;
  cursor?: string;
  limit?: number;
  db?: Database.Database;
}): CanonicalStorePage<CanonicalQuarantineListItemV1> {
  const db = databaseOrDefault(input.db);
  const datasetId = exactIdentifier(input.datasetId, 'datasetId');
  const dataset = paginationDataset(db, datasetId);
  const limit = boundedPageLimit(input.limit);
  const cursor = input.cursor
    ? decodeStoreCursor(input.cursor, 'quarantine', datasetId)
    : {
        version: 1 as const,
        kind: 'quarantine' as const,
        datasetId,
        after: [] as readonly string[],
        snapshotRevision: dataset.resolutionRevision,
        snapshotDigest: dataset.resolutionDigest,
      };
  assertResolutionSnapshot(db, dataset, cursor.snapshotRevision, cursor.snapshotDigest);
  const afterAt = cursor.after[0] ?? '';
  const afterId = cursor.after[1] ?? '';
  const rows = db.prepare(`
    SELECT decision.quarantine_id, result.observation_id,
      batch.committed_at AS authority_created_at
    FROM canonical_resolution_batches AS batch
    JOIN canonical_resolution_batch_results AS result
      ON result.dataset_id = batch.dataset_id AND result.batch_id = batch.batch_id
    JOIN canonical_decisions AS decision
      ON decision.dataset_id = result.dataset_id
      AND decision.observation_id = result.observation_id
    WHERE batch.dataset_id = ? AND batch.batch_ordinal <= ?
      AND result.decision_kind = 'quarantine' AND result.idempotent = 0
      AND (batch.committed_at > ?
        OR (batch.committed_at = ? AND decision.quarantine_id > ?))
    ORDER BY batch.committed_at, decision.quarantine_id
    LIMIT ?
  `).all(
    datasetId, cursor.snapshotRevision,
    afterAt, afterAt, afterId, limit + 1,
  ) as Array<{
    quarantine_id: string;
    observation_id: string;
    authority_created_at: string;
  }>;
  const hasMore = rows.length > limit;
  const retained = rows.slice(0, limit);
  const items = retained.map((row) => {
    const decision = loadDecision(db, datasetId, row.observation_id);
    if (!decision || decision.decision !== 'quarantine'
      || decision.quarantineId !== row.quarantine_id) {
      throw new CanonicalEntityStoreIntegrityError(
        'corrupt',
        `Quarantine ${row.quarantine_id} has contradictory pagination authority.`,
      );
    }
    return {
      quarantineId: decision.quarantineId,
      observationId: decision.observationId,
      reason: decision.reason,
      policyDigest: decision.policyDigest,
      createdAt: exactIso(row.authority_created_at, 'quarantine authority createdAt'),
    };
  });
  const last = retained.at(-1);
  return {
    items,
    ...(hasMore && last
      ? { nextCursor: encodeStoreCursor({
          ...cursor,
          after: [last.authority_created_at, last.quarantine_id],
        }) }
      : {}),
    snapshotRevision: cursor.snapshotRevision,
    snapshotDigest: cursor.snapshotDigest,
  };
}

export function listCanonicalCoverageItemIds(input: {
  datasetId: string;
  partitionId: string;
  cursor?: string;
  limit?: number;
  db?: Database.Database;
}): CanonicalStorePage<string> {
  const db = databaseOrDefault(input.db);
  const datasetId = exactIdentifier(input.datasetId, 'datasetId');
  const partitionId = exactIdentifier(input.partitionId, 'partitionId');
  const dataset = paginationDataset(db, datasetId);
  const limit = boundedPageLimit(input.limit);
  const cursor = input.cursor
    ? decodeStoreCursor(input.cursor, 'coverage_items', datasetId, partitionId)
    : {
        version: 1 as const,
        kind: 'coverage_items' as const,
        datasetId,
        partitionId,
        after: [] as readonly string[],
        snapshotRevision: dataset.coverageRevision,
        snapshotDigest: dataset.coverageDigest,
      };
  assertCoverageSnapshot(db, dataset, cursor.snapshotRevision, cursor.snapshotDigest);
  const after = cursor.after[0] ?? '';
  const rows = db.prepare(`
    SELECT item_id
    FROM canonical_coverage_item_owners
    WHERE dataset_id = ? AND partition_id = ?
      AND first_seen_revision <= ? AND item_id > ?
    ORDER BY item_id
    LIMIT ?
  `).all(
    datasetId, partitionId, cursor.snapshotRevision, after, limit + 1,
  ) as Array<{ item_id: string }>;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => row.item_id);
  return {
    items,
    ...(hasMore && items.length > 0
      ? { nextCursor: encodeStoreCursor({ ...cursor, after: [items.at(-1)!] }) }
      : {}),
    snapshotRevision: cursor.snapshotRevision,
    snapshotDigest: cursor.snapshotDigest,
  };
}

export interface CanonicalCoveragePageHeaderV1 {
  readonly pageId: string;
  readonly coverageOrdinal: number;
  readonly pageOrdinal: number;
  readonly inputCursor: string | null;
  readonly outputCursor: string | null;
  readonly exhaustion: CoveragePage['exhaustion'];
  readonly denominator: CoverageDenominator;
  readonly itemCount: number;
  readonly cursorCycleDetected: boolean;
  readonly previousAuthorityRoot: string;
  readonly nextAuthorityRoot: string;
  readonly committedAt: string;
}

export function listCanonicalCoveragePageHeaders(input: {
  datasetId: string;
  partitionId: string;
  cursor?: string;
  limit?: number;
  db?: Database.Database;
}): CanonicalStorePage<CanonicalCoveragePageHeaderV1> {
  const db = databaseOrDefault(input.db);
  const datasetId = exactIdentifier(input.datasetId, 'datasetId');
  const partitionId = exactIdentifier(input.partitionId, 'partitionId');
  const dataset = paginationDataset(db, datasetId);
  const limit = boundedPageLimit(input.limit);
  const cursor = input.cursor
    ? decodeStoreCursor(input.cursor, 'coverage_pages', datasetId, partitionId)
    : {
        version: 1 as const,
        kind: 'coverage_pages' as const,
        datasetId,
        partitionId,
        after: [] as readonly string[],
        snapshotRevision: dataset.coverageRevision,
        snapshotDigest: dataset.coverageDigest,
      };
  assertCoverageSnapshot(db, dataset, cursor.snapshotRevision, cursor.snapshotDigest);
  const afterOrdinal = cursor.after[0] ? Number(cursor.after[0]) : 0;
  if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
    throw new CanonicalEntityStoreIntegrityError('invalid', 'Coverage page cursor has an invalid ordinal.');
  }
  const rows = db.prepare(`
    SELECT * FROM canonical_coverage_pages
    WHERE dataset_id = ? AND partition_id = ?
      AND coverage_ordinal <= ? AND page_ordinal > ?
    ORDER BY page_ordinal
    LIMIT ?
  `).all(
    datasetId, partitionId, cursor.snapshotRevision, afterOrdinal, limit + 1,
  ) as CoveragePageRow[];
  const hasMore = rows.length > limit;
  const retained = rows.slice(0, limit);
  const items = retained.map((row) => ({
    pageId: row.page_id,
    coverageOrdinal: checkedCount(row.coverage_ordinal, 'coverage ordinal'),
    pageOrdinal: checkedCount(row.page_ordinal, 'page ordinal'),
    inputCursor: row.input_cursor,
    outputCursor: row.output_cursor,
    exhaustion: row.exhaustion,
    denominator: denominatorFromColumns(row.denominator_kind, row.denominator_value, 'page denominator'),
    itemCount: checkedCount(row.item_count, 'page item count'),
    cursorCycleDetected: row.cursor_cycle_detected === 1,
    previousAuthorityRoot: row.previous_digest,
    nextAuthorityRoot: row.next_digest,
    committedAt: exactIso(row.committed_at, 'page committedAt'),
  }));
  const last = retained.at(-1);
  return {
    items,
    ...(hasMore && last
      ? { nextCursor: encodeStoreCursor({ ...cursor, after: [String(last.page_ordinal)] }) }
      : {}),
    snapshotRevision: cursor.snapshotRevision,
    snapshotDigest: cursor.snapshotDigest,
  };
}

export interface CanonicalDatasetIntegrityAuditV1 {
  readonly version: 1;
  readonly datasetId: string;
  readonly observations: number;
  readonly decisions: number;
  readonly records: number;
  readonly quarantines: number;
  readonly resolutionBatches: number;
  readonly coveragePartitions: number;
  readonly coveragePages: number;
  readonly coverageItems: number;
}

/** Explicit O(dataset) audit; normal commits and reads remain candidate/page bounded. */
function auditCanonicalDatasetIntegrityInSnapshot(
  datasetId: string,
  db: Database.Database,
): CanonicalDatasetIntegrityAuditV1 | null {
  const exact = exactIdentifier(datasetId, 'datasetId');
  const row = rowForDataset(db, exact);
  if (!row) return null;
  const dataset = datasetFromRow(db, row);
  validateResolutionLedger(db, dataset, true);
  validateCoverageLedger(db, dataset, true);
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM canonical_observations WHERE dataset_id = ?) AS observations,
      (SELECT COUNT(*) FROM canonical_decisions WHERE dataset_id = ?) AS decisions,
      (SELECT COUNT(*) FROM canonical_records WHERE dataset_id = ?) AS records,
      (SELECT COUNT(*) FROM canonical_quarantine WHERE dataset_id = ?) AS quarantines,
      (SELECT COUNT(*) FROM canonical_decisions
        WHERE dataset_id = ? AND decision_kind = 'quarantine') AS quarantine_decisions,
      (SELECT COUNT(*) FROM canonical_resolution_batches WHERE dataset_id = ?) AS resolution_batches,
      (SELECT COUNT(*) FROM canonical_coverage_partitions WHERE dataset_id = ?) AS coverage_partitions,
      (SELECT COUNT(*) FROM canonical_coverage_pages WHERE dataset_id = ?) AS coverage_pages,
      (SELECT COUNT(*) FROM canonical_coverage_item_owners WHERE dataset_id = ?) AS coverage_items
  `).get(exact, exact, exact, exact, exact, exact, exact, exact, exact) as {
    observations: number;
    decisions: number;
    records: number;
    quarantines: number;
    quarantine_decisions: number;
    resolution_batches: number;
    coverage_partitions: number;
    coverage_pages: number;
    coverage_items: number;
  };
  if (counts.observations !== counts.decisions
    || counts.quarantines !== counts.quarantine_decisions) {
    throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${exact} has incomplete observation decisions.`);
  }
  const observationIds = db.prepare(`
    SELECT observation_id FROM canonical_observations
    WHERE dataset_id = ? ORDER BY observation_id
  `).all(exact) as Array<{ observation_id: string }>;
  for (const observation of observationIds) {
    if (!loadObservation(db, exact, observation.observation_id)
      || !loadDecision(db, exact, observation.observation_id)) {
      throw new CanonicalEntityStoreIntegrityError('corrupt', `Dataset ${exact} has incomplete observation authority.`);
    }
  }
  const recordIds = db.prepare(`
    SELECT canonical_id, record_digest FROM canonical_records
    WHERE dataset_id = ? ORDER BY canonical_id
  `).all(exact) as Array<{ canonical_id: string; record_digest: string }>;
  const latestTransitionDigests = new Map<string, string>();
  const transitionRows = db.prepare(`
    SELECT result.canonical_id, result.transition_record_digest
    FROM canonical_resolution_batch_results AS result
    JOIN canonical_resolution_batches AS batch
      ON batch.dataset_id = result.dataset_id AND batch.batch_id = result.batch_id
    WHERE result.dataset_id = ?
      AND result.idempotent = 0
      AND result.canonical_id IS NOT NULL
    ORDER BY batch.batch_ordinal, result.result_ordinal
  `).all(exact) as Array<{
    canonical_id: string;
    transition_record_digest: string;
  }>;
  for (const transition of transitionRows) {
    latestTransitionDigests.set(transition.canonical_id, transition.transition_record_digest);
  }
  if (latestTransitionDigests.size !== recordIds.length) {
    throw new CanonicalEntityStoreIntegrityError(
      'corrupt',
      `Dataset ${exact} materialized record heads are not fully authenticated by transition receipts.`,
    );
  }
  for (const record of recordIds) {
    loadRecord(db, exact, record.canonical_id);
    if (latestTransitionDigests.get(record.canonical_id) !== record.record_digest) {
      throw new CanonicalEntityStoreIntegrityError(
        'corrupt',
        `Canonical record ${record.canonical_id} does not match its latest transition receipt.`,
      );
    }
  }
  const partitionIds = db.prepare(`
    SELECT partition_id FROM canonical_coverage_partitions
    WHERE dataset_id = ? ORDER BY partition_id
  `).all(exact) as Array<{ partition_id: string }>;
  for (const partition of partitionIds) loadCoveragePartition(db, exact, partition.partition_id);
  return {
    version: 1,
    datasetId: exact,
    observations: checkedCount(counts.observations, 'audit observation count'),
    decisions: checkedCount(counts.decisions, 'audit decision count'),
    records: checkedCount(counts.records, 'audit record count'),
    quarantines: checkedCount(counts.quarantines, 'audit quarantine count'),
    resolutionBatches: checkedCount(counts.resolution_batches, 'audit resolution batch count'),
    coveragePartitions: checkedCount(counts.coverage_partitions, 'audit coverage partition count'),
    coveragePages: checkedCount(counts.coverage_pages, 'audit coverage page count'),
    coverageItems: checkedCount(counts.coverage_items, 'audit coverage item count'),
  };
}

export function auditCanonicalDatasetIntegrity(
  datasetId: string,
  db: Database.Database = openCanonicalEntityStoreDb(),
): CanonicalDatasetIntegrityAuditV1 | null {
  const selected = databaseOrDefault(db);
  return readSnapshot(selected, () => auditCanonicalDatasetIntegrityInSnapshot(datasetId, selected));
}
