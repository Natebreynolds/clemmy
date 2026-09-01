import {
  prepareWorkspaceSetData,
  workspaceDatasetArtifactId,
  type PreparedWorkspaceSetData,
  type WorkspaceSetDataArguments,
} from './workspace-set-data-contract.js';

export type WorkspaceSetDataWorkspaceStatus = 'active' | 'paused' | 'archived';

export interface WorkspaceSetDataWorkspace {
  workspaceId: string;
  slug: string;
  status: WorkspaceSetDataWorkspaceStatus;
}

export interface WorkspaceSetDataObservation {
  observationId: string;
  workspaceId: string;
  sourceId: string;
  refreshId: string;
  status: 'ok' | 'error' | 'awaiting_approval';
  projectionMode: 'source' | 'document';
  cause: string;
  contentDigest: string;
  argsDigest: string | null;
  data: unknown;
  bytes: number;
  deduped: boolean;
}

export interface WorkspaceSetDataCommitRequest {
  workspace: WorkspaceSetDataWorkspace;
  prepared: PreparedWorkspaceSetData;
  refreshId: string;
  cause: string;
  provenance: Record<string, unknown>;
}

/** Storage implementation supplied only at the host carrier boundary. */
export interface WorkspaceSetDataStoragePort {
  resolveWorkspace(slug: string): WorkspaceSetDataWorkspace | null;
  inspectExact(input: {
    workspace: WorkspaceSetDataWorkspace;
    prepared: PreparedWorkspaceSetData;
    refreshId: string;
  }): WorkspaceSetDataObservation | null;
  commit(input: WorkspaceSetDataCommitRequest): WorkspaceSetDataObservation;
  handleFor(input: {
    workspace: WorkspaceSetDataWorkspace;
    observation: WorkspaceSetDataObservation;
  }): string;
  receiptFor(input: {
    workspace: WorkspaceSetDataWorkspace;
    observation: WorkspaceSetDataObservation;
  }): string;
}

export interface ExecuteWorkspaceSetDataOptions {
  mode: 'content_addressed' | 'manual';
  cause: string;
  provenance: Record<string, unknown>;
  manualRefreshId?: string;
}

export interface WorkspaceSetDataExecutionResult {
  artifactId: string;
  workspaceId: string;
  slug: string;
  sourceId: string;
  observationId: string;
  refreshId: string;
  created: boolean;
  contentDigest: string;
  /** Back-compatible local artifact spelling used by workflow fixtures. */
  revisionDigest: string;
  handle: string;
  receipt: string;
  bytes: number;
  rows: number | null;
}

export class WorkspaceSetDataExecutionError extends Error {
  constructor(
    readonly code:
      | 'workspace_not_found'
      | 'workspace_not_active'
      | 'observation_conflict'
      | 'commit_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceSetDataExecutionError';
  }
}

function rowCount(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.records)) return record.records.length;
    if (Array.isArray(record.items)) return record.items.length;
    if (Array.isArray(record.data)) return record.data.length;
  }
  return null;
}

function observationMatches(
  observation: WorkspaceSetDataObservation,
  workspace: WorkspaceSetDataWorkspace,
  prepared: PreparedWorkspaceSetData,
  refreshId: string,
): boolean {
  return observation.workspaceId === workspace.workspaceId
    && observation.sourceId === prepared.sourceId
    && observation.refreshId === refreshId
    && observation.status === 'ok'
    && observation.projectionMode === 'source'
    && observation.contentDigest === prepared.contentDigest
    && observation.argsDigest === prepared.argsDigest;
}

function resultFromObservation(input: {
  workspace: WorkspaceSetDataWorkspace;
  prepared: PreparedWorkspaceSetData;
  observation: WorkspaceSetDataObservation;
  created: boolean;
  storage: WorkspaceSetDataStoragePort;
}): WorkspaceSetDataExecutionResult {
  const { workspace, prepared, observation, storage } = input;
  return Object.freeze({
    artifactId: workspaceDatasetArtifactId(prepared),
    workspaceId: workspace.workspaceId,
    slug: workspace.slug,
    sourceId: prepared.sourceId,
    observationId: observation.observationId,
    refreshId: observation.refreshId,
    created: input.created,
    contentDigest: observation.contentDigest,
    revisionDigest: observation.contentDigest,
    handle: storage.handleFor({ workspace, observation }),
    receipt: storage.receiptFor({ workspace, observation }),
    bytes: observation.bytes,
    rows: rowCount(prepared.data),
  });
}

/**
 * Execute one reviewed mutation using an injected storage port. Validation and
 * deterministic identity are complete before the port is consulted. Exact
 * replay returns the retained observation without calling `commit` at all.
 */
export function executeWorkspaceSetDataWithStorage(
  args: WorkspaceSetDataArguments | Record<string, unknown>,
  storage: WorkspaceSetDataStoragePort,
  options: ExecuteWorkspaceSetDataOptions,
): WorkspaceSetDataExecutionResult {
  const prepared = prepareWorkspaceSetData(args);
  const workspace = storage.resolveWorkspace(prepared.slug);
  if (!workspace) {
    throw new WorkspaceSetDataExecutionError(
      'workspace_not_found',
      `No workspace named "${prepared.slug}".`,
    );
  }
  if (workspace.status !== 'active') {
    throw new WorkspaceSetDataExecutionError(
      'workspace_not_active',
      `Workspace "${prepared.slug}" is ${workspace.status}; data writes are disabled until it is active.`,
    );
  }
  const refreshId = options.mode === 'content_addressed'
    ? prepared.refreshId
    : options.manualRefreshId?.trim() ?? '';
  if (!refreshId) {
    throw new WorkspaceSetDataExecutionError(
      'commit_mismatch',
      'manual Workspace data commit requires a fresh refresh identity',
    );
  }

  if (options.mode === 'content_addressed') {
    const retained = storage.inspectExact({ workspace, prepared, refreshId });
    if (retained) {
      if (!observationMatches(retained, workspace, prepared, refreshId)) {
        throw new WorkspaceSetDataExecutionError(
          'observation_conflict',
          'the deterministic Workspace observation identity is already bound to different content',
        );
      }
      return resultFromObservation({
        workspace,
        prepared,
        observation: retained,
        created: false,
        storage,
      });
    }
  }

  const committed = storage.commit({
    workspace,
    prepared,
    refreshId,
    cause: options.cause,
    provenance: { ...options.provenance, argsHash: prepared.argsDigest },
  });
  if (!observationMatches(committed, workspace, prepared, refreshId)) {
    throw new WorkspaceSetDataExecutionError(
      'commit_mismatch',
      'Workspace observation commit did not return the exact requested artifact',
    );
  }
  return resultFromObservation({
    workspace,
    prepared,
    observation: committed,
    created: !committed.deduped,
    storage,
  });
}
