import { openEventLog } from '../runtime/harness/eventlog.js';
import { readFactRecallTrace } from './recall-trace.js';

export interface StandingPromptContextHealth {
  runs: number;
  telemetryCompleteRuns: number;
  unknownOmissionRuns: number;
  included: number;
  omitted: number;
  lastAt: string | null;
  last: {
    mode: string | null;
    included: number;
    omitted: number | null;
    candidates: number | null;
    enforcementBacked: number;
  } | null;
}

export interface PromptContextHealth {
  windowDays: number;
  runs: number;
  injectedRuns: number;
  telemetryCompleteRuns: number;
  unknownOmissionRuns: number;
  included: number;
  omitted: number;
  candidates: number;
  omissionRate: number | null;
  lastAt: string | null;
  last: {
    included: number;
    omitted: number | null;
    candidates: number | null;
    source: string | null;
    injected: boolean;
  } | null;
  bySource: Record<string, number>;
  standingContext: StandingPromptContextHealth;
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}

/**
 * Read-only prompt exposure telemetry from the canonical harness event log.
 * Older events that predate omission counters remain visible as unknown rather
 * than being rewritten or misleadingly counted as zero omissions.
 */
export function readPromptContextHealth(windowDays = 30, limit = 5_000): PromptContextHealth {
  const days = Math.max(1, Math.min(365, Math.floor(windowDays)));
  const rowLimit = Math.max(1, Math.min(50_000, Math.floor(limit)));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const eventRows = openEventLog().prepare(`
    SELECT data_json, created_at
    FROM events
    WHERE type = 'turn_memory_primer' AND created_at >= ?
    ORDER BY seq DESC
    LIMIT ?
  `).all(since, rowLimit) as Array<{ data_json: string; created_at: string }>;
  const traceRows = readFactRecallTrace(Math.max(3_000, rowLimit));
  const rows = [
    ...eventRows.map((row) => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(row.data_json) as Record<string, unknown>; } catch { /* preserve the run as unknown */ }
      return { data, createdAt: row.created_at };
    }),
    // The direct/legacy assistant does not require a harness session, so its
    // prompt telemetry cannot rely on the event-log session foreign key. The
    // bounded recall trace is its durable, best-effort observability channel.
    ...traceRows
      .filter((entry) => entry.surface === 'turn_memory_primer'
        && entry.mode?.startsWith('legacy_assistant')
        && entry.at >= since)
      .map((entry) => ({
        createdAt: entry.at,
        data: {
          includedCount: entry.includedCount,
          omittedCount: entry.omittedCount,
          candidateCount: entry.candidateCount,
          source: entry.mode,
          injected: (entry.includedCount ?? entry.facts.length) > 0,
        } as Record<string, unknown>,
      })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, rowLimit);

  let injectedRuns = 0;
  let telemetryCompleteRuns = 0;
  let included = 0;
  let knownIncluded = 0;
  let omitted = 0;
  let candidates = 0;
  const bySource: Record<string, number> = {};
  let last: PromptContextHealth['last'] = null;

  for (const row of rows) {
    const data = row.data;
    const includedForRun = finiteCount(data.includedCount) ?? finiteCount(data.hitCount) ?? 0;
    const omittedForRun = finiteCount(data.omittedCount);
    const candidatesForRun = finiteCount(data.candidateCount)
      ?? (omittedForRun === null ? null : includedForRun + omittedForRun);
    const source = typeof data.source === 'string' && data.source.trim() ? data.source : 'unknown';
    const injected = data.injected === true;

    if (injected) injectedRuns += 1;
    included += includedForRun;
    candidates += candidatesForRun ?? 0;
    bySource[source] = (bySource[source] ?? 0) + 1;
    if (omittedForRun !== null) {
      telemetryCompleteRuns += 1;
      knownIncluded += includedForRun;
      omitted += omittedForRun;
    }
    if (!last) {
      last = {
        included: includedForRun,
        omitted: omittedForRun,
        candidates: candidatesForRun,
        source: source === 'unknown' ? null : source,
        injected,
      };
    }
  }

  const knownTotal = knownIncluded + omitted;
  const standingRows = traceRows.filter((entry) =>
    entry.surface === 'facts_for_instructions' && entry.at >= since,
  );
  let standingIncluded = 0;
  let standingOmitted = 0;
  let standingComplete = 0;
  for (const entry of standingRows) {
    standingIncluded += finiteCount(entry.includedCount) ?? entry.facts.length;
    const omittedForRun = finiteCount(entry.omittedCount);
    if (omittedForRun !== null) {
      standingComplete += 1;
      standingOmitted += omittedForRun;
    }
  }
  const latestStanding = standingRows[0];
  const latestStandingOmitted = latestStanding ? finiteCount(latestStanding.omittedCount) : null;
  const standingContext: StandingPromptContextHealth = {
    runs: standingRows.length,
    telemetryCompleteRuns: standingComplete,
    unknownOmissionRuns: standingRows.length - standingComplete,
    included: standingIncluded,
    omitted: standingOmitted,
    lastAt: latestStanding?.at ?? null,
    last: latestStanding ? {
      mode: latestStanding.mode ?? null,
      included: finiteCount(latestStanding.includedCount) ?? latestStanding.facts.length,
      omitted: latestStandingOmitted,
      candidates: finiteCount(latestStanding.candidateCount),
      enforcementBacked: finiteCount(latestStanding.enforcementBackedCount) ?? 0,
    } : null,
  };
  return {
    windowDays: days,
    runs: rows.length,
    injectedRuns,
    telemetryCompleteRuns,
    unknownOmissionRuns: rows.length - telemetryCompleteRuns,
    included,
    omitted,
    candidates,
    omissionRate: knownTotal > 0 ? omitted / knownTotal : null,
    lastAt: rows[0]?.createdAt ?? null,
    last,
    bySource,
    standingContext,
  };
}
