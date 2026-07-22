import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

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

export interface RunStrategyRecord {
  id: string;
  objective: string;
  keywords: string[];
  toolsUsed: string[];
  workerCount: number;
  durationMs: number;
  createdAt: string;
  uses: number;
  lastUsedAt?: string;
}

interface StrategyFile {
  strategies: RunStrategyRecord[];
  version: 'v1';
}

const STORE_FILE = path.join(BASE_DIR, 'state', 'run-strategies.json');
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

function readStore(): StrategyFile {
  if (!existsSync(STORE_FILE)) return { strategies: [], version: 'v1' };
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as StrategyFile;
    if (!parsed || !Array.isArray(parsed.strategies)) return { strategies: [], version: 'v1' };
    return parsed;
  } catch {
    return { strategies: [], version: 'v1' };
  }
}

function writeStore(file: StrategyFile): void {
  const dir = path.dirname(STORE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, STORE_FILE);
}

function overlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const hits = a.filter((w) => setB.has(w)).length;
  return hits / Math.min(a.length, b.length);
}

export interface RecordRunStrategyInput {
  objective: string;
  toolsUsed: string[];
  workerCount: number;
  durationMs: number;
}

/** Record a successful run's shape. Near-duplicate objectives (≥0.8 keyword
 *  overlap) UPDATE the existing record — evidence accumulates, the store does
 *  not fill with restatements of the same job. */
export function recordRunStrategy(input: RecordRunStrategyInput): RunStrategyRecord | null {
  const objective = (input.objective ?? '').trim().slice(0, MAX_OBJECTIVE_CHARS);
  const toolsUsed = [...new Set(input.toolsUsed.map((t) => t.trim()).filter(Boolean))].slice(0, 8);
  if (!objective || toolsUsed.length === 0) return null; // a run that used no real tools teaches nothing
  const keywords = strategyKeywords(objective);
  if (keywords.length === 0) return null;
  const file = readStore();
  const now = new Date().toISOString();
  const existing = file.strategies.find((s) => overlapScore(keywords, s.keywords) >= 0.8);
  if (existing) {
    existing.toolsUsed = toolsUsed;
    existing.workerCount = input.workerCount;
    existing.durationMs = input.durationMs;
    existing.uses += 1;
    existing.lastUsedAt = now;
    writeStore(file);
    return existing;
  }
  const record: RunStrategyRecord = {
    id: `strat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    objective,
    keywords,
    toolsUsed,
    workerCount: Math.max(0, Math.round(input.workerCount)),
    durationMs: Math.max(0, Math.round(input.durationMs)),
    createdAt: now,
    uses: 1,
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
  return `- A similar past run ("${s.objective}") succeeded with: ${s.toolsUsed.join(', ')} · ${shape} · ~${minutes} min${s.uses > 1 ? ` · proven ${s.uses}×` : ''}.`;
}

/** Render the top-matching strategies for an objective, or '' when nothing
 *  clears the relevance floor (additive injection contract). */
export function renderRunStrategiesForContext(objective: string | undefined, limit = 2): string {
  if (!objective?.trim()) return '';
  const keywords = strategyKeywords(objective);
  if (keywords.length === 0) return '';
  const file = readStore();
  const scored = file.strategies
    .map((s) => ({ s, score: overlapScore(keywords, s.keywords) }))
    .filter((x) => x.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (scored.length === 0) return '';
  return scored.map((x) => renderOne(x.s)).join('\n');
}
