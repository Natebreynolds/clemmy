import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { recordOperationalEvent, type WorkspaceOperationalEventType } from '../runtime/operational-telemetry.js';
import { redactSensitiveText } from '../runtime/security.js';
import { ensureWorkspaceSchema } from './workspace-db-schema.js';
import type { SpaceAction, SpaceDataSource, SpaceRecord, SpaceRevision } from './store.js';

export const WORKSPACE_STATE_DIR = path.join(BASE_DIR, 'state');
export const WORKSPACE_DB_PATH = path.join(WORKSPACE_STATE_DIR, 'workspaces.db');
export const WORKSPACE_SPACES_DIR = path.join(BASE_DIR, 'spaces');

type WorkspaceFileKind = 'view' | 'asset' | 'runner' | 'data' | 'note' | 'audit' | 'manifest' | 'snapshot' | 'other';

export interface IndexWorkspaceOptions {
  db?: Database.Database;
  rootDir?: string;
  eventType?: WorkspaceOperationalEventType;
  actor?: string;
  payload?: Record<string, unknown>;
  now?: Date;
  emitOperational?: boolean;
  /**
   * Rebuild/bootstrap callers set false: indexing current file state is not a
   * new state transition. Manifest mutation callers leave this enabled.
   */
  appendStateEvent?: boolean;
}

export interface WorkspaceIndexRow {
  id: string;
  slug: string;
  title: string;
  status: SpaceRecord['status'];
  updatedAt: string;
}

export type WorkspaceDatasetObservationStatus = 'ok' | 'error' | 'awaiting_approval';
export type WorkspaceProjectionMode = 'source' | 'document';

export interface WorkspaceObservationCommitItem {
  /** Durable logical source id. This deliberately does not depend on a manifest-row FK. */
  sourceKey: string;
  /** Idempotency key scoped to workspace + source. */
  refreshId: string;
  /** Why this source was observed: scheduled, manual, direct_put, recovery, etc. */
  cause: string;
  status: WorkspaceDatasetObservationStatus;
  /** Required for ok observations; omitted for error/awaiting observations. */
  data?: unknown;
  error?: string;
  provenance?: Record<string, unknown>;
  observedAt?: string | Date;
  /** `document` stores/replaces the complete data.json document (direct PUT). */
  projectionMode?: WorkspaceProjectionMode;
}

export interface CommitWorkspaceObservationBatchInput {
  workspaceId: string;
  observations: WorkspaceObservationCommitItem[];
  batchId?: string;
  db?: Database.Database;
  rootDir?: string;
  /**
   * Test seam for simulating a process/file failure after the SQLite commit.
   * Production callers should omit it; retrying the same refresh ids heals the
   * projection without duplicating observations.
   */
  afterCommit?: () => void;
}

export interface WorkspaceDatasetObservation {
  id: string;
  workspaceId: string;
  sourceKey: string;
  refreshId: string;
  batchId: string;
  batchIndex: number;
  cause: string;
  projectionMode: WorkspaceProjectionMode;
  datasetId: string | null;
  contentHash: string | null;
  previousObservationId: string | null;
  previousDatasetId: string | null;
  status: WorkspaceDatasetObservationStatus;
  changed: boolean | null;
  isCurrent: boolean;
  provenance: Record<string, unknown>;
  error: string | null;
  observedAt: string;
  createdAt: string;
}

export interface CommittedWorkspaceDatasetObservation extends WorkspaceDatasetObservation {
  deduped: boolean;
}

export interface CommitWorkspaceObservationBatchResult {
  batchId: string;
  observations: CommittedWorkspaceDatasetObservation[];
  projection: WorkspaceProjectionResult;
}

export interface WorkspaceProjectionResult {
  bytes: number;
  sources: number;
}

export interface ListWorkspaceDatasetObservationsOptions {
  db?: Database.Database;
  sourceKey?: string;
  status?: WorkspaceDatasetObservationStatus;
  /**
   * Opaque continuation token: the id of the final observation returned by
   * the prior page. The row's full ordering tuple is resolved server-side so
   * equal observed/created timestamps cannot be skipped.
   */
  cursor?: string;
  /** Legacy timestamp-only boundary. Prefer cursor for lossless pagination. */
  before?: string | Date;
  limit?: number;
}

export interface HealWorkspaceDataProjectionOptions {
  db?: Database.Database;
  rootDir?: string;
}

export interface PruneWorkspaceDatasetHistoryOptions {
  db?: Database.Database;
  maxObservationsPerSource?: number;
  maxAgeDays?: number;
  maxDatasetBytes?: number;
  now?: Date;
}

export interface PruneWorkspaceDatasetHistoryResult {
  observationsDeleted: number;
  datasetsDeleted: number;
  datasetBytesRetained: number;
}

export type BootstrapWorkspaceObservationHistoryResult =
  | { ok: true; imported: number; skipped: number }
  | { ok: false; error: string };

const MAX_WORKSPACE_DATA_BYTES = 5 * 1024 * 1024;
const MAX_OBSERVATION_ERROR_CHARS = 2_000;
const MAX_PROVENANCE_INPUT_BYTES = 64 * 1024;
const MAX_PROVENANCE_BYTES = 8 * 1024;
const MAX_OBSERVATION_LIST = 500;

const PROVENANCE_ALLOWLIST = new Set([
  'provider',
  'adapter',
  'toolSlug',
  'runner',
  'schedule',
  'accountRef',
  'connectionId',
  'requestId',
  'approvalId',
  'runId',
  'sessionId',
  'argsHash',
  'runnerHash',
  'trigger',
  'initiatedBy',
  'attempt',
  'sourceVersion',
  'fetchedAt',
]);

let cachedDb: Database.Database | null = null;

