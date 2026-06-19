/**
 * Phase 1 — just-in-time (JIT) tool loading for the BUILT-IN surface (Tool RAG).
 *
 * Phase-0a measured the built-in tool surface at ~24.8K tokens/turn — the single
 * biggest per-turn cost, ~3× the rubric — and found ~75% of it (71 of 92 tools,
 * ~18.5K tok) is rarely needed on a given turn (workflow authoring, spaces, admin
 * writes…). This module retrieves only the tools a turn plausibly needs: a generous
 * always-loaded CORE plus the top-K built-in tools semantically relevant to the
 * user's input, reusing the existing embedding infra (embedQuery/embedTexts/cosine).
 *
 * Design constraints (mirrors mcp-tool-rank.ts):
 *  - DEFAULT OFF (CLEMMY_TOOL_JIT). Off → expose everything, byte-identical surface.
 *  - GRACEFUL: empty query, no embeddings, or no semantic signal → expose everything.
 *    A reduction only ever happens when we have a real ranking; never throws.
 *  - The CORE is always kept regardless of score, so an under-ranked essential
 *    (execution lane, memory recall, the composio discovery escape-hatch) is never
 *    dropped — the model can always discover+call any tool even when its specific
 *    wrapper wasn't pre-loaded.
 *  - Tool vectors cached in-memory by content hash (daemon lifetime).
 *
 * NOT YET BUILT (Phase 1.2): mid-run acquisition of a JIT-dropped BUILT-IN tool
 * (composio_* already covers external acquisition). Until then the CORE is the
 * safety floor — keep it generous.
 */
import { createHash } from 'node:crypto';
import pino from 'pino';
import { cosine, embedQuery, embedTexts, isEmbeddingsEnabled } from '../memory/embeddings.js';

const logger = pino({ name: 'clementine-next.tool-jit' });

/** DEFAULT OFF — opt-in for the A/B. 'on'/'1'/'true'/'yes' enable. */
export function toolJitEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((process.env.CLEMMY_TOOL_JIT ?? '').trim());
}

/**
 * MANDATED — tools the always-injected rubric IMPERATIVELY tells the model to
 * call, or that are needed for cross-cutting correctness REGARDLESS of the current
 * message's content (so semantic retrieval against this turn's text can't be
 * trusted to surface them). These must NEVER be JIT-dropped: there is no mid-run
 * acquisition for BUILT-IN tools yet (Phase 1.2), so a dropped mandated tool would
 * recreate the "instructed-but-absent" stall the orchestrator's instructions↔surface
 * cross-check exists to prevent. Distinct from conditionally-needed, INTENT-EVIDENT
 * tools (workflow_*, space_*, task_*, goal_*, browser_harness_*…) which the user's
 * own message names — those are the JIT-able prize and semantic retrieval brings
 * them back when relevant. A test asserts MANDATED ⊆ exposed even under a zero-score
 * ranker (tool-jit.test.ts); keep this in sync with the rubric.
 */
export const TOOL_JIT_MANDATED: ReadonlySet<string> = new Set<string>([
  // FOCUS hygiene — rubric: focus_get at the START of every turn; a focus correction
  // / park / clear can land on ANY turn and is NOT evident from the message text.
  'focus_get', 'focus_set', 'focus_update', 'focus_touch', 'focus_park', 'focus_activate', 'focus_clear',
  // EXECUTION lane — write-gating before mutating composio; closing out an execution
  // started on an EARLIER turn ("done", "ship it") is not evident from this message.
  'execution_create', 'execution_list', 'execution_get', 'execution_update_step', 'execution_complete', 'execution_mark_blocked',
  // PLAN coherence — create/list/update + the planner preview tools.
  'create_plan', 'list_plans', 'update_plan_step', 'draft_plan', 'share_plan', 'surface_plan',
  // PRE-WRITE ritual + self-correcting memory.
  'memory_review_instructions', 'memory_forget',
  // MEMORY recall + write (the ever-learning core).
  'memory_recall', 'memory_search', 'memory_read', 'memory_remember',
  // RETRY / continuation correctness (resource-fingerprint + infra-retry rules read these).
  'session_history', 'recall_tool_result', 'tool_output_query',
  // cwd SAFETY before shell.
  'workspace_roots',
  // structural OUTPUT channel that must survive.
  'notify_user',
  // named-model routing + tool-choice correction (cache fixes can land on any turn).
  'set_model_role', 'clear_model_role', 'tool_choice_recall', 'tool_choice_remember', 'tool_choice_invalidate', 'tool_choice_forget',
  // DISCOVERY + acquisition escape-hatch (keeps every EXTERNAL tool reachable) + local CLI probe + skills.
  'composio_search_tools', 'composio_execute_tool', 'local_cli_list', 'local_cli_probe', 'skill_list', 'skill_read',
  // FILES + shell (the local-work backbone).
  'read_file', 'write_file', 'list_files', 'run_shell_command',
  // profile READ (cheaper than asking the user).
  'user_profile_read',
  // the user's REAL browser. MEASURED (measure-tool-jit-accuracy.ts): "log into my
  // LinkedIn…" scores these at NOISE level (0.155 / 0.19 cosine) — the canonical
  // "log into my X" trigger doesn't semantically match the browser-harness tool
  // text, so retrieval can't be trusted to surface them. CORE is the reliable fix.
  'browser_harness_status', 'browser_harness_run',
  // conversation primitives (also added structurally outside JIT — belt-and-suspenders).
  'ask_user_question', 'request_approval', 'run_worker',
]);

