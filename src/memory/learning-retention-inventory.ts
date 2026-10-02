/** Bounded, read-only learning census for retention planning. It does NOT
 * certify a source for deletion: task, receipt, replay, provenance and user
 * history consumers must be checked separately against current harness state.
 * In particular, completed intake is not proof of successful extraction. */
import type Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';

export const LEARNING_RETENTION_STATES = [
  'no_extraction_required', 'extraction_completed', 'learning_pending',
  'learning_failed', 'source_unavailable', 'receipt_missing',
  'inconsistent', 'inspection_limit',
] as const;
export type LearningRetentionState = typeof LEARNING_RETENTION_STATES[number];
const DISPOSITIONS = [
  'structured_task_evidence', 'resource_pointer', 'unstructured', 'control',
  'failed', 'write_ack', 'empty', 'unavailable',
] as const;
type Disposition = typeof DISPOSITIONS[number];

export interface LearningRetentionInventory {
  version: 1;
  scope: 'learning_projection_only';
  deletionAuthorized: false;
  state: 'measured' | 'unavailable';
  complete: boolean;
  stopReason: 'batch_limit' | 'time_limit' | 'child_limit' | 'schema_unavailable' | 'read_failed' | null;
  /** Numeric rowid, not a session/result identifier. Resume with this cursor;
   * each page is a new observation, not one atomic snapshot of the whole DB. */
  afterRowid: number | null;
  throughRowid: number | null;
  batchesInspected: number;
  states: Record<LearningRetentionState, number>;
  /** Counts from completely inspected member sets only, never a DB total
   * when complete=false or an individual batch hit its inspection budget. */
  dispositions: Record<Disposition, number>;
  /** Proposals observed while checking completed shards only, not a total of
   * all memory proposals (pending/failed batches and older intake are outside
   * this subset). A rejected/expired proposal never grants source deletion. */
  candidates: Record<'pending' | 'promoted' | 'rejected' | 'expired', number>;
  durationMs: number;
}

interface Batch { rowid: number; batch_id: string; session_id: string;
  member_count: number; shard_count: number; status: string }
interface Member { ordinal: number; disposition: string }
interface Shard { ordinal: number; status: string; reflection_call_id: string }

function validCount(n: number): boolean { return Number.isSafeInteger(n) && n >= 0; }
function limit(n: number | undefined, fallback: number, max: number): number {
  const value = n ?? fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error('invalid learning inventory budget');
  return value;
}
function counts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map(key => [key, 0])) as Record<T, number>;
}

/** No openMemoryDb import: inspecting an old store must never migrate it,
 * create directories, drain learning, load models or issue retention writes.
 * Run off the foreground thread. Deadlines are cooperative between reads;
 * child-row budgets bound a large batch independently of its task size. */
