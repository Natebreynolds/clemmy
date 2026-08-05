import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { recordOperationalEvent } from './operational-telemetry.js';
import { accrueSessionTokens, getSession, type SessionKind } from './harness/eventlog.js';
import type { TraceEnvelope } from './trace-envelope.js';

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
  /** Why `kind` was chosen (`channel:…`, `session_row:…`, `prefix:…`,
   *  `unclassified:…`). Absent on events written before it existed. */
  kindReason?: string;
  /** Model name (gpt-5.4, gpt-5.4-mini, text-embedding-3-small, etc.). */
  model: string;
  /**
   * DECLARED cache-accounting provenance, stamped by the model adapter that
   * owns the wire format — never guessed from magnitudes. 'inclusive':
   * inputTokens contains the cached subset (OpenAI wire, and the Claude
   * adapters that pre-fold cache reads). 'exclusive': inputTokens excludes
   * cache reads (raw Anthropic result JSON). 'none': the provider has no
   * cache accounting. Absent/'unknown': legacy — visible, uncertifiable,
   * debited conservatively.
   */
  cacheDialect?: CacheDialectProvenance;
  /** Canonical accounting stored at ingestion for external NDJSON readers.
   *  Rollups recompute from raw via the same single function. */
  canonical?: {
    certified: boolean;
    promptTokens: number;
    cachedReadTokens: number;
    uncachedInputTokens: number;
    uncachedWorkTokens: number;
  };
  /** Explicit trace identity joining this call to its accepted source, turn,
   *  attempt, admission, and lane — replaces source-prefix inference where a
   *  lane supplies it. Identifiers and digests only, never content. */
  trace?: TraceEnvelope;
  /** RAW provider-shaped prompt (input) tokens under the declared dialect. */
  inputTokens: number;
  /** The cached-read subset of inputTokens (prompt-cache hits). cacheHitRate =
   *  cachedInputTokens / inputTokens. Split out when the API reports it. */
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  /** Wall-clock duration of the API call, in ms. Helpful for latency vs cost tradeoffs. */
  durationMs?: number;
  /** Provider-reported time spent in remote API calls, in ms. This is a subset
   *  of durationMs when the provider exposes both values (currently Claude SDK). */
  providerApiDurationMs?: number;
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
export interface UsageKindResolution {
  kind: UsageKind;
  /**
   * WHY this kind was chosen — `channel:<value>`, `session_row:<kind>`,
   * `prefix:<token>`, or `unclassified:<head>`. The Stage 0 acceptance rule is
   * that no interactive sample lands in `other` without an explicit reason, and
   * a reason string is what makes the residue diagnosable instead of a bucket.
   */
  reason: string;
}

/** Channel → kind. A channel names the ingress surface, which is authoritative
 *  when present. `guest-harness` is detached project work, not chat. */
const CHANNEL_KINDS: Record<string, UsageKind> = {
  cron: 'cron',
  workflow: 'workflow',
  background: 'background',
  controller: 'controller',
  cli: 'chat',
  discord: 'chat',
  slack: 'chat',
  electron: 'chat',
  desktop: 'chat',
  mobile: 'chat',
  web: 'chat',
  webhook: 'chat',
  'guest-harness': 'background',
};

/** Durable session-row kind → usage kind. The sessions table is the write-time
 *  truth for what a session IS; string sniffing is only the fallback. */
const SESSION_ROW_KINDS: Record<SessionKind, UsageKind> = {
  chat: 'chat',
  workflow: 'workflow',
  agent: 'autonomy',
  execution: 'controller',
};

/**
 * Session-id prefixes observed in production mints, most specific first.
 * Measured 2026-08-04: 490 of 884 live events fell to `other`, and the top
 * sources were `sess-*` chat sessions (desktop chat mints `sess-desktop-…` in
 * console-routes; Discord routes reference `sess-` ids) and the execution
 * controller's `execution:<id>` sessions. A classifier that recognizes only
 * yesterday's id shapes silently un-classifies every new surface, so each entry
 * here names real minting code, not a guess.
 */
const PREFIX_KINDS: Array<[prefix: string, kind: UsageKind]> = [
  ['warmup', 'warmup'],
  ['cron:', 'cron'], ['cron-', 'cron'],
  ['workflow:', 'workflow'], ['workflow-', 'workflow'],
  ['background:', 'background'], ['background-', 'background'], ['bg-', 'background'],
  ['execution-controller:', 'controller'],
  ['execution:', 'controller'],
  ['agent:', 'autonomy'], ['agent-', 'autonomy'],
  ['console:', 'chat'], ['console-', 'chat'],
  ['discord:', 'chat'], ['discord-', 'chat'],
  ['slack:', 'chat'], ['slack-', 'chat'],
  ['mobile-', 'chat'],
  ['webhook:', 'chat'],
  ['approval-', 'chat'],
  ['chat:', 'chat'],
  ['sess-', 'chat'],
];

