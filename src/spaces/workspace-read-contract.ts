/** Storage-free schema and projection for an exact saved Workspace read. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { workspaceDataContentDigest } from './workspace-set-data-contract.js';
import { locateWorkspaceRecords } from './workspace-data-digest.js';

export const WORKSPACE_GET_TOOL_PARAMETERS = {
  slug: z.string().min(2).max(63).describe('The exact saved Workspace slug.'),
  source_id: z.string().max(120).nullish().describe('Optional exact source key. A workflow call returns its complete saved value; omit for the full document.'),
  metadata_only: z.boolean().nullish().describe('Return saved manifest configuration without dataset values. Cannot combine with source_id. Exact workflow reads return scope:metadata and a separate metadata_revision, without reading the dataset.'),
  limit: z.number().int().min(1).max(60).nullish().describe('Record page size. Native chat defaults to 20 trimmed records; an exact workflow call pages only when limit or offset is supplied.'),
  offset: z.number().int().min(0).nullish().describe('Record-page offset within the selected source.'),
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/).nullish().describe('Optional exact saved data/view snapshot revision from a prior read. A changed Workspace is refused; omit to read its current saved snapshot. Exact workflow metadata_only reads use a separate metadata_revision and do not accept this data revision fence.'),
};

export type WorkspaceGetArguments = z.infer<z.ZodObject<typeof WORKSPACE_GET_TOOL_PARAMETERS>>;

export class WorkspaceReadContractError extends Error {
  constructor(readonly code: 'invalid_arguments' | 'workspace_unavailable' | 'workspace_identity_changed'
    | 'workspace_revision_changed' | 'dataset_unavailable' | 'source_unavailable' | 'records_unavailable', message: string) {
    super(message); this.name = 'WorkspaceReadContractError';
  }
}

export function prepareWorkspaceGet(value: unknown): WorkspaceGetArguments {
  const parsed = z.strictObject(WORKSPACE_GET_TOOL_PARAMETERS).safeParse(value);
  if (parsed.success && parsed.data.metadata_only && parsed.data.expected_revision != null) {
    throw new WorkspaceReadContractError('invalid_arguments', 'metadata_only returns a manifest-only metadata_revision. Omit expected_revision, or request a data/view snapshot to use that revision fence.');
  }
  if (!parsed.success || !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(parsed.data.slug)
    || (parsed.data.metadata_only && parsed.data.source_id?.trim())
    || (parsed.data.source_id != null && (!parsed.data.source_id.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(parsed.data.source_id)))
    || ((parsed.data.limit != null || parsed.data.offset != null) && !parsed.data.source_id?.trim())) {
    throw new WorkspaceReadContractError('invalid_arguments', 'space_get requires one exact Workspace/source read and valid optional revision.');
  }
  return parsed.data;
}

interface SavedWorkspaceSnapshot {
  record: { id: string; title: string; status: string; version: number; contentMode?: string;
    dataSources: unknown[]; actions: unknown[]; contract?: unknown };
  manifest: string;
  data?: string;
  revision?: string;
}

export interface WorkspaceSnapshotReadResult {
  version: 1;
  origin: 'saved_workspace_snapshot';
  scope: 'data' | 'metadata';
  workspace: { id: string; title: string; status: string; version: number; revision?: string; data_sha256?: string; metadata_revision?: string };
  source_id: string | null;
  data: unknown;
  complete: boolean;
  records_page?: { path: string; offset: number; limit: number; total: number; returned: number };
  metadata?: { data_sources: unknown[]; actions: unknown[]; contract: unknown };
}

/** The caller holds the existing Workspace snapshot read owner for the whole
 * storage read. This projection neither refreshes a source nor invents an
 * observation/revision from an empty, missing or malformed target. */
