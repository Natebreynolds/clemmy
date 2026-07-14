import path from 'node:path';
import { openMemoryDb } from '../memory/db.js';
import { listActiveFacts, countActiveFacts } from '../memory/facts.js';
import { isEmbeddingsEnabled, loadFactEmbeddings } from '../memory/embeddings.js';
import { getRuntimeEnv } from '../config.js';
import { listToolChoices, computeChoiceScore } from '../memory/tool-choice-store.js';
import { listSkills } from '../memory/skill-store.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { listGoalRecords } from '../memory/goals-list.js';
import { listFocuses } from '../memory/focus.js';
import { compileWordMatcher } from '../memory/word-match.js';
import { loadFactEntityEdges, loadEntityEdges, loadFactResourceEdges } from '../memory/relations.js';
import { getMemoryGeneration } from '../memory/temporal-memory.js';

/**
 * Pure builder for the Memory tab's knowledge graph.
 *
 * Extracted from the `/api/console/memory/graph` route so it can be reused
 * by (a) the route handler, (b) the offline snapshot dumper
 * (`scripts/dump-memory-graph.ts`), and (c) tests — one tested builder, one
 * shape. The route stays a thin param-parse → buildMemoryGraph → res.json.
 *
 * Node types:  fact | kind | file | entity
 * Edge types:  kind (fact→kind membership) · mentions (fact→file) ·
 *              entity (fact→entity) · similar (fact↔fact semantic, opt-in)
 *
 * Everything beyond the original {kind, content, source} fact data and the
 * three original edge types is ADDITIVE and gated, so the bare-URL response
 * (no sim params, no layout) is byte-compatible with the pre-extraction route.
 */

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  data?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  /** cosine similarity for `type:'similar'` edges; recurrence for `type:'related'`. */
  weight?: number;
  /** predicate for stored entity↔entity (`type:'related'`) edges; absent otherwise. */
  label?: string;
  /**
   * True for `mentions`/`entity` edges that were INFERRED at render time by
   * matching the fact text against a file basename / entity name (no stored
   * relationship). The UI renders these dashed to distinguish "we guessed this
   * connection" from a stored edge. Absent (= false) on stored/semantic edges.
   * WS2 replaces the bulk of these with stored `fact_entities` edges.
   */
  inferred?: boolean;
  /** Persisted provenance/temporal attributes for stored relationships. */
  data?: Record<string, unknown>;
  /** Truth contract consumed by every graph UI. */
  truth: 'stored' | 'inferred' | 'semantic';
}

export interface MemoryGraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: Record<string, unknown>;
}

export interface BuildMemoryGraphOpts {
  /** Max fact nodes (clamped 10–300). */
  factsLimit?: number;
  /** Max file nodes considered (clamped 10–200). */
  filesLimit?: number;
  /** Max entity nodes considered (clamped 0–150). */
  entitiesLimit?: number;
  /** Attach PCA `fx/fy/fz` seed positions to fact nodes. */
  semanticLayout?: boolean;
  /** Top-K semantic neighbours per fact; 0 disables semantic edges (clamped 0–8). */
  simEdges?: number;
  /** Cosine cutoff for semantic edges (clamped 0.40–0.95). */
  simThreshold?: number;
  /** Global cap on semantic edges, strongest kept (clamped 0–1500). */
  simCap?: number;
  /** Cluster colouring strategy. `auto` is reserved for v2 (label-prop); today behaves as `kind`. */
  clusterMode?: 'kind' | 'auto';
  /** Default `stored`: only persisted relationships. `augmented` adds clearly
   * labeled text-inferred and semantic overlays. */
  truthMode?: 'stored' | 'augmented';
}

type MemoryDb = ReturnType<typeof openMemoryDb>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Canonical signature for a fact set — sorted ids joined. Shared by the
 * position cache and the semantic-edge cache so both describe the SAME set.
 */
function factSignature(ids: number[]): string {
  return `${getMemoryGeneration()}:${ids.slice().sort((a, b) => a - b).join(',')}`;
}

// ── Semantic 3D layout (PCA) ────────────────────────────────────────────
// Project fact embeddings (1536-dim) → 3D via PCA so semantically similar
// facts cluster in space. Gram-matrix trick (features ≫ samples): the top-3
// eigenvectors of the N×N Gram matrix give the PCA scores directly as
// score_k(i) = √λ_k · u_k[i]. Dependency-free power iteration; N ≤ 300 so it's
// cheap. Result cached by fact-set signature.
let semanticPosCache: { key: string; positions: Map<number, [number, number, number]> } | null = null;

