/**
 * Bounded, model-facing queries over retained Workspace observations.
 *
 * The observation store keeps exact datasets. This module deliberately does
 * not: history returns metadata only, while diff loads at most two
 * workspace/source-scoped documents and emits a bounded structural delta.
 */
import {
  getCurrentWorkspaceDatasetObservation,
  getWorkspaceDatasetObservation,
  getWorkspaceObservationDocument,
  listWorkspaceDatasetObservations,
  scrubWorkspaceObservationError,
  type ListWorkspaceDatasetObservationsOptions,
  type WorkspaceDatasetObservation,
  type WorkspaceDatasetObservationStatus,
} from './workspace-db.js';
import {
  diffWorkspaceObservationDocuments,
  type WorkspaceObservationChange,
  type WorkspaceObservationDiff,
} from './observation-diff.js';
import { redactSensitiveText } from '../runtime/security.js';

type WorkspaceDb = ListWorkspaceDatasetObservationsOptions['db'];

const DEFAULT_HISTORY_LIMIT = 12;
const MAX_HISTORY_LIMIT = 25;
const AVAILABILITY_SCAN_LIMIT = 500;
const DEFAULT_DIFF_CHANGES = 15;
const MAX_DIFF_CHANGES = 25;
const MAX_DIFF_PATH_CHARS = 240;
const MAX_DIFF_ENTITY_CHARS = 120;
const MAX_PROVENANCE_VALUE_CHARS = 80;

const PROVENANCE_LABELS: Readonly<Record<string, string>> = {
  provider: 'provider',
  adapter: 'adapter',
  toolSlug: 'tool',
  runner: 'runner',
  schedule: 'schedule',
  accountRef: 'account',
  connectionId: 'connection',
  requestId: 'request',
  runId: 'run',
  trigger: 'trigger',
  initiatedBy: 'initiated_by',
  attempt: 'attempt',
  sourceVersion: 'source_version',
  fetchedAt: 'fetched_at',
};

export interface WorkspaceObservationHistoryItem {
  id: string;
  source: string;
  status: WorkspaceDatasetObservationStatus;
  changed: boolean | null;
  cause: string;
  timestamp: string;
  current: boolean;
  provenance: string[];
}

export interface WorkspaceObservationHistoryResult {
  status: 'ok';
  workspace: string;
  source: string | null;
  filterStatus: WorkspaceDatasetObservationStatus | null;
  returned: number;
  limit: number;
  observations: WorkspaceObservationHistoryItem[];
}

export interface WorkspaceHistoryAvailability {
  observations: number;
  observationsAreLowerBound: boolean;
  successfulObservations: number;
  sourcesObserved: number;
  comparableSources: string[];
}

export type WorkspaceObservationDiffResult =
  | {
    status: 'changed' | 'unchanged';
    workspace: string;
    source: string;
    from: WorkspaceObservationHistoryItem;
    to: WorkspaceObservationHistoryItem;
    summary: string;
    counts: WorkspaceObservationDiff['counts'];
    changes: WorkspaceObservationChange[];
    truncated: boolean;
  }
  | {
    status: 'insufficient_history';
    workspace: string;
    source: string;
    successfulObservations: number;
    reason: 'no_successful_observations' | 'only_one_successful_observation' | 'no_prior_successful_observation';
  }
  | {
    status: 'observation_not_found';
    workspace: string;
    source: string;
    reason: 'requested observation is not a retained successful observation for this workspace and source';
  }
  | {
    status: 'observation_unavailable';
    workspace: string;
    source: string;
    reason: 'a retained observation document is unavailable';
  };

function boundedInt(value: number | null | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}

function boundedText(value: unknown, maxChars: number): string | null {
  let rendered: string;
  if (typeof value === 'string') rendered = value;
  else if (typeof value === 'number' || typeof value === 'boolean') rendered = String(value);
  else return null;
  const trimmed = redactModelFacingText(rendered).trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
}

