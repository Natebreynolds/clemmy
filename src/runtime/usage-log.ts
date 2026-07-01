import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { recordOperationalEvent } from './operational-telemetry.js';

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

export type UsageKind =
  | 'chat' | 'cron' | 'autonomy' | 'workflow' | 'background'
  | 'embedding' | 'controller' | 'warmup' | 'other';

export interface UsageEvent {
  /** ISO-8601 timestamp when the model response finished. */
  at: string;
  /** Where the call came from: session ID, cron name, "embedding-backfill", etc. */
  source: string;
  /** Higher-level category for grouping in the UI. */
  kind: UsageKind;
  /** Model name (gpt-5.4, gpt-5.4-mini, text-embedding-3-small, etc.). */
  model: string;
  /** Total prompt (input) tokens for the call, INCLUDING any cached subset —
   *  matching the OpenAI Responses convention (input_tokens ⊇ cached_tokens). */
  inputTokens: number;
  /** The cached-read subset of inputTokens (prompt-cache hits). cacheHitRate =
   *  cachedInputTokens / inputTokens. Split out when the API reports it. */
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  /** Wall-clock duration of the API call, in ms. Helpful for latency vs cost tradeoffs. */
  durationMs?: number;
  /** Optional response ID for cross-reference with provider logs. */
  responseId?: string;
  /** Approx token share of the assembled prompt by component (instructions =
   *  rubric+context, tools = tool schemas, history = input items). Answers
   *  "where do my tokens go each turn?". Estimated from wire bytes (≈chars/4)
   *  at assembly time; the efficiency readout averages it across turns. */
  promptComponents?: Record<string, number>;
  /** When this call ran inside a workflow, the run/step/item it belongs to —
   *  derived from the `workflow:<runId>:<stepId>[:<itemKey>]` source so the
   *  State layer can JOIN token cost to a specific iteration without re-parsing
   *  the source string on the read side. Absent for non-workflow calls. */
  runId?: string;
  stepId?: string;
  itemKey?: string;
}

/**
 * Derive {runId, stepId, itemKey} from a workflow harness session id of the form
 * `workflow:<runId>:<stepId>[:<itemKey>]` (the deterministic id minted by
 * getWorkflowHarnessSession in workflow-runner.ts). Returns an empty object for
 * any non-workflow source, so the join keys are simply absent on chat/cron/etc.
 * Pure string inspection — never throws.
 */
export function parseWorkflowSource(source: string): { runId?: string; stepId?: string; itemKey?: string } {
  if (!source.startsWith('workflow:')) return {};
  const [, runId, stepId, ...rest] = source.split(':');
  const itemKey = rest.length > 0 ? rest.join(':') : undefined;
  return {
    ...(runId ? { runId } : {}),
    ...(stepId ? { stepId } : {}),
    ...(itemKey ? { itemKey } : {}),
  };
}

/**
 * Classify a usage event by sessionId/channel into a UI-friendly kind, so the
 * dashboard "Usage" panel and the efficiency readout can group spend by source
 * category (chat vs cron vs autonomy vs workflow vs boot warmup) without parsing
 * the raw sessionId on the read side. Pure — string inspection only.
 *
 * Shared home (was private to codex-native-runtime). Every model lane that
 * records usage classifies the SAME way, so segmented cache-hit-rate is
 * comparable across the Codex / Claude / BYO brains. Boot warmups
 * (`warmup-<ts>`, daemon/runner.ts) get their OWN `warmup` kind so their
 * one-shot, near-zero-output traffic never pollutes the interactive-chat
 * cache-hit-rate number.
 */
export function classifyUsageKind(sessionId: string, channel?: string): UsageKind {
  if (sessionId.startsWith('warmup')) return 'warmup';
  if (channel === 'cron' || sessionId.startsWith('cron:')) return 'cron';
  if (channel === 'workflow' || sessionId.startsWith('workflow:')) return 'workflow';
  if (channel === 'background' || sessionId.startsWith('background:') || sessionId.startsWith('bg-')) return 'background';
  if (channel === 'controller' || sessionId.startsWith('execution-controller:')) return 'controller';
  if (sessionId.startsWith('agent:')) return 'autonomy';
  if (sessionId === 'console:home' || sessionId.startsWith('console:') || sessionId.startsWith('discord:') || channel === 'cli' || channel === 'discord' || channel === 'electron') return 'chat';
  return 'other';
}

/**
 * Convenience recorder shared by every model lane. Derives `source`/`kind`/`at`
 * from the session so the Codex, Claude, and BYO brains all log usage the SAME
 * way (today only the Codex native runtime logged; the Claude/BYO lanes were
 * invisible, so cache-hit-rate was unmeasurable for non-Codex brains). Fails
 * silently — observability must never break the model call path.
 */