export function computeSemanticFactPositions(
  db: MemoryDb,
  factIds: number[],
): Map<number, [number, number, number]> | null {
  if (factIds.length < 4) return null;
  const key = factSignature(factIds);
  if (semanticPosCache && semanticPosCache.key === key) return semanticPosCache.positions;

  const embeddingMap = loadFactEmbeddings(factIds);
  if (embeddingMap.size < 4) return null;
  const ids: number[] = [];
  const vecs: Float32Array[] = [];
  for (const id of factIds) {
    const v = embeddingMap.get(id);
    if (v && v.length > 0) { ids.push(id); vecs.push(v); }
  }
  const n = vecs.length;
  if (n < 4) return null;
  const dim = vecs[0].length;

  // Center the vectors (subtract the mean) — PCA operates on centered data.
  const mean = new Float64Array(dim);
  for (const v of vecs) for (let d = 0; d < dim; d++) mean[d] += v[d];
  for (let d = 0; d < dim; d++) mean[d] /= n;
  const centered: Float64Array[] = vecs.map((v) => {
    const c = new Float64Array(dim);
    for (let d = 0; d < dim; d++) c[d] = v[d] - mean[d];
    return c;
  });

  // Gram matrix G = Xc · Xcᵀ  (n × n, symmetric).
  const G: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    const gi = new Float64Array(n);
    for (let j = 0; j <= i; j++) {
      let dot = 0;
      const a = centered[i], b = centered[j];
      for (let d = 0; d < dim; d++) dot += a[d] * b[d];
      gi[j] = dot;
      if (j < i) G[j][i] = dot; // symmetric fill
    }
    G.push(gi);
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) G[i][j] = G[j][i];

  // Deterministic non-degenerate seed (no Math.random → stable + cacheable).
  const seed = (i: number) => Math.sin((i + 1) * 12.9898) * 43758.5453 % 1;
  const matVec = (M: Float64Array[], x: Float64Array) => {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; const row = M[i]; for (let j = 0; j < n; j++) s += row[j] * x[j]; y[i] = s; }
    return y;
  };
  const norm = (x: Float64Array) => { let s = 0; for (let i = 0; i < n; i++) s += x[i] * x[i]; return Math.sqrt(s); };

  // Power iteration + deflation for the top 3 eigenpairs.
  const comps: Array<{ vec: Float64Array; val: number }> = [];
  const work = G.map((r) => Float64Array.from(r)); // deflated copy
  for (let k = 0; k < 3; k++) {
    let x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = seed(i + k * 7) || 0.01;
    let nrm = norm(x) || 1;
    for (let i = 0; i < n; i++) x[i] /= nrm;
    let lambda = 0;
    for (let iter = 0; iter < 100; iter++) {
      const y = matVec(work, x);
      nrm = norm(y);
      if (nrm < 1e-9) break;
      for (let i = 0; i < n; i++) y[i] /= nrm;
      let diff = 0; for (let i = 0; i < n; i++) diff += Math.abs(y[i] - x[i]);
      x = y;
      lambda = nrm;
      if (diff < 1e-6) break;
    }
    comps.push({ vec: x, val: lambda });
    // Deflate: work -= lambda · x xᵀ
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) work[i][j] -= lambda * x[i] * x[j];
  }

  // Scores: coord_k(i) = √λ_k · u_k[i]. Then scale to a pleasant range.
  const coords: Array<[number, number, number]> = [];
  let maxAbs = 1e-6;
  for (let i = 0; i < n; i++) {
    const c: [number, number, number] = [
      Math.sqrt(Math.max(0, comps[0].val)) * comps[0].vec[i],
      Math.sqrt(Math.max(0, comps[1].val)) * comps[1].vec[i],
      Math.sqrt(Math.max(0, comps[2].val)) * comps[2].vec[i],
    ];
    coords.push(c);
    maxAbs = Math.max(maxAbs, Math.abs(c[0]), Math.abs(c[1]), Math.abs(c[2]));
  }
  const scale = 160 / maxAbs;
  const positions = new Map<number, [number, number, number]>();
  for (let i = 0; i < n; i++) {
    positions.set(ids[i], [coords[i][0] * scale, coords[i][1] * scale, coords[i][2] * scale]);
  }

  semanticPosCache = { key, positions };
  return positions;
}

// ── Semantic fact↔fact edges (kNN over cosine) ──────────────────────────
// There is NO stored fact↔fact link. We derive "related idea" edges from the
// embeddings: top-K nearest neighbours per fact above a cosine threshold,
// undirected-deduped, globally capped (strongest kept). Pre-normalizing each
// vector once turns the O(n²) inner loop into a plain dot product (no per-pair
// sqrt). Graceful no-op when embeddings are unavailable.

interface SemanticEdgeResult {
  edges: GraphEdge[];
  /** Facts that actually had a stored embedding (for meta reporting). */
  embeddedFacts: number;
}

function buildSemanticEdges(
  factIds: number[],
  k: number,
  threshold: number,
  cap: number,
): SemanticEdgeResult {
  if (k <= 0 || cap <= 0 || factIds.length < 2 || !isEmbeddingsEnabled()) {
    return { edges: [], embeddedFacts: 0 };
  }

  const embMap = loadFactEmbeddings(factIds); // Map<id, Float32Array>, one query
  const ids: number[] = [];
  const vecs: Float32Array[] = [];
  for (const id of factIds) {
    const v = embMap.get(id);
    if (v && v.length > 0) { ids.push(id); vecs.push(v); }
  }
  const n = ids.length;
  if (n < 2) return { edges: [], embeddedFacts: n };
  const dim = vecs[0].length;

  // Pre-normalize once → similarity = dot product.
  const unit = vecs.map((v) => {
    let s = 0;
    for (let d = 0; d < v.length; d++) s += v[d] * v[d];
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    const out = new Float32Array(v.length);
    for (let d = 0; d < v.length; d++) out[d] = v[d] * inv;
    return out;
  });

  type Cand = { j: number; w: number };
  const top: Cand[][] = Array.from({ length: n }, () => []);
  const pushTopK = (arr: Cand[], cand: Cand) => {
    if (arr.length < k) {
      arr.push(cand);
      arr.sort((a, b) => b.w - a.w);
      return;
    }
    if (cand.w <= arr[arr.length - 1].w) return;
    arr[arr.length - 1] = cand;
    arr.sort((a, b) => b.w - a.w);
  };

  for (let i = 0; i < n; i++) {
    const a = unit[i];
    if (a.length !== dim) continue;
    for (let j = i + 1; j < n; j++) {
      const b = unit[j];
      if (b.length !== dim) continue;
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += a[d] * b[d];
      if (dot < threshold) continue;
      pushTopK(top[i], { j, w: dot });
      pushTopK(top[j], { j: i, w: dot });
    }
  }

  // Materialize undirected, deduped, globally weight-capped.
  const seen = new Set<number>();
  const flat: Array<{ a: number; b: number; w: number }> = [];
  for (let i = 0; i < n; i++) {
    for (const c of top[i]) {
      const lo = Math.min(i, c.j), hi = Math.max(i, c.j);
      const key = lo * n + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      flat.push({ a: lo, b: hi, w: c.w });
    }
  }
  flat.sort((x, y) => y.w - x.w);

  const edges: GraphEdge[] = [];
  for (const e of flat) {
    if (edges.length >= cap) break;
    edges.push({
      id: `sim:${ids[e.a]}-${ids[e.b]}`,
      source: `fact:${ids[e.a]}`,
      target: `fact:${ids[e.b]}`,
      type: 'similar',
      truth: 'semantic',
      weight: Math.round(e.w * 1000) / 1000,
    });
  }
  return { edges, embeddedFacts: n };
}

