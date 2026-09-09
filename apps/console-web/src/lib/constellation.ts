/**
 * The constellation's pure layout: the selected memory at the center, what it
 * touches on a first ring, what those touch on a second, with an edge label a
 * person can read. Deterministic and tested; the component only draws it.
 */
import type { GraphEdge, GraphNode } from './memory';

export interface StarNode { id: string; label: string; type: string; x: number; y: number; ring: 0 | 1 | 2 }
export interface StarEdge { id: string; from: StarNode; to: StarNode; label: string; weak: boolean }
export interface Constellation { nodes: StarNode[]; edges: StarEdge[] }

const EDGE_LABEL: Record<string, string> = {
  mentions: 'mentions', supports: 'backs', evidence: 'from', about: 'about', relates: 'relates', similar: 'similar', derived: 'derived from',
  source: 'from', file: 'file', person: 'person', entity: 'about', works_at: 'works at', knows: 'knows', part_of: 'part of', located_in: 'in',
};

export function edgeLabel(type: string): string {
  const t = type.toLowerCase();
  return EDGE_LABEL[t] ?? t.replace(/[_-]+/g, ' ').replace(/^fact to /, '').slice(0, 14);
}

/** Short node labels: a file keeps its basename, long text keeps its first words. */
export function starLabel(node: Pick<GraphNode, 'label' | 'type' | 'id'>, max = 18): string {
  let s = (node.label || node.id).trim();
  if (node.type === 'file') s = s.split('/').pop() ?? s;
  // The graph's kind nodes shout in caps ("REFERENCE"); the sky speaks quietly.
  if (node.type === 'kind' && s === s.toUpperCase()) s = s.charAt(0) + s.slice(1).toLowerCase();
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  return s;
}

export function layoutConstellation(seedId: string, nodes: GraphNode[], edges: GraphEdge[], width = 356, height = 170, caps = { ring1: 6, ring2: 6 }): Constellation {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seed = byId.get(seedId);
  if (!seed) return { nodes: [], edges: [] };
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    adj.set(e.source, (adj.get(e.source) ?? new Set()).add(e.target));
    adj.set(e.target, (adj.get(e.target) ?? new Set()).add(e.source));
  }
  const ring1 = [...(adj.get(seedId) ?? [])].slice(0, caps.ring1);
  const seen = new Set([seedId, ...ring1]);
  const ring2: string[] = [];
  for (const r of ring1) for (const n of adj.get(r) ?? []) { if (!seen.has(n) && ring2.length < caps.ring2) { seen.add(n); ring2.push(n); } }
  const cx = width / 2; const cy = height / 2;
  // Ellipses sized to the box so every node (and its label) stays inside.
  const place = (ids: string[], rx: number, ry: number, ring: 1 | 2, offset: number): StarNode[] => ids.map((id, i) => {
    const a = offset + (i / Math.max(1, ids.length)) * Math.PI * 2;
    const n = byId.get(id)!;
    return { id, label: starLabel(n), type: n.type, x: Math.round(cx + Math.cos(a) * rx), y: Math.round(cy + Math.sin(a) * ry), ring };
  });
  const out: StarNode[] = [
    { id: seedId, label: starLabel(seed, 24), type: seed.type, x: cx, y: cy, ring: 0 },
    ...place(ring1, cx * 0.6, cy * 0.55, 1, -Math.PI / 2),
    ...place(ring2, cx * 0.86, cy * 0.8, 2, -Math.PI / 2 + 0.4),
  ];
  const pos = new Map(out.map((n) => [n.id, n]));
  const starEdges: StarEdge[] = [];
  const dedupe = new Set<string>();
  for (const e of edges) {
    const a = pos.get(e.source); const b = pos.get(e.target);
    if (!a || !b) continue;
    const key = [a.id, b.id].sort().join('|');
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    starEdges.push({ id: e.id, from: a, to: b, label: edgeLabel(e.type), weak: a.ring === 2 || b.ring === 2 || e.truth === 'inferred' || e.truth === 'semantic' });
  }
  return { nodes: out, edges: starEdges };
}
