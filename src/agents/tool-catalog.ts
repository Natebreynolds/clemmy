/**
 * Tool catalog and schema-on-demand hot-set resolution.
 *
 * Catalogs are derived 1:1 from TOOL_REGISTRY (the single source of truth).
 * On schema-on-demand lanes, the model gets a complete names-only index and
 * reaches a specific tool THIS turn via tool_search, which returns ranked
 * one-liners plus exact schemas. First-class schemas are reserved for the HOT
 * SET (resolveHotSet). The richer name + description catalog remains available
 * for diagnostics.
 *
 * The live Codex orchestrator and Claude native-ToolSearch brain both consume
 * this bounded hot set. No import cycle: this module imports only the registry
 * (plain data), tool-jit's recall helpers, and the hot-set store — never the
 * orchestrator or the runtime tool registry.
 */
import { getRuntimeEnv } from '../config.js';
import { TOOL_REGISTRY } from '../tools/tool-registry.js';
import { queryExplicitlyNamesTool, recallPinnedBuiltinTools } from './tool-jit.js';
import { getHotSet } from './tool-hotset.js';
import { cosine, embedQuery, embedTexts, isEmbeddingsEnabled } from '../memory/embeddings.js';

export interface CatalogEntry {
  name: string;
  /** First-sentence one-liner from the registry (may be empty for a bare tool). */
  oneLiner: string;
}

/**
 * The tiny schema-loaded kernel for lanes that have a same-turn acquisition
 * path (`tool_search` + `call_tool`, or Claude's native ToolSearch).
 *
 * This is deliberately NOT TOOL_JIT_MANDATED. That older set protects lanes
 * which can only use schemas present at turn start, and has accumulated dozens
 * of incident-specific tools. Reusing it here kept 60+ schemas in every chat
 * prompt even though every deferred tool remained callable. These four tools
 * are the actual acquisition/recovery primitives; structural tools such as
 * ask_user_question, request_approval, and run_worker are assembled separately
 * by the orchestrator.
 */
export const TOOL_SEARCH_ALWAYS_LOADED: ReadonlySet<string> = new Set([
  'memory_recall_all',
  'recall_tool_result',
  'tool_output_query',
  'tool_search',
]);

/** At most the last few tools ACTUALLY dispatched stay schema-loaded. */
const MAX_SESSION_PROMOTIONS = 3;
/** Proven choices help skip discovery, but must not rebuild a giant surface. */
const MAX_RECALL_PROMOTIONS = 3;

/** Every registry tool name (the reachable built-in universe). */
export function allRegistryNames(): Set<string> {
  return new Set(TOOL_REGISTRY.map((d) => d.name));
}

function passesPolicy(name: string, allowedNames?: ReadonlySet<string>): boolean {
  return allowedNames ? allowedNames.has(name) : true;
}

/**
 * The catalog entries, sorted by name. When `allowedNames` is provided the catalog
 * is restricted to policy-allowed tools (the lane's effective surface); otherwise it
 * lists every registry tool. Reachability invariant: every policy-allowed registry
 * tool appears here — nothing reachable-in-principle is invisible-in-practice.
 */
