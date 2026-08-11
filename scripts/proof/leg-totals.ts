/**
 * Leg-total token accounting — the cross-version cost basis.
 *
 * Because one isolated CLEMENTINE_HOME contains exactly one scenario-run,
 * summing EVERY record in that home's token-usage ndjson is the attribution
 * problem solved by construction: unknown-source records, blocked-recovery
 * turns that skipped per-turn accounting, and post-terminal sidecar spend are
 * all still THIS leg's spend, and transport mirrors never appear here (they
 * are event rows, not usage rows).
 *
 * Per-turn certified deltas across versions are structurally impossible (the
 * attribution trace does not exist at v3.14.0 and must never be backported),
 * so this module is the honest comparator input. Token CLASSES are split out
 * (uncached input / cache read / cache write / output) because cache state
 * alone moves provider cost 41-80% — a prefix-stability win must never be
 * misattributed as behavioral efficiency.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface UsageRecordSlice {
  at: string;
  source: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LegTokenTotals {
  /** Headline: every token billed inside this leg's home, all classes. */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** The four billing classes. cacheHitRatio = cachedRead / input. */
  cachedReadTokens: number;
  cacheCreationTokens: number;
  uncachedInputTokens: number;
  cacheHitRatio: number;
  /** Split at the terminal timestamp when one is supplied. Quiesce spend is
   * INCLUDED in totalTokens and reported on its own line so the total can
   * never be accused of being trimmed. */
  preTerminalTokens: number;
  quiesceTokens: number;
  /** True when records were still arriving at the observation ceiling — the
   * total is then a floor, and the report must say so. */
  quiesceTruncated: boolean;
  /** source:"unknown" records — included, never excluded (excluding them would
   * bias against the leg with better attribution). */
  unattributedTokens: number;
  unattributedShare: number;
  unattributedRecords: number;
  byModel: Record<string, number>;
  recordCount: number;
  invalidLines: number;
  firstRecordAt: string | null;
  lastRecordAt: string | null;
}

function asFiniteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function parseUsageLine(line: string): UsageRecordSlice | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const at = typeof record.at === 'string' ? record.at : '';
  if (!at) return null;
  const inputTokens = asFiniteNonNegative(record.inputTokens);
  const outputTokens = asFiniteNonNegative(record.outputTokens);
  const totalTokens = asFiniteNonNegative(record.totalTokens) || inputTokens + outputTokens;
  return {
    at,
    source: typeof record.source === 'string' ? record.source : 'unknown',
    model: typeof record.model === 'string' ? record.model : '(unknown)',
    inputTokens,
    cachedInputTokens: asFiniteNonNegative(record.cachedInputTokens),
    cacheCreationInputTokens: asFiniteNonNegative(record.cacheCreationInputTokens),
    outputTokens,
    totalTokens,
  };
}

export function readUsageRecords(usageDir: string): { records: UsageRecordSlice[]; invalidLines: number } {
  let fileNames: string[] = [];
  try {
    fileNames = readdirSync(usageDir).filter((name) => name.endsWith('.ndjson')).sort();
  } catch {
    return { records: [], invalidLines: 0 };
  }
  const records: UsageRecordSlice[] = [];
  let invalidLines = 0;
  for (const name of fileNames) {
    let content = '';
    try {
      content = readFileSync(path.join(usageDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const record = parseUsageLine(line);
      if (record) records.push(record);
      else invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

export function computeLegTotals(input: {
  records: readonly UsageRecordSlice[];
  invalidLines?: number;
  /** ISO bounds — inclusive since, exclusive until. Omit for whole-home legs. */
  sinceIso?: string;
  untilIso?: string;
  /** The leg's terminal timestamp: records after it are quiesce spend. */
  terminalAt?: string;
  /** True when the quiesce observation window hit its ceiling while records
   * were still arriving — totals become floors. */
  quiesceTruncated?: boolean;
}): LegTokenTotals {
  const inWindow = input.records.filter((record) => {
    if (input.sinceIso && record.at < input.sinceIso) return false;
    if (input.untilIso && record.at >= input.untilIso) return false;
    return true;
  });

  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedReadTokens = 0;
  let cacheCreationTokens = 0;
  let preTerminalTokens = 0;
  let quiesceTokens = 0;
  let unattributedTokens = 0;
  let unattributedRecords = 0;
  const byModel: Record<string, number> = {};

  for (const record of inWindow) {
    totalTokens += record.totalTokens;
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    cachedReadTokens += record.cachedInputTokens;
    cacheCreationTokens += record.cacheCreationInputTokens;
    byModel[record.model] = (byModel[record.model] ?? 0) + record.totalTokens;
    if (record.source === 'unknown') {
      unattributedTokens += record.totalTokens;
      unattributedRecords += 1;
    }
    if (input.terminalAt && record.at > input.terminalAt) {
      quiesceTokens += record.totalTokens;
    } else {
      preTerminalTokens += record.totalTokens;
    }
  }

  const sortedAt = inWindow.map((record) => record.at).sort();
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cachedReadTokens,
    cacheCreationTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedReadTokens),
    cacheHitRatio: inputTokens > 0 ? cachedReadTokens / inputTokens : 0,
    preTerminalTokens,
    quiesceTokens,
    quiesceTruncated: input.quiesceTruncated ?? false,
    unattributedTokens,
    unattributedShare: totalTokens > 0 ? unattributedTokens / totalTokens : 0,
    unattributedRecords,
    byModel,
    recordCount: inWindow.length,
    invalidLines: input.invalidLines ?? 0,
    firstRecordAt: sortedAt[0] ?? null,
    lastRecordAt: sortedAt.at(-1) ?? null,
  };
}

export function legTotalsForHome(input: {
  home: string;
  sinceIso?: string;
  untilIso?: string;
  terminalAt?: string;
  quiesceTruncated?: boolean;
}): LegTokenTotals {
  const usageDir = path.join(input.home, 'state', 'token-usage');
  const { records, invalidLines } = readUsageRecords(usageDir);
  return computeLegTotals({
    records,
    invalidLines,
    sinceIso: input.sinceIso,
    untilIso: input.untilIso,
    terminalAt: input.terminalAt,
    quiesceTruncated: input.quiesceTruncated,
  });
}
