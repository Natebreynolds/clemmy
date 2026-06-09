/**
 * Memory-refinement DETECTORS — the "auto research for memory" P0 layer.
 *
 * Pure, READ-ONLY analysis of the consolidated_facts store that surfaces the
 * cleanup work a closed observe→propose→apply loop would do: near-duplicate
 * clusters, internal-tool noise, stale clutter, and high-value facts that never
 * get recalled. Nothing here mutates the store — it only reports candidates for
 * the Evolution page. P1 (auto-apply the provably-safe class) and P2/P3
 * (approval-gated contradiction/merge) build on these signals.
 *
 * Cheap by construction: candidate generation uses the embeddings we ALREADY
 * stored (in-memory cosine, no API calls) plus SQL — so it's safe to compute on
 * a page load / nightly tick.
 */
import { openMemoryDb } from '../memory/db.js';
import { cosine, loadFactEmbeddings } from '../memory/embeddings.js';
import { isSelfReferentialTool } from '../memory/reflection.js';

export interface RefinementCandidate {
  id: number;
  kind: string;
  content: string;
  importance: number | null;
  meta?: string;
}
export interface DuplicatePair {
  kind: string;
  keepId: number;
  dropId: number;
  similarity: number;
  keep: string;
  drop: string;
}
export interface MemoryRefinements {
  /** Near-duplicate pairs (cosine ≥ threshold) — keep the higher-scored, drop the other. */
  duplicates: { count: number; capped: boolean; pairs: DuplicatePair[] };
  /** Facts derived from Clementine's own introspective tools (memory_read,
   *  task_list, execution_*, …) — low-value self-referential noise. */
  internalNoise: { count: number; byTool: Array<{ tool: string; count: number }>; examples: RefinementCandidate[] };
  /** Old, low-importance, never-recalled facts. */
  stale: { count: number; examples: RefinementCandidate[] };
  /** High-importance / high-trust facts that have NEVER been recalled. */
  recallGaps: { count: number; examples: RefinementCandidate[] };
  totalCandidates: number;
  generatedAt: string;
}

const KINDS = ['user', 'project', 'feedback', 'reference'] as const;
// Show near-dups at/above this. The nightly mechanical dedup folds ≥0.95
// automatically; the 0.90–0.95 band is exactly what needs human review.
const DUP_MIN_SIM = 0.90;
const DUP_MAX_PAIRS = 20;
const PER_KIND_SCAN = 1200;

interface FactRow { id: number; kind: string; content: string; score: number; importance: number | null; derived_from_tool: string | null; }

function trunc(s: string, n = 96): string {
  const c = s.replace(/\s+/g, ' ').trim();
  return c.length > n ? c.slice(0, n) + '…' : c;
}

/** Near-duplicate detection via the already-stored fact embeddings (no API). */
export function detectDuplicates(): MemoryRefinements['duplicates'] {
  const db = openMemoryDb();
  const pairs: DuplicatePair[] = [];
  const dropped = new Set<number>();
  let capped = false;
  for (const kind of KINDS) {
    const rows = db.prepare(
      `SELECT id, content, score FROM consolidated_facts
       WHERE active = 1 AND kind = ? AND pinned = 0
       ORDER BY updated_at DESC LIMIT ?`,
    ).all(kind, PER_KIND_SCAN) as { id: number; content: string; score: number }[];
    const vecs = loadFactEmbeddings(rows.map((r) => r.id));
    const embedded = rows.filter((r) => vecs.has(r.id));
    for (let i = 0; i < embedded.length; i += 1) {
      const a = embedded[i];
      if (dropped.has(a.id)) continue;
      const va = vecs.get(a.id);
      if (!va) continue;
      for (let j = i + 1; j < embedded.length; j += 1) {
        const b = embedded[j];
        if (dropped.has(b.id)) continue;
        const vb = vecs.get(b.id);
        if (!vb) continue;
        const sim = cosine(va, vb);
        if (sim < DUP_MIN_SIM) continue;
        const keep = a.score >= b.score ? a : b;
        const drop = keep === a ? b : a;
        if (pairs.length < DUP_MAX_PAIRS) {
          pairs.push({ kind, keepId: keep.id, dropId: drop.id, similarity: Math.round(sim * 1000) / 1000, keep: trunc(keep.content), drop: trunc(drop.content) });
        } else {
          capped = true;
        }
        dropped.add(drop.id);
        if (drop.id === a.id) break;
      }
    }
  }
  return { count: dropped.size, capped, pairs };
}

