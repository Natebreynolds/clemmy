/**
 * Graph admission: the content-addressed identity a run executes under.
 *
 * The pure walker in graph-executor.ts may run an anonymous graph with
 * optional limits — that is what its unit tests need. An ADMITTED run is the
 * production shape: every digest below is fixed before the first node starts,
 * every budget is finite, and the journal stamps each entry with the admission
 * digest so a resume can prove it is replaying the same run rather than a
 * look-alike. Node ID alone is never reuse identity; this module is where the
 * rest of the identity comes from.
 *
 * Pure and deterministic: `node:crypto` for digests, nothing else. No
 * filesystem, no environment, no clock — admission binds identity, it does
 * not observe the world.
 */
import { createHash } from 'node:crypto';

import type { ExecutableEdge, ExecutableGraph, ExecutableNode } from './graph-executor.js';

/**
 * Every ceiling an admitted run carries. All finite — an admitted production
 * run with an infinite budget is the "runaway loop with no exit" defect the
 * charter forbids. A legitimate long task does not get a bigger infinity; it
 * parks at a resumable boundary and continues in a new activation.
 */
export interface AdmittedBudget {
  maxNodes: number;
  maxWaves: number;
  maxConcurrency: number;
  /** Elapsed wall-clock ceiling, measured by the caller-injected clock. */
  maxElapsedMs: number;
  /** How many dynamic graph patches (emitted subgraphs) may be admitted. */
  maxExpansions: number;
}

export interface GraphAdmission {
  /** Digest over everything below — the run's identity. */
  admissionDigest: string;
  graphDigest: string;
  compilerVersion: string;
  /** Immutable policy snapshot hash. Opaque here; owned by the admission boundary. */
  policyHash: string;
  /** Capability catalog / schema universe hash. Opaque here. */
  catalogHash: string;
  budget: AdmittedBudget;
}

export interface AdmissionRefusal {
  ok: false;
  errors: string[];
}

export interface AdmissionOk {
  ok: true;
  admission: GraphAdmission;
}

export type AdmissionResult = AdmissionOk | AdmissionRefusal;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function canonicalNode(node: ExecutableNode): string {
  return JSON.stringify({ id: node.id, kind: node.kind, joinMode: node.joinMode ?? 'all' });
}

function canonicalEdge(edge: ExecutableEdge): string {
  return JSON.stringify({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    when: edge.when ?? 'success',
    disabled: edge.disabled === true,
  });
}

/**
 * Digest of the graph STRUCTURE. Node/edge declaration order is part of the
 * digest deliberately: the executor schedules in declaration order, so two
 * orderings are two different runs even when set-equal.
 */
export function computeGraphDigest(graph: ExecutableGraph): string {
  return sha256(JSON.stringify({
    graphId: graph.graphId,
    nodes: graph.nodes.map(canonicalNode),
    edges: graph.edges.map(canonicalEdge),
  }));
}

/** Digest of one node's definition — reuse identity requires it to match. */
export function computeNodeDigest(node: ExecutableNode): string {
  return sha256(canonicalNode(node));
}

/**
 * Digest of the inputs a node ran with: the settled output/evidence refs of
 * its fired predecessors, in edge-declaration order. Two attempts whose
 * predecessors produced different artifacts are different work, whatever the
 * node id says.
 */
export function computeInputDigest(
  predecessors: ReadonlyArray<{ nodeId: string; outputRef?: string; evidenceRefs?: readonly string[] }>,
): string {
  return sha256(JSON.stringify(predecessors.map((p) => ({
    nodeId: p.nodeId,
    outputRef: p.outputRef ?? null,
    evidenceRefs: [...(p.evidenceRefs ?? [])],
  }))));
}

const BUDGET_FIELDS: Array<keyof AdmittedBudget> = [
  'maxNodes', 'maxWaves', 'maxConcurrency', 'maxElapsedMs', 'maxExpansions',
];

/**
 * Admit a graph for durable execution.
 *
 * Refuses non-finite or non-positive budgets (maxExpansions may be zero — a
 * run allowed no dynamic growth is a legitimate, common shape). Structural
 * validity (cycles, dangling edges) is the compilers' and validators' job at
 * their own admission seams; this binds identity and ceilings.
 */
