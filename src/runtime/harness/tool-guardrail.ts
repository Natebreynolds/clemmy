/**
 * Tool-call guardrail — Capacity-Aware Clem v0.5.18 primitive 6.
 *
 * Two layers of protection layered on top of `wrapToolForHarness`:
 *
 *   A. Loop detection. Tracks `(tool_name, sha256(canonical_args))`
 *      signatures per session. Same exact call repeated >N times
 *      indicates the model is stuck in a loop — warn or block.
 *      Same-tool-different-args for mutating tools repeated >M times
 *      is a slow-roll runaway — warn or halt.
 *
 *   B. Tool-return size enforcement. When a tool returns >8KB AND the
 *      tool is in HIGH_VOLUME_TOOLS, truncate the return to a head +
 *      tail summary with a `[full output via recall_tool_result("…")]`
 *      marker. The full payload still lives in tool_outputs via the
 *      eventlog hook; the model just doesn't get the bloat in context.
 *
 * Env flags:
 *   CLEMMY_TOOL_GUARDRAIL=strict   → block/halt decisions enforced (throw)
 *   CLEMMY_TOOL_GUARDRAIL=warn     → DEFAULT. Telemetry only; never throws.
 *   CLEMMY_TOOL_GUARDRAIL=off      → bypass entirely.
 *
 * Designed to be safe-by-default (warn only) so initial rollout
 * cannot block legitimate work. Strict mode is opt-in once you've
 * watched the telemetry and trust the thresholds.
 */

import { createHash } from 'node:crypto';
import pino from 'pino';
import { readGuardrailState, writeGuardrailState } from './eventlog.js';
import { MUTATING_VERBS } from './execution-gate.js';

const logger = pino({ name: 'clementine.harness.tool-guardrail' });

// ─────────────────────────────────────────────────────────────────
// v0.5.19 F6 — sqlite persistence (write-through cache)
// ─────────────────────────────────────────────────────────────────

/** Write-through cadence — flush to sqlite every Nth call per session.
 *  Bounded by the recentWindowSize anyway (~50 entries each holding a
 *  signature + toolName + ms), so each row is a few KB. */
const PERSIST_EVERY_N_CALLS = 5;

function persistEnabled(): boolean {
  const raw = (process.env.CLEMMY_GUARDRAIL_PERSIST ?? 'on').toLowerCase();
  return raw !== 'off';
}

function rehydrateFromSqlite(sessionId: string): SessionTrackerState | null {
  if (!persistEnabled()) return null;
  let recentJson: string | null = null;
  try {
    recentJson = readGuardrailState(sessionId);
  } catch (err) {
    logger.warn({ sessionId, err: err instanceof Error ? err.message : err }, 'rehydrate read failed');
    return null;
  }
  if (!recentJson) return null;
  let recent: TrackedCall[];
  try {
    const parsed = JSON.parse(recentJson) as TrackedCall[];
    if (!Array.isArray(parsed)) return null;
    recent = parsed;
  } catch {
    return null;
  }
  // Rebuild derived state from `recent` so the in-memory shape is
  // identical to a session that's been running in-process.
  const countBySignature = new Map<string, number>();
  const distinctArgsByMutTool = new Map<string, Set<string>>();
  const distinctArgsByFanoutKey = new Map<string, Set<string>>();
  for (const call of recent) {
    countBySignature.set(call.signature, (countBySignature.get(call.signature) ?? 0) + 1);
    if (MUTATING_TOOLS.has(call.toolName)) {
      let set = distinctArgsByMutTool.get(call.toolName);
      if (!set) {
        set = new Set();
        distinctArgsByMutTool.set(call.toolName, set);
      }
      set.add(call.signature);
    }
    if (call.fanoutKey) {
      let set = distinctArgsByFanoutKey.get(call.fanoutKey);
      if (!set) {
        set = new Set();
        distinctArgsByFanoutKey.set(call.fanoutKey, set);
      }
      set.add(call.signature);
    }
  }
  return { recent, countBySignature, distinctArgsByMutTool, distinctArgsByFanoutKey };
}

function persistTracker(sessionId: string, tracker: SessionTrackerState): void {
  if (!persistEnabled()) return;
  try {
    writeGuardrailState(sessionId, JSON.stringify(tracker.recent));
  } catch (err) {
    // Don't block the tool call on a persistence failure — log once.
    logger.warn({ sessionId, err: err instanceof Error ? err.message : err }, 'persist write failed');
  }
}

// ─────────────────────────────────────────────────────────────────
// Tool classification
// ─────────────────────────────────────────────────────────────────

/** Read-only tools that are safe to retry. Looping on these wastes
 *  budget but doesn't corrupt state, so thresholds are looser. */