export function catalogEntries(opts: { allowedNames?: ReadonlySet<string> } = {}): CatalogEntry[] {
  return TOOL_REGISTRY
    .filter((d) => passesPolicy(d.name, opts.allowedNames))
    .map((d) => ({ name: d.name, oneLiner: (d.description ?? '').trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Compact catalog text: one `name — one-liner` line per policy-allowed tool. */
export function buildToolCatalog(opts: { allowedNames?: ReadonlySet<string> } = {}): string {
  return catalogEntries(opts)
    .map((e) => (e.oneLiner ? `${e.name} — ${e.oneLiner}` : e.name))
    .join('\n');
}

/**
 * Complete names-only index for schema-on-demand lanes.
 *
 * The full catalog remains useful for human diagnostics, but repeating every
 * one-liner in every model turn costs more than the schemas we deliberately
 * deferred. Tool names are intentionally descriptive, and `tool_search`
 * returns the ranked one-liners plus exact schemas on demand. Grouping names
 * keeps every capability discoverable while making the always-present index
 * roughly one quarter of the previous prompt footprint.
 */
export function buildCompactToolCatalog(
  opts: { allowedNames?: ReadonlySet<string>; namesPerLine?: number } = {},
): string {
  const names = catalogEntries(opts).map((entry) => entry.name);
  const width = Math.max(4, Math.min(20, Math.trunc(opts.namesPerLine ?? 10)));
  const lines: string[] = [];
  for (let index = 0; index < names.length; index += width) {
    lines.push(`- ${names.slice(index, index + width).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * The hot set for this turn: tools that get a FIRST-CLASS schema instead of living
 * behind tool_search. Union of
 *   - TOOL_SEARCH_ALWAYS_LOADED (the tiny acquisition/recovery kernel),
 *   - exact tool names present in the user's request,
 *   - tool_choice_recall pins for this input (memory says these worked before), and
 *   - a bounded session LRU (tools this session actually dispatched),
 * intersected with policy-allowed (defaults to the whole registry). Only names that
 * are real registry tools survive, so LRU/recall drift can never inject a ghost tool.
 */
export function resolveHotSet(
  sessionId: string | undefined | null,
  userInput: string | undefined | null,
  opts: { allowedNames?: ReadonlySet<string> } = {},
): Set<string> {
  const universe = allRegistryNames();
  const allowed = opts.allowedNames;
  const keep = (name: string) => universe.has(name) && passesPolicy(name, allowed);

  const out = new Set<string>();
  for (const name of TOOL_SEARCH_ALWAYS_LOADED) if (keep(name)) out.add(name);
  for (const name of universe) {
    if (keep(name) && queryExplicitlyNamesTool(userInput ?? '', name)) out.add(name);
  }
  for (const name of recallPinnedBuiltinTools(userInput).slice(0, MAX_RECALL_PROMOTIONS)) {
    if (keep(name)) out.add(name);
  }
  for (const name of getHotSet(sessionId).slice(0, MAX_SESSION_PROMOTIONS)) {
    if (keep(name)) out.add(name);
  }
  return out;
}

// ── Ranking (reuses the embedding infra tool-jit ranks with) ──────────────────

export interface RankedCatalogEntry extends CatalogEntry {
  score: number;
}

const catalogVecCache = new Map<string, Float32Array>();

function entryText(e: CatalogEntry): string {
  return `${e.name}\n${e.oneLiner}`;
}

/** Deterministic lexical fallback when embeddings are off/unhealthy: token overlap
 *  between the query and the tool's name+one-liner. Keeps tool_search useful (and
 *  its tests hermetic) without a live embedding endpoint. */
function lexicalScore(queryTokens: string[], e: CatalogEntry): number {
  if (queryTokens.length === 0) return 0;
  const hay = entryText(e).toLowerCase();
  const nameTokens = new Set(e.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  let hits = 0;
  for (const q of queryTokens) {
    if (nameTokens.has(q)) hits += 2; // a name-token match is worth more
    else if (hay.includes(q)) hits += 1;
  }
  return hits / (queryTokens.length * 2);
}

/**
 * Rank the (policy-allowed) catalog against a query, best-first. Uses cosine over
 * the same embedding infra tool-jit uses; on any failure (embeddings off, no
 * signal, error) it falls back to a lexical token-overlap score so a result is
 * always returned. Never throws.
 */
export async function rankCatalog(
  query: string,
  opts: { allowedNames?: ReadonlySet<string> } = {},
): Promise<RankedCatalogEntry[]> {
  const entries = catalogEntries(opts);
  const q = (query ?? '').trim();
  if (!q) return entries.map((e) => ({ ...e, score: 0 }));

  const semantic = await semanticScores(q, entries).catch(() => null);
  if (semantic) {
    return entries
      .map((e) => ({ ...e, score: semantic.get(e.name) ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }

  const queryTokens = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return entries
    .map((e) => ({ ...e, score: lexicalScore(queryTokens, e) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

async function semanticScores(query: string, entries: CatalogEntry[]): Promise<Map<string, number> | null> {
  if (!isEmbeddingsEnabled() || entries.length === 0) return null;
  const queryVec = await embedQuery(query);
  if (!queryVec) return null;

  const missing = entries.filter((e) => !catalogVecCache.has(e.name));
  if (missing.length > 0) {
    const vectors = await embedTexts(missing.map((e) => entryText(e)));
    if (!vectors) return null;
    missing.forEach((e, i) => {
      const v = vectors[i];
      if (v) catalogVecCache.set(e.name, v);
    });
  }
  const scores = new Map<string, number>();
  for (const e of entries) {
    const vec = catalogVecCache.get(e.name);
    if (vec) scores.set(e.name, clamp01(cosine(queryVec, vec)));
  }
  return scores.size > 0 ? scores : null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? 1 : n;
}

/** Test-only: clear the catalog embedding cache. */
export function _resetCatalogCacheForTest(): void {
  catalogVecCache.clear();
}

// ── Schema-on-demand surface decision (mirrors resolveToolJitDecision) ─────────

export interface ToolSearchDecision {
  /** Whether the schema-on-demand surface is used this turn. */
  active: boolean;
}

/** Global switch. DEFAULT ON since v1.3.0 — validated live (cold-tool discovery
 *  via tool_search→call_tool, gate parity keyed on inner names, −67% schema
 *  tokens/turn) with zero tool-calling regressions. The model drives with the
 *  FULL surface name-visible instead of JIT pruning-by-guess; the harness
 *  constrains effects (gates), not methods. Kill-switch: =off ⇒ byte-identical
 *  pre-1.3 first-class surface. */
export function codexToolSearchEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_CODEX_TOOL_SEARCH', 'on') || 'on').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/** Extends the schema-on-demand surface to the autonomous respond lanes
 *  (cron / background / workflow). The original lane gate assumed an
 *  autonomous lane "can't recover a dropped built-in" — but recovery is the
 *  MODEL calling tool_search → call_tool, which needs no user in the loop,
 *  and the worker / workflow-step lanes have relied on exactly that path
 *  since the deferred surface shipped. Requires the global surface to be on:
 *  when tool-search is off entirely, execution lanes keep the FULL first-class
 *  surface (the legacy JIT pruner must never run there — pruning without the
 *  catalog really would strand a dropped tool). Kill-switch:
 *  CLEMMY_EXECUTION_TOOL_SEARCH=off restores the full surface on execution
 *  lanes only, leaving chat untouched. */
export function executionLaneToolSearchEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_EXECUTION_TOOL_SEARCH', 'on') || 'on').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false;
  return codexToolSearchEnabled();
}

/**
 * The single source of truth for "does the schema-on-demand surface run this turn?".
 * Lane admission comes from the caller (`allowLane`): interactive chat always
 * qualifies; the autonomous respond lanes qualify via
 * executionLaneToolSearchEnabled(). (The per-session A/B that guarded the
 * v1.3.0 default flip was retired 2026-07-16 after the flip shipped and held.)
 */
export function resolveToolSearchDecision(opts: { allowLane: boolean; sessionId?: string | null }): ToolSearchDecision {
  return { active: opts.allowLane && codexToolSearchEnabled() };
}

/** Rough token estimate (chars/4) of the serialized JSON schemas for a set of tool
 *  names — used to measure the first-class surface cost with/without schema-on-demand.
 *  `schemaFor` returns a JSON schema (or undefined) for a name. */
export function estimateSchemaTokens(names: Iterable<string>, schemaFor: (name: string) => unknown): number {
  let chars = 0;
  for (const name of names) {
    const schema = schemaFor(name);
    if (schema !== undefined) chars += JSON.stringify(schema).length;
    chars += name.length;
  }
  return Math.round(chars / 4);
}