export function openWorkspaceDb(): Database.Database {
  if (cachedDb) return cachedDb;
  ensureStateDir();
  const db = new Database(WORKSPACE_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  ensureWorkspaceSchema(db);
  cachedDb = db;
  return db;
}

export function closeWorkspaceDb(): void {
  if (!cachedDb) return;
  cachedDb.close();
  cachedDb = null;
}

/** Test-only destructive reset. Production history in this DB is not rebuildable. */
export function resetWorkspaceDbForTest(): void {
  closeWorkspaceDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = WORKSPACE_DB_PATH + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
}

export function indexWorkspaceRecord(record: SpaceRecord, options: IndexWorkspaceOptions = {}): void {
  const db = options.db ?? openWorkspaceDb();
  const rootDir = options.rootDir ?? resolveWorkspaceRoot(record.id);
  const now = (options.now ?? new Date()).toISOString();
  try {
    let retiredSourceKeys: string[] = [];
    const tx = db.transaction(() => {
      upsertWorkspace(db, record, rootDir);
      retiredSourceKeys = replaceDataSources(db, record, now);
      replaceActions(db, record, now);
      replaceFilesAndRevisions(db, record, rootDir);
      if (options.appendStateEvent !== false) {
        appendWorkspaceStateEvent(db, record.id, {
          eventType: options.eventType ?? 'workspace_file_changed',
          actor: options.actor ?? 'workspace-index',
          payload: {
            title: record.title,
            status: record.status,
            version: record.version,
            ...(options.payload ?? {}),
          },
          createdAt: now,
        });
      }
    });
    tx();
    if (retiredSourceKeys.length > 0) {
      // Retirement is committed before the compatibility projection. If the
      // process stops between these steps, boot healing reads the durable
      // tombstone and converges data.json to the same retired/absent state.
      healWorkspaceDataProjection(record.id, { db, rootDir });
    }
    if (options.emitOperational !== false && !options.db) {
      recordOperationalEvent({
        source: 'workspace',
        type: options.eventType ?? 'workspace_file_changed',
        severity: 'info',
        workspaceId: record.id,
        sessionId: record.originSessionId,
        actor: options.actor ?? 'workspace-index',
        now: new Date(now),
        payload: {
          title: record.title,
          status: record.status,
          version: record.version,
          rootDir,
          ...(options.payload ?? {}),
        },
      });
    }
  } catch {
    // Rebuildable index; never break Space writes because the index is unavailable.
  }
}

export function deleteWorkspaceIndex(
  slug: string,
  options: { db?: Database.Database; actor?: string; emitOperational?: boolean; now?: Date } = {},
): boolean {
  if (!isValidWorkspaceSlug(slug)) return false;
  const db = options.db ?? openWorkspaceDb();
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM workspaces WHERE slug = ?').run(slug);
    const remaining = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM workspaces
      WHERE slug = ?
    `).get(slug) as { count: number }).count;
    if (remaining !== 0) {
      throw new Error(`durable Workspace delete verification failed for "${slug}"`);
    }
  });
  remove.immediate();
  if (options.emitOperational !== false && !options.db) {
    try {
      recordOperationalEvent({
        source: 'workspace',
        type: 'workspace_file_changed',
        severity: 'warn',
        workspaceId: slug,
        actor: options.actor ?? 'workspace-index',
        now: options.now,
        payload: { deleted: true },
      });
    } catch {
      // The durable deletion is already committed. Telemetry is best-effort.
    }
  }
  return true;
}

export function reindexWorkspaceRecords(records: SpaceRecord[], options: Omit<IndexWorkspaceOptions, 'eventType'> = {}): number {
  let indexed = 0;
  for (const record of records) {
    indexWorkspaceRecord(record, {
      ...options,
      eventType: 'workspace_file_changed',
      appendStateEvent: false,
      payload: { reindexed: true, ...(options.payload ?? {}) },
    });
    indexed += 1;
  }
  return indexed;
}

export function listIndexedWorkspaces(db: Database.Database = openWorkspaceDb()): WorkspaceIndexRow[] {
  const rows = db.prepare(`
    SELECT id, slug, title, status, updated_at
    FROM workspaces
    ORDER BY updated_at DESC
  `).all() as Array<{ id: string; slug: string; title: string; status: SpaceRecord['status']; updated_at: string }>;
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    updatedAt: row.updated_at,
  }));
}

/**
 * Persist one refresh batch in one SQLite transaction, then atomically project
 * the resulting current state to the legacy data.json file exactly once.
 *
 * A file failure cannot roll SQLite back; that is intentional. The same
 * refresh ids can be retried without duplication, and projection is healed
 * from the committed observations.
 */
export function commitWorkspaceObservationBatch(
  input: CommitWorkspaceObservationBatchInput,
): CommitWorkspaceObservationBatchResult {
  return commitWorkspaceObservationBatchInternal(input, {
    project: true,
    baselineOnly: false,
  });
}

export function listWorkspaceDatasetObservations(
  workspaceId: string,
  options: ListWorkspaceDatasetObservationsOptions = {},
): WorkspaceDatasetObservation[] {
  const db = options.db ?? openWorkspaceDb();
  if (options.cursor !== undefined && options.before !== undefined) {
    throw new Error('Workspace observation listing accepts cursor or before, not both');
  }
  const limit = boundedInteger(options.limit, 100, 1, MAX_OBSERVATION_LIST, 'limit');
  const where = ['workspace_id = @workspaceId'];
  const params: Record<string, unknown> = { workspaceId, limit };
  if (options.sourceKey !== undefined) {
    where.push('source_key = @sourceKey');
    params.sourceKey = normalizeSourceKeyForLookup(options.sourceKey);
  }
  if (options.status !== undefined) {
    where.push('status = @status');
    params.status = normalizeObservationStatus(options.status);
  }
  if (options.cursor !== undefined) {
    const cursorId = normalizeBoundedText(options.cursor, 'cursor', 200);
    const cursor = db.prepare(`
      SELECT
        observed_at,
        created_at,
        rowid AS row_id
      FROM workspace_dataset_observations
      WHERE workspace_id = ?
        AND id = ?
      LIMIT 1
    `).get(workspaceId, cursorId) as {
      observed_at: string;
      created_at: string;
      row_id: number;
    } | undefined;
    if (!cursor) {
      throw new Error('Workspace observation cursor was not found for this workspace');
    }
    where.push(`(
      observed_at < @cursorObservedAt
      OR (
        observed_at = @cursorObservedAt
        AND created_at < @cursorCreatedAt
      )
      OR (
        observed_at = @cursorObservedAt
        AND created_at = @cursorCreatedAt
        AND rowid < @cursorRowId
      )
    )`);
    params.cursorObservedAt = cursor.observed_at;
    params.cursorCreatedAt = cursor.created_at;
    params.cursorRowId = cursor.row_id;
  } else if (options.before !== undefined) {
    where.push('observed_at < @before');
    params.before = normalizeTimestamp(options.before, 'before');
  }
  const rows = db.prepare(`
    SELECT *
    FROM workspace_dataset_observations
    WHERE ${where.join(' AND ')}
    ORDER BY observed_at DESC, created_at DESC, rowid DESC
    LIMIT @limit
  `).all(params) as WorkspaceObservationRow[];
  return rows.map(mapWorkspaceObservation);
}

export function getCurrentWorkspaceDatasetObservation(
  workspaceId: string,
  sourceKey: string,
  db: Database.Database = openWorkspaceDb(),
): WorkspaceDatasetObservation | null {
  const row = db.prepare(`
    SELECT o.*
    FROM workspace_dataset_observations o
    WHERE o.workspace_id = ? AND o.source_key = ? AND o.is_current = 1
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_dataset_source_retirements r
        WHERE r.workspace_id = o.workspace_id
          AND r.source_key = o.source_key
      )
    LIMIT 1
  `).get(workspaceId, normalizeSourceKeyForLookup(sourceKey)) as WorkspaceObservationRow | undefined;
  return row ? mapWorkspaceObservation(row) : null;
}

export function getWorkspaceDatasetObservation(
  workspaceId: string,
  observationId: string,
  db: Database.Database = openWorkspaceDb(),
): WorkspaceDatasetObservation | null {
  const row = db.prepare(`
    SELECT *
    FROM workspace_dataset_observations
    WHERE workspace_id = ? AND id = ?
    LIMIT 1
  `).get(workspaceId, observationId) as WorkspaceObservationRow | undefined;
  return row ? mapWorkspaceObservation(row) : null;
}

/**
 * Resolve the durable result of one logical source refresh. Runner recovery
 * uses this after a thrown commit to distinguish a transaction rollback from
 * the intentional DB-first/file-projection crash seam.
 */
export function getWorkspaceDatasetObservationByRefreshId(
  workspaceId: string,
  sourceKey: string,
  refreshId: string,
  db: Database.Database = openWorkspaceDb(),
): WorkspaceDatasetObservation | null {
  const row = db.prepare(`
    SELECT *
    FROM workspace_dataset_observations
    WHERE workspace_id = ?
      AND source_key = ?
      AND refresh_id = ?
    LIMIT 1
  `).get(
    normalizeWorkspaceId(workspaceId),
    normalizeSourceKeyForLookup(sourceKey),
    normalizeBoundedText(refreshId, 'refreshId', 240),
  ) as WorkspaceObservationRow | undefined;
  return row ? mapWorkspaceObservation(row) : null;
}

/**
 * Load a retained successful observation document. Both the observation and
 * blob join are workspace-scoped, preventing an id from crossing workspaces.
 */
export function getWorkspaceObservationDocument(
  workspaceId: string,
  observationId: string,
  db: Database.Database = openWorkspaceDb(),
): unknown | undefined {
  const row = db.prepare(`
    SELECT d.doc_json
    FROM workspace_dataset_observations o
    JOIN workspace_datasets d
      ON d.id = o.dataset_id
     AND d.workspace_id = o.workspace_id
    WHERE o.workspace_id = ?
      AND o.id = ?
      AND o.status = 'ok'
    LIMIT 1
  `).get(workspaceId, observationId) as { doc_json: string } | undefined;
  if (!row) return undefined;
  const bytes = Buffer.byteLength(row.doc_json, 'utf-8');
  if (bytes > MAX_WORKSPACE_DATA_BYTES) return undefined;
  try {
    return JSON.parse(row.doc_json);
  } catch {
    return undefined;
  }
}

/**
 * Rebuild data.json from current successful observations plus each source's
 * latest failed/awaiting attempt. Unknown legacy keys already in the file are
 * retained unless a newer document-mode observation replaced the document.
 */
export function healWorkspaceDataProjection(
  workspaceId: string,
  options: HealWorkspaceDataProjectionOptions = {},
): WorkspaceProjectionResult {
  const db = options.db ?? openWorkspaceDb();
  const rootDir = options.rootDir ?? workspaceRootFromDb(db, workspaceId);
  const existing = readWorkspaceProjection(rootDir);
  const projection = buildWorkspaceProjection(db, workspaceId, existing);
  const serialized = serializeWorkspaceProjection(projection.document);
  atomicWriteWorkspaceProjection(rootDir, serialized.text);
  return { bytes: serialized.bytes, sources: projection.sources };
}

/**
 * Import a pre-3.0 data.json as comparison baselines without rewriting it.
 * Existing current observations win, so restart/reindex calls are idempotent.
 */
export function bootstrapWorkspaceObservationHistory(
  workspaceId: string,
  options: HealWorkspaceDataProjectionOptions = {},
): BootstrapWorkspaceObservationHistoryResult {
  const db = options.db ?? openWorkspaceDb();
  let rootDir: string;
  try {
    rootDir = options.rootDir ?? workspaceRootFromDb(db, workspaceId);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const file = path.join(rootDir, 'data.json');
  if (!existsSync(file)) return { ok: true, imported: 0, skipped: 0 };

  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    return { ok: false, error: `could not read legacy data.json: ${(err as Error).message}` };
  }
  const bytes = Buffer.byteLength(raw, 'utf-8');
  if (bytes > MAX_WORKSPACE_DATA_BYTES) {
    return {
      ok: false,
      error: `legacy data.json exceeds ${MAX_WORKSPACE_DATA_BYTES} byte cap (${bytes} bytes)`,
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'legacy data.json is not valid JSON' };
  }

  const candidates: WorkspaceObservationCommitItem[] = [];
  if (isJsonObject(document)) {
    for (const [sourceKey, data] of Object.entries(document)) {
      if (sourceKey === '_meta') continue;
      const canonical = canonicalizeJson(data);
      candidates.push({
        sourceKey,
        refreshId: legacyRefreshId(workspaceId, sourceKey, canonical.contentHash),
        cause: 'legacy_import',
        status: 'ok',
        data,
        observedAt: fileTimestamp(file),
      });
    }
  } else {
    const sourceKey = '$document';
    const canonical = canonicalizeJson(document);
    candidates.push({
      sourceKey,
      refreshId: legacyRefreshId(workspaceId, sourceKey, canonical.contentHash),
      cause: 'legacy_import',
      projectionMode: 'document',
      status: 'ok',
      data: document,
      observedAt: fileTimestamp(file),
    });
  }
  if (candidates.length === 0) return { ok: true, imported: 0, skipped: 0 };

  try {
    const result = commitWorkspaceObservationBatchInternal({
      db,
      rootDir,
      workspaceId,
      batchId: `legacy:${hashString(`${workspaceId}\0${raw}`).slice(0, 32)}`,
      observations: candidates,
    }, {
      project: false,
      baselineOnly: true,
    });
    const imported = result.observations.filter((entry) => !entry.deduped).length;
    return {
      ok: true,
      imported,
      skipped: candidates.length - imported,
    };
  } catch (err) {
    return { ok: false, error: `could not bootstrap legacy history: ${(err as Error).message}` };
  }
}

/**
 * Bounded retention hook. It never removes a current observation and only
 * garbage-collects content-addressed blobs created by this layer (`wds_`),
 * preserving any legacy workspace_datasets rows.
 */
export function pruneWorkspaceDatasetHistory(
  workspaceId: string,
  options: PruneWorkspaceDatasetHistoryOptions = {},
): PruneWorkspaceDatasetHistoryResult {
  const db = options.db ?? openWorkspaceDb();
  const maxPerSource = boundedInteger(
    options.maxObservationsPerSource,
    256,
    1,
    10_000,
    'maxObservationsPerSource',
  );
  const maxAgeDays = boundedInteger(options.maxAgeDays, 90, 1, 3_650, 'maxAgeDays');
  const maxDatasetBytes = boundedInteger(
    options.maxDatasetBytes,
    64 * 1024 * 1024,
    1,
    2 * 1024 * 1024 * 1024,
    'maxDatasetBytes',
  );
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();

  const tx = db.transaction((): PruneWorkspaceDatasetHistoryResult => {
    let observationsDeleted = 0;
    let datasetsDeleted = 0;
    const protectedObservationIds = new Set<string>();
    const sourceRows = db.prepare(`
      SELECT DISTINCT source_key
      FROM workspace_dataset_observations
      WHERE workspace_id = ?
    `).all(workspaceId) as Array<{ source_key: string }>;
    const list = db.prepare(`
      SELECT id, status, is_current, previous_observation_id, observed_at
      FROM workspace_dataset_observations
      WHERE workspace_id = ? AND source_key = ?
      ORDER BY observed_at DESC, created_at DESC, rowid DESC
    `);
    const removeObservation = db.prepare(`
      DELETE FROM workspace_dataset_observations
      WHERE workspace_id = ? AND id = ? AND is_current = 0
    `);
    for (const source of sourceRows) {
      const rows = list.all(workspaceId, source.source_key) as Array<{
        id: string;
        status: WorkspaceDatasetObservationStatus;
        is_current: number;
        previous_observation_id: string | null;
        observed_at: string;
      }>;
      const current = rows.find((row) => row.is_current === 1);
      if (current) protectedObservationIds.add(current.id);
      const priorSuccess = (
        current?.previous_observation_id
          ? rows.find((row) => row.id === current.previous_observation_id)
          : undefined
      ) ?? rows.find((row) => row.is_current === 0 && row.status === 'ok');
      if (priorSuccess) protectedObservationIds.add(priorSuccess.id);
      rows.forEach((row, index) => {
        if (protectedObservationIds.has(row.id)) return;
        if (index < maxPerSource && row.observed_at >= cutoff) return;
        observationsDeleted += removeObservation.run(workspaceId, row.id).changes;
      });
    }

    const removeOrphanDatasets = (): number => db.prepare(`
      DELETE FROM workspace_datasets
      WHERE workspace_id = ?
        AND id GLOB 'wds_*'
        AND NOT EXISTS (
          SELECT 1
          FROM workspace_dataset_observations o
          WHERE o.dataset_id = workspace_datasets.id
        )
    `).run(workspaceId).changes;
    datasetsDeleted += removeOrphanDatasets();

    let retainedBytes = workspaceDatasetBytes(db, workspaceId);
    const oldestPrunable = db.prepare(`
      SELECT o.id
      FROM workspace_dataset_observations o
      JOIN workspace_datasets d ON d.id = o.dataset_id
      WHERE o.workspace_id = ?
        AND o.is_current = 0
        AND d.id GLOB 'wds_*'
      ORDER BY o.observed_at ASC, o.created_at ASC, o.rowid ASC
    `);
    while (retainedBytes > maxDatasetBytes) {
      const candidates = oldestPrunable.all(workspaceId) as Array<{ id: string }>;
      const candidate = candidates.find((entry) => !protectedObservationIds.has(entry.id));
      if (!candidate) break;
      const removed = removeObservation.run(workspaceId, candidate.id).changes;
      if (removed === 0) break;
      observationsDeleted += removed;
      datasetsDeleted += removeOrphanDatasets();
      retainedBytes = workspaceDatasetBytes(db, workspaceId);
    }
    return {
      observationsDeleted,
      datasetsDeleted,
      datasetBytesRetained: retainedBytes,
    };
  });
  return tx.immediate();
}

interface PreparedWorkspaceObservation {
  sourceKey: string;
  refreshId: string;
  cause: string;
  status: WorkspaceDatasetObservationStatus;
  projectionMode: WorkspaceProjectionMode;
  canonicalData: string | null;
  contentHash: string | null;
  dataBytes: number;
  error: string | null;
  provenanceJson: string;
  observedAt: string;
  commitHash: string;
}

interface WorkspaceObservationRow {
  id: string;
  workspace_id: string;
  source_key: string;
  refresh_id: string;
  batch_id: string;
  batch_index: number;
  cause: string;
  projection_mode: WorkspaceProjectionMode;
  dataset_id: string | null;
  content_hash: string | null;
  previous_observation_id: string | null;
  previous_dataset_id: string | null;
  status: WorkspaceDatasetObservationStatus;
  changed: number | null;
  is_current: number;
  provenance_json: string;
  error: string | null;
  commit_hash: string;
  observed_at: string;
  created_at: string;
}

interface ProjectionEventRow {
  row_id: number;
  source_key: string;
  projection_mode: WorkspaceProjectionMode;
  status: WorkspaceDatasetObservationStatus;
  doc_json: string | null;
  error: string | null;
  cause: string;
  provenance_json: string;
  observed_at: string;
  created_at: string;
  batch_index: number;
}

interface WorkspaceSourceRetirementRow {
  source_key: string;
  projection_mode: WorkspaceProjectionMode;
  retired_after_rowid: number;
  retired_at: string;
}

interface BuiltWorkspaceProjection {
  document: unknown;
  sources: number;
}

function commitWorkspaceObservationBatchInternal(
  input: CommitWorkspaceObservationBatchInput,
  behavior: { project: boolean; baselineOnly: boolean },
): CommitWorkspaceObservationBatchResult {
  const db = input.db ?? openWorkspaceDb();
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new Error('Workspace observation batch requires at least one observation');
  }
  if (input.observations.length > 500) {
    throw new Error('Workspace observation batch exceeds 500-source cap');
  }
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const rootDir = input.rootDir ?? workspaceRootFromDb(db, workspaceId);
  // Resolve the row even when a test supplies rootDir; observations must never
  // create an orphan workspace implicitly.
  assertWorkspaceExists(db, workspaceId);
  const batchId = normalizeBoundedText(
    input.batchId ?? randomUUID(),
    'batchId',
    200,
  );
  const prepared = input.observations.map(prepareWorkspaceObservation);
  const sourceKeys = new Set<string>();
  for (const item of prepared) {
    if (sourceKeys.has(item.sourceKey)) {
      throw new Error(`Workspace observation batch repeats sourceKey "${item.sourceKey}"`);
    }
    sourceKeys.add(item.sourceKey);
  }
  const existingProjection = behavior.project ? readWorkspaceProjection(rootDir) : {};

  let projectedText: string | null = null;
  let projectedBytes = 0;
  let projectedSources = 0;
  const tx = db.transaction((): CommittedWorkspaceDatasetObservation[] => {
    const committed: CommittedWorkspaceDatasetObservation[] = [];
    for (const [batchIndex, item] of prepared.entries()) {
      const existing = db.prepare(`
        SELECT *
        FROM workspace_dataset_observations
        WHERE workspace_id = ? AND source_key = ? AND refresh_id = ?
        LIMIT 1
      `).get(
        workspaceId,
        item.sourceKey,
        item.refreshId,
      ) as WorkspaceObservationRow | undefined;
      if (existing) {
        if (existing.commit_hash !== item.commitHash) {
          throw new Error(
            `refreshId conflict for source "${item.sourceKey}": "${item.refreshId}" was already committed with different content`,
          );
        }
        committed.push({ ...mapWorkspaceObservation(existing), deduped: true });
        continue;
      }

      if (
        behavior.baselineOnly
        && db.prepare(`
          SELECT 1
          FROM workspace_dataset_source_retirements
          WHERE workspace_id = ? AND source_key = ?
        `).get(workspaceId, item.sourceKey)
      ) {
        continue;
      }

      const current = db.prepare(`
        SELECT *
        FROM workspace_dataset_observations
        WHERE workspace_id = ? AND source_key = ? AND is_current = 1
        LIMIT 1
      `).get(workspaceId, item.sourceKey) as WorkspaceObservationRow | undefined;
      if (behavior.baselineOnly && current) continue;
      const retirement = db.prepare(`
        SELECT 1
        FROM workspace_dataset_source_retirements
        WHERE workspace_id = ? AND source_key = ?
      `).get(workspaceId, item.sourceKey);
      const sourceIsActive = Boolean(db.prepare(`
        SELECT 1
        FROM workspace_data_sources
        WHERE workspace_id = ? AND id = ?
      `).get(workspaceId, `${workspaceId}:source:${item.sourceKey}`));
      const canBecomeCurrent = !retirement || sourceIsActive;

      let datasetId: string | null = null;
      let changed: boolean | null = null;
      if (item.status === 'ok') {
        // Re-adding a retired source does not restore its old snapshot. Only a
        // newly committed successful observation re-establishes current truth.
        if (!behavior.baselineOnly && sourceIsActive) {
          db.prepare(`
            DELETE FROM workspace_dataset_source_retirements
            WHERE workspace_id = ? AND source_key = ?
          `).run(workspaceId, item.sourceKey);
        }
        datasetId = upsertWorkspaceDatasetBlob(db, workspaceId, item);
        changed = current ? current.content_hash !== item.contentHash : null;
        if (current) {
          db.prepare(`
            UPDATE workspace_dataset_observations
            SET is_current = 0
            WHERE id = ? AND workspace_id = ?
          `).run(current.id, workspaceId);
        }
      }

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO workspace_dataset_observations (
          id, workspace_id, source_key, refresh_id, batch_id, batch_index,
          cause, projection_mode, dataset_id, content_hash,
          previous_observation_id, previous_dataset_id, status, changed,
          is_current, provenance_json, error, commit_hash, observed_at,
          created_at
        ) VALUES (
          @id, @workspaceId, @sourceKey, @refreshId, @batchId, @batchIndex,
          @cause, @projectionMode, @datasetId, @contentHash,
          @previousObservationId, @previousDatasetId, @status, @changed,
          @isCurrent, @provenanceJson, @error, @commitHash, @observedAt,
          @createdAt
        )
      `).run({
        id,
        workspaceId,
        sourceKey: item.sourceKey,
        refreshId: item.refreshId,
        batchId,
        batchIndex,
        cause: item.cause,
        projectionMode: item.projectionMode,
        datasetId,
        contentHash: item.contentHash,
        previousObservationId: current?.id ?? null,
        previousDatasetId: current?.dataset_id ?? null,
        status: item.status,
        changed: changed === null ? null : changed ? 1 : 0,
        isCurrent: item.status === 'ok' && canBecomeCurrent ? 1 : 0,
        provenanceJson: item.provenanceJson,
        error: item.error,
        commitHash: item.commitHash,
        observedAt: item.observedAt,
        createdAt,
      });
      const row = db.prepare(`
        SELECT *
        FROM workspace_dataset_observations
        WHERE id = ?
      `).get(id) as WorkspaceObservationRow;
      committed.push({ ...mapWorkspaceObservation(row), deduped: false });
    }

    if (behavior.project) {
      const projection = buildWorkspaceProjection(db, workspaceId, existingProjection);
      const serialized = serializeWorkspaceProjection(projection.document);
      projectedText = serialized.text;
      projectedBytes = serialized.bytes;
      projectedSources = projection.sources;
    }
    return committed;
  });

  const observations = tx.immediate();
  input.afterCommit?.();
  if (behavior.project) {
    // projectedText is assigned inside the successful transaction. Keeping the
    // file write outside it creates the recoverable DB-first crash boundary.
    if (projectedText === null) throw new Error('Workspace projection was not prepared');
    atomicWriteWorkspaceProjection(rootDir, projectedText);
  }
  return {
    batchId,
    observations,
    projection: {
      bytes: projectedBytes,
      sources: projectedSources,
    },
  };
}

