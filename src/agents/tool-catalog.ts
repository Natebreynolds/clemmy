/**
 * Tool catalog + hot-set resolution — Phase 0 of SCHEMA-ON-DEMAND-PLAN-2026-07-07.md.
 *
 * The catalog is the compact "name — one-liner" list of EVERY built-in tool,
 * derived 1:1 from TOOL_REGISTRY (the single source of truth). On the Codex
 * schema-on-demand lane it replaces ~18K tokens of always-loaded JSON schemas:
 * the model reads the catalog, then reaches a specific tool THIS turn via
 * tool_search (names + one-liners + full schema for the top hits). First-class
 * schemas are reserved for the HOT SET (resolveHotSet).
 *
 * Phase 0 is additive + dormant: these helpers ship and the tool_search tool is
 * registered, but nothing here is wired into the live orchestrator surface yet
 * (that is Phase 1, behind CLEMMY_CODEX_TOOL_SEARCH). No import cycle: this module
 * imports only the registry (plain data), tool-jit's exported seed/recall helpers,
 * and the hot-set store — never the orchestrator or the runtime tool registry.
 */
import { createHash } from 'node:crypto';
import { getRuntimeEnv } from '../config.js';
import { TOOL_REGISTRY } from '../tools/tool-registry.js';
import { TOOL_JIT_MANDATED, recallPinnedBuiltinTools } from './tool-jit.js';
import { getHotSet } from './tool-hotset.js';
import { cosine, embedQuery, embedTexts, isEmbeddingsEnabled } from '../memory/embeddings.js';

export interface CatalogEntry {
  name: string;
  /** First-sentence one-liner from the registry (may be empty for a bare tool). */
  oneLiner: string;
}

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
 * The hot set for this turn: tools that get a FIRST-CLASS schema instead of living
 * behind tool_search. Union of
 *   - TOOL_JIT_MANDATED (the structural CORE seed — always first-class),
 *   - tool_choice_recall pins for this input (memory says these worked before), and
 *   - the session LRU (tools this session already reached for),
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
  for (const name of TOOL_JIT_MANDATED) if (keep(name)) out.add(name);
  for (const name of recallPinnedBuiltinTools(userInput)) if (keep(name)) out.add(name);
  for (const name of getHotSet(sessionId)) if (keep(name)) out.add(name);
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

export type ToolSearchArm = 'tool_search' | 'control';

export interface ToolSearchDecision {
  /** Whether the schema-on-demand surface is used this turn. */
  active: boolean;
  /** Assigned arm when the A/B is running; null otherwise. */
  arm: ToolSearchArm | null;
  /** True when the per-session A/B governs (vs the global flag). */
  experiment: boolean;
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

/** Per-session A/B experiment switch (independent of the global flag). Default OFF. */
export function codexToolSearchExperimentEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_CODEX_TOOL_SEARCH_AB', 'off') || 'off').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true' || v === 'yes';
}

function abRatio(): number {
  const r = Number.parseFloat(getRuntimeEnv('CLEMMY_CODEX_TOOL_SEARCH_AB_RATIO', '') || '');
  return Number.isFinite(r) && r >= 0 && r <= 1 ? r : 0.5;
}

/** Deterministic, stable arm for a session (same sessionId → same arm all conversation). */
export function assignToolSearchArm(sessionId: string): ToolSearchArm {
  const digest = createHash('sha1').update(`codex_tool_search_ab::${sessionId}`).digest();
  const frac = digest.readUInt32BE(0) / 0xffffffff;
  return frac < abRatio() ? 'tool_search' : 'control';
}

/**
 * The single source of truth for "does the schema-on-demand surface run this turn?".
 * When the A/B is on and a session exists, the per-session ARM governs; otherwise the
 * global flag governs. Always respects the lane gate (interactive chat only) — an
 * autonomous lane can't recover a catalog-only tool via call_tool the way a
 * conversational turn can, so it keeps the full first-class surface.
 */
export function resolveToolSearchDecision(opts: { allowLane: boolean; sessionId?: string | null }): ToolSearchDecision {
  if (!opts.allowLane) return { active: false, arm: null, experiment: false };
  if (codexToolSearchExperimentEnabled() && opts.sessionId) {
    const arm = assignToolSearchArm(opts.sessionId);
    return { active: arm === 'tool_search', arm, experiment: true };
  }
  return { active: codexToolSearchEnabled(), arm: null, experiment: false };
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
