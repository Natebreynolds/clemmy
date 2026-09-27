import { getSession } from '../runtime/harness/eventlog.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import {
  isValidLearningReceipt,
  type LearningReceipt,
} from './learning-receipt.js';

/**
 * Run-strategy memory (DREAM learning loop v1): after a background run
 * completes, distill HOW it succeeded — the tools that did the work, the
 * fan-out shape, the wall time — so the next similar objective plans from a
 * proven approach instead of rediscovering it. This is the level ABOVE the
 * tool-choice store (which remembers single tool picks): a strategy is the
 * run's shape.
 *
 * Deliberately deterministic: the distillation is a cheap trace summary (no
 * model call per completed task), and recall is keyword overlap. Injection is
 * ADDITIVE — renders '' when nothing matches, so absent strategies change
 * nothing (the no-regression property).
 */

/** One request shape that succeeded in a proven run: the tool and its argument
 * structure with values elided (method and path literal). Learned from the
 * tool's own settled calls, never from the user's text. */
export interface ProvenCallShape {
  tool: string;
  shape: string;
}

export interface RunStrategyRecord {
  id: string;
  objective: string;
  keywords: string[];
  toolsUsed: string[];
  /** Request shapes that succeeded when this strategy was learned. Live
   *  2026-09-24 (source 299146): a generic MCP passthrough was re-called with
   *  `targets` after `target` had already succeeded and paid an invalid-field
   *  refusal; the shape that worked was already on record. */
  provenShapes?: ProvenCallShape[];
  workerCount: number;
  durationMs: number;
  /** WHERE the deliverable went (file path / sheet / mailbox target) — so a
   *  later session's "find those 30 emails we drafted" answers from memory
   *  instead of guessing at mailboxes (live 2026-07-23). */
  deliverable?: string;
  createdAt: string;
  uses: number;
  lastUsedAt?: string;
  /** Runtime-owned proof that at least one clean execution authorized recall. */
  learningReceipt?: LearningReceipt;
  /** Pre-receipt observations retained for audit, never counted as proof. */
  legacyUses?: number;
  /** Where the strategy was learned. A chat request and a workflow step both
   *  record strategies; only a chat strategy may be offered to a chat request
   *  (live 2026-09-22: a step strategy carrying workflow_step_result was
   *  matched to an authoring request). Missing = learned before scopes and
   *  resolved from the receipt's session on read. */
  scope?: RunStrategyScope;
}

export type RunStrategyScope = 'chat' | 'workflow_step';

interface StrategyFile {
  strategies: RunStrategyRecord[];
  version: 'v1';
}

const STORE_FILE = path.join(BASE_DIR, 'state', 'run-strategies.json');
const MAX_PROVEN_SHAPES = 8;
const MAX_SHAPE_CHARS = 400;

