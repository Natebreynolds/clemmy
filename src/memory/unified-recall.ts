import { getRuntimeEnv } from '../config.js';
import { openMemoryDb } from './db.js';
import { findSimilarFactsScored } from './facts.js';
import { recallHybrid } from './recall.js';
import { resolveEntityIdsForText } from './relations.js';
import { listResourcePointers } from './source-map.js';
import { matchToolChoicesForStep } from './tool-choice-store.js';

/**
 * Unified recall facade (WS4). Before this, "what do I know that's relevant?"
 * had to be asked of SIX siloed paths with incomparable ranking scales — facts
 * (cosine), vault (BM25+RRF), entities (no agent path at all), resources (token
 * overlap), tool-choices (jaccard) — and the model had to fire N tools and
 * rarely fired them all, so memory in an un-queried store never surfaced.
 *
 * `recallEverything` fans out to every store, ranks within each, then RRF-merges
 * onto ONE comparable scale (each store's top hit competes equally), returning a
 * single typed, budget-traded list. Reuses each store's existing ranker — no new
 * ranking logic, no behavioral change to the individual stores.
 */

export type UnifiedHitType = 'fact' | 'vault' | 'entity' | 'resource' | 'tool-recall';

export interface UnifiedHit {
  type: UnifiedHitType;
  /** Stable reference within its store (fact id, file path, entity id, resource ref, intent). */
  ref: string;
  title: string;
  snippet: string;
  /** Fused RRF score (higher = more relevant). */
  score: number;
}

export interface UnifiedRecallOptions {
  /** Total hits to return after the merge (clamped 1–50). */
  limit?: number;
  /** Per-store candidate cap before merge (clamped 1–20). */
  perStore?: number;
  /** Restrict which stores participate. Default: all. */
  stores?: UnifiedHitType[];
  /** Minimum query-token overlap for a RESOURCE hit (default 1). The resource
   *  store matches on shared tokens; a floor of 1 surfaces a resource on a single
   *  common word ("report"). Auto-recall callers (the turn primer) pass a stricter
   *  floor so a lone common token doesn't inject an off-topic resource every turn. */
  resourceMinOverlap?: number;
}

export interface UnifiedRecallResult {
  objective: string;
  hits: UnifiedHit[];
  /** Candidate counts per store (pre-merge) — observability. */
  perStore: Record<string, number>;
}

