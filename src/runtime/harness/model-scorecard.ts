/**
 * What each model did, per role, over the last week or month.
 *
 * Two ledgers already measure every model call: the usage ledger (calls,
 * failures, tokens, cache reads, duration, per request role) and the route
 * metrics (whether the turn's answer passed review, whether its tool calls
 * landed, fallovers, explicitly billed cost). Neither reached the owner as a
 * judgement about a model. This joins them per (role, model) for Settings.
 *
 * Read-only. Past days' ledger files never change, so each is read once and
 * kept by its size and mtime; today's file is re-read when it grows. No model
 * call, no estimate: cost is only what an adapter reported as billed.
 */
import { readFile, stat } from 'node:fs/promises';
import {
  canonicalCacheAccounting,
  parseUsageLedger,
  usageFileForDate,
  type UsageEvent,
  type UsageRequestRole,
} from '../usage-log.js';
import { openModelRouteMetricsDb } from '../model-route-metrics.js';

/** The roles the owner assigns in Settings. The internal router is not one. */
export type ScorecardRole = 'brain' | 'worker' | 'writer' | 'judge' | 'memory' | 'quick';
export const SCORECARD_ROLES: readonly ScorecardRole[] = ['brain', 'worker', 'writer', 'judge', 'memory', 'quick'];

export interface ModelScoreRowV1 {
  role: ScorecardRole;
  modelId: string;
  calls: number;
  failedCalls: number;
  /** The ledger's own failure reasons ("timeout", "http_error"). */
  failureReasons: Record<string, number>;
  uncachedInputTokens: number;
  cachedReadTokens: number;
  outputTokens: number;
  /** Cached reads over the prompt, certified calls only; null when none were. */
  cacheHitRate: number | null;
  latencyMs: { p50: number; p95: number } | null;
  /** Turns whose answer this model wrote that a reviewer judged, and passed. */
  reviewed: number;
  passed: number;
  /** Turns with tool calls, and those where every dispatched call landed. */
  toolTurns: number;
  toolTurnsLanded: number;
  /** Calls that fell over to another model, and calls this model took over. */
  fellOver: number;
  stoodIn: number;
  /** Explicitly billed by the adapter; null when no call reported a cost. */
  billedUsd: number | null;
  /** False when any call's token accounting could not be certified. */
  certified: boolean;
}

export interface ModelScorecardV1 {
  version: 1;
  window: { days: 7 | 30; from: string; to: string };
  rows: ModelScoreRowV1[];
  computedAt: string;
}

const USAGE_ROLE: Partial<Record<UsageRequestRole, ScorecardRole>> = {
  brain: 'brain', worker: 'worker', writer: 'writer', reviewer: 'judge', memory: 'memory', quick: 'quick',
};
const ROUTE_ROLE: Record<string, ScorecardRole | undefined> = {
  brain: 'brain', worker: 'worker', writer: 'writer', judge: 'judge', memory: 'memory', quick: 'quick',
};

/** One (role, model)'s usage, summed over any number of days. */
export interface UsageTally {
  role: ScorecardRole;
  modelId: string;
  calls: number;
  failedCalls: number;
  failureReasons: Record<string, number>;
  promptTokens: number;
  uncachedInputTokens: number;
  cachedReadTokens: number;
  outputTokens: number;
  uncertifiedCalls: number;
  durations: number[];
}

const key = (role: string, modelId: string) => `${role}\u0000${modelId}`;

/** Tally usage events per (role, model). Events with no owner-facing role are
 *  not about a model the owner chose, and are left out. */
