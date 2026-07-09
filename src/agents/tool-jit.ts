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
import { getRuntimeEnv } from '../config.js';
import { WORKSPACE_DOCK_TOOLS } from '../spaces/workspace-context.js';
import { deriveJitCore } from '../tools/tool-registry.js';
import { matchToolChoicesForStep } from '../memory/tool-choice-store.js';

const logger = pino({ name: 'clementine-next.tool-jit' });

// All flags read via getRuntimeEnv (not raw process.env) so an operator can flip the
// A/B / tuning in BASE_DIR/.env and have it apply LIVE on the next turn — no daemon
// restart — and to match the codebase convention.
/** DEFAULT ON — global on/off switch. Set CLEMMY_TOOL_JIT=off (or 0/false/no) to
 *  disable; anything else (incl. unset) is on. Safe to default-on because every
 *  no-signal path in selectToolsForTurn falls back to the FULL tool surface
 *  byte-identically (see exposeAll), and the 52-tool CORE set is never dropped. */
export function toolJitEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test((getRuntimeEnv('CLEMMY_TOOL_JIT', 'on') || 'on').trim());
}

// --- Live A/B: per-session bucketing -------------------------------------
// The global flag flips JIT for EVERYONE. To compare on real traffic we instead
// bucket each SESSION deterministically into an arm and attribute outcomes. Default
// OFF (CLEMMY_TOOL_JIT_AB) → the global flag governs, byte-identical to before.
export type ToolJitArm = 'jit' | 'control';

export function toolJitExperimentEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((getRuntimeEnv('CLEMMY_TOOL_JIT_AB', '') || '').trim());
}

/** Fraction of sessions assigned to the JIT arm (rest = control). Default 0.5. */
function abRatio(): number {
  const r = Number.parseFloat(getRuntimeEnv('CLEMMY_TOOL_JIT_AB_RATIO', '') || '');
  return Number.isFinite(r) && r >= 0 && r <= 1 ? r : 0.5;
}

/** Deterministic, stable arm for a session: same sessionId → same arm for the whole
 *  conversation (no flapping mid-session). Pure hash, no state. */
export function assignToolJitArm(sessionId: string): ToolJitArm {
  const digest = createHash('sha1').update(`tool_jit_ab::${sessionId}`).digest();
  const frac = digest.readUInt32BE(0) / 0xffffffff;
  return frac < abRatio() ? 'jit' : 'control';
}

export interface ToolJitDecision {
  /** Whether JIT actually runs this turn. */
  active: boolean;
  /** The assigned arm when the A/B is running; null otherwise. */
  arm: ToolJitArm | null;
  /** True when the per-session A/B governs the decision (vs the global flag). */
  experiment: boolean;
}

/**
 * The single source of truth for "does JIT run this turn?". When the A/B is on and
 * we have a session, the per-session ARM governs (control = off, jit = on),
 * regardless of the global CLEMMY_TOOL_JIT. Otherwise the global flag governs.
 * Always respects the lane gate (interactive chat only) — autonomous lanes never JIT.
 */
