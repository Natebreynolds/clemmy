import { getRuntimeEnv } from '../config.js';
import { asksForCompleteRecallSet, recallMemory, type MemoryEvidenceHit } from './recall-memory.js';
import type { RecallCandidateRef } from './recall-usage.js';

/** Backwards-compatible facade over the evidence-backed recall pipeline. */
export type UnifiedHitType = 'fact' | 'vault' | 'entity' | 'resource' | 'episode' | 'policy' | 'tool-recall' | 'deliverable';

export interface UnifiedHit {
  type: UnifiedHitType;
  ref: string;
  title: string;
  snippet: string;
  /** True when the model-facing snippet is only a prefix of the stored value. */
  truncated?: boolean;
  score: number;
  confidence?: number;
  validFrom?: string;
  validTo?: string;
  evidence?: MemoryEvidenceHit['evidence'];
  whyRecalled?: string[];
}

export interface UnifiedRecallOptions {
  purpose?: 'ambient' | 'targeted';
  limit?: number;
  perStore?: number;
  stores?: UnifiedHitType[];
  resourceMinOverlap?: number;
  graphDepth?: 0 | 1 | 2;
  asOf?: string;
  now?: string;
  timeZone?: string;
}

export interface UnifiedRecallResult {
  purpose?: 'ambient' | 'targeted';
  objective: string;
  hits: UnifiedHit[];
  perStore: Record<string, number>;
  recallId?: string;
  answerability?: 'supported' | 'partial' | 'insufficient';
  diagnostics?: { candidates: number; stores: string[]; elapsedMs: number; utilityAdjusted?: number };
}

function trimSnippet(text: string, max = 240): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Exact-value/list requests must not receive a prefix that silently drops the
 * tail of a roster. Durable facts are capped at 800 chars, so 1,200 preserves a
 * complete fact while ordinary semantic recall keeps the compact 240-char view. */
function asksForCompleteSet(objective: string): boolean {
  return asksForCompleteRecallSet(objective);
}

const LIVE_WORLD_ASK_RE =
  /\b(this month|this week|today|right now|currently|yet to close|set to close|how many|closing)\b/i;

function isLiveWorldAsk(objective: string): boolean {
  return LIVE_WORLD_ASK_RE.test(objective);
}

export function projectedRecallAnswerability(
  result: Pick<UnifiedRecallResult, 'objective' | 'answerability' | 'purpose'>,
  hits: UnifiedHit[],
): UnifiedRecallResult['answerability'] {
  if (result.purpose === 'ambient') return hits.length > 0 ? 'partial' : 'insufficient';
  const entityOrDeliverableOnly = hits.length > 0
    && hits.every((hit) => hit.type === 'entity' || hit.type === 'deliverable');
  if (entityOrDeliverableOnly && isLiveWorldAsk(result.objective)) {
    return 'partial';
  }
  if (!asksForCompleteSet(result.objective) || result.answerability !== 'supported') return result.answerability;
  // Entity/resource stubs can corroborate a roster but cannot contain the full
  // requested set. Only the long-value durable projection is allowed to certify
  // that a complete-set answer is present in what the model actually sees.
  const completeSupport = hits.some((hit) =>
    (hit.type === 'fact' || hit.type === 'policy')
    && !hit.truncated
    && (hit.evidence?.length ?? 0) > 0
    && hit.score >= 0.45);
  return completeSupport ? 'supported' : (hits.length > 0 ? 'partial' : 'insufficient');
}

function projectSnippet(text: string, max: number): { snippet: string; truncated: boolean } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return { snippet: normalized.slice(0, max), truncated: normalized.length > max };
}

function legacyType(hit: MemoryEvidenceHit): UnifiedHitType {
  if (hit.ref.type === 'note') return 'vault';
  if (hit.ref.type === 'procedure') return 'tool-recall';
  return hit.ref.type;
}

function recallStore(type: UnifiedHitType): 'fact' | 'note' | 'entity' | 'resource' | 'episode' | 'policy' | 'procedure' | 'deliverable' {
  if (type === 'vault') return 'note';
  if (type === 'tool-recall') return 'procedure';
  return type;
}

export function unifiedHitRecallRef(hit: Pick<UnifiedHit, 'type' | 'ref'> & Partial<Pick<UnifiedHit, 'title' | 'snippet'>>): RecallCandidateRef {
  // Carry what the model actually SAW (title + snippet) so post-turn auto-credit
  // can match demonstrable use against it. Identity stays type:id.
  const shown = trimSnippet([hit.title, hit.snippet].filter(Boolean).join(': '), 1_200);
  return {
    type: recallStore(hit.type),
    id: hit.ref,
    ...(shown ? { snippet: shown } : {}),
  };
}