/** Facts derived from Clementine's own introspective tools — self-referential noise. */
export function detectInternalNoise(maxExamples = 6): MemoryRefinements['internalNoise'] {
  const db = openMemoryDb();
  const rows = db.prepare(
    `SELECT id, kind, content, importance, derived_from_tool FROM consolidated_facts
     WHERE active = 1 AND pinned = 0 AND derived_from_tool IS NOT NULL`,
  ).all() as FactRow[];
  const noise = rows.filter((r) => isSelfReferentialTool(r.derived_from_tool));
  const byToolMap = new Map<string, number>();
  for (const r of noise) {
    const t = r.derived_from_tool ?? 'unknown';
    byToolMap.set(t, (byToolMap.get(t) ?? 0) + 1);
  }
  const byTool = [...byToolMap.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count);
  const examples = noise.slice(0, maxExamples).map((r) => ({ id: r.id, kind: r.kind, content: trunc(r.content), importance: r.importance, meta: r.derived_from_tool ?? undefined }));
  return { count: noise.length, byTool, examples };
}

/** Old, low-importance, never-recalled facts. */
export function detectStale(maxExamples = 6): MemoryRefinements['stale'] {
  const db = openMemoryDb();
  const rows = db.prepare(
    `SELECT id, kind, content, importance FROM consolidated_facts
     WHERE active = 1 AND pinned = 0
       AND COALESCE(importance, 5) <= 4
       AND (last_accessed_at IS NULL OR last_accessed_at <= datetime(created_at, '+2 seconds'))
       AND julianday('now') - julianday(created_at) > 21
     ORDER BY created_at ASC LIMIT 500`,
  ).all() as FactRow[];
  const examples = rows.slice(0, maxExamples).map((r) => ({ id: r.id, kind: r.kind, content: trunc(r.content), importance: r.importance }));
  return { count: rows.length, examples };
}

/** High-importance / high-trust facts that have never been recalled. */
export function detectRecallGaps(maxExamples = 6): MemoryRefinements['recallGaps'] {
  const db = openMemoryDb();
  const rows = db.prepare(
    `SELECT id, kind, content, importance FROM consolidated_facts
     WHERE active = 1 AND pinned = 0
       AND (COALESCE(importance, 5) >= 7 OR trust_level = 1.0)
       AND (last_accessed_at IS NULL OR last_accessed_at <= datetime(created_at, '+2 seconds'))
       AND julianday('now') - julianday(created_at) > 7
     ORDER BY COALESCE(importance, 5) DESC LIMIT 500`,
  ).all() as FactRow[];
  const examples = rows.slice(0, maxExamples).map((r) => ({ id: r.id, kind: r.kind, content: trunc(r.content), importance: r.importance }));
  return { count: rows.length, examples };
}

/** Run all detectors. Pure read-only; safe on a page load / nightly tick. */
export function computeMemoryRefinements(nowIso: string = new Date().toISOString()): MemoryRefinements {
  const duplicates = detectDuplicates();
  const internalNoise = detectInternalNoise();
  const stale = detectStale();
  const recallGaps = detectRecallGaps();
  return {
    duplicates,
    internalNoise,
    stale,
    recallGaps,
    totalCandidates: duplicates.count + internalNoise.count + stale.count + recallGaps.count,
    generatedAt: nowIso,
  };
}