export function tallyUsage(events: readonly UsageEvent[]): Map<string, UsageTally> {
  const tallies = new Map<string, UsageTally>();
  for (const event of events) {
    const role = event.role ? USAGE_ROLE[event.role] : undefined;
    const modelId = typeof event.model === 'string' ? event.model.trim() : '';
    if (!role || !modelId) continue;
    let tally = tallies.get(key(role, modelId));
    if (!tally) {
      tally = { role, modelId, calls: 0, failedCalls: 0, failureReasons: {}, promptTokens: 0, uncachedInputTokens: 0,
        cachedReadTokens: 0, outputTokens: 0, uncertifiedCalls: 0, durations: [] };
      tallies.set(key(role, modelId), tally);
    }
    tally.calls += 1;
    if (event.ok === false) {
      tally.failedCalls += 1;
      const reason = (event.failReason ?? 'unknown').slice(0, 40) || 'unknown';
      tally.failureReasons[reason] = (tally.failureReasons[reason] ?? 0) + 1;
    }
    const canonical = event.canonical ?? canonicalCacheAccounting(event);
    if (canonical.certified) {
      tally.promptTokens += canonical.promptTokens;
      tally.uncachedInputTokens += canonical.uncachedInputTokens;
      tally.cachedReadTokens += canonical.cachedReadTokens;
      tally.outputTokens += event.outputTokens ?? 0;
    } else {
      tally.uncertifiedCalls += 1;
    }
    if (event.ok !== false && typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0) {
      tally.durations.push(event.durationMs);
    }
  }
  return tallies;
}

export function mergeTallies(parts: Iterable<Map<string, UsageTally>>): Map<string, UsageTally> {
  const merged = new Map<string, UsageTally>();
  for (const part of parts) {
    for (const [k, tally] of part) {
      const into = merged.get(k);
      if (!into) {
        merged.set(k, { ...tally, failureReasons: { ...tally.failureReasons }, durations: [...tally.durations] });
        continue;
      }
      into.calls += tally.calls;
      into.failedCalls += tally.failedCalls;
      for (const [reason, count] of Object.entries(tally.failureReasons)) into.failureReasons[reason] = (into.failureReasons[reason] ?? 0) + count;
      into.promptTokens += tally.promptTokens;
      into.uncachedInputTokens += tally.uncachedInputTokens;
      into.cachedReadTokens += tally.cachedReadTokens;
      into.outputTokens += tally.outputTokens;
      into.uncertifiedCalls += tally.uncertifiedCalls;
      for (const ms of tally.durations) into.durations.push(ms);
    }
  }
  return merged;
}

/** What the route metrics know per (role, model). */
export interface RouteTally {
  role: ScorecardRole;
  modelId: string;
  reviewed: number;
  passed: number;
  toolTurns: number;
  toolTurnsLanded: number;
  fellOver: number;
  stoodIn: number;
  billedUsd: number | null;
}

/** Nearest-rank percentile of a list (sorted here). */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

/**
 * Join usage and route tallies into rows. A role a model never served has no
 * row; route evidence without usage still makes a row (its calls are then the
 * usage the ledger did not attribute, so they read as zero).
 */
export function scorecardFromTallies(input: {
  usage: Map<string, UsageTally>;
  routes: readonly RouteTally[];
  days: 7 | 30;
  now: Date;
}): ModelScorecardV1 {
  const routeByKey = new Map(input.routes.map((route) => [key(route.role, route.modelId), route]));
  const keys = new Set([...input.usage.keys(), ...routeByKey.keys()]);
  const rows: ModelScoreRowV1[] = [];
  for (const k of keys) {
    const usage = input.usage.get(k);
    const route = routeByKey.get(k);
    const role = (usage?.role ?? route?.role)!;
    const modelId = (usage?.modelId ?? route?.modelId)!;
    const durations = usage?.durations ?? [];
    rows.push({
      role,
      modelId,
      calls: usage?.calls ?? 0,
      failedCalls: usage?.failedCalls ?? 0,
      failureReasons: usage?.failureReasons ?? {},
      uncachedInputTokens: usage?.uncachedInputTokens ?? 0,
      cachedReadTokens: usage?.cachedReadTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheHitRate: usage && usage.promptTokens > 0 ? usage.cachedReadTokens / usage.promptTokens : null,
      latencyMs: durations.length > 0 ? { p50: percentile(durations, 50), p95: percentile(durations, 95) } : null,
      reviewed: route?.reviewed ?? 0,
      passed: route?.passed ?? 0,
      toolTurns: route?.toolTurns ?? 0,
      toolTurnsLanded: route?.toolTurnsLanded ?? 0,
      fellOver: route?.fellOver ?? 0,
      stoodIn: route?.stoodIn ?? 0,
      billedUsd: route?.billedUsd ?? null,
      certified: (usage?.uncertifiedCalls ?? 0) === 0,
    });
  }
  rows.sort((a, b) => SCORECARD_ROLES.indexOf(a.role) - SCORECARD_ROLES.indexOf(b.role) || b.calls - a.calls);
  const from = new Date(input.now.getTime() - input.days * 86_400_000);
  return { version: 1, window: { days: input.days, from: from.toISOString(), to: input.now.toISOString() }, rows,
    computedAt: input.now.toISOString() };
}

