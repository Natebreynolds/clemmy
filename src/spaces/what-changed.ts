/**
 * What changed in a Space, from the history it already keeps.
 *
 * For each collection with current data, the current content is compared with
 * the most recent earlier content that was different, so "what changed" means
 * the last real change, not the last refresh. Rows are counted by the stable
 * identity the structural diff proves (`/@id=value` paths): a row's own add or
 * remove is a new or gone row, any edit inside it makes it a changed row, and
 * everything else is an other change. The page never has to build this; the
 * app shows it for every Space.
 */
import { diffWorkspaceObservationDocuments, type WorkspaceObservationDiff } from './observation-diff.js';
import {
  getWorkspaceDatasetObservation,
  getWorkspaceObservationDocument,
  listWorkspaceDatasetObservations,
  type WorkspaceDatasetObservation,
} from './workspace-db.js';

/** How far back the history chain is walked looking for different content. */
const MAX_CHAIN_STEPS = 60;
/** Bound on recorded changes per comparison; above it, counts are a floor. */
const MAX_CHANGES = 2_000;
const CACHE_ENTRIES = 64;

export interface RowCounts {
  added: number;
  changed: number;
  removed: number;
  other: number;
  /** The comparison stopped at its bound: counts are at least these. */
  more: boolean;
}

export interface CollectionChange extends RowCounts {
  collection: string;
  /** The latest refresh of this collection. */
  checkedAt: string;
  /** first: no earlier different content exists; changed: compared below;
   *  unavailable: the earlier data is no longer retained. */
  state: 'first' | 'changed' | 'unavailable';
  /** When the current content first arrived. */
  changedAt?: string;
  /** When the content it is compared with arrived. */
  comparedWith?: string;
}

export function rowCounts(diff: Pick<WorkspaceObservationDiff, 'changes' | 'truncated'>): RowCounts {
  let other = 0;
  const addedRows = new Set<string>();
  const removedRows = new Set<string>();
  const editedRows = new Set<string>();
  for (const change of diff.changes) {
    const segments = change.path.split('/');
    const rowLevel = (segments[segments.length - 1] ?? '').startsWith('@');
    if (!change.entityKey) other += 1;
    else if (rowLevel && change.op === 'add') addedRows.add(change.entityKey);
    else if (rowLevel && change.op === 'remove') removedRows.add(change.entityKey);
    else editedRows.add(change.entityKey);
  }
  let changed = 0;
  for (const key of editedRows) if (!addedRows.has(key) && !removedRows.has(key)) changed += 1;
  return { added: addedRows.size, changed, removed: removedRows.size, other, more: diff.truncated };
}

const cache = new Map<string, CollectionChange>();

function remember(key: string, value: CollectionChange): CollectionChange {
  cache.set(key, value);
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  return value;
}

function successful(observation: WorkspaceDatasetObservation | null | undefined): observation is WorkspaceDatasetObservation {
  return Boolean(observation && observation.status === 'ok' && observation.datasetId);
}

/** One collection: walk back from its current data to the last different content. */
function collectionChange(slug: string, current: WorkspaceDatasetObservation): CollectionChange {
  const key = `${slug}\u0000${current.id}`;
  const known = cache.get(key);
  if (known) return known;
  let arrived = current;
  let earlier: WorkspaceDatasetObservation | undefined;
  let cursor: WorkspaceDatasetObservation | undefined = current;
  for (let step = 0; step < MAX_CHAIN_STEPS && cursor?.previousObservationId; step += 1) {
    const previous: WorkspaceDatasetObservation | undefined = getWorkspaceDatasetObservation(slug, cursor.previousObservationId) ?? undefined;
    if (!previous) break;
    cursor = previous;
    if (!successful(previous)) continue;
    if (previous.contentHash && previous.contentHash === current.contentHash) { arrived = previous; continue; }
    earlier = previous;
    break;
  }
  const base = { collection: current.sourceKey, checkedAt: current.observedAt, added: 0, changed: 0, removed: 0, other: 0, more: false };
  if (!earlier) return remember(key, { ...base, state: 'first' });
  const before = getWorkspaceObservationDocument(slug, earlier.id);
  const after = getWorkspaceObservationDocument(slug, current.id);
  if (before === undefined || after === undefined) {
    return remember(key, { ...base, state: 'unavailable', changedAt: arrived.observedAt, comparedWith: earlier.observedAt });
  }
  const diff = diffWorkspaceObservationDocuments(before, after, { maxChanges: MAX_CHANGES, maxPreviewChars: 1 });
  return remember(key, {
    ...base,
    ...rowCounts(diff),
    state: 'changed',
    changedAt: arrived.observedAt,
    comparedWith: earlier.observedAt,
  });
}

/** What changed in each collection of a Space that has current data. */
export function whatChangedInSpace(slug: string): CollectionChange[] {
  const current = listWorkspaceDatasetObservations(slug, { limit: 500 })
    .filter((observation) => observation.isCurrent && successful(observation));
  return current
    .map((observation) => collectionChange(slug, observation))
    .sort((a, b) => (b.changedAt ?? '').localeCompare(a.changedAt ?? '') || a.collection.localeCompare(b.collection));
}
