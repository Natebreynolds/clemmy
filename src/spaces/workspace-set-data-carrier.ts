import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withHostLocalWriteCommitFromFile } from '../runtime/harness/host-local-write-commit.js';
import { withWorkspaceSnapshotMutation } from './workspace-snapshot.js';

import { appendAudit } from './data-store.js';
import {
  bootstrapWorkspaceObservationHistory,
  commitWorkspaceObservationBatch,
  getWorkspaceDatasetObservationByRefreshId,
  getCurrentWorkspaceDatasetObservation,
  getWorkspaceObservationDocument,
  indexWorkspaceRecord,
  openWorkspaceDb,
  type CommitWorkspaceObservationBatchResult,
  type WorkspaceDatasetObservation,
} from './workspace-db.js';
import { finalizeWorkspaceObservationCommit } from './workspace-observation-finalize.js';
import { resolveInSpace, spaceStore, type SpaceRecord } from './store.js';
import {
  parseWorkspaceDatasetArtifactId,
  prepareWorkspaceSetData,
  workspaceDataContentDigest,
  type WorkspaceSetDataArguments,
} from './workspace-set-data-contract.js';
import {
  executeWorkspaceSetDataWithStorage,
  type WorkspaceSetDataExecutionResult,
  type WorkspaceSetDataObservation,
  type WorkspaceSetDataStoragePort,
  type WorkspaceSetDataWorkspace,
} from './workspace-set-data-executor.js';

const observationBootstrapChecks = new WeakMap<object, Set<string>>();

export interface HostWorkspaceSetDataExecutionResult extends WorkspaceSetDataExecutionResult {
  /** Whole-file proof captured at this commit edge; source identity/digest
   * above remain unchanged and are never replaced by this file digest. */
  hostFileCommit?: string;
}

function prepareObservationStore(rec: SpaceRecord): ReturnType<typeof openWorkspaceDb> {
  const db = openWorkspaceDb();
  const indexed = db.prepare('SELECT 1 FROM workspaces WHERE id = ? LIMIT 1').get(rec.id);
  if (!indexed) {
    indexWorkspaceRecord(rec, {
      db,
      actor: 'workspace-set-data-carrier',
      emitOperational: false,
      appendStateEvent: false,
      payload: { legacyIndex: true },
    });
    if (!db.prepare('SELECT 1 FROM workspaces WHERE id = ? LIMIT 1').get(rec.id)) {
      throw new Error('workspace index could not be prepared');
    }
  }
  let checked = observationBootstrapChecks.get(db);
  if (!checked) {
    checked = new Set<string>();
    observationBootstrapChecks.set(db, checked);
  }
  if (!checked.has(rec.id)) {
    const bootstrap = bootstrapWorkspaceObservationHistory(rec.id, { db });
    if (!bootstrap.ok) {
      throw new Error(`legacy comparison baseline could not be imported: ${bootstrap.error}`);
    }
    checked.add(rec.id);
  }
  return db;
}

function workspaceForRecord(rec: SpaceRecord): WorkspaceSetDataWorkspace {
  return { workspaceId: rec.id, slug: rec.id, status: rec.status };
}

function mappedObservation(input: {
  row: WorkspaceDatasetObservation & { deduped?: boolean };
  data: unknown;
  bytes: number;
}): WorkspaceSetDataObservation {
  const argsHash = typeof input.row.provenance.argsHash === 'string'
    ? input.row.provenance.argsHash
    : null;
  return {
    observationId: input.row.id,
    workspaceId: input.row.workspaceId,
    sourceId: input.row.sourceKey,
    refreshId: input.row.refreshId,
    status: input.row.status,
    projectionMode: input.row.projectionMode,
    cause: input.row.cause,
    contentDigest: input.row.contentHash ?? '',
    argsDigest: argsHash,
    data: input.data,
    bytes: input.bytes,
    deduped: input.row.deduped === true,
  };
}

function createStoragePort(): {
  storage: WorkspaceSetDataStoragePort;
  committed: () => { workspaceId: string; batch: CommitWorkspaceObservationBatchResult } | null;
} {
  let committed: { workspaceId: string; batch: CommitWorkspaceObservationBatchResult } | null = null;
  const storage: WorkspaceSetDataStoragePort = {
    resolveWorkspace(slug) {
      const rec = spaceStore.get(slug);
      return rec ? workspaceForRecord(rec) : null;
    },
    inspectExact({ workspace, prepared, refreshId }) {
      const rec = spaceStore.get(workspace.slug);
      if (!rec || rec.id !== workspace.workspaceId) return null;
      const db = prepareObservationStore(rec);
      const row = getWorkspaceDatasetObservationByRefreshId(
        workspace.workspaceId,
        prepared.sourceId,
        refreshId,
        db,
      );
      if (!row) return null;
      const data = getWorkspaceObservationDocument(workspace.workspaceId, row.id, db);
      return mappedObservation({
        row,
        data,
        bytes: Buffer.byteLength(prepared.canonicalData, 'utf8'),
      });
    },
    commit({ workspace, prepared, refreshId, cause, provenance }) {
      const rec = spaceStore.get(workspace.slug);
      if (!rec || rec.id !== workspace.workspaceId || rec.status !== 'active') {
        throw new Error('Workspace identity/status changed before the observation commit');
      }
      const db = prepareObservationStore(rec);
      const batch = commitWorkspaceObservationBatch({
        db,
        workspaceId: workspace.workspaceId,
        observations: [{
          sourceKey: prepared.sourceId,
          refreshId,
          cause,
          status: 'ok',
          data: prepared.data,
          provenance,
        }],
      });
      const row = batch.observations[0];
      if (!row) throw new Error('Workspace observation commit returned no observation');
      committed = { workspaceId: workspace.workspaceId, batch };
      return mappedObservation({
        row,
        data: prepared.data,
        bytes: Buffer.byteLength(prepared.canonicalData, 'utf8'),
      });
    },
    handleFor({ workspace, observation }) {
      return `${resolveInSpace(workspace.slug, 'data.json')}#source=${encodeURIComponent(observation.sourceId)}`;
    },
    receiptFor({ observation }) {
      return `workspace-observation:${observation.observationId}`;
    },
  };
  return { storage, committed: () => committed };
}

