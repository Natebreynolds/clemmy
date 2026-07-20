import { getRuntimeEnv } from '../config.js';
import { getFact, recordFactImpression, type ConsolidatedFact } from './facts.js';
import { appendFactRecallTrace } from './recall-trace.js';
import {
  formatUnifiedPrimer,
  projectedRecallAnswerability,
  recallEverything,
  unifiedHitRecallRef,
  visibleUnifiedPrimerHits,
  type UnifiedRecallResult,
} from './unified-recall.js';
import { createRecallRunId, recordRecallRun } from './recall-usage.js';

export type UnifiedPrimerSurface = 'automatic_primer' | 'claude_primer' | 'legacy_assistant_primer';

export interface UnifiedTurnPrimerResult {
  status: 'ok' | 'empty' | 'timeout' | 'error' | 'disabled';
  query: string;
  text?: string;
  hitCount: number;
  retrievedHitCount: number;
  omittedHitCount: number;
  injectedBytes: number;
  recallId?: string;
  answerability?: 'supported' | 'partial' | 'insufficient';
  diagnostics?: { candidates: number; stores: string[]; elapsedMs: number };
  error?: string;
}

type RecallEverythingFn = typeof recallEverything;
let recallEverythingImpl: RecallEverythingFn = recallEverything;

/** Test seam for timeout/error parity without stalling the real embedding path. */
export function _setUnifiedTurnPrimerRecallForTest(fn: RecallEverythingFn | null): void {
  recallEverythingImpl = fn ?? recallEverything;
}

export function unifiedTurnPrimerEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_UNIFIED_TURN_PRIMER', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