export function resolveToolJitDecision(opts: { allowLane: boolean; sessionId?: string | null }): ToolJitDecision {
  if (!opts.allowLane) return { active: false, arm: null, experiment: false };
  if (toolJitExperimentEnabled() && opts.sessionId) {
    const arm = assignToolJitArm(opts.sessionId);
    return { active: arm === 'jit', arm, experiment: true };
  }
  return { active: toolJitEnabled(), arm: null, experiment: false };
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
/**
 * TOOL_JIT_MANDATED — the always-loaded CORE, never JIT-pruned.
 *
 * DERIVED from the single tool registry (TOOL-REGISTRY-PLAN-2026-07-07, step 2):
 * the hand-maintained set was deleted; membership is now every registry tool with
 * `tier: 'core'` (deriveJitCore). Add or change a tool's core status in ONE place
 * — tool-registry.ts. The per-tool rationale (which JIT-pruning incidents made each
 * one mandated) lives with its registry entry / git history. Frozen at module load;
 * tool-registry.ts imports nothing (a leaf), so this cannot form an import cycle.
 *
 * A test asserts MANDATED ⊆ exposed even under a zero-score ranker
 * (tool-jit.test.ts); the registry conformance test pins the SET.
 */
export const TOOL_JIT_MANDATED: ReadonlySet<string> = deriveJitCore();

/**
 * The always-loaded CORE — never JIT-gated. CORE === MANDATED today; kept as a
 * distinct alias so a future expansion (e.g. usage-frequency promotion) can add
 * non-mandated always-keeps without weakening the mandated-tools contract/test.
 * Everything NOT in CORE is JIT-able and retrieved per-turn by semantic relevance.
 */
export const TOOL_JIT_CORE: ReadonlySet<string> = TOOL_JIT_MANDATED;

const WORKSPACE_INTENT_TOOLS: ReadonlySet<string> = new Set<string>(WORKSPACE_DOCK_TOOLS);

function looksLikeWorkspaceAuthoringIntent(query: string): boolean {
  const q = query.toLowerCase();
  if (/\b(workspace|workspaces)\b/.test(q)) return true;
  const verbs = String.raw`(?:build|create|make|new|edit|update|fix|improve|refresh|change|wire|author)`;
  const nouns = String.raw`(?:space|spaces|dashboard|tracker|planner|cockpit|surface|live report|mini[- ]app|board)`;
  return new RegExp(String.raw`\b${verbs}\b[\s\S]{0,100}\b${nouns}\b`).test(q)
    || new RegExp(String.raw`\b${nouns}\b[\s\S]{0,100}\b${verbs}\b`).test(q);
}

/** Background-dispatch intent pin (same class as the workspace pin, v0.12.33):
 *  a session whose history skews the semantic ranker elsewhere (live 2026-07-01:
 *  an SEO-heavy session pruned dispatch_background_task off the surface, the
 *  model announced "dispatching now" with nothing to invoke). When the user is
 *  asking for background/deferred work, these must survive selection. */
const BACKGROUND_INTENT_TOOLS: ReadonlySet<string> = new Set([
  'dispatch_background_task',
  'background_task_status',
  'background_tasks_recent',
  'offer_background',
]);

function looksLikeBackgroundDispatchIntent(query: string): boolean {
  const q = query.toLowerCase();
  return /\bbackground\b/.test(q)
    || /\b(dispatch|queue|park|defer)\b[\s\S]{0,60}\b(task|job|run|work)\b/.test(q)
    || /\b(while i('|a)?m (away|out|gone)|overnight|when it('|i)?s done|report back)\b/.test(q);
}

const TEAM_AGENT_INTENT_TOOLS: ReadonlySet<string> = new Set([
  'team_list',
  'team_message',
  'team_request',
  'team_pending_requests',
  'team_reply',
  'agent_propose',
  'create_agent',
  'update_agent',
  'delegate_task',
  'check_delegation',
]);

function looksLikeTeamAgentIntent(query: string): boolean {
  const q = query.toLowerCase();
  return /\bteam[- ]agent(s)?\b/.test(q)
    || /\bagent handoff\b/.test(q)
    || /\bhandoff\b[\s\S]{0,80}\bagent(s)?\b/.test(q)
    || /\b(create|enable|update|make|spin up|set up)\b[\s\S]{0,100}\b(agent|agents|specialist|specialists)\b/.test(q)
    || /\b(agent|agents|specialist|specialists)\b[\s\S]{0,100}\b(create|enable|update|delegate|handoff|message|request)\b/.test(q)
    || /\b(delegate|delegation|team_request|team message|can_message|canmessage)\b/.test(q)
    || /\b(proof-researcher|proof-builder)\b/.test(q);
}

const DEFAULT_TOP_K = 16;
// MEASURED (measure-tool-jit-accuracy.ts, text-embedding-3-small): real domain-named
// intents score their needed tool ≥0.33 (median 0.44); noise/weak matches sit ≤0.19.
// 0.25 is the clean separating floor — keeps every real hit, drops the weak matches
// that bloated negative-control turns at the old 0.18.
const DEFAULT_MIN_SCORE = 0.25;

function topK(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_TOOL_JIT_TOPK', '') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOP_K;
}
function minScore(): number {
  const raw = Number.parseFloat(getRuntimeEnv('CLEMMY_TOOL_JIT_MIN_SCORE', '') || '');
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_MIN_SCORE;
}

// NEVER STARVE A MODEL OF THE TOOLS IT NEEDS. JIT exists to keep tool DEFINITIONS
// from crowding the context — NOT to deny capability. So pruning engages ONLY when
// the full tool surface would actually exceed this token budget; a normal-sized
// toolset keeps EVERY tool. Generous on purpose (tool defs are prompt-cached, so a
// large stable surface is nearly free after the first turn): the 2026-06-29 incident
// was a Salesforce turn pruned to core-only that thrashed 27 shell calls and
// destabilized the model. Only genuinely huge multi-MCP installs get pruned.
const DEFAULT_JIT_BUDGET_TOKENS = 24_000;
function toolJitBudgetTokens(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_TOOL_JIT_BUDGET_TOKENS', '') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_JIT_BUDGET_TOKENS;
}
/** Approximate share of a tool DEFINITION's tokens that name+description alone
 *  captures. The parameter JSON-schema (types, enums, per-field descriptions)
 *  dominates real wire size but isn't carried on JitTool, so name+desc undercounts
 *  by ~3-4× — which is why built-in JIT pruning had NEVER fired (the estimate
 *  never crossed the 24K budget even on a large multi-MCP surface). Calibrate so
 *  the budget reflects real size. Conservative default (3.0, not 4.0) so a normal
 *  built-in surface still stays under budget — only genuinely huge surfaces prune,
 *  and CORE is never dropped regardless. Tunable via CLEMMY_TOOL_JIT_SCHEMA_FACTOR. */
function toolSchemaCalibrationFactor(): number {
  const raw = Number.parseFloat(getRuntimeEnv('CLEMMY_TOOL_JIT_SCHEMA_FACTOR', '') || '');
  return Number.isFinite(raw) && raw > 0 ? raw : 3.0;
}

/** Calibrated token estimate of a toolset's DEFINITIONS (name + description +
 *  the uncarried parameter-schema, approximated by the calibration factor). */
function estimateToolsetTokens(tools: JitTool[]): number {
  let chars = 0;
  for (const t of tools) chars += t.name.length + 1 + (t.description ?? '').length;
  return Math.ceil((chars / 4) * toolSchemaCalibrationFactor());
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
  /** Built-in tool names memory says are PROVEN for this prompt (from the tool-choice
   *  store) — pinned like the intent set so a remembered-good tool survives pruning
   *  even if its semantic score falls below the floor. Mirrors the MCP-side
   *  resolveMcpToolScopeWithRecall. Only names present in `tools` are pinned. */
  recallPinned?: string[];
}): Promise<ToolJitSelection> {
  const all = new Set(opts.tools.map((t) => t.name));
  const exposeAll = (reason: string): ToolJitSelection => ({ exposed: all, reduced: false, reason, droppedCount: 0 });

  // NB: this function does NOT re-check the global CLEMMY_TOOL_JIT flag. Whether JIT
  // runs at all is decided ONCE by resolveToolJitDecision() at the call site — the
  // single source of truth that also handles the A/B arm (the jit arm must reduce even
  // when the global flag is off). A redundant global-flag guard here made the A/B jit
  // arm a silent no-op unless the global flag was ALSO on (pre-tag review REL-5).
  const query = (opts.userInput ?? '').trim();
  if (!query) return exposeAll('no-query');

  const present = opts.tools.filter((t) => TOOL_JIT_CORE.has(t.name)).map((t) => t.name);
  const intentPinned = [
    ...(looksLikeWorkspaceAuthoringIntent(query)
      ? opts.tools.filter((t) => WORKSPACE_INTENT_TOOLS.has(t.name)).map((t) => t.name)
      : []),
    ...(looksLikeBackgroundDispatchIntent(query)
      ? opts.tools.filter((t) => BACKGROUND_INTENT_TOOLS.has(t.name) && !TOOL_JIT_CORE.has(t.name)).map((t) => t.name)
      : []),
    ...(looksLikeTeamAgentIntent(query)
      ? opts.tools.filter((t) => TEAM_AGENT_INTENT_TOOLS.has(t.name) && !TOOL_JIT_CORE.has(t.name)).map((t) => t.name)
      : []),
  ];
  const recallSet = new Set(opts.recallPinned ?? []);
  const recallPinned = recallSet.size > 0
    ? opts.tools.filter((t) => recallSet.has(t.name) && !TOOL_JIT_CORE.has(t.name)).map((t) => t.name)
    : [];
  const candidates = opts.tools.filter((t) => !TOOL_JIT_CORE.has(t.name));
  if (candidates.length === 0) return exposeAll('no-jit-candidates');

  // NEVER STARVE: only prune when the full tool surface would actually crowd the
  // context budget. A normal-sized toolset keeps EVERY tool, so the model is never
  // denied a capability it might need (the 2026-06-29 Salesforce turn got pruned to
  // core-only and thrashed 27 shell calls). Pruning engages only for genuinely large
  // multi-MCP surfaces — and this short-circuits the embedding ranker below when
  // there's nothing to gain.
  if (estimateToolsetTokens(opts.tools) <= toolJitBudgetTokens()) return exposeAll('within-budget');

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

  const exposed = new Set<string>([...present, ...intentPinned, ...recallPinned, ...selected]);
  const droppedCount = all.size - exposed.size;
  return {
    exposed,
    reduced: droppedCount > 0,
    reason: `jit top${k}@${floor} (${present.length} core + ${intentPinned.length} intent + ${recallPinned.length} recall + ${selected.length} retrieved)`,
    droppedCount,
  };
}