export async function recallEverything(objective: string, opts: UnifiedRecallOptions = {}): Promise<UnifiedRecallResult> {
  const obj = objective.replace(/\s+/g, ' ').trim();
  if (!obj) return { objective: '', hits: [], perStore: {}, answerability: 'insufficient' };
  const result = await recallMemory(obj, {
    purpose: opts.purpose,
    limit: opts.limit,
    perStore: opts.perStore,
    stores: opts.stores?.map(recallStore),
    resourceMinOverlap: opts.resourceMinOverlap,
    graphDepth: opts.graphDepth,
    asOf: opts.asOf,
    now: opts.now,
    timeZone: opts.timeZone,
  });
  const perStore: Record<string, number> = {};
  const completeSet = asksForCompleteSet(obj);
  const hits = result.hits.map((hit, index): UnifiedHit => {
    const type = legacyType(hit);
    perStore[type] = (perStore[type] ?? 0) + 1;
    // ANSWERS, NOT LEADS (COMPOUNDING wave): the TOP-ranked fact/policy hit
    // carries its full durable value (up to 1,200 chars) on every query, not
    // only complete-set asks — the measured live primer delivered 240-char
    // leads and the model re-fetched what memory already held. Lower hits
    // stay compact so corroborators still fit.
    const fullValueHit = (type === 'fact' || type === 'policy')
      && (completeSet || index === 0);
    // Selected note bodies are already indexed excerpts, explicitly labeled
    // with source scope. The outer recall/primer budget admits or omits the
    // whole attributed hit; do not silently reduce it to another 240-char lead.
    const projected = type === 'vault'
      ? { snippet: hit.text, truncated: false }
      : projectSnippet(hit.text, fullValueHit ? 1_200 : 240);
    return {
      type,
      ref: String(hit.ref.id),
      title: hit.title ?? type,
      snippet: projected.snippet,
      truncated: projected.truncated,
      score: hit.score,
      confidence: hit.confidence,
      validFrom: hit.validFrom,
      validTo: hit.validTo,
      evidence: hit.evidence,
      whyRecalled: hit.whyRecalled,
    };
  });
  // `recallMemory` judges the full stored hit. A complete-set request can only
  // be called supported when at least one evidence-backed supporting hit is also
  // complete in the projection the model actually receives.
  const answerability = projectedRecallAnswerability({ objective: obj, answerability: result.answerability, purpose: opts.purpose }, hits);
  return { objective: obj, hits, perStore, answerability, diagnostics: result.diagnostics, ...(opts.purpose ? { purpose: opts.purpose } : {}) };
}

export function formatUnifiedRecall(result: UnifiedRecallResult, maxChars = 2400): string {
  if (result.hits.length === 0) return '';
  return [unifiedRecallHeader(result), ...visibleUnifiedRecallHits(result, maxChars).map(unifiedRecallLine)].join('\n');
}

/** Compact automatic-prompt projection. Full evidence counts, score reasons,
 * confidence, and graph diagnostics remain available through memory_recall_all
 * and the Memory UI; repeating them in every model prompt spends context without
 * improving the model's ability to answer or reopen the cited memory. */
export function formatUnifiedPrimer(result: UnifiedRecallResult, maxChars = 1800): string {
  if (result.hits.length === 0) return '';
  return [unifiedRecallHeader(result), ...visibleUnifiedPrimerHits(result, maxChars).map(unifiedPrimerLine)].join('\n');
}

function unifiedRecallHeader(result: UnifiedRecallResult): string {
  const recallTag = result.recallId ? `; recall: ${result.recallId}` : '';
  const scope = result.purpose === 'ambient' ? '; scope: ambient task context' : '';
  return `[RELEVANT MEMORY — evidence-backed; answerability: ${result.answerability ?? 'partial'}${scope}${recallTag}]`;
}

function unifiedTimeEvidence(hit: UnifiedHit): string {
  if (!hit.validFrom && !hit.validTo) return '';
  if ((hit.type === 'episode' || hit.type === 'vault') && hit.validFrom) {
    return ` [occurred_at: ${hit.validFrom}]`;
  }
  return `${hit.validFrom ? ` [valid_from: ${hit.validFrom}]` : ''}${hit.validTo ? ` [valid_to: ${hit.validTo}]` : ''}`;
}

function unifiedRecallLine(hit: UnifiedHit): string {
  const label: Record<UnifiedHitType, string> = {
    fact: 'FACT', vault: 'NOTE', entity: 'WHO/WHAT', resource: 'WHERE', episode: 'EPISODE', policy: 'POLICY', 'tool-recall': 'HOW', deliverable: 'YOUR WORK LIVES AT',
  };
  const evidence = hit.evidence?.length ? ` [${hit.evidence.length} source${hit.evidence.length === 1 ? '' : 's'}]` : '';
  const sourceUris = [...new Set((hit.evidence ?? []).map((item) => item.sourceUri).filter((uri): uri is string => Boolean(uri)))].slice(0, 2);
  const sources = sourceUris.length > 0 ? ` [source: ${sourceUris.join(', ')}]` : '';
  const why = (hit.whyRecalled ?? []).filter(Boolean).slice(0, 3);
  const reasons = why.length > 0 ? ` [why: ${why.join('; ')}]` : '';
  const ref = unifiedHitRecallRef(hit);
  return `- [${label[hit.type]}] [ref ${ref.type}:${ref.id}] ${hit.title}${hit.snippet ? `: ${hit.snippet}` : ''}${evidence}${sources}${reasons}${unifiedTimeEvidence(hit)}`;
}