async function recallWithin(
  query: string,
  options: Parameters<RecallEverythingFn>[1],
  timeoutMs: number,
): Promise<{ kind: 'result'; result: UnifiedRecallResult } | { kind: 'timeout' } | { kind: 'error'; error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const recallPromise = recallEverythingImpl(query, options)
    .then((result) => ({ kind: 'result' as const, result }))
    .catch((error: unknown) => ({ kind: 'error' as const, error }));
  try {
    return await Promise.race([
      recallPromise,
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function visibleFactIds(result: UnifiedRecallResult): number[] {
  return [...new Set(result.hits
    .filter((hit) => hit.type === 'fact' || hit.type === 'policy')
    .map((hit) => Number(hit.ref))
    .filter(Number.isFinite))];
}

function recordPrimerExposure(
  result: UnifiedRecallResult,
  query: string,
  surface: UnifiedPrimerSurface,
  counts: { retrieved: number; included: number },
  sessionId?: string,
): void {
  const facts: ConsolidatedFact[] = [];
  for (const id of visibleFactIds(result)) {
    try { recordFactImpression(id); } catch { /* best effort */ }
    try {
      const fact = getFact(id);
      if (fact) facts.push(fact);
    } catch { /* best effort */ }
  }
  appendFactRecallTrace({
    surface: 'turn_memory_primer',
    query,
    mode: surface,
    sessionId,
    facts: facts.map((fact) => ({ fact, reason: 'unified-evidence-primer' })),
    includedCount: counts.included,
    omittedCount: Math.max(0, counts.retrieved - counts.included),
    candidateCount: result.diagnostics?.candidates ?? counts.retrieved,
  });
}

/**
 * One bounded evidence-backed primer used by both flagship agent lanes.
 * Callers retain their old primer only as a timeout/error/kill-switch fallback.
 * Every visible ref is attributable; anything clipped by the prompt budget is
 * excluded from the durable recall run and cannot receive utility credit.
 */
export async function buildUnifiedTurnPrimer(input: {
  query: string;
  surface: UnifiedPrimerSurface;
  limit?: number;
  maxChars?: number;
  timeoutMs?: number;
  now?: string;
  timeZone?: string;
  /** Optional owning session for prompt-exposure observability. */
  sessionId?: string;
}): Promise<UnifiedTurnPrimerResult> {
  const started = Date.now();
  const query = input.query.replace(/\s+/g, ' ').trim();
  if (!unifiedTurnPrimerEnabled()) {
    return { status: 'disabled', query, hitCount: 0, retrievedHitCount: 0, omittedHitCount: 0, injectedBytes: 0 };
  }
  if (!query) return { status: 'empty', query, hitCount: 0, retrievedHitCount: 0, omittedHitCount: 0, injectedBytes: 0, answerability: 'insufficient' };

  const timeoutMs = Math.max(25, Math.min(15_000, input.timeoutMs ?? 1_500));
  const recalled = await recallWithin(query, {
    limit: Math.max(1, Math.min(20, input.limit ?? 8)),
    graphDepth: 1,
    now: input.now,
    timeZone: input.timeZone,
  }, timeoutMs);
  if (recalled.kind === 'timeout') {
    return { status: 'timeout', query, hitCount: 0, retrievedHitCount: 0, omittedHitCount: 0, injectedBytes: 0, diagnostics: { candidates: 0, stores: [], elapsedMs: Date.now() - started } };
  }
  if (recalled.kind === 'error') {
    return {
      status: 'error',
      query,
      hitCount: 0,
      retrievedHitCount: 0,
      omittedHitCount: 0,
      injectedBytes: 0,
      diagnostics: { candidates: 0, stores: [], elapsedMs: Date.now() - started },
      error: recalled.error instanceof Error ? recalled.error.message : String(recalled.error),
    };
  }

  const result = recalled.result;
  if (result.hits.length === 0) {
    recordPrimerExposure(result, query, input.surface, { retrieved: 0, included: 0 }, input.sessionId);
    return {
      status: 'empty', query, hitCount: 0, retrievedHitCount: 0, omittedHitCount: 0, injectedBytes: 0,
      answerability: result.answerability ?? 'insufficient', diagnostics: result.diagnostics,
    };
  }

  // Defensive identity deduplication at the prompt boundary. The shared
  // ranker normally collapses these already, but an adapter or future store
  // must never make the model pay twice for the same canonical memory ref.
  const seenRefs = new Set<string>();
  result.hits = result.hits.filter((hit) => {
    const ref = unifiedHitRecallRef(hit);
    const key = `${ref.type}:${ref.id}`;
    if (seenRefs.has(key)) return false;
    seenRefs.add(key);
    return true;
  });

  const recallId = createRecallRunId();
  result.recallId = recallId;
  const preamble = '[MEMORY PRIMER]';
  const useRule = 'Use relevant hits: answer directly from a complete evidence-backed FACT for local-memory questions. Treat partial snippets as leads; load a cited source before external writes or when exact requested values are missing.';
  // The [USAGE] mark-used trailer was subtracted 2026-07-16 — usage credit is
  // now attributed in code post-turn (recall-auto-credit.ts). Its budget share
  // goes to the hits themselves.
  const maxChars = Math.max(700, Math.min(12_000, input.maxChars ?? 2_600));
  const recallBudget = Math.max(0, maxChars - preamble.length - useRule.length - 2);
  const retrievedHitCount = result.hits.length;
  result.hits = visibleUnifiedPrimerHits(result, recallBudget);
  result.answerability = projectedRecallAnswerability(result, result.hits);
  if (result.hits.length === 0) {
    recordPrimerExposure(result, query, input.surface, { retrieved: retrievedHitCount, included: 0 }, input.sessionId);
    return {
      status: 'empty', query, hitCount: 0, retrievedHitCount, omittedHitCount: retrievedHitCount, injectedBytes: 0,
      answerability: result.answerability ?? 'partial', diagnostics: result.diagnostics,
    };
  }

  let persistedRecallId: string | undefined;
  try {
    const run = recordRecallRun({
      id: recallId,
      objective: query,
      surface: input.surface,
      answerability: result.answerability ?? 'partial',
      candidateRefs: result.hits.map(unifiedHitRecallRef),
    });
    persistedRecallId = run.id;
  } catch {
    delete result.recallId;
  }

  recordPrimerExposure(
    result,
    query,
    input.surface,
    { retrieved: retrievedHitCount, included: result.hits.length },
    input.sessionId,
  );
  const block = formatUnifiedPrimer(result, recallBudget);
  const text = [preamble, useRule, block].join('\n');
  return {
    status: 'ok',
    query,
    text,
    hitCount: result.hits.length,
    retrievedHitCount,
    omittedHitCount: retrievedHitCount - result.hits.length,
    injectedBytes: Buffer.byteLength(text, 'utf8'),
    recallId: persistedRecallId,
    answerability: result.answerability ?? 'partial',
    diagnostics: result.diagnostics,
  };
}
