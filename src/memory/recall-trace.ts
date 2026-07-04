import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { ConsolidatedFact } from './facts.js';

/**
 * Bounded trace of fact recall/injection decisions.
 *
 * This is the measurement layer for memory quality: whenever a durable fact is
 * surfaced to a model or returned by an agent-facing memory tool, record which
 * facts were exposed, where, and why. It is deliberately JSONL + best-effort so
 * it never requires a DB migration and can never break prompt assembly.
 */
const TRACE_FILE = path.join(BASE_DIR, 'state', 'memory-recall-trace.jsonl');
const MAX_LINES = 3000;

export type FactRecallSurface =
  | 'facts_for_instructions'
  | 'harness_query_recall'
  | 'turn_memory_primer'
  | 'memory_search_facts'
  | 'memory_recall_all';

export interface FactRecallTraceFact {
  id: number;
  kind: string;
  reason: string;
  pinned?: boolean;
  importance?: number | null;
  accessCount?: number;
  trustLevel?: number | null;
}

export interface FactRecallTraceEntry {
  at: string;
  surface: FactRecallSurface;
  query?: string;
  objective?: string;
  mode?: string;
  sessionId?: string;
  facts: FactRecallTraceFact[];
}

function truncate(s: string | undefined, max = 500): string | undefined {
  if (!s) return undefined;
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

export function appendFactRecallTrace(input: {
  surface: FactRecallSurface;
  facts: Array<{ fact: ConsolidatedFact; reason: string }>;
  query?: string;
  objective?: string;
  mode?: string;
  sessionId?: string;
  nowIso?: string;
}): void {
  try {
    const facts = input.facts
      .filter(({ fact }) => Number.isFinite(fact.id))
      .map(({ fact, reason }) => ({
        id: fact.id,
        kind: fact.kind,
        reason,
        pinned: fact.pinned === true,
        importance: fact.importance ?? null,
        accessCount: fact.accessCount ?? 0,
        trustLevel: fact.trustLevel ?? null,
      }));
    if (facts.length === 0) return;
    const entry: FactRecallTraceEntry = {
      at: input.nowIso ?? new Date().toISOString(),
      surface: input.surface,
      facts,
    };
    const query = truncate(input.query);
    const objective = truncate(input.objective);
    if (query) entry.query = query;
    if (objective) entry.objective = objective;
    if (input.mode) entry.mode = input.mode;
    if (input.sessionId) entry.sessionId = input.sessionId;

    mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
    appendFileSync(TRACE_FILE, `${JSON.stringify(entry)}\n`);
    const lines = readFileSync(TRACE_FILE, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      writeFileSync(TRACE_FILE, `${lines.slice(-MAX_LINES).join('\n')}\n`);
    }
  } catch {
    // Best-effort observability only.
  }
}

export function readFactRecallTrace(limit = 200): FactRecallTraceEntry[] {
  try {
    if (!existsSync(TRACE_FILE)) return [];
    const lines = readFileSync(TRACE_FILE, 'utf-8').split('\n').filter(Boolean);
    return lines
      .slice(-Math.max(1, limit))
      .reverse()
      .map((line) => { try { return JSON.parse(line) as FactRecallTraceEntry; } catch { return null; } })
      .filter((entry): entry is FactRecallTraceEntry => Boolean(entry));
  } catch {
    return [];
  }
}