function prepareWorkspaceObservation(
  item: WorkspaceObservationCommitItem,
): PreparedWorkspaceObservation {
  if (!item || typeof item !== 'object') {
    throw new Error('Workspace observation must be an object');
  }
  const sourceKey = normalizeSourceKey(item.sourceKey);
  const refreshId = normalizeBoundedText(item.refreshId, 'refreshId', 240);
  const cause = normalizeBoundedText(item.cause, 'cause', 120);
  const status = normalizeObservationStatus(item.status);
  const projectionMode = item.projectionMode ?? 'source';
  if (projectionMode !== 'source' && projectionMode !== 'document') {
    throw new Error(`invalid Workspace projectionMode: ${String(projectionMode)}`);
  }
  const observedAt = normalizeTimestamp(item.observedAt ?? new Date(), 'observedAt');
  const provenance = sanitizeWorkspaceObservationProvenance(item.provenance);
  const provenanceJson = stableStringify(provenance);
  if (Buffer.byteLength(provenanceJson, 'utf-8') > MAX_PROVENANCE_BYTES) {
    throw new Error(`Workspace observation provenance exceeds ${MAX_PROVENANCE_BYTES} byte cap`);
  }

  let canonicalData: string | null = null;
  let contentHash: string | null = null;
  let dataBytes = 0;
  let error: string | null = null;
  if (status === 'ok') {
    if (!Object.prototype.hasOwnProperty.call(item, 'data')) {
      throw new Error(`successful observation "${sourceKey}" requires data`);
    }
    const canonical = canonicalizeJson(item.data);
    canonicalData = canonical.text;
    contentHash = canonical.contentHash;
    dataBytes = canonical.bytes;
    if (dataBytes > MAX_WORKSPACE_DATA_BYTES) {
      throw new Error(
        `Workspace observation data exceeds ${MAX_WORKSPACE_DATA_BYTES} byte cap (${dataBytes} bytes)`,
      );
    }
  } else {
    if (Object.prototype.hasOwnProperty.call(item, 'data')) {
      throw new Error(`${status} observation "${sourceKey}" cannot include data`);
    }
    error = scrubWorkspaceObservationError(
      item.error ?? (status === 'error' ? 'refresh failed' : 'awaiting approval'),
    );
  }
  const commitHash = hashString(stableStringify({
    sourceKey,
    refreshId,
    cause,
    status,
    projectionMode,
    contentHash,
    error,
    provenance,
  }));
  return {
    sourceKey,
    refreshId,
    cause,
    status,
    projectionMode,
    canonicalData,
    contentHash,
    dataBytes,
    error,
    provenanceJson,
    observedAt,
    commitHash,
  };
}