export function readRouteTallies(since: string): RouteTally[] {
  try {
    const rows = openModelRouteMetricsDb().prepare(`
      SELECT d.role AS role, d.resolved_model AS modelId,
             SUM(o.objective_met IS NOT NULL) AS reviewed,
             SUM(o.objective_met = 1) AS passed,
             SUM(o.tool_success IS NOT NULL) AS toolTurns,
             SUM(o.tool_success = 1) AS toolTurnsLanded,
             SUM(o.status = 'fallback') AS fellOver,
             SUM(d.source = 'fallback' AND o.status IN ('success', 'fallback')) AS stoodIn,
             SUM(o.cost_usd) AS billed,
             COUNT(o.cost_usd) AS billedRows
        FROM model_route_decisions d
        JOIN model_route_outcomes o ON o.decision_id = d.id
       WHERE d.created_at >= ?
       GROUP BY d.role, d.resolved_model
    `).all(since) as Array<Record<string, number | string | null>>;
    const tallies: RouteTally[] = [];
    for (const row of rows) {
      const role = ROUTE_ROLE[String(row.role)];
      if (!role || !row.modelId) continue;
      tallies.push({
        role, modelId: String(row.modelId),
        reviewed: Number(row.reviewed ?? 0), passed: Number(row.passed ?? 0),
        toolTurns: Number(row.toolTurns ?? 0), toolTurnsLanded: Number(row.toolTurnsLanded ?? 0),
        fellOver: Number(row.fellOver ?? 0), stoodIn: Number(row.stoodIn ?? 0),
        billedUsd: Number(row.billedRows ?? 0) > 0 ? Number(row.billed ?? 0) : null,
      });
    }
    return tallies;
  } catch {
    return []; // No route evidence reads as none, never as failure.
  }
}

/** One day's ledger file, tallied once per (size, mtime). */
const dayTallies = new Map<string, { size: number; mtimeMs: number; tallies: Map<string, UsageTally> }>();

async function tallyDay(date: Date): Promise<Map<string, UsageTally>> {
  const file = usageFileForDate(date);
  try {
    const info = await stat(file);
    const cached = dayTallies.get(file);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.tallies;
    const tallies = tallyUsage(parseUsageLedger(await readFile(file, 'utf8')));
    dayTallies.set(file, { size: info.size, mtimeMs: info.mtimeMs, tallies });
    return tallies;
  } catch {
    return new Map();
  }
}

const SCORECARD_TTL_MS = 60_000;
const computed = new Map<number, { at: number; value: Promise<ModelScorecardV1> }>();

/** The owner's scorecard for the last 7 or 30 days, computed at most once a
 *  minute. Days are read one at a time so a cold month never holds the loop. */
export function readModelScorecard(days: 7 | 30, now: Date = new Date()): Promise<ModelScorecardV1> {
  const hit = computed.get(days);
  if (hit && now.getTime() - hit.at < SCORECARD_TTL_MS) return hit.value;
  const value = (async () => {
    const parts: Array<Map<string, UsageTally>> = [];
    // Whole UTC days: today plus the days before it, as the ledger files them.
    for (let back = 0; back < days; back += 1) {
      parts.push(await tallyDay(new Date(now.getTime() - back * 86_400_000)));
    }
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    return scorecardFromTallies({ usage: mergeTallies(parts), routes: readRouteTallies(since), days, now });
  })();
  computed.set(days, { at: now.getTime(), value });
  value.catch(() => computed.delete(days));
  return value;
}

export function _resetModelScorecardForTests(): void {
  dayTallies.clear();
  computed.clear();
}