/**
 * Resolve a usage event's lane, with the reason attached.
 *
 * Authority order: explicit ingress channel, then the durable session row
 * (kind), then id-prefix evidence, then `other` with the unrecognized head so
 * the residue names itself. Pure — the session row is passed in, not fetched.
 */
export function resolveUsageKind(
  sessionId: string,
  opts: { channel?: string; sessionRowKind?: SessionKind } = {},
): UsageKindResolution {
  // Warmup outranks everything: boot traffic must never pollute a lane's
  // interactive cache-hit-rate no matter which channel spawned it.
  if (sessionId.startsWith('warmup')) return { kind: 'warmup', reason: 'prefix:warmup' };
  const channel = opts.channel?.trim().toLowerCase();
  if (channel && CHANNEL_KINDS[channel]) {
    return { kind: CHANNEL_KINDS[channel], reason: `channel:${channel}` };
  }
  if (opts.sessionRowKind && SESSION_ROW_KINDS[opts.sessionRowKind]) {
    return { kind: SESSION_ROW_KINDS[opts.sessionRowKind], reason: `session_row:${opts.sessionRowKind}` };
  }
  for (const [prefix, kind] of PREFIX_KINDS) {
    if (sessionId.startsWith(prefix)) return { kind, reason: `prefix:${prefix}` };
  }
  const head = sessionId.split(/[:\-]/, 1)[0] || 'empty';
  return { kind: 'other', reason: `unclassified:${head.slice(0, 24)}` };
}

/** Back-compat wrapper. Prefer `resolveUsageKind`, which also says WHY. */
export function classifyUsageKind(sessionId: string, channel?: string): UsageKind {
  return resolveUsageKind(sessionId, { channel }).kind;
}

/**
 * Sanitize assembly-time estimates and make their gap to provider-reported
 * input explicit. The remainder includes provider framing and any schemas a
 * lane cannot inspect (notably native MCP tools on the Claude SDK path).
 */
export function reconcilePromptComponents(
  components: Record<string, number> | undefined,
  inputTokens: number,
): Record<string, number> | undefined {
  if (!components) return undefined;
  const clean: Record<string, number> = {};
  for (const [name, raw] of Object.entries(components)) {
    if (!name || !Number.isFinite(raw) || raw <= 0) continue;
    clean[name] = Math.round(raw);
  }
  const attributed = Object.values(clean).reduce((sum, value) => sum + value, 0);
  const remainder = Math.max(0, Math.round(inputTokens) - attributed);
  if (remainder > 0) clean.providerAndToolOverhead = remainder;
  return clean;
}

/**
 * Convenience recorder shared by every model lane. Derives `source`/`kind`/`at`
 * from the session so the Codex, Claude, and BYO brains all log usage the SAME
 * way (today only the Codex native runtime logged; the Claude/BYO lanes were
 * invisible, so cache-hit-rate was unmeasurable for non-Codex brains). Fails
 * silently — observability must never break the model call path.
 */
export type CacheDialectProvenance = 'inclusive' | 'exclusive' | 'none' | 'unknown';

export interface CanonicalUsage {
  dialect: CacheDialectProvenance;
  /** False when the sample cannot be certified: unknown provenance, or a
   *  declared dialect whose numbers contradict it. */
  certified: boolean;
  /** True when the numbers are not token counts at all — quarantined from
   *  every certified sum while the raw NDJSON row stays for diagnosis. */
  invalid: boolean;
  /** Full prompt read by the model, cached + uncached, in ONE convention. */
  promptTokens: number;
  cachedReadTokens: number;
  uncachedInputTokens: number;
  /**
   * What the call actually consumed: uncached input + output (+ reasoning
   * where the provider reports it separately). THE debit unit for session
   * accrual and run budgets. Unknown provenance debits CONSERVATIVELY — no
   * cache credit is ever subtracted on a guess, so a legacy sample can never
   * reduce a budget charge.
   */
  uncachedWorkTokens: number;
  /** cachedReadTokens / promptTokens; 0 when uncertified. */
  hitRate: number;
}