export function projectWorkspaceSnapshotRead(args: WorkspaceGetArguments, snapshot: SavedWorkspaceSnapshot | undefined): WorkspaceSnapshotReadResult {
  if (!snapshot || !['active', 'paused', 'archived'].includes(snapshot.record.status)) {
    throw new WorkspaceReadContractError('workspace_unavailable', 'The exact saved Workspace is unavailable.');
  }
  let manifest: unknown;
  try { manifest = JSON.parse(snapshot.manifest); }
  catch { throw new WorkspaceReadContractError('workspace_unavailable', 'The saved Workspace manifest is not readable JSON.'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || (manifest as { id?: unknown }).id !== args.slug || snapshot.record.id !== args.slug) {
    throw new WorkspaceReadContractError('workspace_identity_changed', 'The saved Workspace identity differs from the requested slug.');
  }
  // An omitted status is the store's retained legacy default. Explicit bad
  // values must never become an invented active claim through normalization.
  const savedStatus = Object.hasOwn(manifest, 'status') ? (manifest as { status?: unknown }).status : 'active';
  if (typeof savedStatus !== 'string' || !['active', 'paused', 'archived'].includes(savedStatus) || savedStatus !== snapshot.record.status) {
    throw new WorkspaceReadContractError('workspace_unavailable', 'The saved Workspace status is unavailable or invalid.');
  }
  if (args.metadata_only) {
    return {
      version: 1, origin: 'saved_workspace_snapshot', scope: 'metadata',
      workspace: { id: args.slug, title: snapshot.record.title, status: savedStatus, version: snapshot.record.version,
        metadata_revision: `workspace-metadata:v1:${createHash('sha256').update(snapshot.manifest, 'utf8').digest('hex')}` },
      source_id: null, data: null, complete: true,
      metadata: { data_sources: snapshot.record.dataSources, actions: snapshot.record.actions, contract: snapshot.record.contract ?? null },
    };
  }
  if (typeof snapshot.revision !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.revision) || (args.expected_revision != null && snapshot.revision !== args.expected_revision)) {
    throw new WorkspaceReadContractError('workspace_revision_changed', 'The saved Workspace changed since the expected revision. Read its current snapshot before continuing.');
  }
  let dataset: unknown;
  try {
    if (typeof snapshot.data !== 'string') throw new Error('missing dataset');
    dataset = JSON.parse(snapshot.data);
  } catch { throw new WorkspaceReadContractError('dataset_unavailable', 'The saved Workspace dataset is not readable JSON.'); }
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    throw new WorkspaceReadContractError('dataset_unavailable', 'The saved Workspace dataset must be a complete object.');
  }
  const sourceId = args.source_id?.trim() ?? null;
  let data: unknown = dataset;
  if (sourceId !== null) {
    if (!Object.hasOwn(dataset, sourceId)) throw new WorkspaceReadContractError('source_unavailable', 'The exact named Workspace source has no saved value.');
    data = (dataset as Record<string, unknown>)[sourceId];
  }
  const result: WorkspaceSnapshotReadResult = {
    version: 1, origin: 'saved_workspace_snapshot', scope: 'data',
    workspace: { id: args.slug, title: snapshot.record.title, status: snapshot.record.status, version: snapshot.record.version,
      revision: snapshot.revision, data_sha256: workspaceDataContentDigest(dataset) },
    source_id: sourceId, data, complete: true,
  };
  if (sourceId !== null && (args.limit != null || args.offset != null)) {
    const located = locateWorkspaceRecords(data);
    if (!located) throw new WorkspaceReadContractError('records_unavailable', 'The selected Workspace source has no record array to page. Omit limit and offset to read its complete value.');
    const offset = Math.min(args.offset ?? 0, located.records.length);
    const limit = args.limit ?? 20;
    const page = located.records.slice(offset, offset + limit);
    result.data = page;
    result.records_page = { path: located.path, offset, limit, total: located.records.length, returned: page.length };
    result.complete = offset === 0 && page.length === located.records.length;
  }
  return result;
}
