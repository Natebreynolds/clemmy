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
  }
  return { recent, countBySignature, distinctArgsByMutTool };
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
  'session_history', 'agent_runs_recent', 'agent_run_get',
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
  'execution_update_step', 'execution_complete', 'execution_mark_blocked',
  'focus_set', 'focus_update', 'focus_touch', 'focus_park', 'focus_activate', 'focus_clear',
  'tool_choice_remember', 'tool_choice_invalidate',
  'notify_user', 'ask_user_question',
  'request_approval',
]);

// ─────────────────────────────────────────────────────────────────
// Thresholds (tunable via env)
// ─────────────────────────────────────────────────────────────────

interface Thresholds {
  /** Same (tool, args) hash repeats: warn at this count. */
  exactArgsWarnAt: number;
  /** Same (tool, args) hash repeats: block at this count (strict mode). */
  exactArgsBlockAt: number;
  /** Same tool, different args (mutating only): warn at this count. */
  sameMutToolWarnAt: number;
  /** Same tool, different args (mutating only): halt at this count (strict mode). */
  sameMutToolHaltAt: number;
  /** Bounded recent-window for signature tracking — older entries
   *  drop off so a long session doesn't accumulate unbounded state. */
  recentWindowSize: number;
}

function readThresholds(): Thresholds {
  const num = (key: string, fallback: number): number => {
    const raw = (process.env[key] ?? '').trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    exactArgsWarnAt: num('CLEMMY_GUARDRAIL_EXACT_WARN', 2),
    exactArgsBlockAt: num('CLEMMY_GUARDRAIL_EXACT_BLOCK', 5),
    sameMutToolWarnAt: num('CLEMMY_GUARDRAIL_MUT_WARN', 3),
    sameMutToolHaltAt: num('CLEMMY_GUARDRAIL_MUT_HALT', 8),
    recentWindowSize: num('CLEMMY_GUARDRAIL_WINDOW', 100),
  };
}

// ─────────────────────────────────────────────────────────────────
// Decision model
// ─────────────────────────────────────────────────────────────────

export type GuardrailMode = 'off' | 'warn' | 'strict';
export type GuardrailAction = 'allow' | 'warn' | 'block' | 'halt';

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
}

function readMode(): GuardrailMode {
  const raw = (process.env.CLEMMY_TOOL_GUARDRAIL ?? 'warn').toLowerCase();
  if (raw === 'off' || raw === 'strict') return raw;
  return 'warn';
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
}

interface SessionTrackerState {
  /** Bounded queue of recent calls in insertion order (newest last). */
  recent: TrackedCall[];
  /** Signature → count in the recent window. Rebuilt on prune. */
  countBySignature: Map<string, number>;
  /** Mutating tool name → count of distinct args seen recently. */
  distinctArgsByMutTool: Map<string, Set<string>>;
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
      ?? { recent: [], countBySignature: new Map(), distinctArgsByMutTool: new Map() };
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
    };
  }
  const tracker = getOrCreateTracker(sessionId);

  // Push + bound the window
  tracker.recent.push({ signature, toolName, firstSeenMs: Date.now() });
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

  if (MUTATING_TOOLS.has(toolName)) {
    let set = tracker.distinctArgsByMutTool.get(toolName);
    if (!set) {
      set = new Set();
      tracker.distinctArgsByMutTool.set(toolName, set);
    }
    set.add(signature);
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
  const isMut = MUTATING_TOOLS.has(toolName);
  const isIdem = IDEMPOTENT_TOOLS.has(toolName);

  // Exact-args repeat rule
  if (exactCount >= thresholds.exactArgsBlockAt) {
    return {
      action: 'block',
      signature,
      toolName,
      reason: `${toolName} called ${exactCount}× with identical args in recent window — strong signal of a model loop`,
      rule: 'exact_args_repeat',
      count: exactCount,
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
  };
}

/** Strict-mode promotion: in warn mode, block→warn and halt→warn.
 *  In strict mode, decisions enforce as-is. Off mode always allows. */
export function applyMode(decision: GuardrailDecision, mode: GuardrailMode = readMode()): GuardrailDecision {
  if (mode === 'off') return { ...decision, action: 'allow' };
  if (mode === 'strict') return decision;
  // warn mode (default): demote block/halt to warn
  if (decision.action === 'block' || decision.action === 'halt') {
    return { ...decision, action: 'warn' };
  }
  return decision;
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
