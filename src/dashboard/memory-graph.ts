import path from 'node:path';
import { openMemoryDb } from '../memory/db.js';
import { listActiveFacts } from '../memory/facts.js';
import { bufferToVector, isEmbeddingsEnabled, loadFactEmbeddings } from '../memory/embeddings.js';

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
  /** cosine similarity for `type:'similar'` edges; absent otherwise. */
  weight?: number;
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
}

type MemoryDb = ReturnType<typeof openMemoryDb>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Canonical signature for a fact set — sorted ids joined. Shared by the
 * position cache and the semantic-edge cache so both describe the SAME set.
 */
function factSignature(ids: number[]): string {
  return ids.slice().sort((a, b) => a - b).join(',');
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

  const placeholders = factIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT fact_id, vector FROM fact_embeddings WHERE fact_id IN (${placeholders})`,
  ).all(...factIds) as Array<{ fact_id: number; vector: Buffer }>;
  if (rows.length < 4) return null;

  const ids: number[] = [];
  const vecs: Float32Array[] = [];
  for (const r of rows) {
    const v = bufferToVector(r.vector);
    if (v && v.length > 0) { ids.push(r.fact_id); vecs.push(v); }
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

  const facts = listActiveFacts({ limit: factsLimit });
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
    return { path: f.path, base, baseLower: base.toLowerCase() };
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
      edges.push({ id: `${id}->kind:${fact.kind}`, source: id, target: `kind:${fact.kind}`, type: 'kind' });
    }
    // Fact → file edges when the fact text mentions a file basename.
    const lower = (fact.content || '').toLowerCase();
    if (lower.length > 0) {
      for (const f of fileBasenames) {
        if (f.baseLower.length < 4) continue; // skip tiny names
        if (lower.includes(f.baseLower)) {
          edges.push({ id: `${id}->file:${f.path}`, source: id, target: `file:${f.path}`, type: 'mentions' });
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

  // Entity nodes + fact→entity edges (derived by substring match of canonical
  // name / aliases, ≥4 chars — same technique as files; no stored link).
  if (entitiesLimit > 0) {
    const entityRows = db.prepare(`
      SELECT id, entity_type, canonical_name, canonical_name_lc, aliases_json, mention_count
      FROM entities
      ORDER BY mention_count DESC, last_seen_at DESC
      LIMIT ?
    `).all(entitiesLimit) as Array<{ id: number; entity_type: string; canonical_name: string; canonical_name_lc: string; aliases_json: string | null; mention_count: number }>;

    const entityMatchers = entityRows.map((e) => {
      const names = new Set<string>();
      if (e.canonical_name_lc && e.canonical_name_lc.length >= 4) names.add(e.canonical_name_lc);
      try {
        const aliases = e.aliases_json ? JSON.parse(e.aliases_json) : [];
        if (Array.isArray(aliases)) {
          for (const a of aliases) {
            const al = String(a || '').trim().toLowerCase();
            if (al.length >= 4) names.add(al);
          }
        }
      } catch { /* malformed aliases — skip */ }
      return { row: e, names: Array.from(names) };
    });

    const referencedEntityIds = new Set<number>();
    for (const fact of facts) {
      const lower = (fact.content || '').toLowerCase();
      if (!lower) continue;
      for (const m of entityMatchers) {
        if (m.names.some((nm) => lower.includes(nm))) {
          referencedEntityIds.add(m.row.id);
          edges.push({ id: `fact:${fact.id}->entity:${m.row.id}`, source: `fact:${fact.id}`, target: `entity:${m.row.id}`, type: 'entity' });
        }
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
  }

  // Semantic fact↔fact edges (opt-in via simEdges).
  let semantic: SemanticEdgeResult = { edges: [], embeddedFacts: 0 };
  if (simK > 0) {
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

  return {
    nodes,
    edges,
    meta: {
      // original meta keys/values — unchanged
      factCount: facts.length,
      fileCount: nodes.filter((n) => n.type === 'file').length,
      kindCount: kinds.length,
      entityCount: nodes.filter((n) => n.type === 'entity').length,
      edgeCount: edges.length,
      semantic: semanticLayout,
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
