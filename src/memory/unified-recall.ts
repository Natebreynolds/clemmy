import { getRuntimeEnv } from '../config.js';
import { recallMemory, type MemoryEvidenceHit } from './recall-memory.js';
import type { RecallCandidateRef } from './recall-usage.js';

/** Backwards-compatible facade over the evidence-backed recall pipeline. */
export type UnifiedHitType = 'fact' | 'vault' | 'entity' | 'resource' | 'episode' | 'policy' | 'tool-recall';

export interface UnifiedHit {
  type: UnifiedHitType;
  ref: string;
  title: string;
  snippet: string;
  score: number;
  confidence?: number;
  evidence?: MemoryEvidenceHit['evidence'];
  whyRecalled?: string[];
}

export interface UnifiedRecallOptions {
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

function legacyType(hit: MemoryEvidenceHit): UnifiedHitType {
  if (hit.ref.type === 'note') return 'vault';
  if (hit.ref.type === 'procedure') return 'tool-recall';
  return hit.ref.type;
}

function recallStore(type: UnifiedHitType): 'fact' | 'note' | 'entity' | 'resource' | 'episode' | 'policy' | 'procedure' {
  if (type === 'vault') return 'note';
  if (type === 'tool-recall') return 'procedure';
  return type;
}

export function unifiedHitRecallRef(hit: Pick<UnifiedHit, 'type' | 'ref'>): RecallCandidateRef {
  return {
    type: recallStore(hit.type),
    id: hit.ref,
  };
}

export async function recallEverything(objective: string, opts: UnifiedRecallOptions = {}): Promise<UnifiedRecallResult> {
  const obj = objective.replace(/\s+/g, ' ').trim();
  if (!obj) return { objective: '', hits: [], perStore: {}, answerability: 'insufficient' };
  const result = await recallMemory(obj, {
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
  const hits = result.hits.map((hit): UnifiedHit => {
    const type = legacyType(hit);
    perStore[type] = (perStore[type] ?? 0) + 1;
    return {
      type,
      ref: String(hit.ref.id),
      title: hit.title ?? type,
      snippet: trimSnippet(hit.text),
      score: hit.score,
      confidence: hit.confidence,
      evidence: hit.evidence,
      whyRecalled: hit.whyRecalled,
    };
  });
  return { objective: obj, hits, perStore, answerability: result.answerability, diagnostics: result.diagnostics };
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
  return `[RELEVANT MEMORY — evidence-backed; answerability: ${result.answerability ?? 'partial'}${recallTag}]`;
}

function unifiedRecallLine(hit: UnifiedHit): string {
  const label: Record<UnifiedHitType, string> = {
    fact: 'FACT', vault: 'NOTE', entity: 'WHO/WHAT', resource: 'WHERE', episode: 'EPISODE', policy: 'POLICY', 'tool-recall': 'HOW',
  };
  const evidence = hit.evidence?.length ? ` [${hit.evidence.length} source${hit.evidence.length === 1 ? '' : 's'}]` : '';
  const sourceUris = [...new Set((hit.evidence ?? []).map((item) => item.sourceUri).filter((uri): uri is string => Boolean(uri)))].slice(0, 2);
  const sources = sourceUris.length > 0 ? ` [source: ${sourceUris.join(', ')}]` : '';
  const why = (hit.whyRecalled ?? []).filter(Boolean).slice(0, 3);
  const reasons = why.length > 0 ? ` [why: ${why.join('; ')}]` : '';
  const ref = unifiedHitRecallRef(hit);
  return `- [${label[hit.type]}] [ref ${ref.type}:${ref.id}] ${hit.title}${hit.snippet ? `: ${hit.snippet}` : ''}${evidence}${sources}${reasons}`;
}

function compactText(value: string | undefined, maxChars: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function unifiedPrimerLine(hit: UnifiedHit): string {
  const label: Record<UnifiedHitType, string> = {
    fact: 'FACT', vault: 'NOTE', entity: 'WHO/WHAT', resource: 'WHERE', episode: 'EPISODE', policy: 'POLICY', 'tool-recall': 'HOW',
  };
  const ref = unifiedHitRecallRef(hit);
  const title = compactText(hit.title, 160);
  const snippet = compactText(hit.snippet, 360);
  // A note ref already is the actionable vault path; repeating the same value as
  // a source URI was one of the largest avoidable primer costs. Keep at most one
  // short, distinct source locator for episode/fact refs that need it.
  const source = [...new Set((hit.evidence ?? [])
    .map((item) => item.sourceUri?.trim())
    .filter((uri): uri is string => Boolean(uri)))]
    .find((uri) => uri !== hit.ref && uri.length <= 240);
  return `- [${label[hit.type]}] [ref ${ref.type}:${ref.id}] ${title}${snippet ? `: ${snippet}` : ''}${source ? ` [source: ${source}]` : ''}`;
}

/** Exact visible candidate set for a bounded recall block. Attribution must
 * never accept a hit that was present in memory but clipped from tool output. */
export function visibleUnifiedRecallHits(result: UnifiedRecallResult, maxChars = 2400): UnifiedHit[] {
  const visible: UnifiedHit[] = [];
  let used = unifiedRecallHeader(result).length;
  for (const hit of result.hits) {
    const line = unifiedRecallLine(hit);
    if (used + line.length + 1 > maxChars) break;
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
    if (used + line.length + 1 > maxChars) break;
    visible.push(hit);
    used += line.length + 1;
  }
  return visible;
}

export function unifiedRecallEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_UNIFIED_RECALL', 'on') ?? 'on').toLowerCase() !== 'off';
}

export async function crossStoreBreadcrumbs(
  query: string,
  opts: { perStore?: number; resourceMinOverlap?: number } = {},
): Promise<string> {
  if (!unifiedRecallEnabled()) return '';
  const q = query.replace(/\s+/g, ' ').trim();
  if (!q) return '';
  try {
    const perStore = opts.perStore ?? 4;
    const result = await recallEverything(q, {
      stores: ['entity', 'resource', 'tool-recall'],
      perStore,
      limit: perStore * 3,
      resourceMinOverlap: opts.resourceMinOverlap ?? 2,
      graphDepth: 1,
    });
    if (result.hits.length === 0) return '';
    const label: Record<string, string> = { entity: 'WHO/WHAT', resource: 'WHERE', 'tool-recall': 'HOW' };
    return [
      '[ALSO IN MEMORY — people/things, places, and proven tools relevant to this message]',
      ...result.hits.map((hit) => `- [${label[hit.type] ?? hit.type}] ${hit.title}${hit.snippet ? `: ${hit.snippet}` : ''}`),
    ].join('\n');
  } catch { return ''; }
}