export function inspectLearningRetentionInventory(db: Database.Database, input: {
  afterRowid?: number | null;
  maxBatches?: number;
  maxRowsPerBatch?: number;
  maxDurationMs?: number;
  clock?: () => number;
} = {}): LearningRetentionInventory {
  const maxBatches = limit(input.maxBatches, 64, 1_000);
  const maxRows = limit(input.maxRowsPerBatch, 1_000, 10_000);
  const duration = limit(input.maxDurationMs, 100, 5_000);
  const after = input.afterRowid ?? null;
  if (after !== null && !Number.isSafeInteger(after)) throw new Error('invalid learning inventory cursor');
  const clock = input.clock ?? (() => performance.now());
  const start = clock();
  const result: LearningRetentionInventory = {
    version: 1, scope: 'learning_projection_only', deletionAuthorized: false,
    state: 'measured', complete: false, stopReason: null,
    afterRowid: after, throughRowid: after, batchesInspected: 0,
    states: counts(LEARNING_RETENTION_STATES), dispositions: counts(DISPOSITIONS), durationMs: 0,
    candidates: counts(['pending', 'promoted', 'rejected', 'expired'] as const),
  };
  const timedOut = () => clock() - start >= duration;
  try {
    const required = ['memory_learning_batches', 'memory_learning_members', 'memory_learning_shards',
      'memory_reflection_receipts', 'memory_reflection_candidates'];
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
    if (required.some(name => !table.get(name))) {
      result.state = 'unavailable'; result.stopReason = 'schema_unavailable';
      return result;
    }
    const first = db.prepare(`SELECT rowid, batch_id, session_id, member_count, shard_count, status
      FROM memory_learning_batches ORDER BY rowid ASC LIMIT 1`);
    const next = db.prepare(`SELECT rowid, batch_id, session_id, member_count, shard_count, status
      FROM memory_learning_batches WHERE rowid > ? ORDER BY rowid ASC LIMIT 1`);
    const readNext = () => (result.throughRowid === null ? first.get() : next.get(result.throughRowid)) as Batch | undefined;
    const members = db.prepare(`SELECT ordinal, disposition FROM memory_learning_members
      WHERE batch_id=? ORDER BY ordinal ASC LIMIT ?`);
    const shards = db.prepare(`SELECT ordinal, status, reflection_call_id FROM memory_learning_shards
      WHERE batch_id=? ORDER BY ordinal ASC LIMIT ?`);
    const reflection = db.prepare(`SELECT status FROM memory_reflection_receipts WHERE session_id=? AND call_id=?`);
    const candidates = db.prepare(`SELECT status FROM memory_reflection_candidates
      WHERE session_id=? AND call_id=? LIMIT ?`);

    while (result.batchesInspected < maxBatches && !timedOut()) {
      // One coherent read snapshot per batch, released before the next batch.
      // The observation may become stale immediately afterward; it is never
      // transferable authority for a later cleanup transaction.
      const observed = db.transaction(() => {
        const batch = readNext();
        if (!batch) return null;
        const dispositionCounts = counts(DISPOSITIONS);
        const candidateCounts = counts(['pending', 'promoted', 'rejected', 'expired'] as const);
        const finish = (state: LearningRetentionState, includeMembers = false) => ({
          rowid: batch.rowid, state, dispositions: includeMembers ? dispositionCounts : null,
          candidates: candidateCounts,
        });
        if (!Number.isSafeInteger(batch.rowid) || !validCount(batch.member_count)
          || !validCount(batch.shard_count) || !['pending', 'completed', 'dead_letter'].includes(batch.status)) {
          return finish('inconsistent');
        }
        if (batch.member_count + batch.shard_count > maxRows) return finish('inspection_limit');
        const ms = members.all(batch.batch_id, maxRows + 1) as Member[];
        const ss = shards.all(batch.batch_id, maxRows + 1) as Shard[];
        if (ms.length + ss.length > maxRows) return finish('inspection_limit');
        if (ms.length !== batch.member_count || ss.length !== batch.shard_count
          || ms.some((m, i) => m.ordinal !== i || !DISPOSITIONS.includes(m.disposition as Disposition))
          || ss.some((s, i) => s.ordinal !== i || !['pending', 'processing', 'completed', 'dead_letter'].includes(s.status))) {
          return finish('inconsistent');
        }
        for (const m of ms) dispositionCounts[m.disposition as Disposition] += 1;
        if (dispositionCounts.unavailable > 0) return finish('source_unavailable', true);
        const hasOpen = ss.some(s => s.status === 'pending' || s.status === 'processing');
        const hasDead = ss.some(s => s.status === 'dead_letter');
        if ((batch.status === 'completed' && (hasOpen || hasDead))
          || (batch.status === 'dead_letter' && !hasDead)
          || (batch.status === 'pending' && !hasOpen && !hasDead)
          || (ss.length === 0 && dispositionCounts.unstructured > 0)
          || (ss.length > 0 && dispositionCounts.unstructured === 0)) return finish('inconsistent', true);
        if (hasDead || batch.status === 'dead_letter') return finish('learning_failed', true);
        if (hasOpen || batch.status === 'pending') return finish('learning_pending', true);
        if (ss.length === 0) return finish('no_extraction_required', true);
        let used = ms.length + ss.length;
        let missing = false;
        let pending = false;
        let failed = false;
        for (const s of ss) {
          if (timedOut() || used >= maxRows) return finish('inspection_limit', true);
          const receipt = reflection.get(batch.session_id, s.reflection_call_id) as { status: string } | undefined;
          used += 1;
          if (!receipt) { missing = true; continue; }
          if (!['completed', 'buffered', 'processing', 'failed'].includes(receipt.status)) return finish('inconsistent', true);
          if (receipt.status === 'failed') failed = true;
          if (receipt.status === 'processing' || receipt.status === 'buffered') pending = true;
          // Extraction can finish while proposed facts still await promotion.
          // A completed extractor receipt must not hide those candidates.
          const cs = candidates.all(batch.session_id, s.reflection_call_id, maxRows - used + 1) as { status: string }[];
          if (cs.length > maxRows - used) return finish('inspection_limit', true);
          used += cs.length;
          if (cs.some(c => !['pending', 'promoted', 'rejected', 'expired'].includes(c.status))) return finish('inconsistent', true);
          for (const c of cs) candidateCounts[c.status as keyof typeof candidateCounts] += 1;
          if (cs.some(c => c.status === 'pending')) pending = true;
        }
        if (failed) return finish('learning_failed', true);
        if (missing) return finish('receipt_missing', true);
        if (pending) return finish('learning_pending', true);
        return finish('extraction_completed', true);
      }).deferred();
      if (!observed) { result.complete = true; break; }
      if (!Number.isSafeInteger(observed.rowid) || (result.throughRowid !== null && observed.rowid <= result.throughRowid)) {
        throw new Error('invalid learning inventory row order');
      }
      result.throughRowid = observed.rowid;
      result.batchesInspected += 1;
      result.states[observed.state] += 1;
      if (observed.dispositions) for (const disposition of DISPOSITIONS) result.dispositions[disposition] += observed.dispositions[disposition];
      for (const key of ['pending', 'promoted', 'rejected', 'expired'] as const) result.candidates[key] += observed.candidates[key];
    }
    if (!result.complete) {
      if (timedOut()) result.stopReason = 'time_limit';
      else if (!readNext()) result.complete = true;
      else result.stopReason = 'batch_limit';
    }
    if (result.complete && result.states.inspection_limit > 0) {
      result.complete = false; result.stopReason = 'child_limit';
    }
  } catch {
    // Prior observed counts remain lower bounds; a read failure is not an
    // empty backlog. Never expose private SQL data or error text in output.
    result.state = 'unavailable'; result.complete = false; result.stopReason = 'read_failed';
  } finally { result.durationMs = Math.max(0, Math.round(clock() - start)); }
  return result;
}