const IDEMPOTENT_TOOLS = new Set<string>([
  'read_file', 'list_files', 'workspace_info', 'workspace_list', 'workspace_roots',
  'git_status',
  'memory_search', 'memory_recall', 'memory_read', 'memory_list_facts',
  'composio_search_tools', 'composio_list_tools', 'composio_status',
  'tool_choice_recall',
  'session_history', 'agent_runs_recent', 'agent_run_get', 'background_tasks_recent', 'background_task_status',
  'goal_list', 'goal_get', 'task_list',
  'list_plans', 'discover_work',
  'user_profile_read',
  'focus_get', 'focus_list', 'focus_inspect',
  'recall_tool_result',
  'skill_list', 'skill_read',
  'workflow_list', 'workflow_get', 'workflow_run_status',
]);

/** Mutating tools — looping on these CAN corrupt state (duplicate
 *  writes, double-sent messages, etc.). Tighter thresholds. */
const MUTATING_TOOLS = new Set<string>([
  'write_file', 'replace_file',
  'composio_execute_tool',
  'run_shell_command',
  'memory_remember', 'memory_forget',
  'task_add', 'task_update',
  'goal_create', 'goal_update',
  'note_create', 'note_take',
  'workflow_run',
  'workflow_rerun_failed_items',
  'execution_update_step', 'execution_complete', 'execution_mark_blocked',
  'focus_set', 'focus_update', 'focus_touch', 'focus_park', 'focus_activate', 'focus_clear',
  'tool_choice_remember', 'tool_choice_invalidate',
  'notify_user', 'ask_user_question',
  'request_approval',
]);

// ─────────────────────────────────────────────────────────────────
// Within-task fetch memory (FIX 2) — see CLEMMY_WITHIN_TASK_RECALL_NUDGE.
//
// A byte-identical repeat of a PROVABLY-STATIC read means she already has that
// result in her own tool memory (the lossless tool_outputs side-store) — so we
// nudge her to recall_tool_result instead of re-fetching. This is an ALLOWLIST,
// deliberately NARROWER than IDEMPOTENT_TOOLS: idempotent ≠ static. A read can
// be idempotent (no state change) yet return DIFFERENT bytes next call because
// an external actor mutated the source — every composio read (AIRTABLE_LIST,
// *_GET, *_SEARCH), every poll (background_task_status, workflow_run_status,
// agent_run_get), git_status. Nudging toward a cached copy of those would point
// her at STALE data. So the allowlist contains only reads whose result is stable
// for the life of a task absent an IN-SESSION mutation we can observe:
const CACHE_SAFE_READS = new Set<string>([
  'read_file', 'list_files',
  'skill_read', 'skill_list',
  'composio_search_tools', 'composio_list_tools',
  'memory_search', 'memory_recall',
  'focus_get',
]);

// In-session mutators per cache-safe read: if any of these ran AFTER the prior
// identical read and BEFORE this one, the cached copy may be stale → suppress
// the nudge. A read with no mapped mutator family (skill_*, composio_*_tools)
// has no in-session writer, so its cache never invalidates. Conservative: a
// write to ANY path invalidates a read_file cache (the intervening tool's path
// args aren't tracked here), so we under-nudge rather than serve stale.
const READ_MUTATORS: Record<string, ReadonlySet<string>> = {
  read_file: new Set(['write_file', 'replace_file', 'run_shell_command']),
  list_files: new Set(['write_file', 'replace_file', 'run_shell_command']),
  focus_get: new Set(['focus_set', 'focus_update', 'focus_touch', 'focus_park', 'focus_activate', 'focus_clear']),
  memory_search: new Set(['memory_remember', 'memory_forget']),
  memory_recall: new Set(['memory_remember', 'memory_forget']),
};

// ─────────────────────────────────────────────────────────────────
// composio_execute_tool is a GATEWAY: it wraps a read (AIRTABLE_LIST_RECORDS,
// *_GET_*, *_SEARCH_*) just as often as a write. Classifying the wrapper as
// flatly mutating means a looping READ gets escalate-KILLED with a raw error
// ("AIRTABLE_LIST_RECORDS called 7× … Ending the turn" — observed live
// 2026-06-01), which is wrong: repeating a read wastes budget but never
// corrupts state, so it should get the soft "do something different" block,
// never a turn-kill. Classify by the INNER slug.
//
// Reuse the CANONICAL write-verb set + TOKEN matching from execution-gate.ts
// (the execution-wrap gate). Token matching (split on '_', check each segment)
// — NOT a substring regex — so a read slug like AIRTABLE_LIST_RECORDS,
// HUBSPOT_GET_OFFSET, *_ADDRESS_* is never misclassified as a write by an
// incidental "SET"/"ADD" substring. Single source of truth: if a verb is
// added there, the guardrail tracks it automatically.
function composioSlugOf(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const slug = (args as Record<string, unknown>).tool_slug;
  return typeof slug === 'string' && slug.length > 0 ? slug : undefined;
}

function composioSlugIsMutating(slug: string): boolean {
  for (const part of slug.split('_')) {
    if (MUTATING_VERBS.has(part.toUpperCase())) return true;
  }
  return false;
}