function upsertWorkspaceDatasetBlob(
  db: Database.Database,
  workspaceId: string,
  item: PreparedWorkspaceObservation,
): string {
  if (
    item.status !== 'ok'
    || item.canonicalData === null
    || item.contentHash === null
  ) {
    throw new Error('only successful observations can create Workspace dataset blobs');
  }
  const candidates = db.prepare(`
    SELECT id, doc_json
    FROM workspace_datasets
    WHERE workspace_id = ?
      AND source_key = ?
      AND content_hash = ?
      AND status = 'ok'
    ORDER BY refreshed_at ASC, id ASC
  `).all(workspaceId, item.sourceKey, item.contentHash) as Array<{
    id: string;
    doc_json: string;
  }>;
  const reusable = candidates.find((candidate) => candidate.doc_json === item.canonicalData);
  const sourceId = db.prepare(`
    SELECT id
    FROM workspace_data_sources
    WHERE workspace_id = ? AND id = ?
    LIMIT 1
  `).get(
    workspaceId,
    `${workspaceId}:source:${item.sourceKey}`,
  ) as { id: string } | undefined;
  if (reusable) {
    db.prepare(`
      UPDATE workspace_datasets
      SET last_seen_at = ?,
          source_id = COALESCE(source_id, ?)
      WHERE id = ? AND workspace_id = ?
    `).run(item.observedAt, sourceId?.id ?? null, reusable.id, workspaceId);
    return reusable.id;
  }

  const id = `wds_${hashString(
    `${workspaceId}\0${item.sourceKey}\0${item.contentHash}`,
  )}`;
  db.prepare(`
    INSERT INTO workspace_datasets (
      id, workspace_id, source_id, source_key, doc_json, content_hash, bytes,
      status, error, refreshed_at, first_seen_at, last_seen_at
    ) VALUES (
      @id, @workspaceId, @sourceId, @sourceKey, @docJson, @contentHash, @bytes,
      'ok', NULL, @refreshedAt, @firstSeenAt, @lastSeenAt
    )
    ON CONFLICT(id) DO NOTHING
  `).run({
    id,
    workspaceId,
    sourceId: sourceId?.id ?? null,
    sourceKey: item.sourceKey,
    docJson: item.canonicalData,
    contentHash: item.contentHash,
    bytes: item.dataBytes,
    refreshedAt: item.observedAt,
    firstSeenAt: item.observedAt,
    lastSeenAt: item.observedAt,
  });
  const stored = db.prepare(`
    SELECT workspace_id, source_key, content_hash, doc_json
    FROM workspace_datasets
    WHERE id = ?
  `).get(id) as {
    workspace_id: string;
    source_key: string;
    content_hash: string;
    doc_json: string;
  } | undefined;
  if (
    !stored
    || stored.workspace_id !== workspaceId
    || stored.source_key !== item.sourceKey
    || stored.content_hash !== item.contentHash
    || stored.doc_json !== item.canonicalData
  ) {
    throw new Error('Workspace dataset content-address collision');
  }
  return id;
}

