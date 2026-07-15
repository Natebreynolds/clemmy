import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { openMemoryDb } from './db.js';
import { searchFactsByText } from './facts.js';
import { recallMemory, type MemoryRecallResult } from './recall-memory.js';

const TRACE_FILE = path.join(BASE_DIR, 'state', 'memory-recall-shadow.jsonl');
const MAX_LINES = 5_000;

export type RecallShadowSurface = 'automatic_primer' | 'claude_primer' | 'memory_recall_all' | 'console_search';

export interface RecallShadowEntry {
  at: string;
  surface: RecallShadowSurface;
  queryHash: string;
  primaryFactIds: number[];
  legacyFactIds: number[];
  primaryOnlyFactIds: number[];
  legacyOnlyFactIds: number[];
  overlap: number;
  tailFactIds: number[];
  evidenceBacked: number;
  primaryFacts: number;
  answerability: MemoryRecallResult['answerability'];
  elapsedMs: number;
}

export interface RecallShadowSummary {
  samples: number;
  averageOverlap: number;
  primaryOnly: number;
  legacyOnly: number;
  tailHits: number;
  evidenceBacked: number;
  primaryFacts: number;
  evidenceRate: number;
  supported: number;
  lastAt: string | null;
  bySurface: Record<string, number>;
}

function enabled(): boolean {
  return (getRuntimeEnv('CLEMMY_MEMORY_RECALL_SHADOW', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

function sampleRate(): number {
  const raw = Number.parseFloat(getRuntimeEnv('CLEMMY_MEMORY_RECALL_SHADOW_SAMPLE_RATE', '0.1') ?? '0.1');
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.1;
}

function sampled(): boolean {
  return enabled() && Math.random() < sampleRate();
}

function factIds(result: MemoryRecallResult, limit: number): number[] {
  return result.hits
    .filter((hit) => hit.ref.type === 'fact')
    .map((hit) => Number(hit.ref.id))
    .filter(Number.isFinite)
    .slice(0, limit);
}

function tailFactIds(ids: number[]): number[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = openMemoryDb().prepare(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at DESC, id DESC) AS recency_rank
      FROM consolidated_facts WHERE active = 1
    )
    SELECT id FROM ranked WHERE id IN (${placeholders}) AND recency_rank > 500
  `).all(...ids) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

function append(entry: RecallShadowEntry): void {
  try {
    mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
    appendFileSync(TRACE_FILE, `${JSON.stringify(entry)}\n`);
    const lines = readFileSync(TRACE_FILE, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) writeFileSync(TRACE_FILE, `${lines.slice(-MAX_LINES).join('\n')}\n`);
  } catch {
    // Shadow measurement must never affect recall or prompt assembly.
  }
}

/** Compare evidence-backed graph recall with the legacy lexical fact path.
 * This function is awaited in tests and may be given an already-computed
 * primary result by tool/console callers; automatic primer callers let it run
 * the primary path off to the side. */
export async function compareRecallShadow(input: {
  query: string;
  surface: RecallShadowSurface;
  limit?: number;
  primary?: MemoryRecallResult;
  nowIso?: string;
}): Promise<RecallShadowEntry | null> {
  const query = input.query.replace(/\s+/g, ' ').trim();
  if (!query) return null;
  const started = Date.now();
  const limit = Math.max(1, Math.min(30, input.limit ?? 10));
  const primary = input.primary ?? await recallMemory(query, { stores: ['fact'], graphDepth: 1, limit });
  const primaryIds = factIds(primary, limit);
  const legacyIds = searchFactsByText(query, limit).map((fact) => fact.id);
  const primarySet = new Set(primaryIds);
  const legacySet = new Set(legacyIds);
  const intersection = primaryIds.filter((id) => legacySet.has(id)).length;
  const union = new Set([...primaryIds, ...legacyIds]).size;
  const evidenceBacked = primary.hits.filter((hit) =>
    hit.ref.type === 'fact' && primarySet.has(Number(hit.ref.id)) && hit.evidence.length > 0).length;
  const entry: RecallShadowEntry = {
    at: input.nowIso ?? new Date().toISOString(),
    surface: input.surface,
    queryHash: createHash('sha256').update(query).digest('hex').slice(0, 16),
    primaryFactIds: primaryIds,
    legacyFactIds: legacyIds,
    primaryOnlyFactIds: primaryIds.filter((id) => !legacySet.has(id)),
    legacyOnlyFactIds: legacyIds.filter((id) => !primarySet.has(id)),
    overlap: union > 0 ? intersection / union : 1,
    tailFactIds: tailFactIds(primaryIds),
    evidenceBacked,
    primaryFacts: primaryIds.length,
    answerability: primary.answerability,
    elapsedMs: Date.now() - started,
  };
  append(entry);
  return entry;
}

/** Sampled fire-and-forget wrapper for prompt paths. */
export function scheduleRecallShadow(input: {
  query: string;
  surface: RecallShadowSurface;
  limit?: number;
  primary?: MemoryRecallResult;
}): void {
  if (!sampled()) return;
  void compareRecallShadow(input).catch(() => undefined);
}

export function readRecallShadowEntries(limit = 500): RecallShadowEntry[] {
  try {
    if (!existsSync(TRACE_FILE)) return [];
    return readFileSync(TRACE_FILE, 'utf-8').split('\n').filter(Boolean)
      .slice(-Math.max(1, limit))
      .map((line) => { try { return JSON.parse(line) as RecallShadowEntry; } catch { return null; } })
      .filter((entry): entry is RecallShadowEntry => Boolean(entry));
  } catch { return []; }
}

export function readRecallShadowSummary(limit = 500): RecallShadowSummary {
  const entries = readRecallShadowEntries(limit);
  const sums = entries.reduce((acc, entry) => {
    acc.overlap += entry.overlap;
    acc.primaryOnly += entry.primaryOnlyFactIds.length;
    acc.legacyOnly += entry.legacyOnlyFactIds.length;
    acc.tailHits += entry.tailFactIds.length;
    acc.evidenceBacked += entry.evidenceBacked;
    acc.primaryFacts += entry.primaryFacts;
    acc.supported += entry.answerability === 'supported' ? 1 : 0;
    acc.bySurface[entry.surface] = (acc.bySurface[entry.surface] ?? 0) + 1;
    return acc;
  }, { overlap: 0, primaryOnly: 0, legacyOnly: 0, tailHits: 0, evidenceBacked: 0, primaryFacts: 0, supported: 0, bySurface: {} as Record<string, number> });
  return {
    samples: entries.length,
    averageOverlap: entries.length > 0 ? sums.overlap / entries.length : 0,
    primaryOnly: sums.primaryOnly,
    legacyOnly: sums.legacyOnly,
    tailHits: sums.tailHits,
    evidenceBacked: sums.evidenceBacked,
    primaryFacts: sums.primaryFacts,
    evidenceRate: sums.primaryFacts > 0 ? sums.evidenceBacked / sums.primaryFacts : 0,
    supported: sums.supported,
    lastAt: entries.at(-1)?.at ?? null,
    bySurface: sums.bySurface,
  };
}