/**
 * The always-loaded CORE — never JIT-gated. CORE === MANDATED today; kept as a
 * distinct alias so a future expansion (e.g. usage-frequency promotion) can add
 * non-mandated always-keeps without weakening the mandated-tools contract/test.
 * Everything NOT in CORE is JIT-able and retrieved per-turn by semantic relevance.
 */
export const TOOL_JIT_CORE: ReadonlySet<string> = TOOL_JIT_MANDATED;

const DEFAULT_TOP_K = 16;
// MEASURED (measure-tool-jit-accuracy.ts, text-embedding-3-small): real domain-named
// intents score their needed tool ≥0.33 (median 0.44); noise/weak matches sit ≤0.19.
// 0.25 is the clean separating floor — keeps every real hit, drops the weak matches
// that bloated negative-control turns at the old 0.18.
const DEFAULT_MIN_SCORE = 0.25;

function topK(): number {
  const raw = Number.parseInt(process.env.CLEMMY_TOOL_JIT_TOPK ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOP_K;
}
function minScore(): number {
  const raw = Number.parseFloat(process.env.CLEMMY_TOOL_JIT_MIN_SCORE ?? '');
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_MIN_SCORE;
}

export interface JitTool {
  name: string;
  description?: string | null;
}

export interface ToolJitSelection {
  /** Tool names to expose this turn (always a superset of the present CORE). */
  exposed: Set<string>;
  /** True only when at least one tool was actually dropped. */
  reduced: boolean;
  /** Telemetry — why this selection (jit-off, no-query, no-signal, or the topK rule). */
  reason: string;
  /** How many tools were dropped from the full surface. */
  droppedCount: number;
}

/** Ranker seam: name → cosine in [0,1]. Returns undefined to signal "no signal". */
export type JitRankFn = (query: string, tools: JitTool[]) => Promise<Map<string, number> | undefined>;

// Tool text → vector, content-hashed (daemon lifetime). Only new/changed tools embed.
const toolVecCache = new Map<string, Float32Array>();
const QUERY_TTL_MS = 60_000;
let queryCache: { key: string; vec: Float32Array | null; at: number } | null = null;

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
function clamp01(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? 1 : n;
}
function toolText(t: JitTool): string {
  return `${t.name}\n${(t.description ?? '').trim()}`;
}

/** The real semantic ranker — embeds the query + each tool, returns cosine map.
 *  Graceful: undefined whenever embeddings are off/unhealthy. Never throws. */
async function semanticRank(query: string, tools: JitTool[], now: number): Promise<Map<string, number> | undefined> {
  if (!isEmbeddingsEnabled() || tools.length === 0) return undefined;
  try {
    if (!(queryCache && queryCache.key === query && now - queryCache.at < QUERY_TTL_MS)) {
      queryCache = { key: query, vec: await embedQuery(query), at: now };
    }
    const queryVec = queryCache.vec;
    if (!queryVec) return undefined;

    const entries = tools.map((t) => ({ name: t.name, hash: hashText(toolText(t)), text: toolText(t) }));
    const missing = entries.filter((e) => !toolVecCache.has(e.hash));
    if (missing.length > 0) {
      const vectors = await embedTexts(missing.map((e) => e.text));
      if (!vectors) return undefined;
      missing.forEach((e, i) => {
        const v = vectors[i];
        if (v) toolVecCache.set(e.hash, v);
      });
    }
    const scores = new Map<string, number>();
    for (const e of entries) {
      const vec = toolVecCache.get(e.hash);
      if (vec) scores.set(e.name, clamp01(cosine(queryVec, vec)));
    }
    return scores.size > 0 ? scores : undefined;
  } catch (err) {
    logger.warn({ err }, 'tool-jit semantic rank failed; exposing full surface');
    return undefined;
  }
}

/**
 * Select which built-in tools to expose this turn. CORE is always kept; the rest
 * are ranked semantically and only the top-K above the minimum score are added.
 * Any failure mode (flag off, no query, no embeddings, no signal) exposes the FULL
 * surface unchanged — a reduction is strictly opt-in and best-effort.
 */
export async function selectToolsForTurn(opts: {
  userInput?: string | null;
  tools: JitTool[];
  rankFn?: JitRankFn;
  now?: number;
}): Promise<ToolJitSelection> {
  const all = new Set(opts.tools.map((t) => t.name));
  const exposeAll = (reason: string): ToolJitSelection => ({ exposed: all, reduced: false, reason, droppedCount: 0 });

  if (!toolJitEnabled()) return exposeAll('jit-off');
  const query = (opts.userInput ?? '').trim();
  if (!query) return exposeAll('no-query');

  const present = opts.tools.filter((t) => TOOL_JIT_CORE.has(t.name)).map((t) => t.name);
  const candidates = opts.tools.filter((t) => !TOOL_JIT_CORE.has(t.name));
  if (candidates.length === 0) return exposeAll('no-jit-candidates');

  const ranker = opts.rankFn ?? ((q, t) => semanticRank(q, t, opts.now ?? Date.now()));
  const scores = await ranker(query, candidates);
  if (!scores) return exposeAll('no-semantic-signal');

  const k = topK();
  const floor = minScore();
  const selected = candidates
    .map((t) => ({ name: t.name, score: scores.get(t.name) ?? 0 }))
    .filter((r) => r.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => r.name);

  const exposed = new Set<string>([...present, ...selected]);
  const droppedCount = all.size - exposed.size;
  return {
    exposed,
    reduced: droppedCount > 0,
    reason: `jit top${k}@${floor} (${present.length} core + ${selected.length} retrieved)`,
    droppedCount,
  };
}

/** Test-only: clear the in-memory caches. */
export function _resetToolJitCachesForTest(): void {
  toolVecCache.clear();
  queryCache = null;
}
