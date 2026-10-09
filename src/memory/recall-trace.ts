import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

export const RECALL_SELECTION_TRACE_CAP = 128;
export interface RecallSelectionRef { type: string; id?: string; digest?: string }
export interface RecallSelectionRow {
  ref: RecallSelectionRef;
  rank: number;
  reason: string;
  score?: number;
  scoreBeforeDistinctiveness?: number;
  scoreAfterDistinctiveness?: number;
  distinctiveCueApplied?: boolean;
  lineChars?: number;
  rankOut?: number;
}
export interface RecallSelectionStage {
  stage: 'topK' | 'tail_selection' | 'primer_bytes';
  candidates: number;
  selected: number;
  rowsOmitted: number;
  rows: RecallSelectionRow[];
  limit?: number;
  relativeFloor?: number;
  reservedPolicySlots?: number;
  maxChars?: number;
  initialChars?: number;
}
export interface RecallSelectionDiagnostic {
  version: 1;
  asOf: string;
  admitted: number;
  stages: RecallSelectionStage[];
}

const selectionSidecars = new WeakMap<object, RecallSelectionDiagnostic>();
export function recallSelectionDiagnostic(result: object): RecallSelectionDiagnostic | undefined {
  return selectionSidecars.get(result);
}
export function retainRecallSelectionDiagnostic(result: object, diagnostic: RecallSelectionDiagnostic): void {
  selectionSidecars.set(result, diagnostic);
}

/** Exact numeric identities; opaque digests for path/URI-bearing refs. */
export function recallSelectionRef(type: string, id: string | number): RecallSelectionRef {
  const value = String(id);
  const safeType = /^(fact|policy|entity|resource|episode|note|vault|procedure|tool-recall|deliverable)$/.test(type) ? type : 'other';
  return /^(fact|policy|entity|resource)$/.test(safeType) && /^\d{1,20}$/.test(value)
    ? { type: safeType, id: value }
    : { type: safeType, digest: createHash('sha256').update(value).digest('hex') };
}

/** Keep actual selected rows even when duplicate-heavy ranking passes the cap. */
export function retainRecallSelectionRow(rows: RecallSelectionRow[], row: RecallSelectionRow): void {
  if (rows.length < RECALL_SELECTION_TRACE_CAP) { rows.push(row); return; }
  if (row.reason !== 'selected') return;
  let replace = rows.length - 1;
  while (replace >= 0 && rows[replace].reason === 'selected') replace -= 1;
  if (replace >= 0) rows[replace] = row;
}

function privateSelectionDiagnostic(diagnostic: RecallSelectionDiagnostic): RecallSelectionDiagnostic {
  const finite = (value: number | undefined): number | undefined => Number.isFinite(value) ? value : undefined;
  const count = (value: number): number => Math.max(0, Math.floor(finite(value) ?? 0));
  // Copy a whitelist only. A diagnostic caller must not accidentally persist
  // source text, excerpts, queries, paths or arbitrary fields here.
  return {
    version: 1, asOf: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(diagnostic.asOf) ? diagnostic.asOf : '',
    admitted: count(diagnostic.admitted),
    stages: diagnostic.stages.filter(stage => /^(topK|tail_selection|primer_bytes)$/.test(stage.stage)).slice(0, 3).map(stage => ({
      stage: stage.stage, candidates: count(stage.candidates), selected: count(stage.selected),
      rowsOmitted: Math.max(count(stage.rowsOmitted), stage.rows.length - RECALL_SELECTION_TRACE_CAP),
      limit: finite(stage.limit), relativeFloor: finite(stage.relativeFloor),
      reservedPolicySlots: finite(stage.reservedPolicySlots), maxChars: finite(stage.maxChars), initialChars: finite(stage.initialChars),
      rows: stage.rows.slice(0, RECALL_SELECTION_TRACE_CAP).map(row => ({
        ref: row.ref.id !== undefined ? recallSelectionRef(row.ref.type, row.ref.id)
          : { type: recallSelectionRef(row.ref.type, '').type, digest: /^[a-f0-9]{64}$/.test(row.ref.digest ?? '') ? row.ref.digest : undefined },
        rank: count(row.rank), rankOut: finite(row.rankOut),
        reason: /^(selected|similarity_duplicate|topK|core_already_visible|reserved_policy|relative_floor|byte_budget|forced_first_oversize)$/.test(row.reason) ? row.reason : 'other',
        score: finite(row.score), scoreBeforeDistinctiveness: finite(row.scoreBeforeDistinctiveness),
        scoreAfterDistinctiveness: finite(row.scoreAfterDistinctiveness),
        distinctiveCueApplied: row.distinctiveCueApplied === true, lineChars: finite(row.lineChars),
      })),
    })),
  };
}

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
  includedCount?: number;
  omittedCount?: number;
  candidateCount?: number;
  enforcementBackedCount?: number;
  /** Private bounded selection metadata. Exact source joins via recallId. */
  selection?: RecallSelectionDiagnostic & { recallId?: string; sessionId?: string };
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
  includedCount?: number;
  omittedCount?: number;
  candidateCount?: number;
  enforcementBackedCount?: number;
  selection?: RecallSelectionDiagnostic;
  recallId?: string;
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
    const hasPromptCounts = typeof input.includedCount === 'number'
      || typeof input.omittedCount === 'number'
      || typeof input.candidateCount === 'number';
    if (facts.length === 0 && !hasPromptCounts) return;
    const entry: FactRecallTraceEntry = {
      at: input.nowIso ?? new Date().toISOString(),
      surface: input.surface,
      facts,
    };
    if (typeof input.includedCount === 'number') entry.includedCount = Math.max(0, Math.floor(input.includedCount));
    if (typeof input.omittedCount === 'number') entry.omittedCount = Math.max(0, Math.floor(input.omittedCount));
    if (typeof input.candidateCount === 'number') entry.candidateCount = Math.max(0, Math.floor(input.candidateCount));
    if (typeof input.enforcementBackedCount === 'number') entry.enforcementBackedCount = Math.max(0, Math.floor(input.enforcementBackedCount));
    const query = truncate(input.query);
    const objective = truncate(input.objective);
    if (query) entry.query = query;
    if (objective) entry.objective = objective;
    if (input.mode) entry.mode = input.mode;
    if (input.sessionId) entry.sessionId = input.sessionId;
    if (input.selection) entry.selection = {
      ...privateSelectionDiagnostic(input.selection),
      ...(input.recallId && /^mr-[a-f0-9-]{36}$/.test(input.recallId) ? { recallId: input.recallId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };

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
