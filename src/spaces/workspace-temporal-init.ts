/**
 * Upgrade/restart initialization for Workspace temporal storage.
 *
 * File-backed manifests remain authoritative. We rebuild their query rows,
 * import a pre-3.0 data.json as a non-mutating baseline, and heal data.json
 * only when a post-baseline observation exists (the DB-commit/file-crash seam).
 */
import { spaceStore, type SpaceRecord } from './store.js';
import {
  bootstrapWorkspaceObservationHistory,
  healWorkspaceDataProjection,
  indexWorkspaceRecord,
  openWorkspaceDb,
  pruneWorkspaceDatasetHistory,
  type BootstrapWorkspaceObservationHistoryResult,
  type PruneWorkspaceDatasetHistoryResult,
} from './workspace-db.js';
import {
  pruneWorkspaceObservationProjectionReceipts,
  recoverWorkspaceObservationMemory,
  WORKSPACE_HISTORY_RETENTION,
  type WorkspaceObservationMemoryRecoveryResult,
} from './workspace-observation-finalize.js';

export interface WorkspaceTemporalInitDependencies {
  listWorkspaces(): SpaceRecord[];
  index(record: SpaceRecord): void;
  bootstrap(workspaceId: string): BootstrapWorkspaceObservationHistoryResult;
  hasNonLegacyObservation(workspaceId: string): boolean;
  heal(workspaceId: string): void;
  recoverMemory(workspaceId: string): Promise<WorkspaceObservationMemoryRecoveryResult>;
  prune(workspaceId: string): PruneWorkspaceDatasetHistoryResult;
  pruneProjectionReceipts?(workspaceId: string): number;
}

export interface WorkspaceTemporalInitResult {
  examined: number;
  baselinesImported: number;
  projectionsHealed: number;
  memoryCandidates: number;
  memoryRecorded: number;
  memoryDeduped: number;
  memoryFailures: number;
  observationsPruned: number;
  datasetsPruned: number;
  projectionReceiptsPruned: number;
  errors: Array<{ workspaceId: string; error: string }>;
}

const defaultDependencies: WorkspaceTemporalInitDependencies = {
  listWorkspaces: () => spaceStore.list(true),
  index: (record) => indexWorkspaceRecord(record, {
    actor: 'workspace-temporal-init',
    emitOperational: false,
    appendStateEvent: false,
  }),
  bootstrap: (workspaceId) => bootstrapWorkspaceObservationHistory(workspaceId),
  hasNonLegacyObservation: (workspaceId) => Boolean(openWorkspaceDb().prepare(`
    SELECT 1
    FROM workspace_dataset_observations
    WHERE workspace_id = ? AND cause <> 'legacy_import'
    LIMIT 1
  `).get(workspaceId)),
  heal: (workspaceId) => {
    healWorkspaceDataProjection(workspaceId);
  },
  recoverMemory: (workspaceId) => recoverWorkspaceObservationMemory(workspaceId),
  prune: (workspaceId) => pruneWorkspaceDatasetHistory(
    workspaceId,
    WORKSPACE_HISTORY_RETENTION,
  ),
  pruneProjectionReceipts: (workspaceId) =>
    pruneWorkspaceObservationProjectionReceipts(workspaceId),
};

export async function initializeWorkspaceTemporalStorage(
  dependencies: WorkspaceTemporalInitDependencies = defaultDependencies,
): Promise<WorkspaceTemporalInitResult> {
  const result: WorkspaceTemporalInitResult = {
    examined: 0,
    baselinesImported: 0,
    projectionsHealed: 0,
    memoryCandidates: 0,
    memoryRecorded: 0,
    memoryDeduped: 0,
    memoryFailures: 0,
    observationsPruned: 0,
    datasetsPruned: 0,
    projectionReceiptsPruned: 0,
    errors: [],
  };

  for (const workspace of dependencies.listWorkspaces()) {
    result.examined += 1;
    try {
      dependencies.index(workspace);
      const baseline = dependencies.bootstrap(workspace.id);
      if (!baseline.ok) throw new Error(baseline.error);
      result.baselinesImported += baseline.imported;

      // Baseline import deliberately does not rewrite a healthy 2.7.5 file.
      // A newer observation means SQLite has become projection-authoritative,
      // so heal the crash seam before schedules or reads begin.
      if (dependencies.hasNonLegacyObservation(workspace.id)) {
        dependencies.heal(workspace.id);
        result.projectionsHealed += 1;
      }
      // Memory is a recoverable projection of the exact retained ledger.
      // Replay before retention so a crash after the durable commit cannot
      // permanently lose the episode. Retention remains bounded even during a
      // prolonged memory outage; current + immediately-prior observations stay
      // protected by the Workspace retention contract for the next boot.
      try {
        const recovered = await dependencies.recoverMemory(workspace.id);
        result.memoryCandidates += recovered.memoryCandidates;
        result.memoryRecorded += recovered.memoryRecorded;
        result.memoryDeduped += recovered.memoryDeduped;
        result.memoryFailures += recovered.memoryFailed;
      } catch (error) {
        result.memoryFailures += 1;
        result.errors.push({
          workspaceId: workspace.id,
          error: `memory recovery failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      const pruned = dependencies.prune(workspace.id);
      result.observationsPruned += pruned.observationsDeleted;
      result.datasetsPruned += pruned.datasetsDeleted;
      result.projectionReceiptsPruned +=
        dependencies.pruneProjectionReceipts?.(workspace.id) ?? 0;
    } catch (error) {
      result.errors.push({
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