/** Slug-aware: a composio_execute_tool call is mutating only when its inner
 *  slug names a write. Unknown slug → mutating (safe default). */
function isMutatingCall(toolName: string, args: unknown): boolean {
  if (toolName === 'composio_execute_tool') {
    const slug = composioSlugOf(args);
    if (!slug) return true;
    return composioSlugIsMutating(slug);
  }
  return MUTATING_TOOLS.has(toolName);
}

/** Slug-specific batch-API hints for the fan-out nudge. When the serialized
 *  slug has a REAL batch shape, naming it beats the generic advice — the live
 *  2026-06-11 run posted 25 DataForSEO tasks one TASK_POST at a time even
 *  though the endpoint accepts a `tasks` array. Checked in order; first match
 *  wins. Keep entries few and certain — a wrong hint is worse than none. */
const BATCH_API_HINTS: Array<{ test: (slug: string) => boolean; hint: string }> = [
  {
    test: (s) => s.startsWith('DATAFORSEO_') && s.includes('TASK_POST'),
    hint: 'NOTE: this DataForSEO endpoint accepts a `tasks` ARRAY — post ALL remaining items in ONE call.',
  },
  {
    test: (s) => s.startsWith('DATAFORSEO_') && (s.includes('TASK_GET') || s.includes('_BY_ID')),
    hint: 'NOTE: DataForSEO has a TASKS_READY endpoint — poll it ONCE to list all completed task ids instead of polling each id separately.',
  },
  {
    test: (s) => /^AIRTABLE_(CREATE|UPDATE|DELETE)_RECORDS$/.test(s),
    hint: 'NOTE: this Airtable endpoint accepts a `records` ARRAY (up to 10 per call) — batch the remaining rows.',
  },
];

function batchApiHintFor(slug: string): string | undefined {
  return BATCH_API_HINTS.find((h) => h.test(slug))?.hint;
}

/** Slug-aware: a composio read slug is idempotent (looping is legitimate). */
function isIdempotentCall(toolName: string, args: unknown): boolean {
  if (toolName === 'composio_execute_tool') {
    const slug = composioSlugOf(args);
    if (slug) return !composioSlugIsMutating(slug);
  }
  return IDEMPOTENT_TOOLS.has(toolName);
}

// Thresholds (tunable via env)
// ─────────────────────────────────────────────────────────────────

interface Thresholds {
  /** Same (tool, args) hash repeats: warn at this count. */
  exactArgsWarnAt: number;
  /** Same (tool, args) hash repeats: block at this count (strict mode). */
  exactArgsBlockAt: number;
  /** Same (tool, args) hash repeats on a MUTATING tool: HARD-stop (end the
   *  turn) at this count. Set generously above blockAt so the model gets a
   *  long advisory window of soft refusals to self-correct first; the hard
   *  stop is only the runaway/budget backstop, not the first response. */
  exactArgsHardStopAt: number;
  /** Same tool, different args (mutating only): warn at this count. */
  sameMutToolWarnAt: number;
  /** Same tool, different args (mutating only): halt at this count (strict mode). */
  sameMutToolHaltAt: number;
  /** Bounded recent-window for signature tracking — older entries
   *  drop off so a long session doesn't accumulate unbounded state. */
  recentWindowSize: number;
  /** Same external tool/slug with this many DISTINCT arg sets in the
   *  window → attach a fan-out nudge to the decision (advisory). */
  fanoutNudgeAt: number;
}