function buildWorkspaceProjection(
  db: Database.Database,
  workspaceId: string,
  existing: unknown,
): BuiltWorkspaceProjection {
  const retirements = db.prepare(`
    SELECT source_key, projection_mode, retired_after_rowid, retired_at
    FROM workspace_dataset_source_retirements
    WHERE workspace_id = ?
  `).all(workspaceId) as WorkspaceSourceRetirementRow[];
  const retirementBySource = new Map(
    retirements.map((entry) => [entry.source_key, entry] as const),
  );
  const activeSourceKeys = new Set(
    (db.prepare(`
      SELECT id
      FROM workspace_data_sources
      WHERE workspace_id = ?
    `).all(workspaceId) as Array<{ id: string }>).map(
      (entry) => sourceKeyFromStoredRowId(workspaceId, entry.id),
    ),
  );
  const current = db.prepare(`
    SELECT
      o.rowid AS row_id,
      o.source_key,
      o.projection_mode,
      o.status,
      d.doc_json,
      o.error,
      o.cause,
      o.provenance_json,
      o.observed_at,
      o.created_at,
      o.batch_index
    FROM workspace_dataset_observations o
    JOIN workspace_datasets d
      ON d.id = o.dataset_id
     AND d.workspace_id = o.workspace_id
    WHERE o.workspace_id = ?
      AND o.is_current = 1
      AND o.status = 'ok'
  `).all(workspaceId) as ProjectionEventRow[];
  const latestNonSuccess = db.prepare(`
    SELECT
      o.rowid AS row_id,
      o.source_key,
      o.projection_mode,
      o.status,
      NULL AS doc_json,
      o.error,
      o.cause,
      o.provenance_json,
      o.observed_at,
      o.created_at,
      o.batch_index
    FROM workspace_dataset_observations o
    WHERE o.workspace_id = ?
      AND o.status <> 'ok'
      AND o.rowid = (
        SELECT newest.rowid
        FROM workspace_dataset_observations newest
        WHERE newest.workspace_id = o.workspace_id
          AND newest.source_key = o.source_key
        ORDER BY newest.rowid DESC
        LIMIT 1
      )
  `).all(workspaceId) as ProjectionEventRow[];
  const events = [...current, ...latestNonSuccess]
    .filter((event) => {
      const retirement = retirementBySource.get(event.source_key);
      if (!retirement) return true;
      if (event.status === 'ok') return false;
      // A re-added source may surface a new failed/awaiting attempt, but an
      // error from before retirement must not reappear just because the
      // manifest declared the same id again.
      return activeSourceKeys.has(event.source_key)
        && event.row_id > retirement.retired_after_rowid;
    })
    .sort(compareProjectionEvents);
  let document = pruneRetiredSourceProjections(existing, retirements);
  const sources = new Set<string>();
  for (const event of events) {
    sources.add(event.source_key);
    if (event.status === 'ok') {
      let data: unknown;
      try {
        data = JSON.parse(event.doc_json ?? 'null');
      } catch {
        // A corrupt legacy blob cannot be safely projected.
        continue;
      }
      if (event.projection_mode === 'document') {
        document = data;
      } else {
        document = applySourceProjection(document, event.source_key, data, {
          refreshedAt: event.observed_at,
          ok: true,
          provenance: event.cause,
        });
      }
      continue;
    }
    const provenance = parseProvenanceJson(event.provenance_json);
    const approvalId = (
      event.status === 'awaiting_approval'
      && typeof provenance.approvalId === 'string'
    ) ? provenance.approvalId : undefined;
    document = applySourceMeta(document, event.source_key, {
      refreshedAt: event.observed_at,
      ok: event.status === 'awaiting_approval' ? null : false,
      status: event.status,
      error: event.error ?? (
        event.status === 'awaiting_approval' ? 'awaiting approval' : 'refresh failed'
      ),
      ...(approvalId ? { approvalId } : {}),
    });
  }
  return { document, sources: sources.size };
}