// Standard RRF constant (matches recall.ts). Each store contributes
// 1/(RRF_K + rankWithinStore), so every store's #1 scores identically and the
// merge interleaves fairly rather than letting one store's scale dominate.
const RRF_K = 60;

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function rrf(rank: number): number { return 1 / (RRF_K + rank); }
function trimSnippet(s: string, n = 240): string { return (s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

export async function recallEverything(objective: string, opts: UnifiedRecallOptions = {}): Promise<UnifiedRecallResult> {
  const obj = (objective || '').trim();
  const limit = clamp(opts.limit ?? 12, 1, 50);
  const perStore = clamp(opts.perStore ?? 6, 1, 20);
  const want = new Set<UnifiedHitType>(opts.stores ?? ['fact', 'vault', 'entity', 'resource', 'tool-recall']);
  const perStoreCounts: Record<string, number> = {};
  if (!obj) return { objective: obj, hits: [], perStore: perStoreCounts };

  const hits: UnifiedHit[] = [];
  const add = (type: UnifiedHitType, ref: string, title: string, snippet: string, rank: number) => {
    hits.push({ type, ref, title, snippet: trimSnippet(snippet), score: rrf(rank) });
  };

  // Each store is independently guarded — one failing store never sinks recall.
  // Facts + vault are async (may embed); the rest are sync over local stores.
  const tasks: Array<Promise<void>> = [];

  if (want.has('fact')) {
    tasks.push((async () => {
      try {
        const scored = await findSimilarFactsScored(obj, { topK: perStore });
        perStoreCounts.fact = scored.length;
        scored.forEach((s, i) => add('fact', String(s.fact.id), `${s.fact.kind} fact`, s.fact.content, i + 1));
      } catch { perStoreCounts.fact = 0; }
    })());
  }

  if (want.has('vault')) {
    tasks.push((async () => {
      try {
        const vault = await recallHybrid(obj, { limit: perStore });
        perStoreCounts.vault = vault.length;
        vault.forEach((h, i) => add('vault', h.filePath, h.title, h.snippet, i + 1));
      } catch { perStoreCounts.vault = 0; }
    })());
  }

  await Promise.all(tasks);

  // Sync stores.
  if (want.has('entity')) {
    try {
      const ids = resolveEntityIdsForText(obj, perStore);
      perStoreCounts.entity = ids.length;
      if (ids.length > 0) {
        const db = openMemoryDb();
        const ph = ids.map(() => '?').join(',');
        const rows = db.prepare(`SELECT id, entity_type, canonical_name, mention_count FROM entities WHERE id IN (${ph})`).all(...ids) as Array<{ id: number; entity_type: string; canonical_name: string; mention_count: number }>;
        const byId = new Map(rows.map((r) => [r.id, r]));
        ids.forEach((id, i) => {
          const r = byId.get(id);
          if (r) add('entity', String(r.id), r.canonical_name, `${r.entity_type} · mentioned ${r.mention_count}×`, i + 1);
        });
      }
    } catch { perStoreCounts.entity = 0; }
  }

  if (want.has('resource')) {
    try {
      const objTokens = new Set(obj.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
      const minOverlap = Math.max(1, opts.resourceMinOverlap ?? 1);
      const scored = listResourcePointers({ limit: 200 })
        .map((p) => {
          const hay = `${p.name} ${p.whatsHere ?? ''} ${p.whenToUse ?? ''}`.toLowerCase();
          let overlap = 0;
          for (const t of objTokens) if (hay.includes(t)) overlap += 1;
          return { p, overlap };
        })
        .filter((x) => x.overlap >= minOverlap)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, perStore);
      perStoreCounts.resource = scored.length;
      scored.forEach((x, i) => add('resource', x.p.ref, x.p.name, `${x.p.app}${x.p.whatsHere ? ` · ${x.p.whatsHere}` : ''}`, i + 1));
    } catch { perStoreCounts.resource = 0; }
  }

  if (want.has('tool-recall')) {
    try {
      const matches = matchToolChoicesForStep(obj, { limit: perStore });
      perStoreCounts['tool-recall'] = matches.length;
      matches.forEach((m, i) => {
        add('tool-recall', m.intent, m.intent, `proven tool → ${m.kind}:${m.identifier}`, i + 1);
      });
    } catch { perStoreCounts['tool-recall'] = 0; }
  }

  hits.sort((a, b) => b.score - a.score);
  return { objective: obj, hits: hits.slice(0, limit), perStore: perStoreCounts };
}

/** Render a unified recall result as a compact context block. */
export function formatUnifiedRecall(result: UnifiedRecallResult, maxChars = 2400): string {
  if (result.hits.length === 0) return '';
  const label: Record<UnifiedHitType, string> = {
    fact: 'FACT', vault: 'NOTE', entity: 'WHO/WHAT', resource: 'WHERE', 'tool-recall': 'HOW',
  };
  const lines: string[] = ['[RELEVANT MEMORY — facts, notes, people, places, proven tools — ranked across all stores]'];
  let used = lines[0].length;
  for (const h of result.hits) {
    const line = `- [${label[h.type]}] ${h.title}${h.snippet ? `: ${h.snippet}` : ''}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/** Whether the auto-injected cross-store recall breadcrumbs are enabled (default
 *  on; kill-switch CLEMMY_UNIFIED_RECALL=off). */
export function unifiedRecallEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_UNIFIED_RECALL', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** Wave 2 Move A: a compact, appendable cross-store breadcrumbs block for the
 *  turn context — the entity (who/what), resource (where), and proven-tool (how)
 *  stores that had NO per-turn auto-recall before. SYNC sqlite stores ONLY (no
 *  fact/vault → no embed, no network → zero first-token latency); facts/vault keep
 *  their existing recency/trust-aware paths, so no stale-fact injection. Self-
 *  gating (returns '' when disabled or on empty/no-hit/throw), so callers just
 *  append it. Shared by BOTH brain lanes (loop primer + Claude SDK brain context). */
export async function crossStoreBreadcrumbs(
  query: string,
  opts: { perStore?: number; resourceMinOverlap?: number } = {},
): Promise<string> {
  if (!unifiedRecallEnabled()) return '';
  const q = (query || '').replace(/\s+/g, ' ').trim();
  if (!q) return '';
  try {
    const perStore = opts.perStore ?? 4;
    const result = await recallEverything(q, {
      stores: ['entity', 'resource', 'tool-recall'],
      perStore,
      limit: perStore * 3,
      // Stricter resource floor than general recall: a lone shared common word
      // must not inject an off-topic resource into every turn context.
      resourceMinOverlap: opts.resourceMinOverlap ?? 2,
    });
    if (result.hits.length === 0) return '';
    const label: Record<string, string> = { entity: 'WHO/WHAT', resource: 'WHERE', 'tool-recall': 'HOW' };
    const lines = ['[ALSO IN MEMORY — people/things, places, and proven tools relevant to this message]'];
    for (const h of result.hits) {
      lines.push(`- [${label[h.type] ?? h.type}] ${h.title}${h.snippet ? `: ${h.snippet}` : ''}`);
    }
    return lines.join('\n');
  } catch { return ''; }
}