function readThresholds(): Thresholds {
  const num = (key: string, fallback: number): number => {
    const raw = (process.env[key] ?? '').trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const blockAt = num('CLEMMY_GUARDRAIL_EXACT_BLOCK', 5);
  return {
    exactArgsWarnAt: num('CLEMMY_GUARDRAIL_EXACT_WARN', 2),
    exactArgsBlockAt: blockAt,
    // Default = blockAt + 7 (12 by default). Gives ~7 soft-refusal chances to
    // self-correct before the terminal stop, vs the old blockAt+2 (=7) which
    // hard-killed the turn after only two soft blocks. Clamped to > blockAt so an
    // inverted env override (hardStop <= blockAt) can never make escalate fire
    // before the soft-block window exists — the corrective-then-terminal
    // invariant always holds (at minimum one soft block precedes the kill).
    exactArgsHardStopAt: Math.max(num('CLEMMY_GUARDRAIL_EXACT_HARDSTOP', blockAt + 7), blockAt + 1),
    sameMutToolWarnAt: num('CLEMMY_GUARDRAIL_MUT_WARN', 3),
    sameMutToolHaltAt: num('CLEMMY_GUARDRAIL_MUT_HALT', 8),
    recentWindowSize: num('CLEMMY_GUARDRAIL_WINDOW', 100),
    fanoutNudgeAt: num('CLEMMY_GUARDRAIL_FANOUT_NUDGE', 3),
  };
}

// ─────────────────────────────────────────────────────────────────
// Decision model
// ─────────────────────────────────────────────────────────────────

export type GuardrailMode = 'off' | 'warn' | 'strict';
// 'escalate' = a MUTATING tool repeated byte-identical past the GENEROUS
// hardStopAt threshold — i.e. the model ignored a long window of soft 'block'
// refusals (which it sees and can recover from) and is now in a runaway loop
// burning budget. Only THEN does 'escalate' END the turn; it is never
// downgraded to warn (that's its whole job — the runaway/budget backstop that
// stops the live 84×/3-min workflow_run hang). The earlier counts are soft
// 'block's so the model gets every chance to self-correct first (the
// corrective-then-terminal ladder, 2026-06-20). See brackets.ts
// ToolGuardrailEscalated.
export type GuardrailAction = 'allow' | 'warn' | 'block' | 'halt' | 'escalate';

export interface GuardrailDecision {
  action: GuardrailAction;
  /** Stable signature for telemetry / dedup. */
  signature: string;
  /** Tool name being evaluated. */
  toolName: string;
  /** Human-readable reason — surfaced in events + error messages. */
  reason: string;
  /** Bucket the decision came from (exact-args / same-mut-tool / etc). */
  rule: 'exact_args_repeat' | 'same_mut_tool_repeat' | 'allowed';
  /** Current count for the matched signature/tool. */
  count: number;
  /** Slug-aware mutating verdict for THIS call (composio_execute_tool is
   *  classified by its inner slug; native tools by set membership). Carried
   *  on the decision so `applyMode` can demote a looping READ to warn even
   *  when the wrapper tool name (composio_execute_tool) is itself mutating —
   *  the args aren't reachable from applyMode. Optional: when absent (a
   *  hand-built decision) applyMode falls back to MUTATING_TOOLS membership. */
  mutating?: boolean;
  /** Advisory fan-out steering message. Set when the same EXTERNAL tool
   *  (composio_execute_tool, keyed by inner slug) has been called with N+
   *  distinct arg sets in the recent window — the serial-batch trap observed
   *  live 2026-06-11 (74 sequential DataForSEO/Airtable calls, 25 minutes,
   *  zero run_worker). Unlike warn (telemetry-only), the harness APPENDS this
   *  to the tool's RESULT so the model actually reads it mid-stride and can
   *  switch to run_worker / the service's batch API. Never blocks. */
  fanoutNudge?: string;
  /** Within-task fetch memory (FIX 2). Set when THIS call is a byte-identical
   *  repeat of a CACHE_SAFE read whose source hasn't mutated in-session — the
   *  call_id of the PRIOR identical call, which the harness turns into a
   *  "recall_tool_result(this id) instead of re-fetching" nudge. Advisory,
   *  never blocks, never serves a payload (so it can never serve stale data —
   *  the model decides whether to recall or re-fetch). Only set when
   *  CLEMMY_WITHIN_TASK_RECALL_NUDGE=on. */
  cachedCallId?: string;
  /** Age in ms of the prior identical call the cache nudge points at. */
  cachedAgeMs?: number;
}

function readMode(): GuardrailMode {
  const raw = (process.env.CLEMMY_TOOL_GUARDRAIL ?? 'warn').toLowerCase();
  if (raw === 'off' || raw === 'strict') return raw;
  return 'warn';
}

/** Within-task fetch-memory nudge (FIX 2). Default OFF — the continuation-effort
 *  fix (FIX 1) is the primary lever; this is a measured backstop. `on` lets the
 *  guardrail mark a byte-identical cache-safe read so the harness can point the
 *  model at recall_tool_result instead of re-fetching. */
function readNudgeEnabled(): boolean {
  return (process.env.CLEMMY_WITHIN_TASK_RECALL_NUDGE ?? 'off').toLowerCase() === 'on';
}

// ─────────────────────────────────────────────────────────────────
// Per-session tracker
// ─────────────────────────────────────────────────────────────────

interface TrackedCall {
  /** SHA-256 of (toolName + canonical args JSON). */
  signature: string;
  toolName: string;
  /** Wall-clock ms when this signature first appeared in the window. */
  firstSeenMs: number;
  /** Fan-out grouping key (composio_execute_tool keyed by inner slug).
   *  Optional — absent on rows persisted before this field existed. */
  fanoutKey?: string;
  /** SDK call_id of this invocation — lets the within-task fetch-memory nudge
   *  (FIX 2) point at the PRIOR identical call's tool_outputs row. Optional:
   *  absent on the legacy/test path and on rows persisted before this field. */
  callId?: string;
}

interface SessionTrackerState {
  /** Bounded queue of recent calls in insertion order (newest last). */
  recent: TrackedCall[];
  /** Signature → count in the recent window. Rebuilt on prune. */
  countBySignature: Map<string, number>;
  /** Mutating tool name → count of distinct args seen recently. */
  distinctArgsByMutTool: Map<string, Set<string>>;
  /** Fan-out key (e.g. composio::DATAFORSEO_…_TASK_POST) → distinct arg
   *  signatures seen recently. Drives the serial-batch fan-out nudge. */
  distinctArgsByFanoutKey: Map<string, Set<string>>;
}

const trackers = new Map<string, SessionTrackerState>();

function getOrCreateTracker(sessionId: string): SessionTrackerState {
  let t = trackers.get(sessionId);
  if (!t) {
    // v0.5.19 F6 — first cache touch in this process: try rehydrating
    // from sqlite. Multi-hour workflows that cross a daemon restart
    // get their loop-detection state back. New sessions just see null
    // and start fresh.
    t = rehydrateFromSqlite(sessionId)
      ?? { recent: [], countBySignature: new Map(), distinctArgsByMutTool: new Map(), distinctArgsByFanoutKey: new Map() };
    trackers.set(sessionId, t);
  }
  return t;
}

/**
 * Hash a tool call to a stable signature. Canonicalizes args by
 * sorting JSON keys so {"a":1,"b":2} and {"b":2,"a":1} hash the
 * same. Strings/numbers/arrays are kept verbatim — different args
 * intentionally hash differently.
 */
export function hashToolCall(toolName: string, args: unknown): string {
  const canonical = canonicalize(args);
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(`${toolName}::${json}`).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}

/**
 * Record a tool call attempt and return the guardrail's decision.
 *
 * Called BEFORE the tool executes — the harness wrapper can throw
 * (in strict mode) or just log telemetry (warn mode). Always
 * registers the call into the session tracker so future calls see
 * accurate counts.
 */
export function evaluateToolCall(
  sessionId: string | undefined,
  toolName: string,
  args: unknown,
  callId?: string,
): GuardrailDecision {
  const thresholds = readThresholds();
  const signature = hashToolCall(toolName, args);
  if (!sessionId) {
    return {
      action: 'allow',
      signature,
      toolName,
      reason: 'no session context — guardrail bypassed',
      rule: 'allowed',
      count: 0,
      mutating: isMutatingCall(toolName, args),
    };
  }
  const tracker = getOrCreateTracker(sessionId);

  // Fan-out grouping key: composio_execute_tool is the external-API gateway
  // where serial batch work actually bites (DataForSEO, Airtable, Salesforce,
  // Outlook). Key by the INNER slug so 25 different-keyword TASK_POSTs group
  // together while unrelated slugs don't. Local tools (read_file, execution_*)
  // legitimately serialize and get no key.
  const slug = toolName === 'composio_execute_tool' ? composioSlugOf(args) : undefined;
  const fanoutKey = slug ? `composio::${slug}` : undefined;

  // Push + bound the window
  tracker.recent.push({ signature, toolName, firstSeenMs: Date.now(), ...(fanoutKey ? { fanoutKey } : {}), ...(callId ? { callId } : {}) });
  if (tracker.recent.length > thresholds.recentWindowSize) {
    const dropped = tracker.recent.shift();
    if (dropped) {
      const prevCount = tracker.countBySignature.get(dropped.signature) ?? 0;
      if (prevCount <= 1) tracker.countBySignature.delete(dropped.signature);
      else tracker.countBySignature.set(dropped.signature, prevCount - 1);
      // Note: distinctArgsByMutTool is approximate — we don't decay
      // it precisely on window drop because tracking which args
      // dropped requires a more complex structure. Reset on every
      // window-full as an approximation.
    }
  }
  tracker.countBySignature.set(signature, (tracker.countBySignature.get(signature) ?? 0) + 1);

  if (isMutatingCall(toolName, args)) {
    let set = tracker.distinctArgsByMutTool.get(toolName);
    if (!set) {
      set = new Set();
      tracker.distinctArgsByMutTool.set(toolName, set);
    }
    set.add(signature);
  }

  // Fan-out nudge: same slug, N distinct arg sets → the model is serializing
  // per-item batch work in its own context (re-polls of ONE id hash identical,
  // so legitimate polling never trips this). Fires at the threshold, then
  // every 5 further distinct items, so a long serial run is re-nudged without
  // spamming every call. Advisory only — delivered by appending to the tool
  // RESULT in brackets.ts (warn events are telemetry the model never sees;
  // that gap is exactly how the live 2026-06-11 serial run slipped through).
  let fanoutNudge: string | undefined;
  if (fanoutKey) {
    let set = tracker.distinctArgsByFanoutKey.get(fanoutKey);
    if (!set) {
      set = new Set();
      tracker.distinctArgsByFanoutKey.set(fanoutKey, set);
    }
    set.add(signature);
    const distinct = set.size;
    const at = thresholds.fanoutNudgeAt;
    if (distinct >= at && (distinct - at) % 5 === 0) {
      const batchHint = slug ? batchApiHintFor(slug) : undefined;
      fanoutNudge =
        `[harness fan-out check] You have now made ${distinct} DISTINCT ${slug} calls in this conversation's recent window — `
        + `you are serializing per-item batch work through your own context. STOP looping serially: `
        + `fan the REMAINING items out with run_worker (one item per worker, waves of up to 8), `
        + `or use the service's real batch API if it accepts an array of items in one call. `
        + `For very large batches (>50), author a workflow with forEach instead. `
        + `Serial looping piles every item's payload into your context and is dramatically slower.`
        + (batchHint ? ` ${batchHint}` : '');
    }
  }

  // Within-task fetch memory (FIX 2, CLEMMY_WITHIN_TASK_RECALL_NUDGE=on).
  // A byte-identical repeat of a CACHE_SAFE read whose source hasn't mutated
  // in-session → mark the PRIOR identical call's id so the harness can point her
  // at recall_tool_result instead of re-fetching. Allowlist (not the broad
  // idempotent set) + in-session mutation invalidation keep external-mutable
  // reads and pollers out by construction; the nudge never serves a payload, so
  // it can't serve stale data. The serve-side (brackets.ts) additionally drops
  // it inside worker scope and when the prior output was error-shaped.
  let cachedCallId: string | undefined;
  let cachedAgeMs: number | undefined;
  if (readNudgeEnabled() && CACHE_SAFE_READS.has(toolName)) {
    const prior = priorIdenticalCall(tracker, signature);
    if (prior?.callId && !mutatedSince(tracker, toolName, signature)) {
      cachedCallId = prior.callId;
      cachedAgeMs = Math.max(0, Date.now() - prior.firstSeenMs);
    }
  }

  // v0.5.19 F6 — write-through to sqlite on every call. Bounded by
  // recentWindowSize (~50 entries × ~100 bytes each = ~5KB per row),
  // so cost is negligible vs the eventlog append already happening
  // for every tool call. Failures are logged and ignored — the
  // in-memory tracker is the source of truth for this process. The
  // PERSIST_EVERY_N_CALLS knob is retained for future opt-out via
  // env if the write cost ever becomes measurable.
  persistTracker(sessionId, tracker);

  const exactCount = tracker.countBySignature.get(signature) ?? 1;
  const isMut = isMutatingCall(toolName, args);
  const isIdem = isIdempotentCall(toolName, args);

  // Exact-args repeat rule — CORRECTIVE-THEN-TERMINAL (2026-06-20).
  // The governing bar is "inform, rarely block; hard-stop only on an
  // irreversible-write-without-approval or token ≫ ceiling." A repeating
  // identical call wastes budget but causes no NEW harm, so it should be
  // ADVISED, not summarily killed. So:
  //   - blockAt .. hardStopAt-1  → SOFT block (refused, the model SEES the
  //     reason as the tool's output and can self-correct in-turn). The message
  //     hardens in tone once we pass blockAt+2 ("provably stuck").
  //   - >= hardStopAt            → TERMINAL escalate (end the turn). This is
  //     the runaway/budget backstop that still stops the 84×/3-min hang; it
  //     just fires far later, after a long advisory window. Read/idempotent
  //     tools NEVER escalate (polling is legitimate).
  if (isMut && exactCount >= thresholds.exactArgsHardStopAt) {
    return {
      action: 'escalate',
      signature,
      toolName,
      reason: `${toolName} called ${exactCount}× with IDENTICAL arguments despite repeated soft warnings — a runaway loop burning budget. Ending the turn.`,
      rule: 'exact_args_repeat',
      count: exactCount,
      mutating: isMut,
    };
  }
  if (exactCount >= thresholds.exactArgsBlockAt) {
    const provablyStuck = exactCount >= thresholds.exactArgsBlockAt + 2;
    const reason = provablyStuck
      ? `${toolName} has now been called ${exactCount}× with IDENTICAL arguments and keeps failing — you are provably stuck. Read the specific error above: change the call materially (different args, tool, or approach) or report the exact blocker to the user and move on. Do NOT call ${toolName} with these same arguments again — continuing to repeat it will end the turn.`
      : `Loop detected: ${toolName} has been called ${exactCount}× with IDENTICAL arguments and keeps failing/returning the same result. Repeating it will not help. STOP — do something different: change the arguments, try another tool/approach, or if you're blocked, report the specific blocker to the user. Do NOT call ${toolName} with these same arguments again.`;
    return {
      action: 'block',
      signature,
      toolName,
      reason,
      rule: 'exact_args_repeat',
      count: exactCount,
      mutating: isMut,
    };
  }
  if (exactCount >= thresholds.exactArgsWarnAt) {
    return {
      action: 'warn',
      signature,
      toolName,
      reason: `${toolName} called ${exactCount}× with identical args in recent window`,
      rule: 'exact_args_repeat',
      count: exactCount,
      mutating: isMut,
      ...(fanoutNudge ? { fanoutNudge } : {}),
      ...(cachedCallId ? { cachedCallId, cachedAgeMs } : {}),
    };
  }

  // Same-mut-tool repeat rule (only for mutating tools)
  if (isMut) {
    const distinctArgsCount = tracker.distinctArgsByMutTool.get(toolName)?.size ?? 0;
    if (distinctArgsCount >= thresholds.sameMutToolHaltAt) {
      return {
        action: 'halt',
        signature,
        toolName,
        reason: `mutating tool ${toolName} called with ${distinctArgsCount} distinct arg sets in recent window — runaway pattern`,
        rule: 'same_mut_tool_repeat',
        count: distinctArgsCount,
        mutating: isMut,
      };
    }
    if (distinctArgsCount >= thresholds.sameMutToolWarnAt) {
      return {
        action: 'warn',
        signature,
        toolName,
        reason: `mutating tool ${toolName} called with ${distinctArgsCount} distinct arg sets in recent window`,
        rule: 'same_mut_tool_repeat',
        count: distinctArgsCount,
        mutating: isMut,
        ...(fanoutNudge ? { fanoutNudge } : {}),
      };
    }
  }

  // Helpful annotation for telemetry — note when a tool isn't classified
  if (!isMut && !isIdem) {
    logger.debug({ toolName }, 'tool not classified as idempotent or mutating — assuming neutral');
  }

  return {
    action: 'allow',
    signature,
    toolName,
    reason: 'within thresholds',
    rule: 'allowed',
    count: exactCount,
    mutating: isMut,
    ...(fanoutNudge ? { fanoutNudge } : {}),
    ...(cachedCallId ? { cachedCallId, cachedAgeMs } : {}),
  };
}

/** The PRIOR identical call in the window (the second-from-newest match for this
 *  signature; the newest is the current call, just pushed). Undefined if this is
 *  the first time the signature appears. Drives the within-task fetch-memory
 *  nudge — its callId points at the cached tool_outputs row. */
function priorIdenticalCall(tracker: SessionTrackerState, signature: string): TrackedCall | undefined {
  const recent = tracker.recent;
  let seen = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].signature === signature) {
      seen += 1;
      if (seen === 2) return recent[i];
    }
  }
  return undefined;
}

