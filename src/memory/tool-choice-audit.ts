/**
 * tool-choice-audit — periodic self-heal of the procedural (tool-choice) memory
 * (Wave 2 "ever-learning robustness").
 *
 * The write-time cross-service guard in composio-tools (maybeAutoRemember…)
 * prevents NEW pollution: a query about toolkit X can no longer bind to a slug
 * from toolkit Y (the 2026-06-22 "DataForSEO intent → AIRTABLE_LIST_RECORDS"
 * mis-bind that made workers "hard-error"). But it can't fix bindings that were
 * ALREADY poisoned before the guard shipped, or any that slipped through its
 * fail-open path. Without a sweep those rot silently and workers keep honoring
 * them. This module is that sweep: a maintenance tick re-applies the SAME guard
 * across the whole store and INVALIDATES (recoverable — moved to fallbacks,
 * re-learnable) any active choice that is provably mis-bound.
 *
 * Two pollution signals (mirror scripts/clean-polluted-toolchoices.ts, now the
 * single source of truth):
 *   • cross-service mismatch — intent names toolkit X, choice is a toolkit-Y slug.
 *   • async-task-post for a LIVE intent — a *_TASK_POST slug (returns a task id,
 *     not data) bound to a "live"-data intent; a worker reads its task-id reply
 *     as a failure.
 *
 * Safety: NEVER audits without a known-toolkit baseline (an empty/failed toolkit
 * list → no-op, so a transient Composio outage can't quarantine the whole store).
 * Fail-open throughout. Kill-switch CLEMMY_TOOLCHOICE_AUDIT (default on).
 * DELETE-WHEN-VALIDATED: fold in unconditionally once a few daemon cycles show it
 * heals real pollution with zero false quarantines of legitimate bindings.
 */
import { getRuntimeEnv } from '../config.js';
import { isCrossServiceToolkitMismatch } from '../tools/composio-tools.js';
import { listToolChoices, invalidateToolChoice, type ToolChoiceRecord } from './tool-choice-store.js';

export function isToolChoiceAuditEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_TOOLCHOICE_AUDIT', 'on') ?? 'on').toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

export type PollutionReason = 'cross_service_mismatch' | 'async_taskpost_for_live_intent';
export interface PollutionHit {
  intent: string;
  identifier: string;
  reason: PollutionReason;
}

/**
 * Pure: classify whether a record's ACTIVE choice is provably mis-bound, given
 * the runtime-discovered known toolkits. Returns null for clean / non-composio /
 * already-invalidated records. Never flags on an empty toolkit list (the caller
 * guards, but be defensive).
 */
export function detectToolChoicePollution(record: ToolChoiceRecord, knownToolkits: string[]): PollutionHit | null {
  const choice = record.choice;
  if (!choice || choice.kind !== 'composio') return null;
  const id = choice.identifier;
  if (knownToolkits.length > 0 && isCrossServiceToolkitMismatch(record.intent, id, knownToolkits)) {
    return { intent: record.intent, identifier: id, reason: 'cross_service_mismatch' };
  }
  if (/_TASK_POST$/i.test(id) && /\blive\b/i.test(record.intent)) {
    return { intent: record.intent, identifier: id, reason: 'async_taskpost_for_live_intent' };
  }
  return null;
}

/**
 * Scan the tool-choice store and invalidate every polluted active choice.
 * Returns the hits (whether or not dryRun). Resolves the known toolkits at
 * runtime (never hardcoded); if none are available, returns [] without touching
 * anything — auditing against an empty baseline would false-quarantine.
 */
export async function auditAndHealToolChoices(
  opts: { knownToolkits?: string[]; dryRun?: boolean } = {},
): Promise<PollutionHit[]> {
  if (!isToolChoiceAuditEnabled()) return [];
  let known = opts.knownToolkits;
  if (!known) {
    try {
      const { listConnectedToolkits } = await import('../integrations/composio/client.js');
      known = (await listConnectedToolkits()).map((t) => t.slug).filter((s): s is string => Boolean(s));
    } catch {
      return []; // fail-open: no toolkit list → never audit blind
    }
  }
  if (!known || known.length === 0) return [];
  const hits: PollutionHit[] = [];
  for (const record of listToolChoices()) {
    const hit = detectToolChoicePollution(record, known);
    if (hit) hits.push(hit);
  }
  if (!opts.dryRun) {
    for (const h of hits) {
      try { invalidateToolChoice(h.intent, `audit:${h.reason}`, { automatic: true }); }
      catch { /* best-effort: one bad record must not abort the sweep */ }
    }
  }
  return hits;
}