export function admitGraph(input: {
  graph: ExecutableGraph;
  compilerVersion: string;
  policyHash: string;
  catalogHash: string;
  budget: AdmittedBudget;
}): AdmissionResult {
  const errors: string[] = [];
  for (const field of BUDGET_FIELDS) {
    const value = input.budget[field];
    const floor = field === 'maxExpansions' ? 0 : 1;
    if (!Number.isFinite(value) || value < floor) {
      errors.push(`budget.${field} must be a finite number >= ${floor}; got ${String(value)}`);
    }
  }
  if (!input.compilerVersion.trim()) errors.push('compilerVersion is required');
  if (!input.policyHash.trim()) errors.push('policyHash is required');
  if (!input.catalogHash.trim()) errors.push('catalogHash is required');
  if (errors.length > 0) return { ok: false, errors };

  const graphDigest = computeGraphDigest(input.graph);
  const budget: AdmittedBudget = {
    maxNodes: Math.floor(input.budget.maxNodes),
    maxWaves: Math.floor(input.budget.maxWaves),
    maxConcurrency: Math.floor(input.budget.maxConcurrency),
    maxElapsedMs: Math.floor(input.budget.maxElapsedMs),
    maxExpansions: Math.floor(input.budget.maxExpansions),
  };
  const admissionDigest = sha256(JSON.stringify({
    graphDigest,
    compilerVersion: input.compilerVersion,
    policyHash: input.policyHash,
    catalogHash: input.catalogHash,
    budget,
  }));
  return {
    ok: true,
    admission: {
      admissionDigest,
      graphDigest,
      compilerVersion: input.compilerVersion,
      policyHash: input.policyHash,
      catalogHash: input.catalogHash,
      budget,
    },
  };
}

// ── dynamic topology ─────────────────────────────────────────────────────────

/** A subgraph emitted at runtime by a completed node. */
export interface GraphPatch {
  /** The node whose completion emitted this patch. */
  emittedBy: string;
  nodes: readonly ExecutableNode[];
  edges: readonly ExecutableEdge[];
}

export interface PatchValidationOk {
  ok: true;
  patchDigest: string;
}

export type PatchValidationResult = PatchValidationOk | AdmissionRefusal;

/**
 * Structural validation of a runtime-emitted patch, before any child starts.
 *
 * A patch may only ADD: new node ids, edges among new nodes, edges from
 * existing nodes into new ones, and JOIN edges from new nodes into existing
 * nodes — the shape a fan-out contract needs, where runtime workers join a
 * compiled reducer. It cannot redefine an existing node and cannot introduce
 * a cycle anywhere in the combined graph.
 *
 * A join edge is structurally legal but temporally guarded: the EXECUTOR
 * refuses a patch whose join target has already settled or whose readiness
 * has already fired, because growing a node's AND-set after it fired would
 * rewrite scheduling history. Structure here, time there — this function is
 * pure and cannot know runtime state. Authority narrowing is the injected
 * patch admitter's dimension.
 */
export function validateGraphPatch(
  graph: ExecutableGraph,
  patch: GraphPatch,
): PatchValidationResult {
  const errors: string[] = [];
  const existingNodes = new Set(graph.nodes.map((node) => node.id));
  const existingEdges = new Set(graph.edges.map((edge) => edge.id));
  const newNodes = new Set<string>();

  if (!existingNodes.has(patch.emittedBy)) {
    errors.push(`emittedBy "${patch.emittedBy}" is not a node in the admitted graph`);
  }
  if (patch.nodes.length === 0) errors.push('a patch must add at least one node');
  for (const node of patch.nodes) {
    if (existingNodes.has(node.id)) errors.push(`node "${node.id}" already exists; a patch cannot redefine`);
    if (newNodes.has(node.id)) errors.push(`node "${node.id}" appears twice in the patch`);
    newNodes.add(node.id);
  }
  for (const edge of patch.edges) {
    if (existingEdges.has(edge.id)) errors.push(`edge "${edge.id}" already exists`);
    if (!newNodes.has(edge.target) && !existingNodes.has(edge.target)) {
      errors.push(`edge "${edge.id}" targets unknown node "${edge.target}"`);
    }
    if (!newNodes.has(edge.source) && !existingNodes.has(edge.source)) {
      errors.push(`edge "${edge.id}" sources unknown node "${edge.source}"`);
    }
    if (existingNodes.has(edge.source) && existingNodes.has(edge.target)) {
      errors.push(`edge "${edge.id}" connects two existing nodes — a patch cannot rewire the admitted graph`);
    }
  }

  // Cycle check over the COMBINED graph: a join edge into an existing node can
  // close a loop through the admitted topology, not only among additions.
  const adjacency = new Map<string, string[]>();
  const link = (source: string, target: string): void => {
    adjacency.set(source, [...(adjacency.get(source) ?? []), target]);
  };
  for (const edge of graph.edges) { if (!edge.disabled) link(edge.source, edge.target); }
  for (const edge of patch.edges) { if (!edge.disabled) link(edge.source, edge.target); }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) if (hasCycle(next)) return true;
    visiting.delete(id);
    done.add(id);
    return false;
  };
  for (const id of [...existingNodes, ...newNodes]) {
    if (hasCycle(id)) { errors.push('patch introduces a cycle in the combined graph'); break; }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    patchDigest: sha256(JSON.stringify({
      emittedBy: patch.emittedBy,
      nodes: patch.nodes.map(canonicalNode),
      edges: patch.edges.map(canonicalEdge),
    })),
  };
}