function pruneRetiredSourceProjections(
  document: unknown,
  retirements: WorkspaceSourceRetirementRow[],
): unknown {
  if (retirements.length === 0) return cloneJsonValue(document);
  // A document-mode observation owns the complete compatibility projection.
  // Retiring it therefore resets that owned document before active source
  // observations are replayed below.
  if (retirements.some((entry) => entry.projection_mode === 'document')) return {};

  const root = isJsonObject(document) ? { ...document } : {};
  const meta = isJsonObject(root._meta) ? { ...root._meta } : null;
  for (const retirement of retirements) {
    Reflect.deleteProperty(root, retirement.source_key);
    if (meta) Reflect.deleteProperty(meta, retirement.source_key);
  }
  if (meta) defineOwnEnumerable(root, '_meta', meta);
  return root;
}

function compareProjectionEvents(a: ProjectionEventRow, b: ProjectionEventRow): number {
  // Projection semantics follow commit order, not a provider-supplied event
  // timestamp that may arrive late or be backfilled.
  return a.row_id - b.row_id;
}

function applySourceProjection(
  document: unknown,
  sourceKey: string,
  data: unknown,
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const root = isJsonObject(document) ? { ...document } : {};
  defineOwnEnumerable(root, sourceKey, data);
  return applySourceMeta(root, sourceKey, meta);
}

function applySourceMeta(
  document: unknown,
  sourceKey: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const root = isJsonObject(document) ? { ...document } : {};
  const existingMeta = isJsonObject(root._meta) ? { ...root._meta } : {};
  defineOwnEnumerable(existingMeta, sourceKey, entry);
  defineOwnEnumerable(root, '_meta', existingMeta);
  return root;
}

/**
 * Bracket assignment to "__proto__" invokes Object.prototype's legacy setter.
 * Workspace source ids are user-owned and may legitimately use that key, so
 * projections always define an own data property instead.
 */
function defineOwnEnumerable(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function readWorkspaceProjection(rootDir: string): unknown {
  const file = path.join(rootDir, 'data.json');
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, 'utf-8');
    if (Buffer.byteLength(raw, 'utf-8') > MAX_WORKSPACE_DATA_BYTES) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function serializeWorkspaceProjection(document: unknown): {
  text: string;
  bytes: number;
} {
  let text: string;
  try {
    const serialized = JSON.stringify(document === undefined ? {} : document);
    if (serialized === undefined) {
      throw new Error('top-level value is not representable in JSON');
    }
    text = serialized;
  } catch (err) {
    throw new Error(`Workspace data projection is not JSON-serializable: ${(err as Error).message}`);
  }
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes > MAX_WORKSPACE_DATA_BYTES) {
    throw new Error(
      `Workspace data projection exceeds ${MAX_WORKSPACE_DATA_BYTES} byte cap (${bytes} bytes)`,
    );
  }
  return { text, bytes };
}

function atomicWriteWorkspaceProjection(rootDir: string, text: string): void {
  if (!existsSync(rootDir)) mkdirSync(rootDir, { recursive: true });
  const file = path.join(rootDir, 'data.json');
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, file);
}

function workspaceRootFromDb(db: Database.Database, workspaceId: string): string {
  const row = db.prepare(`
    SELECT root_dir
    FROM workspaces
    WHERE id = ?
    LIMIT 1
  `).get(workspaceId) as { root_dir: string } | undefined;
  if (!row) throw new Error(`Workspace "${workspaceId}" is not indexed`);
  return row.root_dir;
}

function assertWorkspaceExists(db: Database.Database, workspaceId: string): void {
  if (!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId)) {
    throw new Error(`Workspace "${workspaceId}" is not indexed`);
  }
}

function mapWorkspaceObservation(row: WorkspaceObservationRow): WorkspaceDatasetObservation {
  const provenance = parseProvenanceJson(row.provenance_json);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceKey: row.source_key,
    refreshId: row.refresh_id,
    batchId: row.batch_id,
    batchIndex: row.batch_index,
    cause: row.cause,
    projectionMode: row.projection_mode,
    datasetId: row.dataset_id,
    contentHash: row.content_hash,
    previousObservationId: row.previous_observation_id,
    previousDatasetId: row.previous_dataset_id,
    status: row.status,
    changed: row.changed === null ? null : row.changed === 1,
    isCurrent: row.is_current === 1,
    provenance,
    error: row.error,
    observedAt: row.observed_at,
    createdAt: row.created_at,
  };
}

function parseProvenanceJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    // Persisted metadata is untrusted at read time; an invalid value becomes {}.
    return {};
  }
}

export function sanitizeWorkspaceObservationProvenance(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (input === undefined) return {};
  if (!isJsonObject(input)) throw new Error('Workspace observation provenance must be an object');
  let raw: string;
  try {
    raw = JSON.stringify(input);
  } catch {
    throw new Error('Workspace observation provenance must be JSON-serializable');
  }
  if (Buffer.byteLength(raw, 'utf-8') > MAX_PROVENANCE_INPUT_BYTES) {
    throw new Error(
      `Workspace observation provenance input exceeds ${MAX_PROVENANCE_INPUT_BYTES} byte cap`,
    );
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!PROVENANCE_ALLOWLIST.has(key)) continue;
    if (
      value === null
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
    ) {
      out[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      out[key] = provenanceString(value);
    }
  }
  return out;
}

export function scrubWorkspaceObservationError(input: unknown): string {
  let value = redactSensitiveText(String(input ?? '')).replaceAll('\0', '');
  value = value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /(["']?(?:authorization|proxy-authorization|x-api-key|api(?:[_\s-]?key)|access(?:[_\s-]?token)|refresh(?:[_\s-]?token)|client(?:[_\s-]?secret)|password|passwd|secret|cookie|set-cookie)["']?\s*[:=]\s*)(["'])(.*?)\2/gi,
      '$1$2[REDACTED]$2',
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(
      /\b(?:authorization|proxy-authorization|x-api-key|api(?:[_\s-]?key)|access(?:[_\s-]?token)|refresh(?:[_\s-]?token)|client(?:[_\s-]?secret)|password|passwd|secret|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '[REDACTED]',
    )
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi,
      '$1[REDACTED]@',
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)=)[^&#\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\b(?:sk-|gh[pousr]_|xox[baprs]-|rk_|whsec_)[A-Za-z0-9_-]{4,}\b/gi, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  return value.slice(0, MAX_OBSERVATION_ERROR_CHARS);
}

function provenanceString(value: string): string {
  const bounded = value.slice(0, 1_000);
  const scrubbed = scrubWorkspaceObservationError(bounded);
  return scrubbed !== bounded ? '[REDACTED]' : scrubbed;
}