/** True when an in-session mutator for `readTool` ran AFTER the prior identical
 *  read and BEFORE this one — i.e. the cached copy may be stale, so suppress the
 *  nudge. A read with no mapped mutator family never invalidates this way. */
function mutatedSince(tracker: SessionTrackerState, readTool: string, signature: string): boolean {
  const mutators = READ_MUTATORS[readTool];
  if (!mutators) return false;
  const recent = tracker.recent;
  // Find the prior identical call (second match from the tail); scan the entries
  // strictly between it and the current call (the tail) for a mutator.
  let seen = 0;
  let priorIdx = -1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].signature === signature) {
      seen += 1;
      if (seen === 2) { priorIdx = i; break; }
    }
  }
  if (priorIdx < 0) return false;
  for (let i = priorIdx + 1; i < recent.length - 1; i++) {
    if (mutators.has(recent[i].toolName)) return true;
  }
  return false;
}

/** Strict-mode promotion: in warn mode, block→warn and halt→warn.
 *  In strict mode, decisions enforce as-is. Off mode always allows. */
export function applyMode(decision: GuardrailDecision, mode: GuardrailMode = readMode()): GuardrailDecision {
  if (mode === 'off') return { ...decision, action: 'allow', fanoutNudge: undefined, cachedCallId: undefined, cachedAgeMs: undefined };
  // 'escalate' is a terminal-stuck signal — it is NEVER downgraded (even in
  // warn mode) because the model cannot recover by retrying. The ONLY way to
  // suppress it is mode 'off' (handled above). This is what actually stops the
  // 84×/3-min hang that 'block' (soft, retryable) could not.
  if (decision.action === 'escalate') return decision;
  if (mode === 'strict') return decision;
  // warn mode (default).
  //
  // An EXACT-args repeat (same tool, byte-identical args, ≥ block threshold)
  // is hard-blocked even in the default mode — BUT ONLY for MUTATING calls.
  // That's the dangerous runaway: 137× workflow_run with the same inputs,
  // repeated sends, etc. — stopped at the source, agent forced to
  // reconsider. READ/poll calls (workflow_run_status, list/get/search) are
  // non-destructive, and repeating the identical call is LEGITIMATE
  // (polling an async result, re-reading) — never block a poll; demote to
  // warn. (A read loop wastes tokens but can't corrupt/spawn/send and is
  // bounded by the turn's limits.)
  //
  // Use the decision's SLUG-AWARE `mutating` flag, not set membership on the
  // tool name: `composio_execute_tool` IS in MUTATING_TOOLS, but it's a
  // gateway that wraps reads (AIRTABLE_LIST_RECORDS) as often as writes.
  // Keying off the name hard-blocked a looping Airtable READ ("the system
  // stopped repeated Airtable reads" — live 2026-06-02) even though it can't
  // corrupt state. The flag is classified by the inner slug upstream.
  // (Hand-built decisions without the flag fall back to set membership.)
  const decisionIsMutating = decision.mutating ?? MUTATING_TOOLS.has(decision.toolName);
  if (
    decision.action === 'block'
    && decision.rule === 'exact_args_repeat'
    && decisionIsMutating
  ) {
    return decision;
  }
  // A same-mut-tool HALT — a MUTATING runaway across DISTINCT arg sets (the
  // 45-emails-to-45-distinct-addresses class) — enforces even in the default
  // mode, exactly like the exact-args mutating block above. Distinct-args mass
  // mutation is at least as dangerous as identical repeats, and until 2026-07-06
  // it demoted to warn-only, so a real 45-send runaway went out unchecked.
  // Kill-switch CLEMMY_GUARDRAIL_MUT_HALT_ENFORCE=off restores warn-only.
  if (
    decision.action === 'halt'
    && decision.rule === 'same_mut_tool_repeat'
    && decision.mutating === true // EXPLICIT slug-classified write only — never the composio gateway name-fallback (a looping read must not enforce)
    && sameMutHaltEnforcedInWarn()
  ) {
    return decision;
  }
  // Everything else (read loops, and same-tool/different-args signals that
  // may be legitimate varied/batch work) stays demoted to warn in the
  // default mode; strict mode enforces them.
  if (decision.action === 'block' || decision.action === 'halt') {
    return { ...decision, action: 'warn' };
  }
  return decision;
}