function redactModelFacingText(value: string): string {
  return scrubWorkspaceObservationError(redactSensitiveText(value))
    .replace(
      /-----BEGIN [^-]{0,48}PRIVATE KEY-----[\s\S]*/gi,
      '[REDACTED PRIVATE KEY]',
    );
}

function redactAndCap(value: string, maxChars: number): string {
  const redacted = redactModelFacingText(value);
  return redacted.length > maxChars
    ? `${redacted.slice(0, maxChars - 1)}…`
    : redacted;
}

function summarizeProvenance(provenance: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, label] of Object.entries(PROVENANCE_LABELS)) {
    const rendered = boundedText(provenance[key], MAX_PROVENANCE_VALUE_CHARS);
    if (rendered) out.push(`${label}=${rendered}`);
    if (out.length >= 4) break;
  }
  return out;
}

function historyItem(observation: WorkspaceDatasetObservation): WorkspaceObservationHistoryItem {
  return {
    id: boundedText(observation.id, 200) ?? observation.id,
    source: boundedText(observation.sourceKey, 160) ?? observation.sourceKey,
    status: observation.status,
    // A first successful observation is a baseline, not evidence of a delta.
    changed: observation.previousObservationId ? observation.changed : null,
    cause: boundedText(observation.cause, 120) ?? 'unknown',
    timestamp: boundedText(observation.observedAt, 80) ?? observation.observedAt,
    current: observation.isCurrent,
    provenance: summarizeProvenance(observation.provenance),
  };
}

function boundedChange(change: WorkspaceObservationChange): WorkspaceObservationChange {
  const path = redactAndCap(change.path, MAX_DIFF_PATH_CHARS);
  const entityKey = change.entityKey
    ? redactAndCap(change.entityKey, MAX_DIFF_ENTITY_CHARS)
    : undefined;
  return {
    ...change,
    path,
    ...(entityKey ? { entityKey } : { entityKey: undefined }),
    ...(change.before !== undefined ? { before: redactAndCap(change.before, 160) } : {}),
    ...(change.after !== undefined ? { after: redactAndCap(change.after, 160) } : {}),
  };
}