function canonicalizeJson(value: unknown): {
  text: string;
  contentHash: string;
  bytes: number;
} {
  let normalized: unknown;
  try {
    const ordinary = JSON.stringify(value === undefined ? {} : value);
    if (ordinary === undefined) {
      throw new Error('top-level value is not representable in JSON');
    }
    normalized = JSON.parse(ordinary);
  } catch (err) {
    throw new Error(`Workspace observation data is not JSON-serializable: ${(err as Error).message}`);
  }
  const text = stableStringify(normalized);
  return {
    text,
    contentHash: hashString(text),
    bytes: Buffer.byteLength(text, 'utf-8'),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
    ).join(',')}}`;
  }
  throw new Error(`unsupported JSON value: ${typeof value}`);
}

function cloneJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    return {};
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeWorkspaceId(value: string): string {
  const id = normalizeBoundedText(value, 'workspaceId', 128);
  if (!isValidWorkspaceSlug(id)) throw new Error(`invalid workspace slug: ${id}`);
  return id;
}

function normalizeSourceKey(value: string): string {
  const sourceKey = normalizeSourceKeyForLookup(value);
  if (sourceKey === '_meta') throw new Error('"_meta" is a reserved Workspace source key');
  return sourceKey;
}

function normalizeSourceKeyForLookup(value: string): string {
  const sourceKey = normalizeBoundedText(value, 'sourceKey', 512);
  if (/[\u0000-\u001f\u007f]/.test(sourceKey)) {
    throw new Error('Workspace sourceKey cannot contain control characters');
  }
  return sourceKey;
}

function normalizeObservationStatus(value: unknown): WorkspaceDatasetObservationStatus {
  if (value === 'ok' || value === 'error' || value === 'awaiting_approval') return value;
  throw new Error(`invalid Workspace observation status: ${String(value)}`);
}

function normalizeBoundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} cannot be blank`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} character cap`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} contains control characters`);
  }
  return normalized;
}

function normalizeTimestamp(value: string | Date, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < min || selected > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return selected;
}

function legacyRefreshId(
  workspaceId: string,
  sourceKey: string,
  contentHash: string,
): string {
  return `legacy:${hashString(`${workspaceId}\0${sourceKey}\0${contentHash}`).slice(0, 48)}`;
}