/** A MUTATING-tool runaway halt (same_mut_tool_repeat, distinct args) enforces
 *  even in the default warn mode. DEFAULT OFF pending reconciliation: the
 *  guardrail's composio mutating-classifier (composioSlugIsMutating) is BROADER
 *  than the authoritative isMutatingExternalWrite() — it flags read-only
 *  DataForSEO *_TASK_POST / FIRECRAWL_BATCH_* as mutating, and the sqlite
 *  rehydrate seeds distinct-mutation counts by NAME (folding composio READS in).
 *  Enforcing by default would refuse legitimate read-only SEO/scrape fan-outs and
 *  mis-halt the first composio write after a restart (adversarial review 07-06).
 *  The 45-email runaway is still caught by the goal-fidelity fail-closed gate;
 *  this belt-and-suspenders stays OPT-IN until the classifier + rehydrate agree.
 *  Set CLEMMY_GUARDRAIL_MUT_HALT_ENFORCE=on to enable. */
function sameMutHaltEnforcedInWarn(): boolean {
  return (process.env.CLEMMY_GUARDRAIL_MUT_HALT_ENFORCE ?? 'off').toLowerCase() === 'on';
}

// NOTE: A `maybeTruncateToolReturn` helper used to live here. Removed
// 2026-05-24 because the existing hooks.ts `clipToolResult` +
// `writeToolOutput` + compaction.ts Layer 1 already cover (a) inline
// trim with recall_tool_result marker, (b) lossless 200K side store,
// (c) compaction-driven history trim. Adding a fourth layer was
// redundant. If a different truncation strategy is needed in future,
// prefer extending hooks.ts (the single canonical write path) over
// re-introducing this layer.

