import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

/**
 * Token-usage observability log. Append-only NDJSON per day.
 *
 * Why: users were getting Codex-token-drained without any visibility
 * into WHAT was eating tokens. A dashboard "Usage" panel needs source-
 * attributed data to render a breakdown. This module captures every
 * model call's token counts so the panel can show:
 *   - Tokens by source today (cron jobs, dashboard polls, harness, etc.)
 *   - Tokens by model (gpt-5.4 vs mini)
 *   - Top sessions
 *   - Hour-over-hour spend
 *
 * Storage: ~/.clementine-next/state/token-usage/YYYY-MM-DD.ndjson
 * Daily roll, no encryption (no secrets in usage data).
 * Inserts are O(1) append, queries are O(events-in-day).
 *
 * NOT a substitute for the provider's billing dashboard — this only
 * sees what the daemon itself drives. Manual API key usage from other
 * tools shows up at OpenAI/Codex but not here.
 */

const USAGE_DIR = path.join(BASE_DIR, 'state', 'token-usage');

export interface UsageEvent {
  /** ISO-8601 timestamp when the model response finished. */
  at: string;
  /** Where the call came from: session ID, cron name, "embedding-backfill", etc. */
  source: string;
  /** Higher-level category for grouping in the UI. */
  kind: 'chat' | 'cron' | 'autonomy' | 'workflow' | 'background' | 'embedding' | 'controller' | 'other';
  /** Model name (gpt-5.4, gpt-5.4-mini, text-embedding-3-small, etc.). */
  model: string;
  /** Cached input tokens are split out when the API reports them. */
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  /** Wall-clock duration of the API call, in ms. Helpful for latency vs cost tradeoffs. */
  durationMs?: number;
  /** Optional response ID for cross-reference with provider logs. */
  responseId?: string;
}

function ensureDir(): void {
  if (!existsSync(USAGE_DIR)) mkdirSync(USAGE_DIR, { recursive: true });
}

function todaysFile(date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return path.join(USAGE_DIR, `${day}.ndjson`);
}

/**
 * Append a usage event. Fails silently — billing observability must
 * never crash the model call path.
 */
export function recordUsage(event: UsageEvent): void {
  try {
    ensureDir();
    appendFileSync(todaysFile(new Date(event.at || Date.now())), JSON.stringify(event) + '\n', 'utf-8');
  } catch {
    // intentional swallow
  }
}

/**
 * Read all usage events for a date (default today). Returns oldest-first.
 */
export function readUsageEventsForDate(date: Date = new Date()): UsageEvent[] {
  try {
    const file = todaysFile(date);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try { return JSON.parse(line) as UsageEvent; }
        catch { return null; }
      })
      .filter((e): e is UsageEvent => e !== null);
  } catch {
    return [];
  }
}

export interface UsageRollup {
  /** Total tokens used in the window. */
  totalTokens: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Tokens grouped by `kind` (chat/cron/autonomy/...). */
  byKind: Record<string, { tokens: number; calls: number }>;
  /** Tokens grouped by `source`. Surfaces "cron:morning-briefing", "console:home", etc. */
  bySource: Array<{ source: string; tokens: number; calls: number; kind: string }>;
  /** Tokens grouped by model. */
  byModel: Record<string, { tokens: number; calls: number }>;
  /** Per-hour buckets for the chart (24 entries, 00:00–23:00, current day local time). */
  byHour: Array<{ hour: string; tokens: number; calls: number }>;
  /** When the underlying log was last updated. */
  generatedAt: string;
}

/**
 * Aggregate events into a dashboard-friendly rollup. Cheap for a
 * single day's NDJSON (typical: a few hundred to a few thousand
 * lines), so the dashboard can hit /api/console/usage on every panel
 * open or periodic refresh without a worry.
 */
export function rollupUsage(events: UsageEvent[], windowDate: Date = new Date()): UsageRollup {
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const byKind: Record<string, { tokens: number; calls: number }> = {};
  const bySourceMap = new Map<string, { tokens: number; calls: number; kind: string }>();
  const byModel: Record<string, { tokens: number; calls: number }> = {};
  const hourBuckets = new Map<string, { tokens: number; calls: number }>();
  // Seed 24 hour buckets for the local day so the chart has stable x-axis.
  const dayStart = new Date(windowDate);
  dayStart.setHours(0, 0, 0, 0);
  for (let h = 0; h < 24; h += 1) {
    const label = `${String(h).padStart(2, '0')}:00`;
    hourBuckets.set(label, { tokens: 0, calls: 0 });
  }

  for (const ev of events) {
    totalTokens += ev.totalTokens;
    totalInputTokens += ev.inputTokens;
    totalOutputTokens += ev.outputTokens;

    const k = ev.kind || 'other';
    if (!byKind[k]) byKind[k] = { tokens: 0, calls: 0 };
    byKind[k].tokens += ev.totalTokens;
    byKind[k].calls += 1;

    const srcKey = ev.source;
    const existing = bySourceMap.get(srcKey);
    if (existing) {
      existing.tokens += ev.totalTokens;
      existing.calls += 1;
    } else {
      bySourceMap.set(srcKey, { tokens: ev.totalTokens, calls: 1, kind: k });
    }

    const m = ev.model || 'unknown';
    if (!byModel[m]) byModel[m] = { tokens: 0, calls: 0 };
    byModel[m].tokens += ev.totalTokens;
    byModel[m].calls += 1;

    try {
      const ts = new Date(ev.at);
      const sameDay = ts.toDateString() === windowDate.toDateString();
      if (sameDay) {
        const label = `${String(ts.getHours()).padStart(2, '0')}:00`;
        const bucket = hourBuckets.get(label);
        if (bucket) {
          bucket.tokens += ev.totalTokens;
          bucket.calls += 1;
        }
      }
    } catch { /* skip malformed timestamps */ }
  }

  const bySource = Array.from(bySourceMap.entries())
    .map(([source, v]) => ({ source, tokens: v.tokens, calls: v.calls, kind: v.kind }))
    .sort((a, b) => b.tokens - a.tokens);

  const byHour = Array.from(hourBuckets.entries())
    .map(([hour, v]) => ({ hour, tokens: v.tokens, calls: v.calls }));

  return {
    totalTokens,
    totalCalls: events.length,
    totalInputTokens,
    totalOutputTokens,
    byKind,
    bySource,
    byModel,
    byHour,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Convenience — list all available usage log dates (newest first).
 * Used by the dashboard's date-picker dropdown if we add one later.
 */
export function listUsageDates(): string[] {
  try {
    if (!existsSync(USAGE_DIR)) return [];
    return readdirSync(USAGE_DIR)
      .filter((n) => n.endsWith('.ndjson'))
      .map((n) => n.slice(0, -'.ndjson'.length))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