function fileTimestamp(file: string): string {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function workspaceDatasetBytes(db: Database.Database, workspaceId: string): number {
  return Number((db.prepare(`
    SELECT COALESCE(SUM(bytes), 0) AS bytes
    FROM workspace_datasets
    WHERE workspace_id = ? AND id GLOB 'wds_*'
  `).get(workspaceId) as { bytes: number } | undefined)?.bytes ?? 0);
}

function upsertWorkspace(db: Database.Database, record: SpaceRecord, rootDir: string): void {
  db.prepare(`
    INSERT INTO workspaces (
      id, slug, title, status, root_dir, view_entry, origin_session_id, focus_id,
      recipe_json, metadata_json, created_at, updated_at, last_opened_at,
      last_refreshed_at
    ) VALUES (
      @id, @slug, @title, @status, @rootDir, @viewEntry, @originSessionId, @focusId,
      @recipeJson, @metadataJson, @createdAt, @updatedAt, @lastOpenedAt,
      @lastRefreshedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      slug = excluded.slug,
      title = excluded.title,
      status = excluded.status,
      root_dir = excluded.root_dir,
      view_entry = excluded.view_entry,
      origin_session_id = excluded.origin_session_id,
      focus_id = excluded.focus_id,
      recipe_json = excluded.recipe_json,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at,
      last_opened_at = excluded.last_opened_at,
      last_refreshed_at = excluded.last_refreshed_at
  `).run({
    id: record.id,
    slug: record.id,
    title: record.title,
    status: record.status,
    rootDir,
    viewEntry: record.viewEntry,
    originSessionId: record.originSessionId ?? null,
    focusId: record.focusId ?? null,
    recipeJson: record.recipe ? JSON.stringify({ text: record.recipe }) : null,
    metadataJson: JSON.stringify({
      contract: record.contract,
      reengage: record.reengage,
      manifestErrors: record.manifestErrors,
      version: record.version,
    }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastOpenedAt: record.lastOpenedAt ?? null,
    lastRefreshedAt: record.lastRefreshedAt ?? null,
  });
}

function replaceDataSources(db: Database.Database, record: SpaceRecord, now: string): string[] {
  const previousIds = (db.prepare(`
    SELECT id
    FROM workspace_data_sources
    WHERE workspace_id = ?
  `).all(record.id) as Array<{ id: string }>).map((entry) => entry.id);
  const insert = db.prepare(`
    INSERT INTO workspace_data_sources (
      id, workspace_id, runner, composio_slug, args_json, schedule, timezone,
      created_at, updated_at
    ) VALUES (
      @id, @workspaceId, @runner, @composioSlug, @argsJson, @schedule, @timezone,
      @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      runner = excluded.runner,
      composio_slug = excluded.composio_slug,
      args_json = excluded.args_json,
      schedule = excluded.schedule,
      timezone = excluded.timezone,
      updated_at = excluded.updated_at
  `);
  const retainedIds: string[] = [];
  for (const [index, source] of record.dataSources.entries()) {
    if (!source.runner && !source.composioSlug) continue;
    const id = sourceRowId(record.id, source, index);
    retainedIds.push(id);
    insert.run({
      id,
      workspaceId: record.id,
      runner: source.runner ?? null,
      composioSlug: source.composioSlug ?? null,
      argsJson: JSON.stringify(source.composioArgs ?? {}),
      schedule: source.schedule ?? null,
      timezone: source.timezone ?? null,
      createdAt: record.createdAt,
      updatedAt: now,
    });
  }
  if (retainedIds.length === 0) {
    db.prepare('DELETE FROM workspace_data_sources WHERE workspace_id = ?').run(record.id);
  } else {
    const placeholders = retainedIds.map(() => '?').join(',');
    db.prepare(`
      DELETE FROM workspace_data_sources
      WHERE workspace_id = ?
        AND id NOT IN (${placeholders})
    `).run(record.id, ...retainedIds);
  }
  const retained = new Set(retainedIds);
  const retiredSourceKeys = previousIds
    .filter((id) => !retained.has(id))
    .map((id) => sourceKeyFromStoredRowId(record.id, id));
  const latestProjectionMode = db.prepare(`
    SELECT rowid AS row_id, projection_mode
    FROM workspace_dataset_observations
    WHERE workspace_id = ? AND source_key = ?
    ORDER BY rowid DESC
    LIMIT 1
  `);
  const retire = db.prepare(`
    INSERT INTO workspace_dataset_source_retirements (
      workspace_id, source_key, projection_mode, retired_after_rowid, retired_at
    ) VALUES (
      @workspaceId, @sourceKey, @projectionMode, @retiredAfterRowId, @retiredAt
    )
    ON CONFLICT(workspace_id, source_key) DO UPDATE SET
      projection_mode = excluded.projection_mode,
      retired_after_rowid = excluded.retired_after_rowid,
      retired_at = excluded.retired_at
  `);
  const clearCurrent = db.prepare(`
    UPDATE workspace_dataset_observations
    SET is_current = 0
    WHERE workspace_id = ? AND source_key = ? AND is_current = 1
  `);
  for (const sourceKey of retiredSourceKeys) {
    const latest = latestProjectionMode.get(record.id, sourceKey) as {
      row_id: number;
      projection_mode: WorkspaceProjectionMode;
    } | undefined;
    retire.run({
      workspaceId: record.id,
      sourceKey,
      projectionMode: latest?.projection_mode ?? 'source',
      retiredAfterRowId: latest?.row_id ?? 0,
      retiredAt: now,
    });
    clearCurrent.run(record.id, sourceKey);
  }
  return retiredSourceKeys;
}

function replaceActions(db: Database.Database, record: SpaceRecord, now: string): void {
  db.prepare('DELETE FROM workspace_actions WHERE workspace_id = ?').run(record.id);
  const insert = db.prepare(`
    INSERT INTO workspace_actions (
      id, workspace_id, runner, composio_slug, args_template_json, side_effect,
      approval_policy, created_at, updated_at
    ) VALUES (
      @id, @workspaceId, @runner, @composioSlug, @argsTemplateJson, @sideEffect,
      @approvalPolicy, @createdAt, @updatedAt
    )
  `);
  for (const [index, action] of record.actions.entries()) {
    if (!action.runner && !action.composioSlug) continue;
    insert.run({
      id: actionRowId(record.id, action, index),
      workspaceId: record.id,
      runner: action.runner ?? null,
      composioSlug: action.composioSlug ?? null,
      argsTemplateJson: JSON.stringify(action.argsTemplate ?? {}),
      sideEffect: sideEffectForAction(action),
      approvalPolicy: 'required',
      createdAt: record.createdAt,
      updatedAt: now,
    });
  }
}

function replaceFilesAndRevisions(db: Database.Database, record: SpaceRecord, rootDir: string): void {
  db.prepare('DELETE FROM workspace_revisions WHERE workspace_id = ?').run(record.id);
  db.prepare('DELETE FROM workspace_files WHERE workspace_id = ?').run(record.id);
  const files = collectWorkspaceFiles(record, rootDir);
  const fileIdsByRel = new Map<string, string>();
  const insertFile = db.prepare(`
    INSERT INTO workspace_files (
      id, workspace_id, rel_path, kind, content_hash, bytes, version, created_at,
      updated_at
    ) VALUES (
      @id, @workspaceId, @relPath, @kind, @contentHash, @bytes, @version, @createdAt,
      @updatedAt
    )
  `);
  for (const file of files) {
    const id = fileRowId(record.id, file.relPath);
    fileIdsByRel.set(file.relPath, id);
    insertFile.run({
      id,
      workspaceId: record.id,
      relPath: file.relPath,
      kind: file.kind,
      contentHash: file.contentHash,
      bytes: file.bytes,
      version: file.relPath === record.viewEntry ? record.version : 1,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    });
  }
  replaceRevisions(db, record, rootDir, fileIdsByRel);
}

function replaceRevisions(
  db: Database.Database,
  record: SpaceRecord,
  rootDir: string,
  fileIdsByRel: Map<string, string>,
): void {
  const insert = db.prepare(`
    INSERT INTO workspace_revisions (
      id, workspace_id, file_id, version, snapshot_path, content_hash, bytes,
      author_session_id, created_at
    ) VALUES (
      @id, @workspaceId, @fileId, @version, @snapshotPath, @contentHash, @bytes,
      @authorSessionId, @createdAt
    )
  `);
  for (const revision of record.revisions) {
    const snapshot = statWorkspaceFile(rootDir, revision.file);
    insert.run({
      id: revisionRowId(record.id, revision),
      workspaceId: record.id,
      fileId: fileIdsByRel.get(revision.file) ?? null,
      version: revision.version,
      snapshotPath: revision.file,
      contentHash: snapshot?.contentHash ?? hashString(`${record.id}:${revision.file}:${revision.version}:${revision.ts}`),
      bytes: snapshot?.bytes ?? revision.bytes,
      authorSessionId: record.originSessionId ?? null,
      createdAt: revision.ts,
    });
  }
}

function appendWorkspaceStateEvent(
  db: Database.Database,
  workspaceId: string,
  input: {
    eventType: WorkspaceOperationalEventType;
    actor: string;
    payload: Record<string, unknown>;
    createdAt: string;
  },
): void {
  const seq = ((db.prepare(`
    SELECT COALESCE(MAX(seq), 0) + 1 AS seq
    FROM workspace_state_events
    WHERE workspace_id = ?
  `).get(workspaceId) as { seq: number } | undefined)?.seq) ?? 1;
  db.prepare(`
    INSERT INTO workspace_state_events (
      id, workspace_id, seq, session_id, event_type, actor, payload_json, created_at
    ) VALUES (
      @id, @workspaceId, @seq, @sessionId, @eventType, @actor, @payloadJson, @createdAt
    )
  `).run({
    id: randomUUID(),
    workspaceId,
    seq,
    sessionId: typeof input.payload.originSessionId === 'string' ? input.payload.originSessionId : null,
    eventType: input.eventType,
    actor: input.actor,
    payloadJson: JSON.stringify(input.payload),
    createdAt: input.createdAt,
  });
}

interface IndexedWorkspaceFile {
  relPath: string;
  kind: WorkspaceFileKind;
  contentHash: string;
  bytes: number;
  createdAt: string;
  updatedAt: string;
}

function collectWorkspaceFiles(record: SpaceRecord, rootDir: string): IndexedWorkspaceFile[] {
  const rels = new Set<string>(['space.json', record.viewEntry, 'data.json', 'notes.jsonl', 'audit.jsonl']);
  for (const source of record.dataSources) if (source.runner) rels.add(path.posix.join('data', source.runner));
  for (const action of record.actions) if (action.runner) rels.add(path.posix.join('data', action.runner));
  for (const revision of record.revisions) rels.add(revision.file);
  for (const rel of walkWorkspaceFiles(rootDir, 'view')) rels.add(rel);
  for (const rel of walkWorkspaceFiles(rootDir, 'data')) rels.add(rel);
  for (const rel of walkWorkspaceFiles(rootDir, 'view-history')) rels.add(rel);

  const out: IndexedWorkspaceFile[] = [];
  for (const relPath of rels) {
    const stat = statWorkspaceFile(rootDir, relPath);
    if (!stat) continue;
    out.push({
      relPath,
      kind: classifyWorkspaceFile(record, relPath),
      ...stat,
    });
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function walkWorkspaceFiles(rootDir: string, relDir: string): string[] {
  const abs = path.join(rootDir, relDir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        visit(full);
      } else if (st.isFile()) {
        out.push(toPosix(path.relative(rootDir, full)));
      }
    }
  };
  visit(abs);
  return out;
}

function statWorkspaceFile(rootDir: string, relPath: string): Omit<IndexedWorkspaceFile, 'relPath' | 'kind'> | null {
  const full = safeJoin(rootDir, relPath);
  if (!full || !existsSync(full)) return null;
  try {
    const st = statSync(full);
    if (!st.isFile()) return null;
    return {
      contentHash: hashBuffer(readFileSync(full)),
      bytes: st.size,
      createdAt: st.birthtime.toISOString(),
      updatedAt: st.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function classifyWorkspaceFile(record: SpaceRecord, relPath: string): WorkspaceFileKind {
  if (relPath === 'space.json') return 'manifest';
  if (relPath === record.viewEntry) return 'view';
  if (relPath === 'data.json') return 'data';
  if (relPath === 'notes.jsonl') return 'note';
  if (relPath === 'audit.jsonl') return 'audit';
  if (relPath.startsWith('view-history/')) return 'snapshot';
  if (relPath.startsWith('view/')) return 'asset';
  if (relPath.startsWith('data/')) return 'runner';
  return 'other';
}

function resolveWorkspaceRoot(slug: string): string {
  if (!isValidWorkspaceSlug(slug)) throw new Error(`invalid workspace slug: ${slug}`);
  return path.join(WORKSPACE_SPACES_DIR, slug);
}

function isValidWorkspaceSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(slug);
}

function sourceRowId(workspaceId: string, source: SpaceDataSource, index: number): string {
  return `${workspaceId}:source:${source.id || index}`;
}

function sourceKeyFromStoredRowId(workspaceId: string, rowId: string): string {
  const prefix = `${workspaceId}:source:`;
  return rowId.startsWith(prefix) ? rowId.slice(prefix.length) : rowId;
}

function actionRowId(workspaceId: string, action: SpaceAction, index: number): string {
  return `${workspaceId}:action:${action.id || index}`;
}

function fileRowId(workspaceId: string, relPath: string): string {
  return `${workspaceId}:file:${hashString(relPath).slice(0, 16)}`;
}

function revisionRowId(workspaceId: string, revision: SpaceRevision): string {
  return `${workspaceId}:revision:${revision.version}:${hashString(`${revision.file}:${revision.ts}`).slice(0, 12)}`;
}

function sideEffectForAction(action: SpaceAction): 'write' | 'send' {
  const slug = `${action.composioSlug ?? ''} ${action.runner ?? ''}`.toLowerCase();
  return slug.includes('send') || slug.includes('email') || slug.includes('mail') ? 'send' : 'write';
}

function safeJoin(rootDir: string, relPath: string): string | null {
  const target = path.resolve(rootDir, relPath);
  const rel = path.relative(rootDir, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ensureStateDir(): void {
  if (!existsSync(WORKSPACE_STATE_DIR)) mkdirSync(WORKSPACE_STATE_DIR, { recursive: true });
}