// ─────────────────────────────────────────────────────────────────
// Lifecycle: test/reset helpers
// ─────────────────────────────────────────────────────────────────

/** Reset the per-session tracker for the given session. Used by
 *  tests + by session lifecycle hooks if we want to clear state on
 *  session end (currently we let the in-memory map grow until the
 *  daemon restarts).
 *  v0.5.19 F6: only clears the in-memory cache, NOT the sqlite row.
 *  Use clearTrackerPersistent() to wipe both — that's the session-end
 *  hook we'd wire when sessions transition to terminal states. */
export function resetTracker(sessionId: string): void {
  trackers.delete(sessionId);
}

/** Test-only: simulate a daemon restart by dropping the in-memory
 *  cache without touching sqlite. The next getOrCreateTracker call
 *  for this session will rehydrate from the persisted row. */
export function _simulateRestartForTests(sessionId: string): void {
  trackers.delete(sessionId);
}

/** Test/diagnostic export: peek at the current tracker state. */
export function _peekTracker(sessionId: string): Readonly<{
  recentCount: number;
  uniqueSignatures: number;
  distinctMutToolNames: number;
}> {
  const t = trackers.get(sessionId);
  if (!t) return { recentCount: 0, uniqueSignatures: 0, distinctMutToolNames: 0 };
  return {
    recentCount: t.recent.length,
    uniqueSignatures: t.countBySignature.size,
    distinctMutToolNames: t.distinctArgsByMutTool.size,
  };
}

/** Test-only: clear all trackers + classification cache. */
export function _resetAllTrackersForTests(): void {
  trackers.clear();
}