function compactText(value: string | undefined, maxChars: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function unifiedPrimerLine(hit: UnifiedHit): string {
  const label: Record<UnifiedHitType, string> = {
    fact: 'FACT', vault: 'NOTE', entity: 'WHO/WHAT', resource: 'WHERE', episode: 'EPISODE', policy: 'POLICY', 'tool-recall': 'HOW', deliverable: 'YOUR WORK LIVES AT',
  };
  const ref = unifiedHitRecallRef(hit);
  const title = hit.type === 'vault' ? hit.title : compactText(hit.title, 160);
  // Ordinary hits are projected to <=240 chars before this formatter. A
  // fact/policy snippet longer than 360 therefore signals an exact/complete-set
  // request, where clipping the tail can silently drop roster members. Preserve
  // the complete durable value; the outer primer budget still bounds the block.
  const snippetLimit = (hit.type === 'fact' || hit.type === 'policy') && hit.snippet.length > 360
    ? 1_200
    : 360;
  const snippet = hit.type === 'vault'
    ? hit.snippet.replace(/\s+/g, ' ').trim()
    : compactText(hit.snippet, snippetLimit);
  // A note ref already is the actionable vault path; repeating the same value as
  // a source URI was one of the largest avoidable primer costs. Keep at most one
  // short, distinct source locator for episode/fact refs that need it.
  const source = [...new Set((hit.evidence ?? [])
    .map((item) => item.sourceUri?.trim())
    .filter((uri): uri is string => Boolean(uri)))]
    .find((uri) => uri !== hit.ref && uri.length <= 240);
  return `- [${label[hit.type]}] [ref ${ref.type}:${ref.id}] ${title}${snippet ? `: ${snippet}` : ''}${source ? ` [source: ${source}]` : ''}${unifiedTimeEvidence(hit)}`;
}

/** Exact visible candidate set for a bounded recall block. Attribution must
 * never accept a hit that was present in memory but clipped from tool output. */
export function visibleUnifiedRecallHits(result: UnifiedRecallResult, maxChars = 2400): UnifiedHit[] {
  const visible: UnifiedHit[] = [];
  let used = unifiedRecallHeader(result).length;
  for (const hit of result.hits) {
    const line = unifiedRecallLine(hit);
    // Skip an over-budget hit and keep going — do NOT terminate. A single large
    // hit must not discard every lower-ranked hit after it (that silently
    // dropped a roster ranked behind a pinned policy / same-day episode).
    if (used + line.length + 1 > maxChars) continue;
    visible.push(hit);
    used += line.length + 1;
  }
  return visible;
}

/** Exact visible candidate set for the compact automatic primer. Attribution
 * must use this formatter's real boundary, not the larger tool-output format. */
export function visibleUnifiedPrimerHits(result: UnifiedRecallResult, maxChars = 1800): UnifiedHit[] {
  const visible: UnifiedHit[] = [];
  let used = unifiedRecallHeader(result).length;
  for (const hit of result.hits) {
    const line = unifiedPrimerLine(hit);
    // Skip-and-continue, not break — one large hit must not discard the rest.
    if (used + line.length + 1 > maxChars) continue;
    visible.push(hit);
    used += line.length + 1;
  }
  // Never return an EMPTY primer when recall produced hits: force-include the
  // top-ranked one even if it alone exceeds the compact budget. The complete-set
  // boost ranks a durable roster first, so this guarantees the roster reaches
  // the model instead of being silently dropped (the 2026-07-19 incident).
  if (visible.length === 0 && result.hits.length > 0) visible.push(result.hits[0]);
  return visible;
}

export function unifiedRecallEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_UNIFIED_RECALL', 'on') ?? 'on').toLowerCase() !== 'off';
}

export async function crossStoreBreadcrumbs(
  query: string,
  opts: { perStore?: number; resourceMinOverlap?: number; timeoutMs?: number } = {},
): Promise<string> {
  if (!unifiedRecallEnabled()) return '';
  const q = query.replace(/\s+/g, ' ').trim();
  if (!q) return '';
  try {
    const perStore = opts.perStore ?? 4;
    const timeoutMs = Math.max(25, Math.min(15_000, opts.timeoutMs ?? 1_500));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recalled = await Promise.race([
      recallEverything(q, {
        stores: ['entity', 'resource', 'tool-recall'],
        perStore,
        limit: perStore * 3,
        resourceMinOverlap: opts.resourceMinOverlap ?? 2,
        graphDepth: 1,
      }).then((result) => ({ kind: 'result' as const, result })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (recalled.kind === 'timeout') return '';
    const result = recalled.result;
    if (result.hits.length === 0) return '';
    const label: Record<string, string> = { entity: 'WHO/WHAT', resource: 'WHERE', 'tool-recall': 'HOW' };
    return [
      '[ALSO IN MEMORY — people/things, places, and proven tools relevant to this message]',
      ...result.hits.map((hit) => `- [${label[hit.type] ?? hit.type}] ${hit.title}${hit.snippet ? `: ${hit.snippet}` : ''}`),
    ].join('\n');
  } catch { return ''; }
}