/**
 * The ONE canonical cache-accounting function. Every consumer — session
 * accrual, run budgets, lane/model/source rollups, dashboard summaries, and
 * measure:efficiency — reads through this. It consumes the adapter-DECLARED
 * dialect; the previous magnitude guess (`cached > input` ⇒ exclusive) is
 * deleted, because it is not deterministic: an exclusive sample whose cached
 * reads are smaller than its uncached input (e.g. input=900, cached=100,
 * output=100, total=1000) is misclassified as inclusive and under-debited.
 * Pure.
 */
export function canonicalCacheAccounting(event: {
  cacheDialect?: CacheDialectProvenance;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}): CanonicalUsage {
  const dialect = event.cacheDialect ?? 'unknown';
  const input = event.inputTokens ?? 0;
  const cached = event.cachedInputTokens ?? 0;
  const output = event.outputTokens ?? 0;
  const reasoning = event.reasoningTokens ?? 0;
  const total = event.totalTokens ?? 0;
  const invalid = (base: Partial<CanonicalUsage> = {}): CanonicalUsage => ({
    dialect, certified: false, invalid: true,
    promptTokens: 0, cachedReadTokens: 0, uncachedInputTokens: 0,
    uncachedWorkTokens: 0, hitRate: 0, ...base,
  });
  for (const value of [input, cached, output, reasoning, total]) {
    if (!Number.isFinite(value) || value < 0) return invalid();
  }
  if (dialect === 'inclusive') {
    if (cached > input) return invalid(); // contradicts the declared dialect
    return {
      dialect, certified: true, invalid: false,
      promptTokens: input,
      cachedReadTokens: cached,
      uncachedInputTokens: input - cached,
      uncachedWorkTokens: Math.max(total, input + output) - cached,
      hitRate: input > 0 ? cached / input : 0,
    };
  }
  if (dialect === 'exclusive') {
    const promptTokens = input + cached;
    return {
      dialect, certified: true, invalid: false,
      promptTokens,
      cachedReadTokens: cached,
      uncachedInputTokens: input,
      uncachedWorkTokens: input + output + reasoning,
      hitRate: promptTokens > 0 ? cached / promptTokens : 0,
    };
  }
  if (dialect === 'none') {
    if (cached > 0) return invalid(); // a cache read under a no-cache dialect
    return {
      dialect, certified: true, invalid: false,
      promptTokens: input,
      cachedReadTokens: 0,
      uncachedInputTokens: input,
      uncachedWorkTokens: Math.max(total, input + output),
      hitRate: 0,
    };
  }
  // Unknown/legacy: visible, uncertifiable, conservatively debited.
  return {
    dialect: 'unknown', certified: false, invalid: false,
    promptTokens: Math.max(input, cached),
    cachedReadTokens: cached,
    uncachedInputTokens: input,
    uncachedWorkTokens: Math.max(total, input + output),
    hitRate: 0,
  };
}

/**
 * Uncached work for the run token meter — the canonical debit unit. Reads the
 * adapter-declared dialect through `canonicalCacheAccounting`; a sample with
 * no declared provenance debits conservatively (no cache credit).
 */
export function uncachedTokensForAccrual(event: {
  cacheDialect?: CacheDialectProvenance;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}): number {
  return canonicalCacheAccounting(event).uncachedWorkTokens;
}

