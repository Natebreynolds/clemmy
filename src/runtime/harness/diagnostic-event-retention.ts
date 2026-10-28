/**
 * Diagnostic rows in the event log age out; the transcript stays.
 *
 * The event log holds two kinds of rows. The transcript — what the owner
 * said, what Clem replied, which tools ran and what came back, what was
 * approved — is the conversation's record and is kept for as long as the
 * conversation is. Diagnostic rows record how a turn went while it ran:
 * transport and retry timing, dispatch bookkeeping, prompt composition, the
 * governor's decisions, discovery outcomes, guardrail notes. A turn reads its
 * own; nothing reads another turn's a month later. Live 10-27 they were half
 * of the log's bytes and grew ~270 MB a month.
 *
 * A diagnostic row another record still points at (a dispatch's start event,
 * a receipt's source) is kept: the delete yields to the foreign key and moves
 * on. Rows go oldest first through the (type, seq) index in bounded batches.
 */
import type Database from 'better-sqlite3';

/** Observational event types: read within their own turn, never as history. */
export const DIAGNOSTIC_EVENT_TYPES = [
  'model_transport_observed',
  'model_resilience_observed',
  'model_stream_diagnostic',
  'provider_dispatch_started',
  'provider_dispatch_settled',
  'prompt_composition',
  'turn_phase_timings',
  'tool_attempt_settled',
  'guardrail_tripped',
  'discovery_governor_decision',
  'discovery_governor_outcome',
  'discovery_source_outcome',
  'capability_discovered',
] as const;

export const DIAGNOSTIC_EVENT_TTL_DAYS = 30;

export interface DiagnosticEventRetentionResult {
  /** Rows removed. */
  removed: number;
  /** Rows old enough but still referenced by another record. */
  pinned: number;
  /** True when every eligible row was handled within the bound. */
  caughtUp: boolean;
}

/** A RESTRICT foreign key refuses through SQLite's own internal trigger, so
 * the refusal arrives as a trigger constraint carrying the foreign-key text. */
function refusedByForeignKey(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : String(error);
  return code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || (code === 'SQLITE_CONSTRAINT_TRIGGER' && message.includes('FOREIGN KEY'));
}

/** Remove diagnostic rows older than the window, at most `maxRows` per call. */
export function reapStaleDiagnosticEvents(db: Database.Database, input: {
  nowMs?: number;
  maxAgeDays?: number;
  maxRows?: number;
} = {}): DiagnosticEventRetentionResult {
  const cutoff = new Date((input.nowMs ?? Date.now()) - (input.maxAgeDays ?? DIAGNOSTIC_EVENT_TTL_DAYS) * 86_400_000).toISOString();
  const bound = Math.max(1, Math.floor(input.maxRows ?? 5_000));
  const result: DiagnosticEventRetentionResult = { removed: 0, pinned: 0, caughtUp: true };
  // Oldest first per type; seq grows with time, so the walk stops at the
  // first row inside the window. Pinned rows are skipped by seq on the next
  // pass, never retried in a loop.
  const page = db.prepare(`
    SELECT seq, created_at AS createdAt FROM events
     WHERE type = ? AND seq > ? ORDER BY seq LIMIT ?
  `);
  const deleteOne = db.prepare('DELETE FROM events WHERE seq = ?');
  const deleteMany = (seqs: number[]) => db.prepare(`DELETE FROM events WHERE seq IN (${seqs.map(() => '?').join(',')})`).run(...seqs).changes;
  let budget = bound;
  for (const type of DIAGNOSTIC_EVENT_TYPES) {
    let after = 0;
    while (budget > 0) {
      const rows = page.all(type, after, Math.min(budget, 500)) as Array<{ seq: number; createdAt: string }>;
      if (rows.length === 0) break;
      const eligible = rows.filter((row) => row.createdAt < cutoff).map((row) => row.seq);
      if (eligible.length === 0) break;
      after = eligible[eligible.length - 1]!;
      budget -= eligible.length;
      try {
        result.removed += db.transaction(() => deleteMany(eligible))();
      } catch (error) {
        if (!refusedByForeignKey(error)) throw error;
        // One of the batch is still referenced: take the rest one by one.
        for (const seq of eligible) {
          try { result.removed += deleteOne.run(seq).changes; } catch (one) {
            if (!refusedByForeignKey(one)) throw one;
            result.pinned += 1;
          }
        }
      }
      if (eligible.length < rows.length) break; // the window starts inside this page
    }
    if (budget <= 0) { result.caughtUp = false; break; }
  }
  return result;
}
