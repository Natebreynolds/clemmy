/**
 * Post-commit projection for Workspace observations.
 *
 * SQLite + data.json are already durable before this runs. Semantic memory and
 * retention are deliberately best-effort: neither may turn a successful data
 * refresh into a failure. Memory receives only a bounded structural summary,
 * never the retained dataset documents used to compute it.
 */
import {
  getWorkspaceDatasetObservation,
  getWorkspaceObservationDocument,
  openWorkspaceDb,
  pruneWorkspaceDatasetHistory,
  type CommitWorkspaceObservationBatchResult,
  type PruneWorkspaceDatasetHistoryResult,
  type WorkspaceDatasetObservation,
} from './workspace-db.js';
import {
  diffWorkspaceObservationDocuments,
  type WorkspaceObservationDiff,
} from './observation-diff.js';
import {
  createWorkspaceObservationMemoryBridge,
  hasWorkspaceObservationMemoryProjection,
  listWorkspaceObservationMemoryProjectionIds,
  pruneWorkspaceObservationMemoryProjections,
  recordWorkspaceObservationMemoryProjection,
  type WorkspaceMemoryCaptureResult,
  type WorkspaceMemorySignal,
  type WorkspaceObservationProjectionDisposition,
} from '../memory/workspace-observation-bridge.js';

export const WORKSPACE_HISTORY_RETENTION = Object.freeze({
  maxObservationsPerSource: 256,
  maxAgeDays: 90,
  maxDatasetBytes: 64 * 1024 * 1024,
});

type CaptureWorkspaceMemory = (
  signal: WorkspaceMemorySignal,
) => Promise<WorkspaceMemoryCaptureResult>;

export interface WorkspaceObservationFinalizeDependencies {
  getObservation(
    workspaceId: string,
    observationId: string,
  ): WorkspaceDatasetObservation | null;
  getDocument(workspaceId: string, observationId: string): unknown | undefined;
  captureMemory: CaptureWorkspaceMemory;
  hasProjection?(workspaceId: string, observationId: string): boolean;
  recordProjection?(input: {
    workspaceId: string;
    observationId: string;
    disposition: WorkspaceObservationProjectionDisposition;
    reason: string;
  }): void;
  prune(workspaceId: string): PruneWorkspaceDatasetHistoryResult;
  pruneProjectionReceipts?(workspaceId: string): number;
}

export interface WorkspaceObservationMemoryRecoveryDependencies {
  listRecoverable(workspaceId: string): WorkspaceDatasetObservation[];
  getObservation(
    workspaceId: string,
    observationId: string,
  ): WorkspaceDatasetObservation | null;
  getDocument(workspaceId: string, observationId: string): unknown | undefined;
  captureMemory: CaptureWorkspaceMemory;
  hasProjection?(workspaceId: string, observationId: string): boolean;
  recordProjection?(input: {
    workspaceId: string;
    observationId: string;
    disposition: WorkspaceObservationProjectionDisposition;
    reason: string;
  }): void;
}

export interface WorkspaceObservationFinalizeResult {
  memory: WorkspaceMemoryCaptureResult[];
  memoryCandidates: number;
  memoryRecorded: number;
  retention: PruneWorkspaceDatasetHistoryResult | null;
  projectionReceiptsPruned: number;
}

export interface WorkspaceObservationMemoryRecoveryResult {
  examined: number;
  memory: WorkspaceMemoryCaptureResult[];
  memoryCandidates: number;
  memoryRecorded: number;
  memoryDeduped: number;
  memoryFailed: number;
}

const memoryBridge = createWorkspaceObservationMemoryBridge();

const defaultDependencies: WorkspaceObservationFinalizeDependencies = {
  getObservation: (workspaceId, observationId) =>
    getWorkspaceDatasetObservation(workspaceId, observationId),
  getDocument: (workspaceId, observationId) =>
    getWorkspaceObservationDocument(workspaceId, observationId),
  captureMemory: (signal) => memoryBridge.capture(signal),
  hasProjection: (workspaceId, observationId) =>
    hasWorkspaceObservationMemoryProjection(workspaceId, observationId),
  recordProjection: (input) => {
    recordWorkspaceObservationMemoryProjection(input);
  },
  prune: (workspaceId) => pruneWorkspaceDatasetHistory(
    workspaceId,
    WORKSPACE_HISTORY_RETENTION,
  ),
  pruneProjectionReceipts: (workspaceId) =>
    pruneWorkspaceObservationProjectionReceipts(workspaceId),
};

