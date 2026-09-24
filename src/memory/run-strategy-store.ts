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
 * Strings under `method`, `path`, `endpoint` and `tool_slug` stay literal: they
 * select the operation, they are not the user's data. */
export function shapeOfProvenArguments(args: unknown, depth = 0): string {
  const shape = (value: unknown, key: string | null, level: number): unknown => {
    if (level > 6) return '…';
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return key && LITERAL_SHAPE_KEYS.has(key) ? value.slice(0, 120) : 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return value.length ? [shape(value[0], null, level + 1)] : [];
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 24)) out[k] = shape(v, k, level + 1);
      return out;
    }
    return typeof value;
  };
  return JSON.stringify(shape(args, null, depth)).slice(0, MAX_SHAPE_CHARS);
}

const LITERAL_SHAPE_KEYS: ReadonlySet<string> = new Set(['method', 'path', 'endpoint', 'tool_slug']);
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
    if (record.scope !== undefined) continue;
    record.scope = runStrategyScopeForSession(record.learningReceipt?.sessionId);
    changed = true;
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

function renderOne(s: RunStrategyRecord): string {
  const minutes = Math.max(1, Math.round(s.durationMs / 60_000));
  const shape = s.workerCount >= 2 ? `fan-out ${s.workerCount} workers` : 'single-threaded';
  const produced = s.deliverable ? ` → produced ${s.deliverable}` : '';
  return `- A similar past run ("${s.objective}") succeeded with: ${s.toolsUsed.join(', ')} · ${shape} · ~${minutes} min${s.uses > 1 ? ` · proven ${s.uses}×` : ''}${produced}.`;
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

/** Render the top-matching strategies for an objective, or '' when nothing
 *  clears the relevance floor (additive injection contract). */
export function renderRunStrategiesForContext(objective: string | undefined, limit = 2): string {
  const scored = listMatchingRunStrategies(objective, limit);
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