async function executeWithHostStorage(
  args: WorkspaceSetDataArguments | Record<string, unknown>,
  mode: 'manual' | 'content_addressed',
): Promise<HostWorkspaceSetDataExecutionResult> {
  const carrier = createStoragePort();
  const prepared = prepareWorkspaceSetData(args);
  const result = withWorkspaceSnapshotMutation(prepared.slug, () => {
  const result = executeWorkspaceSetDataWithStorage(args, carrier.storage, mode === 'manual'
    ? {
        mode,
        manualRefreshId: randomUUID(),
        cause: 'manual',
        provenance: { adapter: 'manual', initiatedBy: 'model' },
      }
    : {
        mode,
        cause: 'reviewed_local',
        provenance: { adapter: 'reviewed_local', initiatedBy: 'workflow_v3' },
      });
  const current = getCurrentWorkspaceDatasetObservation(result.workspaceId, result.sourceId);
  const document = JSON.parse(readFileSync(resolveInSpace(result.slug, 'data.json'), 'utf8')) as Record<string, unknown>;
  // Replaying an old content-addressed observation must not mint a fresh file
  // proof for some newer source generation. Its historical artifact remains
  // available to reconciliation, but current delivery coverage is unresolved.
  const sourceStillCurrent = current?.id === result.observationId
    && Object.hasOwn(document, result.sourceId)
    && workspaceDataContentDigest(document[result.sourceId]) === result.contentDigest;
  const n = result.rows;
  return { ...result, ...(sourceStillCurrent ? { hostFileCommit: withHostLocalWriteCommitFromFile({
    createdId: result.slug, committedPath: resolveInSpace(result.slug, 'data.json'),
    result: `Saved ${n == null ? 'data' : `${n} row${n === 1 ? '' : 's'}`} under "${result.sourceId}" (${result.bytes} bytes, marked ${mode === 'manual' ? 'manual' : 'reviewed local'}). Observation ${result.observationId}; source digest ${result.contentDigest}. The open Workspace auto-refreshes.`,
  }) } : {}) };
  });
  const committed = carrier.committed();
  if (result.created && committed) {
    try {
      await finalizeWorkspaceObservationCommit(committed.workspaceId, committed.batch);
    } catch {
      // SQLite + data.json are already durable; memory/retention are best-effort.
    }
    appendAudit(result.slug, {
      method: 'SET_DATA',
      path: `/set_data/${result.sourceId}`,
      outcome: 'ok',
      bytes: result.bytes,
    });
  }
  return result;
}

export function executeManualWorkspaceSetData(
  args: WorkspaceSetDataArguments | Record<string, unknown>,
): Promise<HostWorkspaceSetDataExecutionResult> {
  return executeWithHostStorage(args, 'manual');
}

export function executeReviewedWorkspaceSetData(
  args: WorkspaceSetDataArguments | Record<string, unknown>,
): Promise<HostWorkspaceSetDataExecutionResult> {
  return executeWithHostStorage(args, 'content_addressed');
}

export interface ReconciledWorkspaceDatasetArtifact {
  exists: true;
  artifactId: string;
  handle: string;
  contentDigest: string;
  receipt: string;
  content: unknown;
}

/** Read-only exact probe for a previously returned content-addressed artifact. */
export function reconcileWorkspaceDatasetArtifact(
  artifactId: string,
): ReconciledWorkspaceDatasetArtifact | { exists: false } {
  const identity = parseWorkspaceDatasetArtifactId(artifactId);
  if (!identity) return { exists: false };
  const rec = spaceStore.get(identity.slug);
  if (!rec) return { exists: false };
  const db = openWorkspaceDb();
  const row = getWorkspaceDatasetObservationByRefreshId(
    rec.id,
    identity.sourceId,
    identity.refreshId,
    db,
  );
  if (
    !row
    || row.status !== 'ok'
    || row.projectionMode !== 'source'
    || row.contentHash !== identity.contentDigest
    || row.cause !== 'reviewed_local'
    || row.provenance.adapter !== 'reviewed_local'
    || row.provenance.initiatedBy !== 'workflow_v3'
    || row.provenance.argsHash !== identity.argsDigest
  ) return { exists: false };
  const content = getWorkspaceObservationDocument(rec.id, row.id, db);
  if (content === undefined || workspaceDataContentDigest(content) !== identity.contentDigest) {
    return { exists: false };
  }
  const prepared = prepareWorkspaceSetData({
    slug: identity.slug,
    source_id: identity.sourceId,
    data_json: JSON.stringify(content),
  });
  if (
    prepared.argsDigest !== identity.argsDigest
    || prepared.refreshId !== identity.refreshId
    || prepared.contentDigest !== identity.contentDigest
  ) return { exists: false };
  const observation = mappedObservation({
    row,
    data: content,
    bytes: Buffer.byteLength(prepared.canonicalData, 'utf8'),
  });
  const workspace = workspaceForRecord(rec);
  const carrier = createStoragePort().storage;
  return {
    exists: true,
    artifactId,
    handle: carrier.handleFor({ workspace, observation }),
    contentDigest: identity.contentDigest,
    receipt: carrier.receiptFor({ workspace, observation }),
    content,
  };
}