const defaultRecoveryDependencies: WorkspaceObservationMemoryRecoveryDependencies = {
  listRecoverable: (workspaceId) => {
    const db = openWorkspaceDb();
    const projected = listWorkspaceObservationMemoryProjectionIds(workspaceId);
    const rows = db.prepare(`
      SELECT id
      FROM workspace_dataset_observations
      WHERE workspace_id = ?
        AND status = 'ok'
        AND changed = 1
        AND previous_observation_id IS NOT NULL
      ORDER BY rowid ASC
    `).all(workspaceId) as Array<{ id: string }>;
    return rows
      .filter((row) => !projected.has(row.id))
      .map((row) => getWorkspaceDatasetObservation(workspaceId, row.id, db))
      .filter((entry): entry is WorkspaceDatasetObservation => Boolean(entry));
  },
  getObservation: (workspaceId, observationId) =>
    getWorkspaceDatasetObservation(workspaceId, observationId),
  getDocument: (workspaceId, observationId) =>
    getWorkspaceObservationDocument(workspaceId, observationId),
  captureMemory: (signal) => memoryBridge.capture(signal),
  recordProjection: (input) => {
    recordWorkspaceObservationMemoryProjection(input);
  },
};

export function pruneWorkspaceObservationProjectionReceipts(
  workspaceId: string,
): number {
  const db = openWorkspaceDb();
  const retained = (db.prepare(`
    SELECT id
    FROM workspace_dataset_observations
    WHERE workspace_id = ?
  `).all(workspaceId) as Array<{ id: string }>).map((row) => row.id);
  return pruneWorkspaceObservationMemoryProjections(workspaceId, retained);
}

function provenanceSummary(cause: string): string {
  switch (cause) {
    case 'scheduled':
      return 'Scheduled Workspace observation committed.';
    case 'creation_smoke':
      return 'Workspace creation-check observation committed.';
    case 'retry':
      return 'Workspace recovery observation committed.';
    case 'direct_put':
      return 'Direct Workspace document observation committed.';
    case 'manual':
      return 'Manual Workspace observation committed.';
    case 'legacy_import':
      return 'Pre-3.0 Workspace baseline imported.';
    default:
      return 'Workspace observation committed.';
  }
}

const VOLATILE_FIELD_NAMES = new Set([
  'createdat',
  'fetchedat',
  'generatedat',
  'ingestedat',
  'lastrefreshedat',
  'lastsyncedat',
  'modifiedat',
  'observedat',
  'refreshedat',
  'retrievedat',
  'syncedat',
  'timestamp',
  'updatedat',
]);

function decodedPointerLeaf(path: string): string {
  const part = path.split('/').at(-1) ?? '';
  return part.replace(/~1/g, '/').replace(/~0/g, '~');
}

function normalizedFieldName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Provider clocks and fetch metadata often change on every identical pull.
 * They stay exact in the retained observation ledger, but do not deserve an
 * episodic-memory slot by themselves. A truncated diff is never suppressed
 * because unseen changes may be substantive.
 */
function memoryRelevantDiff(diff: WorkspaceObservationDiff): WorkspaceObservationDiff {
  const changes = diff.changes.filter((change) =>
    !VOLATILE_FIELD_NAMES.has(normalizedFieldName(decodedPointerLeaf(change.path))));
  const counts: WorkspaceObservationDiff['counts'] = { add: 0, remove: 0, replace: 0 };
  for (const change of changes) counts[change.op] += 1;
  return {
    changed: changes.length > 0 || diff.truncated,
    summary: '',
    counts,
    changes,
    truncated: diff.truncated,
  };
}