function mergeProvenShapes(
  existing: readonly ProvenCallShape[] | undefined,
  incoming: readonly ProvenCallShape[] | undefined,
): ProvenCallShape[] {
  const out: ProvenCallShape[] = [];
  const seen = new Set<string>();
  for (const row of [...(incoming ?? []), ...(existing ?? [])]) {
    const tool = String(row?.tool ?? '').trim();
    const shape = String(row?.shape ?? '').trim().slice(0, MAX_SHAPE_CHARS);
    if (!tool || !shape) continue;
    const key = `${tool}\u0000${shape}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tool, shape });
    if (out.length >= MAX_PROVEN_SHAPES) break;
  }
  return out;
}

/** The structure of one successful call's arguments with values elided.
 * Only strings that select the operation stay literal: `method` and
 * `tool_slug` always; `path` and `endpoint` only beside a `method`, where they
 * are an API route, with resource segments elided. Anywhere else a path is the
 * user's own file or resource, a value like any other. */
export function shapeOfProvenArguments(args: unknown, depth = 0): string {
  const shape = (value: unknown, key: string | null, level: number, siblings: Record<string, unknown> | null): unknown => {
    if (level > 6) return '…';
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return literalSelector(key, value, siblings) ?? 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return value.length ? [shape(value[0], null, level + 1, null)] : [];
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record).slice(0, 24)) out[k] = shape(v, k, level + 1, record);
      return out;
    }
    return typeof value;
  };
  return JSON.stringify(shape(args, null, depth, null)).slice(0, MAX_SHAPE_CHARS);
}

const ALWAYS_LITERAL_SELECTOR_KEYS: ReadonlySet<string> = new Set(['method', 'tool_slug']);
const ROUTE_SELECTOR_KEYS: ReadonlySet<string> = new Set(['path', 'endpoint']);
const SHAPE_TYPE_WORDS: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'null', '…', 'object', 'function', 'symbol', 'bigint', 'undefined']);

function literalSelector(key: string | null, value: string, siblings: Record<string, unknown> | null): string | null {
  if (!key) return null;
  if (ALWAYS_LITERAL_SELECTOR_KEYS.has(key)) return value.slice(0, 120);
  if (ROUTE_SELECTOR_KEYS.has(key) && siblings && typeof siblings.method === 'string') return elideRouteResources(value).slice(0, 120);
  return null;
}

/** An API route keeps the segments that name the operation. The origin, the
 *  query string and the fragment are dropped, and a segment that names a
 *  resource (a host-like token, a long number, an id) is elided. */
export function elideRouteResources(route: string): string {
  const withoutQuery = route.split(/[?#]/)[0] ?? '';
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(withoutQuery);
  const pathPart = schemeMatch ? (schemeMatch[1] ?? '/') : withoutQuery;
  return pathPart.split('/').map((segment) => (
    segment && (/\./.test(segment) || /\d{4,}/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment)) ? '{id}' : segment
  )).join('/');
}

/** A stored shape re-read under the current literal rule: a route beside a
 *  method keeps its operation segments; any other literal path is a value. */
export function normalizeProvenShape(shape: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(shape); } catch { return shape; }
  const walk = (value: unknown, siblings: Record<string, unknown> | null, key: string | null): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, null, null));
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record)) out[k] = walk(v, record, k);
      return out;
    }
    if (typeof value === 'string' && key && ROUTE_SELECTOR_KEYS.has(key) && !SHAPE_TYPE_WORDS.has(value)) {
      return literalSelector(key, value, siblings) ?? 'string';
    }
    return value;
  };
  return JSON.stringify(walk(parsed, null, null)).slice(0, MAX_SHAPE_CHARS);
}

/** The role of each argument in the proven calls of one tool, as dotted
 *  field paths (`data[].target`), with a literal selector shown as
 *  `path=/v3/…`. This is what a hint may carry about a past run: the shape of
 *  the work, never the values an earlier request put into it. */
export function describeProvenShapeRoles(
  shapes: readonly ProvenCallShape[] | undefined,
  tool: string,
  limits: { maxRoles?: number; maxChars?: number; maxShapes?: number } = {},
): string {
  const maxRoles = limits.maxRoles ?? 10;
  const maxChars = limits.maxChars ?? 200;
  const roles: string[] = [];
  const literals = new Map<string, string[]>();
  const add = (role: string) => { if (!roles.includes(role)) roles.push(role); };
  const walk = (value: unknown, prefix: string): void => {
    if (Array.isArray(value)) {
      if (value.length) walk(value[0], `${prefix}[]`); else add(prefix);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, prefix ? `${prefix}.${k}` : k);
      return;
    }
    if (!prefix) return;
    if (typeof value === 'string' && !SHAPE_TYPE_WORDS.has(value)) {
      const list = literals.get(prefix) ?? [];
      if (!list.includes(value)) list.push(value);
      literals.set(prefix, list);
    }
    add(prefix);
  };
  for (const row of (shapes ?? []).filter((entry) => entry.tool === tool).slice(0, limits.maxShapes ?? 4)) {
    try { walk(JSON.parse(row.shape), ''); } catch { /* a clipped shape describes nothing */ }
  }
  const text = roles.slice(0, maxRoles).map((role) => {
    const list = literals.get(role);
    return list ? `${role}=${list.slice(0, 3).join(' | ')}` : role;
  }).join(', ');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
const MAX_RECORDS = 200;
const MAX_OBJECTIVE_CHARS = 200;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'from', 'into', 'per', 'each',
  'this', 'that', 'these', 'those', 'it', 'its', 'is', 'are', 'be', 'as', 'at', 'by', 'me', 'my', 'our',
  'please', 'then', 'them', 'their', 'all', 'any', 'one', 'using', 'use', 'run', 'task', 'background',
]);

export function strategyKeywords(text: string): string[] {
  const words = (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w);
}

function readStoreRaw(): StrategyFile {
  if (!existsSync(STORE_FILE)) return { strategies: [], version: 'v1' };
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as StrategyFile;
    if (!parsed || !Array.isArray(parsed.strategies)) return { strategies: [], version: 'v1' };
    return parsed;
  } catch {
    return { strategies: [], version: 'v1' };
  }
}

/** Records learned before scopes exist resolve their scope once from the
 *  receipt's session and are written back, so a step strategy never
 *  masquerades as a chat one on the next read. */
function readStore(): StrategyFile {
  const file = readStoreRaw();
  let changed = false;
  for (const record of file.strategies) {
    if (record.scope === undefined) {
      record.scope = runStrategyScopeForSession(record.learningReceipt?.sessionId);
      changed = true;
    }
    // A shape recorded before the route rule may hold a literal file path;
    // it is re-read under the current rule once and written back.
    if (record.provenShapes?.length) {
      const normalized = record.provenShapes.map((row) => ({ tool: row.tool, shape: normalizeProvenShape(row.shape) }));
      if (normalized.some((row, index) => row.shape !== record.provenShapes![index]!.shape)) {
        record.provenShapes = mergeProvenShapes(undefined, normalized);
        changed = true;
      }
    }
  }
  if (changed) {
    try { writeStore(file); } catch { /* the in-memory view is already scoped */ }
  }
  return file;
}

function writeStore(file: StrategyFile): void {
  const dir = path.dirname(STORE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, STORE_FILE);
}

export function overlapScore(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const hits = a.filter((w) => setB.has(w)).length;
  return hits / Math.min(a.length, b.length);
}

export interface RecordRunStrategyInput {
  objective: string;
  toolsUsed: string[];
  provenShapes?: ProvenCallShape[];
  workerCount: number;
  durationMs: number;
  deliverable?: string;
  learningReceipt: LearningReceipt;
  scope?: RunStrategyScope;
}

/** The scope a receipt's session implies: a workflow-kind session learned a
 *  step strategy; anything else is a chat strategy. */
export function runStrategyScopeForSession(sessionId: string | undefined): RunStrategyScope {
  if (!sessionId) return 'chat';
  try {
    return getSession(sessionId)?.kind === 'workflow' ? 'workflow_step' : 'chat';
  } catch {
    return 'chat';
  }
}

function scopeOf(record: Pick<RunStrategyRecord, 'scope'>): RunStrategyScope {
  return record.scope ?? 'chat';
}

/** Record a successful run's shape. Near-duplicate objectives (≥0.8 keyword
 *  overlap) UPDATE the existing record — evidence accumulates, the store does
 *  not fill with restatements of the same job. */
export function recordRunStrategy(input: RecordRunStrategyInput): RunStrategyRecord | null {
  if (!isValidLearningReceipt(input.learningReceipt, { target: 'strategy' })) return null;
  const acceptedObjective = (input.objective ?? '').trim();
  const objective = acceptedObjective.slice(0, MAX_OBJECTIVE_CHARS);
  const toolsUsed = [...new Set(input.toolsUsed.map((t) => t.trim()).filter(Boolean))].slice(0, 8);
  if (!objective || toolsUsed.length === 0) return null; // a run that used no real tools teaches nothing
  const keywords = strategyKeywords(acceptedObjective);
  if (keywords.length === 0) return null;
  const file = readStore();
  const now = new Date().toISOString();
  const scope: RunStrategyScope = input.scope ?? runStrategyScopeForSession(input.learningReceipt.sessionId);
  // Evidence accumulates within a scope only: a step that restates a chat
  // request must not inflate the chat strategy's proof, or the reverse.
  const existing = file.strategies.find((s) => scopeOf(s) === scope && overlapScore(keywords, s.keywords) >= 0.8);
  if (existing) {
    // Close the write-before-learning-event crash window as well. Replaying
    // the same proof does not turn one successful run into two observations.
    if (isValidLearningReceipt(existing.learningReceipt, { target: 'strategy' })
      && existing.learningReceipt.sessionId === input.learningReceipt.sessionId
      && existing.learningReceipt.sourceId === input.learningReceipt.sourceId) return existing;
    const wasVerified = isValidLearningReceipt(existing.learningReceipt, { target: 'strategy' });
    existing.scope = scope;
    existing.objective = objective;
    existing.keywords = keywords;
    existing.toolsUsed = toolsUsed;
    existing.provenShapes = mergeProvenShapes(existing.provenShapes, input.provenShapes);
    existing.workerCount = input.workerCount;
    existing.durationMs = input.durationMs;
    if (input.deliverable?.trim()) existing.deliverable = input.deliverable.trim().slice(0, 240);
    if (!wasVerified && existing.uses > 0) existing.legacyUses = existing.uses;
    existing.uses = wasVerified ? existing.uses + 1 : 1;
    existing.lastUsedAt = now;
    existing.learningReceipt = input.learningReceipt;
    writeStore(file);
    return existing;
  }
  const record: RunStrategyRecord = {
    id: `strat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    objective,
    keywords,
    toolsUsed,
    ...(mergeProvenShapes(undefined, input.provenShapes).length ? { provenShapes: mergeProvenShapes(undefined, input.provenShapes) } : {}),
    workerCount: Math.max(0, Math.round(input.workerCount)),
    durationMs: Math.max(0, Math.round(input.durationMs)),
    ...(input.deliverable?.trim() ? { deliverable: input.deliverable.trim().slice(0, 240) } : {}),
    createdAt: now,
    uses: 1,
    learningReceipt: input.learningReceipt,
    scope,
  };
  file.strategies.push(record);
  if (file.strategies.length > MAX_RECORDS) {
    file.strategies.sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt));
    file.strategies = file.strategies.slice(0, MAX_RECORDS);
  }
  writeStore(file);
  return record;
}

