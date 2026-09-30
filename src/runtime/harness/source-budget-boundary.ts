/** A pre-dispatch check of the original request's observed spend. This is not
 * a reservation system: provider calls still in flight, unrecorded calls and
 * time lost between checkpoints are not made complete by this check. */
import { readAcceptedSourceUsage } from '../accepted-source-usage.js';
import { openEventLog } from './eventlog.js';
import type { SourceBudgetPolicy } from './source-budget-policy.js';

type Source = { sessionId: string; sourceUserSeq: number };
export interface ReportedTaskUsage {
  uncachedWorkTokens: number;
  calls: number;
  participants: Source[];
  unknown: Array<{ source: Source; reason: 'meter_unavailable' | 'predates_meter' | 'unknown_call_cost' | 'invalid_worker_link' }>;
}
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const key = (source: Source) => JSON.stringify([source.sessionId, source.sourceUserSeq]);

/** Follow exact host worker provenance, not session lifetime usage. Each
 * session/type lookup uses the existing event index; no daily log scans.
 * Child sources must independently name the same parent accepted event.
 * Background task delegation has a different lifecycle and is not included. */
export function readReportedTaskUsage(source: Source): ReportedTaskUsage {
  const db = openEventLog();
  const result: ReportedTaskUsage = { uncachedWorkTokens: 0, calls: 0, participants: [], unknown: [] };
  const queue = [source];
  const seen = new Set([key(source)]);
  const findSource = db.prepare(`SELECT id, parent_event_id, data_json FROM events WHERE session_id = ? AND seq = ?
    AND type = 'user_input_received' AND role = 'user'`);
  const findWorkers = db.prepare(`SELECT data_json FROM events WHERE session_id = ? AND type = 'worker_started'
    AND (json_extract(data_json, '$.parentSourceUserSeq') = ? OR json_extract(data_json, '$.sourceUserSeq') = ?)`);
  for (const owner of queue) {
    result.participants.push(owner);
    const usage = readAcceptedSourceUsage(owner);
    if (!usage) result.unknown.push({ source: owner, reason: 'meter_unavailable' });
    else {
      result.uncachedWorkTokens += usage.totals.uncachedWorkTokens;
      result.calls += usage.totals.calls;
      if (usage.sourcePredatesMetering) result.unknown.push({ source: owner, reason: 'predates_meter' });
      if (usage.totals.unknownCostCalls) result.unknown.push({ source: owner, reason: 'unknown_call_cost' });
    }
    const parent = findSource.get(owner.sessionId, owner.sourceUserSeq) as { id: string } | undefined;
    for (const row of findWorkers.all(owner.sessionId, owner.sourceUserSeq, owner.sourceUserSeq) as Array<{ data_json: string }>) {
      const data = JSON.parse(row.data_json) as Record<string, unknown>;
      const child = { sessionId: typeof data.childSessionId === 'string' ? data.childSessionId : '',
        sourceUserSeq: data.childSourceUserSeq as number };
      const accepted = child.sessionId && positive(child.sourceUserSeq)
        ? findSource.get(child.sessionId, child.sourceUserSeq) as { parent_event_id: string | null; data_json: string } | undefined
        : undefined;
      const lineage = accepted ? JSON.parse(accepted.data_json).delegatedWorker as Record<string, unknown> | undefined : undefined;
      if (!parent || data.parentSessionId !== owner.sessionId || data.parentSourceUserSeq !== owner.sourceUserSeq
        || (data.sourceUserSeq !== undefined && data.sourceUserSeq !== owner.sourceUserSeq)
        || !accepted || accepted.parent_event_id !== parent.id || !lineage
        || lineage.parentSessionId !== owner.sessionId || lineage.parentSourceUserSeq !== owner.sourceUserSeq) {
        result.unknown.push({ source: owner, reason: 'invalid_worker_link' });
        continue;
      }
      if (seen.has(key(child))) continue;
      seen.add(key(child));
      queue.push(child);
    }
  }
  return result;
}

export class SourceBudgetBoundaryError extends Error {
  constructor(readonly reason: 'wall_clock' | 'token_budget' | 'budget_usage_unavailable',
    readonly evidence: { observed: number; limit: number; unknown?: ReportedTaskUsage['unknown'] }) {
    super(reason === 'wall_clock'
      ? 'This task reached its configured active-time limit. Completed work is saved; I stopped before another model request.'
      : reason === 'token_budget'
        ? 'This task reached its configured token limit. Completed work is saved; I stopped before another model request.'
        : 'I could not verify this task’s earlier token spend against its configured limit. Completed work is saved; I stopped before another model request.');
    this.name = 'SourceBudgetBoundaryError';
  }
}

/** Check only before a new request, never between a returned side effect and
 * its receipt. Zero/unlimited and the original enforcement setting stay exact.
 * Known reported spend is a lower bound, not a guarantee against overshoot by
 * a current request or untracked concurrent work. */
export function assertSourceBudgetBeforeModel(policy: SourceBudgetPolicy, observedActiveMs: number): void {
  if (policy.maxActiveMs > 0 && observedActiveMs >= policy.maxActiveMs) {
    throw new SourceBudgetBoundaryError('wall_clock', { observed: observedActiveMs, limit: policy.maxActiveMs });
  }
  if (!policy.tokenEnforcementEnabled || policy.maxUncachedTokens === 0) return;
  let usage: ReportedTaskUsage;
  try { usage = readReportedTaskUsage(policy); }
  catch {
    throw new SourceBudgetBoundaryError('budget_usage_unavailable', { observed: 0, limit: policy.maxUncachedTokens,
      unknown: [{ source: { sessionId: policy.sessionId, sourceUserSeq: policy.sourceUserSeq }, reason: 'meter_unavailable' }] });
  }
  if (usage.uncachedWorkTokens >= policy.maxUncachedTokens) {
    throw new SourceBudgetBoundaryError('token_budget', { observed: usage.uncachedWorkTokens, limit: policy.maxUncachedTokens });
  }
  if (usage.unknown.length) {
    throw new SourceBudgetBoundaryError('budget_usage_unavailable', { observed: usage.uncachedWorkTokens,
      limit: policy.maxUncachedTokens, unknown: usage.unknown });
  }
}
