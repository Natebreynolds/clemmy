import { createHash } from 'node:crypto';

export interface SharedWorkerResult {
  id: string;
  parentSessionId: string;
  digest: string;
}

export interface RetainedResultContent {
  output: string;
  truncatedAtWrite: boolean;
}

function digest(row: RetainedResultContent): string {
  return createHash('sha256').update(row.output).digest('hex');
}

/** The caller supplies its authenticated parent session, never a model-chosen
 * session. Store references and fingerprints, not another copy of the payload. */
export function prepareWorkerResultShares(
  parentSessionId: string,
  ids: readonly string[],
  read: (id: string) => RetainedResultContent | null,
): SharedWorkerResult[] {
  if (ids.length > 32) throw new Error('Too many retained results in worker packet.');
  return [...new Set(ids)].map(id => {
    const row = read(id);
    if (!row || row.truncatedAtWrite) throw new Error(`Worker retained result ${id} is missing or incomplete in its parent session.`);
    return { id, parentSessionId, digest: digest(row) };
  });
}

export function readSharedWorkerResult<T extends RetainedResultContent>(
  requestedId: string,
  parentSessionId: unknown,
  shares: unknown,
  read: (parentSessionId: string, id: string) => T | null,
): T | null {
  if (typeof parentSessionId !== 'string' || !Array.isArray(shares)) return null;
  const matches = shares.filter(s => s && typeof s === 'object' && s.id === requestedId
    && s.parentSessionId === parentSessionId && typeof s.digest === 'string');
  if (matches.length !== 1) return null;
  const row = read(parentSessionId, requestedId);
  return row && !row.truncatedAtWrite && digest(row) === matches[0].digest ? row : null;
}