/** A hint carries the shape of the work: the tools and the role of each
 *  argument. It never quotes the earlier request or what that run produced;
 *  those targets, names, figures and handles belong to that instance and
 *  would be carried into this one. */
function renderOne(s: RunStrategyRecord): string {
  const minutes = Math.max(1, Math.round(s.durationMs / 60_000));
  const shape = s.workerCount >= 2 ? `fan-out ${s.workerCount} workers` : 'single-threaded';
  const tools = s.toolsUsed.map((tool) => {
    const roles = describeProvenShapeRoles(s.provenShapes, tool);
    return roles ? `${tool} (${roles})` : tool;
  });
  return `- A proven run of this kind of request used: ${tools.join('; ')} · ${shape} · ~${minutes} min${s.uses > 1 ? ` · proven ${s.uses}×` : ''}. Use this request's own targets and values.`;
}

export interface MatchedRunStrategy {
  strategy: RunStrategyRecord;
  score: number;
}

/** Every receipt-backed strategy, newest-used first. Heartbeat schema staging reads this. */
export function listVerifiedRunStrategies(): RunStrategyRecord[] {
  return readStore().strategies
    .filter((strategy) => isValidLearningReceipt(strategy.learningReceipt, { target: 'strategy' }))
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt));
}

/** Ranked proven strategies for this objective. Empty when nothing clears the floor. */
export function listMatchingRunStrategies(
  objective: string | undefined,
  limit = 4,
  options: { scope?: RunStrategyScope | 'any' } = {},
): MatchedRunStrategy[] {
  if (!objective?.trim()) return [];
  const keywords = strategyKeywords(objective);
  if (keywords.length === 0) return [];
  const scope = options.scope ?? 'chat';
  const file = readStore();
  return file.strategies
    .filter((s) => isValidLearningReceipt(s.learningReceipt, { target: 'strategy' }))
    .filter((s) => scope === 'any' || scopeOf(s) === scope)
    .map((s) => ({ strategy: s, score: overlapScore(keywords, s.keywords) }))
    .filter((x) => x.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Shared words over all words of either side a remembered run needs before
 *  it is offered without a judgement. */
export const STRATEGY_COVERAGE_MIN_OVERLAP = 0.5;

/** Does the strategy cover the request, not merely touch it? The recall score
 *  above is containment of the SHORTER keyword list, so a two-word strategy
 *  matches any longer request that mentions one of its words, and a
 *  three-word strategy matches a four-word request about something else that
 *  shares two of them. Offering the run's tools without a judgement needs the
 *  two keyword sets to mostly coincide: shared words over all words of either
 *  side, at least half. */
export function strategyCoversRequest(request: string, strategy: Pick<RunStrategyRecord, 'keywords'>): boolean {
  const words = new Set(strategyKeywords(request));
  const known = new Set(strategy.keywords);
  if (words.size === 0 || known.size === 0) return words.size === known.size;
  let shared = 0;
  for (const word of words) if (known.has(word)) shared += 1;
  const union = words.size + known.size - shared;
  return shared / union >= STRATEGY_COVERAGE_MIN_OVERLAP;
}

/** Render the top-matching strategies for an objective, or '' when nothing
 *  clears the relevance floor (additive injection contract). A context note
 *  that names a run's tools is a recommendation made with no judgement, so
 *  only a run that covers the request is named; one that merely shares words
 *  with it is left to tool discovery. `request`, when given, is the literal
 *  accepted request the coverage is measured against (the ranking objective
 *  may also carry focus text). */
export function renderRunStrategiesForContext(objective: string | undefined, limit = 2, request?: string): string {
  const coverageText = request?.trim() || objective || '';
  // Coverage filters the whole recall before the limit applies, so a covering
  // run ranked just below one that merely shares words is still named.
  const scored = listMatchingRunStrategies(objective, Number.POSITIVE_INFINITY)
    .filter((match) => strategyCoversRequest(coverageText, match.strategy))
    .slice(0, limit);
  if (scored.length === 0) return '';
  return scored.map((x) => renderOne(x.strategy)).join('\n');
}

export interface RunStrategyLearningStats {
  total: number;
  verified: number;
  legacyExcluded: number;
}

/** Audit projection: legacy records remain on disk but cannot steer a run until
 * one clean, receipt-backed execution rehabilitates them. */
export function getRunStrategyLearningStats(): RunStrategyLearningStats {
  const strategies = readStore().strategies;
  const verified = strategies.filter((strategy) => (
    isValidLearningReceipt(strategy.learningReceipt, { target: 'strategy' })
  )).length;
  return {
    total: strategies.length,
    verified,
    legacyExcluded: strategies.length - verified,
  };
}
