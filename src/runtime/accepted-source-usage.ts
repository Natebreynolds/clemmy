/** Indexed, reported usage owned by an exact accepted request. No inference
 * from the latest session/attempt, no daily log scan, and no execution grant.
 * The provider's billing record remains authoritative for actual charges. */
import { openEventLog } from './harness/eventlog.js';
import type { UsageEvent } from './usage-log.js';

export interface AcceptedSourceUsageTotals {
  calls: number; failedCalls: number; uncertifiedCalls: number; unknownCostCalls: number;
  promptTokens: number; cachedReadTokens: number; uncachedWorkTokens: number;
  outputTokens: number; reportedTotalTokens: number; modelMs: number;
}
export interface AcceptedSourceUsage {
  sessionId: string; sourceUserSeq: number;
  /** Earlier NDJSON history was not backfilled or silently treated as zero. */
  meteringStartedAt: string;
  sourcePredatesMetering: boolean;
  totals: AcceptedSourceUsageTotals;
  byRole: Record<string, AcceptedSourceUsageTotals>;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
}

const natural = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const blank = (): AcceptedSourceUsageTotals => ({ calls: 0, failedCalls: 0, uncertifiedCalls: 0,
  unknownCostCalls: 0, promptTokens: 0, cachedReadTokens: 0, uncachedWorkTokens: 0,
  outputTokens: 0, reportedTotalTokens: 0, modelMs: 0 });

/** Return false for rowless jobs or inconsistent source tuples. A parent's
 * sequence number cannot be combined with a child's session id. The usage
 * writer chooses the whole exact tuple before entering this function. */
export function recordAcceptedSourceUsage(
  source: { sessionId: string; sourceUserSeq: number }, event: UsageEvent,
): boolean {
  const canonical = event.canonical;
  if (!source.sessionId || !Number.isSafeInteger(source.sourceUserSeq) || source.sourceUserSeq <= 0 || !canonical
    || ![canonical.promptTokens, canonical.cachedReadTokens, canonical.uncachedWorkTokens,
      event.outputTokens, event.totalTokens, event.durationMs ?? 0].every(natural)
    || !Number.isFinite(Date.parse(event.at))) return false;
  const unknown = event.ok === false && [event.inputTokens, event.cachedInputTokens ?? 0,
    event.outputTokens, event.reasoningTokens ?? 0, event.totalTokens].every(value => value === 0);
  const values = [source.sessionId, source.sourceUserSeq, event.role ?? 'unset', 1, event.ok === false ? 1 : 0,
    canonical.certified ? 0 : 1, unknown ? 1 : 0, Math.trunc(canonical.promptTokens), Math.trunc(canonical.cachedReadTokens),
    Math.trunc(canonical.uncachedWorkTokens), Math.trunc(event.outputTokens), Math.trunc(event.totalTokens),
    event.durationMs ?? 0, event.at, event.at];
  const result = openEventLog().prepare(`INSERT INTO accepted_source_usage_v1
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM events WHERE session_id = ? AND seq = ?
      AND type = 'user_input_received' AND role = 'user')
    ON CONFLICT(session_id, source_user_seq, role) DO UPDATE SET
      calls = calls + excluded.calls, failed_calls = failed_calls + excluded.failed_calls,
      uncertified_calls = uncertified_calls + excluded.uncertified_calls,
      unknown_cost_calls = unknown_cost_calls + excluded.unknown_cost_calls,
      prompt_tokens = prompt_tokens + excluded.prompt_tokens, cached_tokens = cached_tokens + excluded.cached_tokens,
      uncached_tokens = uncached_tokens + excluded.uncached_tokens, output_tokens = output_tokens + excluded.output_tokens,
      reported_total_tokens = reported_total_tokens + excluded.reported_total_tokens,
      model_ms = model_ms + excluded.model_ms,
      first_recorded_at = MIN(first_recorded_at, excluded.first_recorded_at),
      last_recorded_at = MAX(last_recorded_at, excluded.last_recorded_at)`)
    .run(...values, source.sessionId, source.sourceUserSeq);
  return result.changes === 1;
}

export function readAcceptedSourceUsage(source: { sessionId: string; sourceUserSeq: number }): AcceptedSourceUsage | null {
  if (!source.sessionId || !Number.isSafeInteger(source.sourceUserSeq) || source.sourceUserSeq <= 0) return null;
  const db = openEventLog();
  const accepted = db.prepare(`SELECT created_at FROM events WHERE session_id = ? AND seq = ?
    AND type = 'user_input_received' AND role = 'user'`).get(source.sessionId, source.sourceUserSeq) as { created_at: string } | undefined;
  const meter = db.prepare('SELECT applied_at FROM schema_version WHERE version = 84').get() as { applied_at: string } | undefined;
  if (!accepted || !meter) return null;
  const rows = db.prepare(`SELECT role, calls, failed_calls AS failedCalls, uncertified_calls AS uncertifiedCalls,
    unknown_cost_calls AS unknownCostCalls, prompt_tokens AS promptTokens, cached_tokens AS cachedReadTokens,
    uncached_tokens AS uncachedWorkTokens, output_tokens AS outputTokens, reported_total_tokens AS reportedTotalTokens,
    model_ms AS modelMs, first_recorded_at, last_recorded_at FROM accepted_source_usage_v1
    WHERE session_id = ? AND source_user_seq = ? ORDER BY role`).all(source.sessionId, source.sourceUserSeq) as Array<AcceptedSourceUsageTotals & {
      role: string; first_recorded_at: string; last_recorded_at: string;
    }>;
  const totals = blank();
  const byRole: Record<string, AcceptedSourceUsageTotals> = {};
  for (const row of rows) {
    const own = blank();
    for (const key of Object.keys(totals) as Array<keyof AcceptedSourceUsageTotals>) {
      own[key] = row[key]; totals[key] += row[key];
    }
    byRole[row.role] = own;
  }
  return { ...source, meteringStartedAt: meter.applied_at, sourcePredatesMetering: accepted.created_at < meter.applied_at,
    totals, byRole, firstRecordedAt: rows.map(row => row.first_recorded_at).sort()[0] ?? null,
    lastRecordedAt: rows.map(row => row.last_recorded_at).sort().at(-1) ?? null };
}