/** DEFAULT ON — recall-driven pin of built-in tools. Off (CLEMMY_JIT_RECALL_PIN=off)
 *  ⇒ no recall pinning (byte-identical to intent+semantic only). */
function jitRecallPinEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_JIT_RECALL_PIN', 'on') ?? 'on').toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false' && v !== 'no';
}

/**
 * Built-in tool names that MEMORY proves were the right tool for a prompt like this,
 * from the tool-choice store (the same store resolveMcpToolScopeWithRecall reads on
 * the MCP side). Pass the result to selectToolsForTurn({ recallPinned }) so a
 * remembered-good built-in survives JIT pruning even when its semantic score is low —
 * the "find the right tool using memory" half on the built-in surface. Strictly
 * additive (only ever widens the exposed set); best-effort (never throws). Filtering
 * to the turn's actual tool names happens inside selectToolsForTurn.
 */
export function recallPinnedBuiltinTools(userInput?: string | null): string[] {
  if (!jitRecallPinEnabled()) return [];
  const query = (userInput ?? '').trim();
  if (!query) return [];
  try {
    const matches = matchToolChoicesForStep(query, { limit: 5 });
    const names = new Set<string>();
    for (const m of matches) {
      for (const fam of m.family) names.add(fam);
    }
    return [...names];
  } catch {
    return [];
  }
}

/** Test-only: clear the in-memory caches. */
export function _resetToolJitCachesForTest(): void {
  toolVecCache.clear();
  queryCache = null;
}