let semanticEdgeCache: { key: string; result: SemanticEdgeResult } | null = null;

function semanticEdgesCached(
  factIds: number[],
  k: number,
  threshold: number,
  cap: number,
): SemanticEdgeResult {
  const key = `${factSignature(factIds)}|k${k}|t${threshold}|c${cap}`;
  if (semanticEdgeCache && semanticEdgeCache.key === key) return semanticEdgeCache.result;
  const result = buildSemanticEdges(factIds, k, threshold, cap);
  semanticEdgeCache = { key, result };
  return result;
}

// ── Non-fact stores (tool-recall · skills · workflows · goals · focus) ────
// The graph historically rendered ONLY fact|kind|file|entity, so the entire
// procedural-memory store (tool-recall), the capability layer (skills /
// workflows), and the intent layer (goals / focus) were invisible — the user's
// "I don't see the entire picture" complaint. This collector adds them as
// first-class node types with the ownership/usage edges that already exist as
// data (workflow→skill, goal→focus). Each store read is independently guarded
// so one bad store never blanks the graph. Gated by isGraphFullEnabled() so the
// legacy response stays byte-identical when off.

/** Default-ON; `CLEMMY_GRAPH_FULL=off` restores the legacy fact-only graph. */
export function isGraphFullEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_GRAPH_FULL', 'on') || 'on').trim().toLowerCase() !== 'off';
}

interface NonFactStoreResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: { toolRecall: number; skills: number; workflows: number; goals: number; focus: number };
}

export function collectNonFactStoreNodes(opts: {
  toolRecallLimit?: number; skillsLimit?: number; workflowsLimit?: number; goalsLimit?: number; focusLimit?: number;
} = {}): NonFactStoreResult {
  const toolRecallLimit = clamp(opts.toolRecallLimit ?? 120, 0, 400);
  const skillsLimit = clamp(opts.skillsLimit ?? 120, 0, 400);
  const workflowsLimit = clamp(opts.workflowsLimit ?? 120, 0, 400);
  const goalsLimit = clamp(opts.goalsLimit ?? 80, 0, 300);
  const focusLimit = clamp(opts.focusLimit ?? 40, 0, 200);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const counts = { toolRecall: 0, skills: 0, workflows: 0, goals: 0, focus: 0 };

  // Tool-recall (procedural) memory — proven tool per intent, with outcome score.
  try {
    const choices = listToolChoices().slice(0, toolRecallLimit);
    for (const c of choices) {
      const id = `toolrecall:${c.intent}`;
      nodes.push({
        id,
        label: c.intent.length > 60 ? `${c.intent.slice(0, 57)}…` : c.intent,
        type: 'tool-recall',
        data: {
          chosenTool: c.choice?.identifier ?? null,
          kind: c.choice?.kind ?? null,
          score: c.choice ? computeChoiceScore(c.choice) : 0,
          successCount: c.choice?.successCount ?? 0,
          failureCount: c.choice?.failureCount ?? 0,
          fallbacks: c.fallbacks.length,
          invalidated: c.choice === null,
        },
      });
    }
    counts.toolRecall = choices.length;
  } catch { /* tool-choice store unreadable — skip */ }

  // Skills (capability layer). Skip quarantined drafts (hidden from the index).
  const skillNames = new Set<string>();
  try {
    const skills = listSkills().filter((s) => s.frontmatter?.quarantined !== true).slice(0, skillsLimit);
    for (const s of skills) {
      skillNames.add(s.name);
      nodes.push({
        id: `skill:${s.name}`,
        label: s.name,
        type: 'skill',
        data: {
          description: s.frontmatter?.description?.slice(0, 200) ?? null,
          tier: s.frontmatter?.tier ?? 'approved',
          useCount: s.frontmatter?.useCount ?? 0,
          failureCount: s.frontmatter?.failureCount ?? 0,
        },
      });
    }
    counts.skills = skills.length;
  } catch { /* skills dir unreadable — skip */ }

  // Workflows (capability layer) + workflow→skill ownership edges.
  try {
    const workflows = listWorkflows().slice(0, workflowsLimit);
    for (const w of workflows) {
      const id = `workflow:${w.name}`;
      nodes.push({
        id,
        label: w.name,
        type: 'workflow',
        data: {
          description: w.data?.description?.slice(0, 200) ?? null,
          enabled: w.data?.enabled !== false,
          steps: Array.isArray(w.data?.steps) ? w.data.steps.length : 0,
        },
      });
      // Skill usage: any per-step `uses_skill` (steps compose installed skills).
      const skillRefs = new Set<string>();
      for (const step of w.data?.steps ?? []) {
        const ref = step.usesSkill;
        if (typeof ref === 'string' && ref.trim()) skillRefs.add(ref.trim());
      }
      for (const ref of skillRefs) {
        if (skillNames.has(ref)) {
          edges.push({ id: `${id}->skill:${ref}`, source: id, target: `skill:${ref}`, type: 'uses', truth: 'stored' });
        }
      }
    }
    counts.workflows = workflows.length;
  } catch { /* workflows dir unreadable — skip */ }

  // Goals (intent layer). Active/paused/blocked only — completed goals retire.
  const goalIds = new Set<string>();
  try {
    const goals = listGoalRecords().filter((g) => g.status !== 'completed').slice(0, goalsLimit);
    for (const g of goals) {
      goalIds.add(g.id);
      nodes.push({
        id: `goal:${g.id}`,
        label: (g.title || g.id).slice(0, 60),
        type: 'goal',
        data: { status: g.status, priority: g.priority, nextActions: g.nextActions?.length ?? 0 },
      });
    }
    counts.goals = goals.length;
  } catch { /* goals store unreadable — skip */ }

  // Focus (intent layer) + goal→focus "pursues" edges.
  try {
    const focuses = listFocuses({ limit: focusLimit });
    for (const f of focuses) {
      const id = `focus:${f.id}`;
      nodes.push({
        id,
        label: (f.title || f.resource_ref || `focus ${f.id}`).slice(0, 60),
        type: 'focus',
        data: { status: f.status, resourceKind: f.resource_kind ?? null },
      });
      if (f.related_goal_id && goalIds.has(f.related_goal_id)) {
        edges.push({ id: `goal:${f.related_goal_id}->${id}`, source: `goal:${f.related_goal_id}`, target: id, type: 'pursues', truth: 'stored' });
      }
    }
    counts.focus = focuses.length;
  } catch { /* focus store unreadable — skip */ }

  return { nodes, edges, counts };
}

