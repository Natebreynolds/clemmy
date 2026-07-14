import { getRuntimeEnv } from '../config.js';
import { recallMemory, type MemoryEvidenceHit } from './recall-memory.js';

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
}

export interface UnifiedRecallResult {
  objective: string;
  hits: UnifiedHit[];
  perStore: Record<string, number>;
  answerability?: 'supported' | 'partial' | 'insufficient';
  diagnostics?: { candidates: number; stores: string[]; elapsedMs: number };
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
  const label: Record<UnifiedHitType, string> = {
    fact: 'FACT', vault: 'NOTE', entity: 'WHO/WHAT', resource: 'WHERE', episode: 'EPISODE', policy: 'POLICY', 'tool-recall': 'HOW',
  };
  const lines = [`[RELEVANT MEMORY — evidence-backed; answerability: ${result.answerability ?? 'partial'}]`];
  let used = lines[0].length;
  for (const hit of result.hits) {
    const evidence = hit.evidence?.length ? ` [${hit.evidence.length} source${hit.evidence.length === 1 ? '' : 's'}]` : '';
    const line = `- [${label[hit.type]}] ${hit.title}${hit.snippet ? `: ${hit.snippet}` : ''}${evidence}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
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
