/** Optional optimistic concurrency for the focused memory editor. Existing
 * callers without a snapshot retain their established route behavior. */
import { openMemoryDb } from '../memory/db.js';
import { getFact, type ConsolidatedFact } from '../memory/facts.js';

export interface ExpectedMemorySnapshot {
  updatedAt: string;
  content: string;
  active: boolean;
  supersededByFactId: number | null;
  pinned: boolean;
}
export type GuardedMemoryOperation = 'correct' | 'forget' | 'restore' | 'pin';
type Result<T> = { ok: true; value: T } | { ok: false; status: 400 | 409 | 500; error: string };

function snapshot(value: unknown): ExpectedMemorySnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const successor = row.supersededByFactId ?? null;
  if (typeof row.updatedAt !== 'string' || !row.updatedAt
    || typeof row.content !== 'string' || typeof row.active !== 'boolean' || typeof row.pinned !== 'boolean'
    || (successor !== null && (!Number.isSafeInteger(successor) || Number(successor) <= 0))) return null;
  return { updatedAt: row.updatedAt, content: row.content, active: row.active, pinned: row.pinned,
    supersededByFactId: successor as number | null };
}

/** Validate, compare and mutate under the same write lock. A stale caller may
 * inspect its original fact again, but cannot fork or restore an obsolete one. */
export function runGuardedMemoryFactMutation<T>(
  rawId: string,
  expectedMemory: unknown,
  operation: GuardedMemoryOperation,
  mutate: (current: ConsolidatedFact) => T,
): Result<T> {
  const id = /^\d+$/.test(rawId) ? Number(rawId) : NaN;
  const expected = snapshot(expectedMemory);
  if (!Number.isSafeInteger(id) || id <= 0 || !expected) {
    return { ok: false, status: 400, error: 'A valid memory snapshot is required. Reload this saved memory.' };
  }
  try {
    return openMemoryDb().transaction((): Result<T> => {
      const current = getFact(id);
      const successor = current?.supersededByFactId ?? null;
      const matches = current && current.updatedAt === expected.updatedAt && current.content === expected.content
        && current.active === expected.active && Boolean(current.pinned) === expected.pinned
        && successor === expected.supersededByFactId;
      const eligible = current && successor === null && (operation === 'restore' ? !current.active : current.active);
      if (!matches || !eligible) {
        return { ok: false, status: 409, error: 'This saved memory changed. Reload it and review before trying again.' };
      }
      return { ok: true, value: mutate(current) };
    }).immediate();
  } catch {
    return { ok: false, status: 500, error: 'This saved memory is temporarily unavailable.' };
  }
}