// ── The builder ─────────────────────────────────────────────────────────

export function buildMemoryGraph(db: MemoryDb, opts: BuildMemoryGraphOpts = {}): MemoryGraphResult {
  // NOTE: the 300 fact ceiling bounds the O(n²) semantic-edge scan to a
  // sub-frame cost (≈69M FMA worst case). Do NOT raise it without revisiting
  // buildSemanticEdges performance.
  const factsLimit = clamp(opts.factsLimit ?? 100, 10, 300);
  const filesLimit = clamp(opts.filesLimit ?? 60, 10, 200);
  const entitiesLimit = clamp(opts.entitiesLimit ?? 80, 0, 150);
  const simK = clamp(opts.simEdges ?? 0, 0, 8);
  const simThreshold = clamp(opts.simThreshold ?? 0.70, 0.40, 0.95);
  const simCap = clamp(opts.simCap ?? 300, 0, 1500);
  const clusterMode: 'kind' | 'auto' = opts.clusterMode === 'auto' ? 'auto' : 'kind';
  const semanticLayout = opts.semanticLayout === true;
  const truthMode = opts.truthMode === 'augmented' ? 'augmented' : 'stored';

  const facts = listActiveFacts({ limit: factsLimit });
  const factIds = facts.map((fact) => fact.id);
  const files = db.prepare(`
    SELECT path, MAX(mtime) AS mtime, COUNT(*) AS chunks
    FROM vault_chunks
    GROUP BY path
    ORDER BY MAX(mtime) DESC
    LIMIT ?
  `).all(filesLimit) as Array<{ path: string; mtime: number; chunks: number }>;

  const KIND_SET = new Set<string>();
  for (const f of facts) if (f.kind) KIND_SET.add(f.kind);
  const kinds = Array.from(KIND_SET);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Kind cluster nodes.
  for (const kind of kinds) {
    nodes.push({ id: `kind:${kind}`, label: kind.toUpperCase(), type: 'kind' });
  }

  // Fact nodes + fact→kind + fact→file edges.
  const fileBasenames = files.map((f) => {
    const base = path.basename(f.path, path.extname(f.path));
    const baseLower = base.toLowerCase();
    return { path: f.path, base, baseLower, re: compileWordMatcher(baseLower) };
  });

  for (const fact of facts) {
    const id = `fact:${fact.id}`;
    const summary = (fact.content || '(fact)').trim().split('\n')[0].slice(0, 60);
    nodes.push({
      id,
      label: summary,
      type: 'fact',
      data: {
        // original fields (kept for byte-compat with the 2D view)
        kind: fact.kind,
        content: fact.content?.slice(0, 600),
        source: fact.source,
        // additive visual-encoding fields (ignored by the 2D Cytoscape view)
        importance: fact.importance ?? null,
        pinned: fact.pinned === true,
        updatedAt: fact.updatedAt,
        lastAccessedAt: fact.lastAccessedAt ?? null,
        derivationDepth: fact.derivationDepth ?? 0,
        clusterId: `kind:${fact.kind}`,
      },
    });
    if (fact.kind) {
      edges.push({ id: `${id}->kind:${fact.kind}`, source: id, target: `kind:${fact.kind}`, type: 'kind', truth: 'stored' });
    }
    if (fact.source.path && files.some((file) => file.path === fact.source.path)) {
      edges.push({
        id: `${id}->file:${fact.source.path}`,
        source: id,
        target: `file:${fact.source.path}`,
        type: 'source',
        truth: 'stored',
      });
    }
    // Fact → file edges when the fact text mentions a file basename. INFERRED
    // (word-boundary match, no stored link) — rendered dashed by the UI.
    const lower = (fact.content || '').toLowerCase();
    if (truthMode === 'augmented' && lower.length > 0) {
      for (const f of fileBasenames) {
        if (!f.re) continue; // tiny/empty names skipped
        if (f.re.test(lower)) {
          edges.push({ id: `${id}->file:${f.path}`, source: id, target: `file:${f.path}`, type: 'mentions', inferred: true, truth: 'inferred' });
        }
      }
    }
  }

  // File nodes — only include files with an inbound edge OR recently-active (top 30 by mtime).
  const referencedFilePaths = new Set(edges.filter((e) => e.target.startsWith('file:')).map((e) => e.target.slice(5)));
  const recentTop = files.slice(0, 30).map((f) => f.path);
  for (const p of recentTop) referencedFilePaths.add(p);

  for (const f of files) {
    if (!referencedFilePaths.has(f.path)) continue;
    nodes.push({
      id: `file:${f.path}`,
      label: f.path.split('/').slice(-2).join('/'),
      type: 'file',
      data: { chunks: f.chunks, mtime: f.mtime },
    });
  }

  // Entity nodes + fact→entity edges. STORED edges (fact_entities, WS2) are
  // emitted SOLID (inferred:false); for any rendered fact with NO stored link
  // we fall back to the word-boundary substring match (inferred:true, dashed) so
  // the graph degrades gracefully before/without a link sync. Plus entity↔entity
  // edges from the stored entity_edges relation.
  if (entitiesLimit > 0) {
    const entityRows = db.prepare(`
      SELECT id, entity_type, canonical_name, canonical_name_lc, aliases_json, mention_count
      FROM entities
      ORDER BY mention_count DESC, last_seen_at DESC
      LIMIT ?
    `).all(entitiesLimit) as Array<{ id: number; entity_type: string; canonical_name: string; canonical_name_lc: string; aliases_json: string | null; mention_count: number }>;
    const entityById = new Map(entityRows.map((e) => [e.id, e]));

    const referencedEntityIds = new Set<number>();
    // 1. STORED fact→entity edges (only to entities we'll render).
    const factsWithStoredLink = new Set<number>();
    for (const link of loadFactEntityEdges(factIds)) {
      if (!entityById.has(link.entityId)) continue;
      referencedEntityIds.add(link.entityId);
      factsWithStoredLink.add(link.factId);
      edges.push({ id: `fact:${link.factId}->entity:${link.entityId}`, source: `fact:${link.factId}`, target: `entity:${link.entityId}`, type: 'entity', truth: 'stored' });
    }

    // 2. INFERRED fallback — only for facts the stored layer hasn't covered yet.
    const entityMatchers = entityRows.map((e) => {
      const names = new Set<string>();
      if (e.canonical_name_lc) names.add(e.canonical_name_lc);
      try {
        const aliases = e.aliases_json ? JSON.parse(e.aliases_json) : [];
        if (Array.isArray(aliases)) for (const a of aliases) {
          const al = String(a || '').trim().toLowerCase();
          if (al) names.add(al);
        }
      } catch { /* malformed aliases — skip */ }
      const res = Array.from(names).map((n) => compileWordMatcher(n)).filter((r): r is RegExp => r !== null);
      return { row: e, res };
    });
    for (const fact of truthMode === 'augmented' ? facts : []) {
      if (factsWithStoredLink.has(fact.id)) continue;
      const lower = (fact.content || '').toLowerCase();
      if (!lower) continue;
      for (const m of entityMatchers) {
        if (m.res.some((re) => re.test(lower))) {
          referencedEntityIds.add(m.row.id);
          edges.push({ id: `fact:${fact.id}->entity:${m.row.id}`, source: `fact:${fact.id}`, target: `entity:${m.row.id}`, type: 'entity', inferred: true, truth: 'inferred' });
        }
      }
    }

    // 3. STORED entity↔entity edges (predicate-labeled), endpoints must render.
    const edgeRows = loadEntityEdges(200);
    for (const ee of edgeRows) {
      if (entityById.has(ee.subjectId) && entityById.has(ee.objectId)) {
        referencedEntityIds.add(ee.subjectId);
        referencedEntityIds.add(ee.objectId);
      }
    }

    const topEntityIds = new Set(entityRows.slice(0, 30).map((e) => e.id));
    for (const e of entityRows) {
      if (!referencedEntityIds.has(e.id) && !topEntityIds.has(e.id)) continue;
      nodes.push({
        id: `entity:${e.id}`,
        label: e.canonical_name,
        type: 'entity',
        data: { entity_type: e.entity_type, mention_count: e.mention_count },
      });
    }

    // Emit entity↔entity edges only between entities that ended up as nodes.
    const entityNodeIds = new Set(nodes.filter((n) => n.type === 'entity').map((n) => n.id));
    for (const ee of edgeRows) {
      const s = `entity:${ee.subjectId}`, t = `entity:${ee.objectId}`;
      if (entityNodeIds.has(s) && entityNodeIds.has(t)) {
        edges.push({
          id: `related:${ee.subjectId}-${ee.predicate}-${ee.objectId}`,
          source: s,
          target: t,
          type: 'related',
          label: ee.predicate,
          weight: ee.recurrenceCount,
          truth: 'stored',
          data: {
            confidence: ee.confidence,
            evidenceEpisodeId: ee.evidenceEpisodeId,
            validFrom: ee.validFrom,
            validTo: ee.validTo,
          },
        });
      }
    }
  }

  // Stored fact→resource pointers.
  const resourceLinks = loadFactResourceEdges(factIds);
  if (resourceLinks.length > 0) {
    const resourceIds = Array.from(new Set(resourceLinks.map((link) => link.resourceId)));
    const placeholders = resourceIds.map(() => '?').join(',');
    const resources = db.prepare(`
      SELECT id, app, kind, ref, name, whats_here, trust, last_seen_at
      FROM resource_pointers WHERE id IN (${placeholders})
    `).all(...resourceIds) as Array<{
      id: number; app: string; kind: string; ref: string; name: string;
      whats_here: string | null; trust: number | null; last_seen_at: string;
    }>;
    for (const resource of resources) nodes.push({
      id: `resource:${resource.id}`,
      label: resource.name,
      type: 'resource',
      data: { app: resource.app, kind: resource.kind, ref: resource.ref, whatsHere: resource.whats_here, trust: resource.trust, lastSeenAt: resource.last_seen_at },
    });
    const visible = new Set(resources.map((resource) => resource.id));
    for (const link of resourceLinks) if (visible.has(link.resourceId)) edges.push({
      id: `fact:${link.factId}->resource:${link.resourceId}`,
      source: `fact:${link.factId}`,
      target: `resource:${link.resourceId}`,
      type: 'resource',
      truth: 'stored',
    });
  }

  // Durable episode/evidence provenance for rendered facts.
  if (factIds.length > 0) {
    const placeholders = factIds.map(() => '?').join(',');
    const episodeRows = db.prepare(`
      SELECT DISTINCT me.id, me.kind, me.source_app, me.source_uri, me.occurred_at,
             me.status, me.evidence_excerpt, fe.fact_id
      FROM fact_evidence fe
      JOIN memory_episodes me ON me.id = fe.episode_id
      WHERE fe.fact_id IN (${placeholders})
      ORDER BY me.occurred_at DESC
      LIMIT 300
    `).all(...factIds) as Array<{
      id: string; kind: string; source_app: string | null; source_uri: string | null;
      occurred_at: string; status: string; evidence_excerpt: string | null; fact_id: number;
    }>;
    const episodeIds = new Set<string>();
    for (const episode of episodeRows) {
      if (!episodeIds.has(episode.id)) {
        episodeIds.add(episode.id);
        nodes.push({
          id: `episode:${episode.id}`,
          label: episode.source_app ?? `${episode.kind} ${episode.occurred_at.slice(0, 10)}`,
          type: 'episode',
          data: { kind: episode.kind, sourceUri: episode.source_uri, occurredAt: episode.occurred_at, status: episode.status, excerpt: episode.evidence_excerpt },
        });
      }
      edges.push({
        id: `fact:${episode.fact_id}->episode:${episode.id}`,
        source: `fact:${episode.fact_id}`,
        target: `episode:${episode.id}`,
        type: 'evidence',
        truth: 'stored',
      });
    }
  }

  // Typed policy nodes make enforcement semantics visible instead of treating
  // every pinned fact as the same kind of prompt instruction.
  if (factIds.length > 0) {
    const placeholders = factIds.map(() => '?').join(',');
    const policies = db.prepare(`
      SELECT fact_id, policy_type, enforcement, priority
      FROM memory_policies WHERE fact_id IN (${placeholders})
    `).all(...factIds) as Array<{ fact_id: number; policy_type: string; enforcement: string; priority: number }>;
    for (const policy of policies) {
      const id = `policy:${policy.fact_id}`;
      nodes.push({ id, label: policy.policy_type.replace(/_/g, ' '), type: 'policy', data: policy });
      edges.push({ id: `${id}->fact:${policy.fact_id}`, source: id, target: `fact:${policy.fact_id}`, type: 'governs', truth: 'stored' });
    }
  }

  // Non-fact stores (tool-recall · skills · workflows · goals · focus). Additive;
  // gated so the legacy fact-only response is byte-identical when disabled.
  let nonFact: NonFactStoreResult = { nodes: [], edges: [], counts: { toolRecall: 0, skills: 0, workflows: 0, goals: 0, focus: 0 } };
  if (isGraphFullEnabled()) {
    nonFact = collectNonFactStoreNodes();
    for (const n of nonFact.nodes) nodes.push(n);
    for (const e of nonFact.edges) edges.push(e);
  }

  // Semantic fact↔fact edges (opt-in via simEdges).
  let semantic: SemanticEdgeResult = { edges: [], embeddedFacts: 0 };
  if (truthMode === 'augmented' && simK > 0) {
    semantic = semanticEdgesCached(facts.map((f) => f.id), simK, simThreshold, simCap);
    // Only emit edges whose endpoints are present fact nodes (all are, but be safe).
    const present = new Set(nodes.filter((n) => n.type === 'fact').map((n) => n.id));
    for (const e of semantic.edges) {
      if (present.has(e.source) && present.has(e.target)) edges.push(e);
    }
  }

  // Degree pass → enrich fact nodes (the 3D view sizes hubs by connectivity).
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  for (const n of nodes) {
    if (n.type === 'fact' && n.data) n.data.degree = degree.get(n.id) ?? 0;
  }

  // Optional PCA 3D seed positions on fact nodes.
  if (semanticLayout) {
    try {
      const positions = computeSemanticFactPositions(db, facts.map((f) => f.id));
      if (positions) {
        for (const node of nodes) {
          if (node.type !== 'fact') continue;
          const fid = Number(String(node.id).slice('fact:'.length));
          const p = positions.get(fid);
          if (p) node.data = { ...(node.data || {}), fx: p[0], fy: p[1], fz: p[2] };
        }
      }
    } catch { /* embeddings unavailable — fall back to force layout */ }
  }

  const semanticEdgeCount = edges.filter((e) => e.type === 'similar').length;
  const totals = {
    facts: countActiveFacts(),
    files: (db.prepare('SELECT COUNT(DISTINCT path) AS c FROM vault_chunks').get() as { c: number }).c,
    entities: (db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c,
    resources: (db.prepare('SELECT COUNT(*) AS c FROM resource_pointers').get() as { c: number }).c,
    episodes: (db.prepare('SELECT COUNT(*) AS c FROM memory_episodes').get() as { c: number }).c,
    policies: (db.prepare('SELECT COUNT(*) AS c FROM memory_policies').get() as { c: number }).c,
  };
  const visibleByType: Record<string, number> = {};
  for (const node of nodes) visibleByType[node.type] = (visibleByType[node.type] ?? 0) + 1;
  const edgeTruth = { stored: 0, inferred: 0, semantic: 0 };
  for (const edge of edges) edgeTruth[edge.truth] += 1;

  return {
    nodes,
    edges,
    meta: {
      // original meta keys/values — unchanged
      factCount: facts.length,
      // True total of active facts so the UI can show "showing N of M" instead
      // of implying the rendered slice (capped at factsLimit) is everything.
      totalFacts: countActiveFacts(),
      fileCount: nodes.filter((n) => n.type === 'file').length,
      kindCount: kinds.length,
      entityCount: nodes.filter((n) => n.type === 'entity').length,
      edgeCount: edges.length,
      semantic: semanticLayout,
      // additive meta — non-fact store presence (WS1 graph completeness).
      graphFull: isGraphFullEnabled(),
      truthMode,
      coverage: { totals, visible: visibleByType, edges: edgeTruth },
      stores: nonFact.counts,
      // additive meta
      semanticEdges: {
        enabled: isEmbeddingsEnabled(),
        requested: simK,
        threshold: simThreshold,
        cap: simCap,
        count: semanticEdgeCount,
        embeddedFacts: semantic.embeddedFacts,
        skippedNoEmbedding: simK > 0 ? Math.max(0, facts.length - semantic.embeddedFacts) : 0,
      },
      clustering: { mode: clusterMode === 'auto' ? 'kind' : 'kind', clusters: kinds.length },
    },
  };
}

/** Exact stored neighborhood for on-demand graph expansion. Unlike the overview
 * sample, the requested seed is always loaded even when it sits outside the
 * top-N fact/entity slices. */
export function buildMemoryNeighborhood(db: MemoryDb, nodeId: string, depth: 1 | 2 = 1): MemoryGraphResult {
  const facts = new Set<number>();
  const entities = new Set<number>();
  const resources = new Set<number>();
  const episodes = new Set<string>();
  const policies = new Set<number>();
  const separator = nodeId.indexOf(':');
  const type = separator >= 0 ? nodeId.slice(0, separator) : nodeId;
  const rawId = separator >= 0 ? nodeId.slice(separator + 1) : '';
  if (type === 'fact' && Number.isInteger(Number(rawId))) facts.add(Number(rawId));
  else if (type === 'entity' && Number.isInteger(Number(rawId))) entities.add(Number(rawId));
  else if (type === 'resource' && Number.isInteger(Number(rawId))) resources.add(Number(rawId));
  else if (type === 'episode' && rawId) episodes.add(rawId);
  else if (type === 'policy' && Number.isInteger(Number(rawId))) policies.add(Number(rawId));
  else return { nodes: [], edges: [], meta: { truthMode: 'stored', seed: nodeId, depth, error: 'unsupported node id' } };

  const idsSql = (values: Array<number | string>) => values.map(() => '?').join(',');
  const expandEndpointFacts = (): void => {
    if (entities.size > 0) {
      const ids = Array.from(entities);
      for (const row of db.prepare(`SELECT fact_id FROM fact_entities WHERE entity_id IN (${idsSql(ids)}) LIMIT 300`).all(...ids) as Array<{ fact_id: number }>) facts.add(row.fact_id);
    }
    if (resources.size > 0) {
      const ids = Array.from(resources);
      for (const row of db.prepare(`SELECT fact_id FROM fact_resources WHERE resource_id IN (${idsSql(ids)}) LIMIT 300`).all(...ids) as Array<{ fact_id: number }>) facts.add(row.fact_id);
    }
    if (episodes.size > 0) {
      const ids = Array.from(episodes);
      for (const row of db.prepare(`SELECT fact_id FROM fact_evidence WHERE episode_id IN (${idsSql(ids)}) LIMIT 300`).all(...ids) as Array<{ fact_id: number }>) facts.add(row.fact_id);
    }
    for (const factId of policies) facts.add(factId);
  };
  const expandFacts = (): void => {
    if (facts.size === 0) return;
    const ids = Array.from(facts);
    for (const row of db.prepare(`SELECT entity_id FROM fact_entities WHERE fact_id IN (${idsSql(ids)}) LIMIT 300`).all(...ids) as Array<{ entity_id: number }>) entities.add(row.entity_id);
    for (const row of db.prepare(`SELECT resource_id FROM fact_resources WHERE fact_id IN (${idsSql(ids)}) LIMIT 300`).all(...ids) as Array<{ resource_id: number }>) resources.add(row.resource_id);
    for (const row of db.prepare(`SELECT episode_id FROM fact_evidence WHERE fact_id IN (${idsSql(ids)}) LIMIT 300`).all(...ids) as Array<{ episode_id: string }>) episodes.add(row.episode_id);
    for (const row of db.prepare(`SELECT fact_id FROM memory_policies WHERE fact_id IN (${idsSql(ids)})`).all(...ids) as Array<{ fact_id: number }>) policies.add(row.fact_id);
  };

  for (let hop = 0; hop < depth; hop++) {
    expandEndpointFacts();
    expandFacts();
    if (entities.size > 0 && hop + 1 < depth) {
      const ids = Array.from(entities);
      const now = new Date().toISOString();
      const rows = db.prepare(`
        SELECT subject_id, object_id FROM entity_edges
        WHERE (invalidated_at IS NULL OR invalidated_at > ?)
          AND (valid_from IS NULL OR valid_from <= ?)
          AND (valid_to IS NULL OR valid_to > ?)
          AND (subject_id IN (${idsSql(ids)}) OR object_id IN (${idsSql(ids)}))
        LIMIT 200
      `).all(now, now, now, ...ids, ...ids) as Array<{ subject_id: number; object_id: number }>;
      for (const row of rows) { entities.add(row.subject_id); entities.add(row.object_id); }
    }
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const factIds = Array.from(facts).slice(0, 300);
  const entityIds = Array.from(entities).slice(0, 300);
  const resourceIds = Array.from(resources).slice(0, 300);
  const episodeIds = Array.from(episodes).slice(0, 300);
  const policyIds = Array.from(policies).filter((id) => factIds.includes(id));

  if (factIds.length > 0) {
    const rows = db.prepare(`SELECT id, kind, content, importance, confidence, valid_from, valid_to, pinned FROM consolidated_facts WHERE id IN (${idsSql(factIds)})`).all(...factIds) as Array<{
      id: number; kind: string; content: string; importance: number | null; confidence: number | null; valid_from: string | null; valid_to: string | null; pinned: number;
    }>;
    const kinds = new Set(rows.map((row) => row.kind));
    for (const kind of kinds) nodes.push({ id: `kind:${kind}`, label: kind.toUpperCase(), type: 'kind' });
    for (const row of rows) {
      nodes.push({ id: `fact:${row.id}`, label: row.content.slice(0, 60), type: 'fact', data: { kind: row.kind, content: row.content, importance: row.importance, confidence: row.confidence, validFrom: row.valid_from, validTo: row.valid_to, pinned: row.pinned === 1 } });
      edges.push({ id: `fact:${row.id}->kind:${row.kind}`, source: `fact:${row.id}`, target: `kind:${row.kind}`, type: 'kind', truth: 'stored' });
    }
  }
  if (entityIds.length > 0) {
    const rows = db.prepare(`SELECT id, canonical_name, entity_type, mention_count FROM entities WHERE id IN (${idsSql(entityIds)})`).all(...entityIds) as Array<{ id: number; canonical_name: string; entity_type: string; mention_count: number }>;
    for (const row of rows) nodes.push({ id: `entity:${row.id}`, label: row.canonical_name, type: 'entity', data: { entity_type: row.entity_type, mention_count: row.mention_count } });
  }
  if (resourceIds.length > 0) {
    const rows = db.prepare(`SELECT id, name, app, kind, ref, whats_here, trust FROM resource_pointers WHERE id IN (${idsSql(resourceIds)})`).all(...resourceIds) as Array<{ id: number; name: string; app: string; kind: string; ref: string; whats_here: string | null; trust: number | null }>;
    for (const row of rows) nodes.push({ id: `resource:${row.id}`, label: row.name, type: 'resource', data: { app: row.app, kind: row.kind, ref: row.ref, whatsHere: row.whats_here, trust: row.trust } });
  }
  if (episodeIds.length > 0) {
    const rows = db.prepare(`SELECT id, kind, source_app, source_uri, occurred_at, status, evidence_excerpt FROM memory_episodes WHERE id IN (${idsSql(episodeIds)})`).all(...episodeIds) as Array<{ id: string; kind: string; source_app: string | null; source_uri: string | null; occurred_at: string; status: string; evidence_excerpt: string | null }>;
    for (const row of rows) nodes.push({ id: `episode:${row.id}`, label: row.source_app ?? row.kind, type: 'episode', data: { sourceUri: row.source_uri, occurredAt: row.occurred_at, status: row.status, excerpt: row.evidence_excerpt } });
  }
  if (policyIds.length > 0) {
    const rows = db.prepare(`SELECT fact_id, policy_type, enforcement, priority FROM memory_policies WHERE fact_id IN (${idsSql(policyIds)})`).all(...policyIds) as Array<{ fact_id: number; policy_type: string; enforcement: string; priority: number }>;
    for (const row of rows) {
      nodes.push({ id: `policy:${row.fact_id}`, label: row.policy_type.replace(/_/g, ' '), type: 'policy', data: row });
      edges.push({ id: `policy:${row.fact_id}->fact:${row.fact_id}`, source: `policy:${row.fact_id}`, target: `fact:${row.fact_id}`, type: 'governs', truth: 'stored' });
    }
  }

  const factSet = new Set(factIds), entitySet = new Set(entityIds), resourceSet = new Set(resourceIds), episodeSet = new Set(episodeIds);
  if (factIds.length > 0) {
    for (const row of db.prepare(`SELECT fact_id, entity_id FROM fact_entities WHERE fact_id IN (${idsSql(factIds)})`).all(...factIds) as Array<{ fact_id: number; entity_id: number }>) if (entitySet.has(row.entity_id)) edges.push({ id: `fact:${row.fact_id}->entity:${row.entity_id}`, source: `fact:${row.fact_id}`, target: `entity:${row.entity_id}`, type: 'entity', truth: 'stored' });
    for (const row of db.prepare(`SELECT fact_id, resource_id FROM fact_resources WHERE fact_id IN (${idsSql(factIds)})`).all(...factIds) as Array<{ fact_id: number; resource_id: number }>) if (resourceSet.has(row.resource_id)) edges.push({ id: `fact:${row.fact_id}->resource:${row.resource_id}`, source: `fact:${row.fact_id}`, target: `resource:${row.resource_id}`, type: 'resource', truth: 'stored' });
    for (const row of db.prepare(`SELECT fact_id, episode_id FROM fact_evidence WHERE fact_id IN (${idsSql(factIds)})`).all(...factIds) as Array<{ fact_id: number; episode_id: string }>) if (episodeSet.has(row.episode_id)) edges.push({ id: `fact:${row.fact_id}->episode:${row.episode_id}`, source: `fact:${row.fact_id}`, target: `episode:${row.episode_id}`, type: 'evidence', truth: 'stored' });
  }
  if (entityIds.length > 0) {
    const now = new Date().toISOString();
    const rows = db.prepare(`
      SELECT subject_id, predicate, object_id, recurrence_count, confidence,
             evidence_episode_id, valid_from, valid_to
      FROM entity_edges
      WHERE (invalidated_at IS NULL OR invalidated_at > ?)
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_to IS NULL OR valid_to > ?)
        AND subject_id IN (${idsSql(entityIds)})
        AND object_id IN (${idsSql(entityIds)})
    `).all(now, now, now, ...entityIds, ...entityIds) as Array<{
      subject_id: number; predicate: string; object_id: number; recurrence_count: number;
      confidence: number; evidence_episode_id: string | null; valid_from: string | null; valid_to: string | null;
    }>;
    for (const row of rows) if (entitySet.has(row.subject_id) && entitySet.has(row.object_id)) edges.push({
      id: `related:${row.subject_id}-${row.predicate}-${row.object_id}`,
      source: `entity:${row.subject_id}`,
      target: `entity:${row.object_id}`,
      type: 'related',
      label: row.predicate,
      weight: row.recurrence_count,
      truth: 'stored',
      data: { confidence: row.confidence, evidenceEpisodeId: row.evidence_episode_id, validFrom: row.valid_from, validTo: row.valid_to },
    });
  }

  return { nodes, edges, meta: { truthMode: 'stored', seed: nodeId, depth, factCount: factSet.size, edgeCount: edges.length } };
}