export function listWorkspaceObservationHistory(
  workspaceId: string,
  options: {
    db?: WorkspaceDb;
    sourceKey?: string;
    status?: WorkspaceDatasetObservationStatus;
    limit?: number | null;
  } = {},
): WorkspaceObservationHistoryResult {
  const limit = boundedInt(options.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
  const modelFacingWorkspace = boundedText(workspaceId, 128) ?? '[redacted workspace]';
  const observations = listWorkspaceDatasetObservations(workspaceId, {
    db: options.db,
    ...(options.sourceKey ? { sourceKey: options.sourceKey } : {}),
    ...(options.status ? { status: options.status } : {}),
    limit,
  });
  return {
    status: 'ok',
    workspace: modelFacingWorkspace,
    source: options.sourceKey
      ? boundedText(options.sourceKey, 160) ?? '[redacted source]'
      : null,
    filterStatus: options.status ?? null,
    returned: observations.length,
    limit,
    observations: observations.map(historyItem),
  };
}

export function getWorkspaceHistoryAvailability(
  workspaceId: string,
  db?: WorkspaceDb,
): WorkspaceHistoryAvailability {
  const observations = listWorkspaceDatasetObservations(workspaceId, {
    db,
    limit: AVAILABILITY_SCAN_LIMIT,
  });
  const successesBySource = new Map<string, number>();
  for (const observation of observations) {
    if (observation.status !== 'ok') continue;
    successesBySource.set(
      observation.sourceKey,
      (successesBySource.get(observation.sourceKey) ?? 0) + 1,
    );
  }
  const successfulObservations = [...successesBySource.values()]
    .reduce((sum, count) => sum + count, 0);
  return {
    observations: observations.length,
    observationsAreLowerBound: observations.length === AVAILABILITY_SCAN_LIMIT,
    successfulObservations,
    sourcesObserved: new Set(observations.map((observation) => observation.sourceKey)).size,
    comparableSources: [...successesBySource.entries()]
      .filter(([, count]) => count >= 2)
      .map(([source]) => boundedText(source, 160) ?? '[redacted source]')
      .filter((source, index, all) => all.indexOf(source) === index)
      .sort(),
  };
}

export function diffWorkspaceObservations(
  workspaceId: string,
  sourceKey: string,
  options: {
    db?: WorkspaceDb;
    fromObservationId?: string | null;
    toObservationId?: string | null;
    maxChanges?: number | null;
  } = {},
): WorkspaceObservationDiffResult {
  const modelFacingWorkspace = boundedText(workspaceId, 128) ?? '[redacted workspace]';
  const modelFacingSource = boundedText(sourceKey, 160) ?? '[redacted source]';
  const successful = listWorkspaceDatasetObservations(workspaceId, {
    db: options.db,
    sourceKey,
    status: 'ok',
    limit: AVAILABILITY_SCAN_LIMIT,
  });
  const requestedFrom = options.fromObservationId?.trim() || null;
  const requestedTo = options.toObservationId?.trim() || null;
  const comparableObservation = (observationId: string): WorkspaceDatasetObservation | null => {
    const observation = getWorkspaceDatasetObservation(workspaceId, observationId, options.db);
    return observation?.sourceKey === sourceKey && observation.status === 'ok'
      ? observation
      : null;
  };
  const explicitFrom = requestedFrom ? comparableObservation(requestedFrom) : null;
  const explicitTo = requestedTo ? comparableObservation(requestedTo) : null;

  if ((requestedFrom && !explicitFrom) || (requestedTo && !explicitTo)) {
    return {
      status: 'observation_not_found',
      workspace: modelFacingWorkspace,
      source: modelFacingSource,
      reason: 'requested observation is not a retained successful observation for this workspace and source',
    };
  }

  const current = getCurrentWorkspaceDatasetObservation(workspaceId, sourceKey, options.db);
  const to = explicitTo ?? current;
  if (!to) {
    return {
      status: 'insufficient_history',
      workspace: modelFacingWorkspace,
      source: modelFacingSource,
      successfulObservations: successful.length,
      reason: 'no_successful_observations',
    };
  }

  const from = explicitFrom
    ?? (to.previousObservationId
      ? comparableObservation(to.previousObservationId) ?? undefined
      : undefined);
  if (!from) {
    return {
      status: 'insufficient_history',
      workspace: modelFacingWorkspace,
      source: modelFacingSource,
      successfulObservations: successful.length,
      reason: successful.length <= 1
        ? 'only_one_successful_observation'
        : 'no_prior_successful_observation',
    };
  }

  const before = getWorkspaceObservationDocument(workspaceId, from.id, options.db);
  const after = getWorkspaceObservationDocument(workspaceId, to.id, options.db);
  if (before === undefined || after === undefined) {
    return {
      status: 'observation_unavailable',
      workspace: modelFacingWorkspace,
      source: modelFacingSource,
      reason: 'a retained observation document is unavailable',
    };
  }

  const diff = diffWorkspaceObservationDocuments(before, after, {
    maxChanges: boundedInt(options.maxChanges, DEFAULT_DIFF_CHANGES, MAX_DIFF_CHANGES),
    maxDepth: 8,
    maxPreviewChars: 160,
    maxCollectionEntries: 500,
  });
  return {
    status: diff.changed ? 'changed' : 'unchanged',
    workspace: modelFacingWorkspace,
    source: modelFacingSource,
    from: historyItem(from),
    to: historyItem(to),
    summary: redactAndCap(diff.summary, 500),
    counts: diff.counts,
    changes: diff.changes.map(boundedChange),
    truncated: diff.truncated,
  };
}