export function recordModelUsage(args: {
  sessionId: string;
  channel?: string;
  model: string;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  responseId?: string;
  promptComponents?: Record<string, number>;
  /** Context-window health (Claude SDK lane): how close this call ran to the
   *  model's window. utilization = inputTokens / contextWindowTokens. */
  contextWindowTokens?: number;
  windowUtilization?: number;
}): void {
  const source = args.sessionId || 'unknown';
  const event = {
    at: new Date().toISOString(),
    source,
    kind: classifyUsageKind(source, args.channel),
    model: args.model,
    inputTokens: args.inputTokens,
    cachedInputTokens: args.cachedInputTokens,
    outputTokens: args.outputTokens,
    reasoningTokens: args.reasoningTokens,
    totalTokens: args.totalTokens ?? args.inputTokens + args.outputTokens,
    durationMs: args.durationMs,
    responseId: args.responseId,
    promptComponents: args.promptComponents,
    contextWindowTokens: args.contextWindowTokens,
    windowUtilization: args.windowUtilization,
    // Join keys for the State layer — derived, so every workflow lane gets them
    // for free (no per-model-lane call-site change). Absent for non-workflow calls.
    ...parseWorkflowSource(source),
  };
  recordUsage(event);
  recordOperationalEvent({
    source: 'model',
    type: 'model_call_completed',
    severity: 'info',
    sessionId: source,
    workflowRunId: event.runId,
    modelCallId: args.responseId,
    actor: 'usage-log',
    now: new Date(event.at),
    payload: {
      channel: args.channel,
      usageKind: event.kind,
      model: event.model,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      reasoningTokens: event.reasoningTokens,
      totalTokens: event.totalTokens,
      durationMs: event.durationMs,
      responseId: event.responseId,
      runId: event.runId,
      stepId: event.stepId,
      itemKey: event.itemKey,
      promptComponents: event.promptComponents,
    },
  });
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
  /** Cached-read input tokens across the window, and the derived hit-rate
   *  (cachedInputTokens / inputTokens). The single largest economic lever —
   *  segment via byKind below to read the INTERACTIVE-chat rate in isolation
   *  (boot `warmup` traffic otherwise dominates and skews it). */
  totalCachedInputTokens: number;
  cacheHitRate: number;
  /** Tokens grouped by `kind` (chat/cron/autonomy/...). `tokens`/`calls` are
   *  unchanged; `inputTokens`/`cachedInputTokens` are additive so each kind's
   *  cache-hit-rate is derivable (cachedInputTokens / inputTokens). */
  byKind: Record<string, { tokens: number; calls: number; inputTokens: number; cachedInputTokens: number }>;
  /** Tokens grouped by `source`. Surfaces "cron:morning-briefing", "console:home", etc. */
  bySource: Array<{ source: string; tokens: number; calls: number; kind: string }>;
  /** Tokens grouped by model. */
  byModel: Record<string, { tokens: number; calls: number; inputTokens: number; cachedInputTokens: number }>;
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
  let totalCachedInputTokens = 0;
  const byKind: Record<string, { tokens: number; calls: number; inputTokens: number; cachedInputTokens: number }> = {};
  const bySourceMap = new Map<string, { tokens: number; calls: number; kind: string }>();
  const byModel: Record<string, { tokens: number; calls: number; inputTokens: number; cachedInputTokens: number }> = {};
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
    const cached = ev.cachedInputTokens ?? 0;
    totalCachedInputTokens += cached;

    const k = ev.kind || 'other';
    if (!byKind[k]) byKind[k] = { tokens: 0, calls: 0, inputTokens: 0, cachedInputTokens: 0 };
    byKind[k].tokens += ev.totalTokens;
    byKind[k].calls += 1;
    byKind[k].inputTokens += ev.inputTokens;
    byKind[k].cachedInputTokens += cached;

    const srcKey = ev.source;
    const existing = bySourceMap.get(srcKey);
    if (existing) {
      existing.tokens += ev.totalTokens;
      existing.calls += 1;
    } else {
      bySourceMap.set(srcKey, { tokens: ev.totalTokens, calls: 1, kind: k });
    }

    const m = ev.model || 'unknown';
    if (!byModel[m]) byModel[m] = { tokens: 0, calls: 0, inputTokens: 0, cachedInputTokens: 0 };
    byModel[m].tokens += ev.totalTokens;
    byModel[m].calls += 1;
    byModel[m].inputTokens += ev.inputTokens;
    byModel[m].cachedInputTokens += cached;

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
    totalCachedInputTokens,
    cacheHitRate: totalInputTokens > 0 ? totalCachedInputTokens / totalInputTokens : 0,
    byKind,
    bySource,
    byModel,
    byHour,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Total tokens recorded for a single source (session id) on a date (default
 * today). The State layer's per-attempt metrics call this to attribute token
 * cost to a workflow step's deterministic `workflow:<runId>:<stepId>` session —
 * snapshotting before/after an attempt and diffing isolates that attempt's
 * spend. Cheap: one day's NDJSON (a few hundred–thousand lines). Best-effort —
 * an attempt straddling midnight under-counts the pre-midnight slice; never throws.
 */
export function sumUsageTokensForSource(source: string, date: Date = new Date()): number {
  let total = 0;
  for (const ev of readUsageEventsForDate(date)) {
    if (ev.source === source) total += ev.totalTokens;
  }
  return total;
}

/**
 * Total tokens recorded across an entire workflow run (all its steps) on a date,
 * using the derived `runId` join key. Leverages the S2 join so the run-level
 * STATE record can report "this whole goal attempt cost N tokens" without
 * re-correlating sessions. Best-effort; never throws.
 */
export function sumUsageTokensForRun(runId: string, date: Date = new Date()): number {
  let total = 0;
  for (const ev of readUsageEventsForDate(date)) {
    if (ev.runId === runId) total += ev.totalTokens;
  }
  return total;
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