async function projectObservationMemory(
  workspaceId: string,
  observation: WorkspaceDatasetObservation,
  dependencies: Pick<
    WorkspaceObservationMemoryRecoveryDependencies,
    'getObservation' | 'getDocument' | 'captureMemory' | 'hasProjection' | 'recordProjection'
  >,
): Promise<WorkspaceMemoryCaptureResult | null> {
  if (
    observation.status !== 'ok'
    || observation.changed !== true
    || !observation.contentHash
    || !observation.previousObservationId
  ) return null;
  if (dependencies.hasProjection?.(workspaceId, observation.id)) return null;

  const previous = dependencies.getObservation(
    workspaceId,
    observation.previousObservationId,
  );
  if (
    !previous
    || previous.workspaceId !== workspaceId
    || previous.sourceKey !== observation.sourceKey
    || previous.status !== 'ok'
    || !previous.contentHash
  ) {
    dependencies.recordProjection?.({
      workspaceId,
      observationId: observation.id,
      disposition: 'suppressed',
      reason: 'previous_observation_unavailable',
    });
    return null;
  }
  const before = dependencies.getDocument(workspaceId, previous.id);
  const after = dependencies.getDocument(workspaceId, observation.id);
  if (before === undefined || after === undefined) {
    dependencies.recordProjection?.({
      workspaceId,
      observationId: observation.id,
      disposition: 'suppressed',
      reason: 'observation_document_unavailable',
    });
    return null;
  }

  const diff = memoryRelevantDiff(diffWorkspaceObservationDocuments(before, after));
  if (!diff.changed) {
    dependencies.recordProjection?.({
      workspaceId,
      observationId: observation.id,
      disposition: 'suppressed',
      reason: 'volatile_only',
    });
    return null;
  }
  const captured = await dependencies.captureMemory({
    kind: 'observation',
    workspaceId,
    sourceId: observation.sourceKey,
    observationId: observation.id,
    contentHash: observation.contentHash,
    previousContentHash: previous.contentHash,
    occurredAt: observation.observedAt,
    provenanceSummary: provenanceSummary(observation.cause),
    outcome: 'succeeded',
    changeCounts: diff.counts,
    truncated: diff.truncated,
  });
  if (captured.status !== 'failed') {
    dependencies.recordProjection?.({
      workspaceId,
      observationId: observation.id,
      disposition: 'captured',
      reason: captured.status,
    });
  }
  return captured;
}

/**
 * Project changed successful observations into compact episodic memory, then
 * enforce bounded local history. Call only after commitWorkspaceObservationBatch
 * returns successfully.
 */
export async function finalizeWorkspaceObservationCommit(
  workspaceId: string,
  committed: CommitWorkspaceObservationBatchResult,
  dependencies: WorkspaceObservationFinalizeDependencies = defaultDependencies,
): Promise<WorkspaceObservationFinalizeResult> {
  const memory: WorkspaceMemoryCaptureResult[] = [];
  let memoryCandidates = 0;

  for (const observation of committed.observations) {
    try {
      const captured = await projectObservationMemory(
        workspaceId,
        observation,
        dependencies,
      );
      if (!captured) continue;
      memoryCandidates += 1;
      memory.push(captured);
    } catch {
      memory.push({
        status: 'failed',
        reason: 'memory_unavailable',
        episodeId: null,
        wake: false,
      });
    }
  }

  let retention: PruneWorkspaceDatasetHistoryResult | null = null;
  let projectionReceiptsPruned = 0;
  try {
    retention = dependencies.prune(workspaceId);
    projectionReceiptsPruned = dependencies.pruneProjectionReceipts?.(workspaceId) ?? 0;
  } catch {
    // The observation and data.json projection are already durable. Retention
    // can retry after the next refresh or at daemon boot.
  }

  return {
    memory,
    memoryCandidates,
    memoryRecorded: memory.filter((entry) => entry.status === 'recorded').length,
    retention,
    projectionReceiptsPruned,
  };
}

/**
 * Restart repair for the DB-commit → memory-projection crash seam. Every
 * retained changed success is replayed oldest-first. Deterministic bridge IDs
 * make this at-least-once without multiplying episodes, including observations
 * returned as deduped by a retried provider refresh.
 */
export async function recoverWorkspaceObservationMemory(
  workspaceId: string,
  dependencies: WorkspaceObservationMemoryRecoveryDependencies =
    defaultRecoveryDependencies,
): Promise<WorkspaceObservationMemoryRecoveryResult> {
  const observations = dependencies.listRecoverable(workspaceId);
  const memory: WorkspaceMemoryCaptureResult[] = [];
  let memoryCandidates = 0;
  for (const observation of observations) {
    try {
      const captured = await projectObservationMemory(
        workspaceId,
        observation,
        dependencies,
      );
      if (!captured) continue;
      memoryCandidates += 1;
      memory.push(captured);
    } catch {
      memoryCandidates += 1;
      memory.push({
        status: 'failed',
        reason: 'memory_unavailable',
        episodeId: null,
        wake: false,
      });
    }
  }
  return {
    examined: observations.length,
    memory,
    memoryCandidates,
    memoryRecorded: memory.filter((entry) => entry.status === 'recorded').length,
    memoryDeduped: memory.filter((entry) => entry.status === 'deduped').length,
    memoryFailed: memory.filter((entry) => entry.status === 'failed').length,
  };
}