export function recordModelUsage(args: {
  sessionId: string;
  channel?: string;
  model: string;
  /** Declared by the adapter that owns the wire format. Absent = 'unknown'
   *  (legacy): visible, uncertifiable, conservatively debited. */
  cacheDialect?: CacheDialectProvenance;
  /** Explicit trace identity where the lane has one (identifiers only). */
  trace?: TraceEnvelope;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  providerApiDurationMs?: number;
  responseId?: string;
  promptComponents?: Record<string, number>;
  /** Context-window health (Claude SDK lane): how close this call ran to the
   *  model's window. utilization = inputTokens / contextWindowTokens. */
  contextWindowTokens?: number;
  windowUtilization?: number;
  /** Spawn → first stream message (Claude SDK lane cold-start latency). */
  firstByteMs?: number;
}): void {
  const source = args.sessionId || 'unknown';
  // Write-time authority: the durable session row knows what this session IS,
  // so classification does not depend on every surface's id-minting habits.
  // Guarded — observability must never break the model-call path.
  let sessionRowKind: SessionKind | undefined;
  try {
    sessionRowKind = getSession(source)?.kind;
  } catch { /* classification falls back to channel/prefix evidence */ }
  const resolution = resolveUsageKind(source, { channel: args.channel, sessionRowKind });
  const canonical = canonicalCacheAccounting(args);
  const event = {
    at: new Date().toISOString(),
    source,
    kind: resolution.kind,
    kindReason: resolution.reason,
    model: args.model,
    cacheDialect: args.cacheDialect ?? 'unknown' as const,
    ...(args.trace ? { trace: args.trace } : {}),
    canonical: {
      certified: canonical.certified,
      promptTokens: canonical.promptTokens,
      cachedReadTokens: canonical.cachedReadTokens,
      uncachedInputTokens: canonical.uncachedInputTokens,
      uncachedWorkTokens: canonical.uncachedWorkTokens,
    },
    inputTokens: args.inputTokens,
    cachedInputTokens: args.cachedInputTokens,
    outputTokens: args.outputTokens,
    reasoningTokens: args.reasoningTokens,
    totalTokens: args.totalTokens ?? args.inputTokens + args.outputTokens,
    durationMs: args.durationMs,
    providerApiDurationMs: args.providerApiDurationMs,
    responseId: args.responseId,
    promptComponents: reconcilePromptComponents(args.promptComponents, args.inputTokens),
    contextWindowTokens: args.contextWindowTokens,
    windowUtilization: args.windowUtilization,
    firstByteMs: args.firstByteMs,
    // Join keys for the State layer — derived, so every workflow lane gets them
    // for free (no per-model-lane call-site change). Absent for non-workflow calls.
    ...parseWorkflowSource(source),
  };
  recordUsage(event);
  // Stage 4 (aggregate run budget): durable, restart/midnight-proof per-session
  // accumulator (fills the previously-dead sessions.tokens_used column). The
  // unit is UNCACHED tokens — counting the full prompt every turn would let
  // cache reads eat a run's ceiling (a 200k-context brain over 50 turns is
  // ~10M mostly-cached "tokens"). Silent no-op for rowless sources (warmup,
  // 'unknown'); atomic under parallel worker completions.
  try {
    accrueSessionTokens(source, uncachedTokensForAccrual(event));
  } catch { /* the meter must never break the model-call path */ }
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
      providerApiDurationMs: event.providerApiDurationMs,
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
  /** Cached-read input tokens across the window, and the derived hit-rate.
   *  The rate is computed over DIALECT-NORMALIZED prompt tokens
   *  (`normalizeCacheAccounting`), so it is structurally within [0, 1] — a
   *  window mixing cache-inclusive (OpenAI) and cache-exclusive (Anthropic)
   *  reporting can no longer certify an impossible >100% rate. Segment via
   *  byKind below to read the INTERACTIVE-chat rate in isolation (boot
   *  `warmup` traffic otherwise dominates and skews it). */
  totalCachedInputTokens: number;
  /** Normalized full-prompt tokens (cached + uncached, one convention). */
  totalPromptTokens: number;
  cacheHitRate: number;
  /** Samples excluded from certified token sums because their token fields are
   *  not arithmetically token counts (or contradict their declared dialect).
   *  Counted here, never hidden — the raw NDJSON record is untouched. */
  quarantinedCalls: number;
  /** Samples with no declared cache provenance (legacy/unknown dialect):
   *  visible in totals and calls, EXCLUDED from certified cache sums and the
   *  hit rate, and conservatively debited. */
  uncertifiedCalls: number;
  /** Tokens grouped by `kind` (chat/cron/autonomy/...). `promptTokens` is
   *  dialect-normalized so each kind's hit-rate (cachedInputTokens /
   *  promptTokens) is certified. `durationSamples`/`totalDurationMs` make
   *  latency PRESENCE visible: a lane whose durationSamples < calls is a lane
   *  whose latency cannot yet be trusted, which the Stage 0 audit found. */
  byKind: Record<string, {
    tokens: number; calls: number; inputTokens: number; cachedInputTokens: number;
    promptTokens: number; durationSamples: number; totalDurationMs: number;
  }>;
  /** Tokens grouped by `source`. Surfaces "cron:morning-briefing", "console:home", etc. */
  bySource: Array<{ source: string; tokens: number; calls: number; kind: string }>;
  /** Tokens grouped by model. `promptTokens` is dialect-normalized. */
  byModel: Record<string, {
    tokens: number; calls: number; inputTokens: number; cachedInputTokens: number;
    promptTokens: number;
  }>;
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
  let totalPromptTokens = 0;
  let quarantinedCalls = 0;
  let uncertifiedCalls = 0;
  const byKind: Record<string, {
    tokens: number; calls: number; inputTokens: number; cachedInputTokens: number;
    promptTokens: number; durationSamples: number; totalDurationMs: number;
  }> = {};
  const bySourceMap = new Map<string, { tokens: number; calls: number; kind: string }>();
  const byModel: Record<string, {
    tokens: number; calls: number; inputTokens: number; cachedInputTokens: number;
    promptTokens: number;
  }> = {};
  const hourBuckets = new Map<string, { tokens: number; calls: number }>();
  // Seed 24 hour buckets for the local day so the chart has stable x-axis.
  const dayStart = new Date(windowDate);
  dayStart.setHours(0, 0, 0, 0);
  for (let h = 0; h < 24; h += 1) {
    const label = `${String(h).padStart(2, '0')}:00`;
    hourBuckets.set(label, { tokens: 0, calls: 0 });
  }

  for (const ev of events) {
    const accounting = canonicalCacheAccounting(ev);
    if (accounting.invalid) {
      // Excluded from certified token sums, counted so it cannot hide, raw
      // NDJSON record untouched for diagnosis.
      quarantinedCalls += 1;
      continue;
    }
    if (!accounting.certified) uncertifiedCalls += 1;
    totalTokens += ev.totalTokens;
    totalInputTokens += ev.inputTokens;
    totalOutputTokens += ev.outputTokens;
    // Only CERTIFIED provenance may enter the cache sums the hit rate is
    // computed over — an unknown dialect is visible, never certified.
    const cached = accounting.certified ? accounting.cachedReadTokens : 0;
    const prompt = accounting.certified ? accounting.promptTokens : 0;
    totalCachedInputTokens += cached;
    totalPromptTokens += prompt;

    const k = ev.kind || 'other';
    if (!byKind[k]) {
      byKind[k] = {
        tokens: 0, calls: 0, inputTokens: 0, cachedInputTokens: 0,
        promptTokens: 0, durationSamples: 0, totalDurationMs: 0,
      };
    }
    byKind[k].tokens += ev.totalTokens;
    byKind[k].calls += 1;
    byKind[k].inputTokens += ev.inputTokens;
    byKind[k].cachedInputTokens += cached;
    byKind[k].promptTokens += prompt;
    if (Number.isFinite(ev.durationMs) && (ev.durationMs ?? 0) > 0) {
      byKind[k].durationSamples += 1;
      byKind[k].totalDurationMs += ev.durationMs!;
    }

    const srcKey = ev.source;
    const existing = bySourceMap.get(srcKey);
    if (existing) {
      existing.tokens += ev.totalTokens;
      existing.calls += 1;
    } else {
      bySourceMap.set(srcKey, { tokens: ev.totalTokens, calls: 1, kind: k });
    }

    const m = ev.model || 'unknown';
    if (!byModel[m]) {
      byModel[m] = { tokens: 0, calls: 0, inputTokens: 0, cachedInputTokens: 0, promptTokens: 0 };
    }
    byModel[m].tokens += ev.totalTokens;
    byModel[m].calls += 1;
    byModel[m].inputTokens += ev.inputTokens;
    byModel[m].cachedInputTokens += cached;
    byModel[m].promptTokens += prompt;

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
    totalPromptTokens,
    // Over normalized prompt tokens, so mixing dialects cannot exceed 1.
    cacheHitRate: totalPromptTokens > 0 ? totalCachedInputTokens / totalPromptTokens : 0,
    quarantinedCalls,
    uncertifiedCalls,
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
 * The honest per-source split. `totalTokens` is dominated by CACHED prompt
 * re-reads on long agentic runs (live 2026-07-22: a 6-minute Sonnet run showed
 * 7.45M "total" of which 93% was cache hits and only ~53K was real output) —
 * showing the raw total reads as alarming spend. UI surfaces should headline
 * `uncachedInput + output` (what the run actually consumed) with the total as
 * secondary context.
 */
export function sumUsageSplitForSource(
  source: string,
  date: Date = new Date(),
): { total: number; cachedInput: number; uncachedInput: number; output: number } {
  const split = { total: 0, cachedInput: 0, uncachedInput: 0, output: 0 };
  for (const ev of readUsageEventsForDate(date)) {
    if (ev.source !== source) continue;
    const canonical = canonicalCacheAccounting(ev);
    split.total += ev.totalTokens;
    split.cachedInput += canonical.cachedReadTokens;
    split.uncachedInput += canonical.uncachedInputTokens;
    split.output += ev.outputTokens ?? 0;
  }
  return split;
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
