/**
 * Run: npx tsx --test src/runtime/graph/graph-admission.test.ts
 *
 * Admission is identity. These tests pin that every dimension of the identity
 * — structure, order, versions, budgets — changes the digest, that no admitted
 * budget can be infinite, and that a runtime patch can only ADD, never rewire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  admitGraph,
  computeGraphDigest,
  computeInputDigest,
  computeNodeDigest,
  validateGraphPatch,
  type AdmittedBudget,
} from './graph-admission.js';
import type { ExecutableGraph } from './graph-executor.js';

const GRAPH: ExecutableGraph = {
  graphId: 'g1',
  nodes: [{ id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }],
  edges: [{ id: 'e1', source: 'a', target: 'b' }],
};

const BUDGET: AdmittedBudget = {
  maxNodes: 100, maxWaves: 50, maxConcurrency: 8, maxElapsedMs: 60_000, maxExpansions: 4,
};

function admit(overrides: Partial<Parameters<typeof admitGraph>[0]> = {}) {
  return admitGraph({
    graph: GRAPH, compilerVersion: 'c1', policyHash: 'p1', catalogHash: 'k1',
    budget: BUDGET, ...overrides,
  });
}

test('every identity dimension changes the admission digest', () => {
  const base = admit();
  assert.equal(base.ok, true);
  const baseline = (base as Extract<typeof base, { ok: true }>).admission.admissionDigest;

  const variants: Array<Parameters<typeof admitGraph>[0]> = [
    { graph: { ...GRAPH, nodes: [...GRAPH.nodes, { id: 'c', kind: 'step' }] }, compilerVersion: 'c1', policyHash: 'p1', catalogHash: 'k1', budget: BUDGET },
    { graph: GRAPH, compilerVersion: 'c2', policyHash: 'p1', catalogHash: 'k1', budget: BUDGET },
    { graph: GRAPH, compilerVersion: 'c1', policyHash: 'p2', catalogHash: 'k1', budget: BUDGET },
    { graph: GRAPH, compilerVersion: 'c1', policyHash: 'p1', catalogHash: 'k2', budget: BUDGET },
    { graph: GRAPH, compilerVersion: 'c1', policyHash: 'p1', catalogHash: 'k1', budget: { ...BUDGET, maxNodes: 99 } },
  ];
  for (const [i, input] of variants.entries()) {
    const result = admitGraph(input);
    assert.equal(result.ok, true);
    assert.notEqual(
      (result as Extract<typeof result, { ok: true }>).admission.admissionDigest,
      baseline,
      `variant ${i} did not change the admission digest`,
    );
  }
  // Same input, same digest — identity is deterministic.
  const again = admit();
  assert.equal((again as Extract<typeof again, { ok: true }>).admission.admissionDigest, baseline);
});

test('declaration ORDER is part of graph identity', () => {
  const reordered: ExecutableGraph = {
    ...GRAPH,
    nodes: [GRAPH.nodes[1]!, GRAPH.nodes[0]!],
  };
  assert.notEqual(computeGraphDigest(GRAPH), computeGraphDigest(reordered),
    'the executor schedules in declaration order, so order must be identity');
});

test('no admitted budget may be infinite or non-positive', () => {
  for (const field of ['maxNodes', 'maxWaves', 'maxConcurrency', 'maxElapsedMs'] as const) {
    for (const bad of [Number.POSITIVE_INFINITY, 0, -1, Number.NaN]) {
      const result = admit({ budget: { ...BUDGET, [field]: bad } });
      assert.equal(result.ok, false, `${field}=${bad} was admitted`);
    }
  }
  // Zero expansions is a legitimate no-growth run; infinity still is not.
  assert.equal(admit({ budget: { ...BUDGET, maxExpansions: 0 } }).ok, true);
  assert.equal(admit({ budget: { ...BUDGET, maxExpansions: Number.POSITIVE_INFINITY } }).ok, false);
});

test('input digest binds predecessor artifacts, not just names', () => {
  const a = computeInputDigest([{ nodeId: 'a', outputRef: 'art-1' }]);
  const b = computeInputDigest([{ nodeId: 'a', outputRef: 'art-2' }]);
  const c = computeInputDigest([{ nodeId: 'a', outputRef: 'art-1', evidenceRefs: ['ev-1'] }]);
  assert.notEqual(a, b, 'a different predecessor output produced the same input identity');
  assert.notEqual(a, c, 'evidence refs are not part of input identity');
  assert.equal(a, computeInputDigest([{ nodeId: 'a', outputRef: 'art-1' }]));
  assert.notEqual(computeNodeDigest({ id: 'a', kind: 'step' }), computeNodeDigest({ id: 'a', kind: 'model' }));
});

// ── patches: add-only, acyclic, no rewiring ─────────────────────────────────

test('a valid patch adds nodes and edges into the new region only', () => {
  const result = validateGraphPatch(GRAPH, {
    emittedBy: 'b',
    nodes: [{ id: 'c1', kind: 'worker' }, { id: 'c2', kind: 'worker' }, { id: 'r', kind: 'reduce' }],
    edges: [
      { id: 'p1', source: 'b', target: 'c1' },
      { id: 'p2', source: 'b', target: 'c2' },
      { id: 'p3', source: 'c1', target: 'r' },
      { id: 'p4', source: 'c2', target: 'r' },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match((result as Extract<typeof result, { ok: true }>).patchDigest, /^[0-9a-f]{64}$/);
});

test('a patch cannot redefine, rewire, or cycle', () => {
  const redefine = validateGraphPatch(GRAPH, {
    emittedBy: 'b', nodes: [{ id: 'a', kind: 'step' }], edges: [],
  });
  assert.equal(redefine.ok, false, 'redefining an existing node was admitted');

  // A JOIN edge into an existing node is structurally legal — that is how a
  // fan-out contract joins runtime workers into a compiled reducer. But an
  // edge between two EXISTING nodes rewires the admitted graph, and a join
  // that closes a loop through the admitted topology is a cycle. (The
  // temporal half — refusing joins whose target already settled or fired —
  // is the executor's, pinned in graph-executor-topology.test.ts.)
  const join = validateGraphPatch(GRAPH, {
    emittedBy: 'a',
    nodes: [{ id: 'c', kind: 'worker' }],
    edges: [
      { id: 'p1', source: 'a', target: 'c' },
      { id: 'p2', source: 'c', target: 'b' },
    ],
  });
  assert.equal(join.ok, true, 'a legal join into an unsettled compiled reducer was refused');

  const rewire = validateGraphPatch(GRAPH, {
    emittedBy: 'b',
    nodes: [{ id: 'c', kind: 'step' }],
    edges: [{ id: 'p1', source: 'a', target: 'b' }],
  });
  assert.equal(rewire.ok, false, 'an edge between two existing nodes was admitted');

  const cycleViaExisting = validateGraphPatch(GRAPH, {
    emittedBy: 'a',
    nodes: [{ id: 'c', kind: 'step' }],
    edges: [
      { id: 'p1', source: 'b', target: 'c' },
      { id: 'p2', source: 'c', target: 'a' },
    ],
  });
  assert.equal(cycleViaExisting.ok, false, 'a cycle THROUGH the admitted graph was admitted');

  const cycle = validateGraphPatch(GRAPH, {
    emittedBy: 'b',
    nodes: [{ id: 'c', kind: 'step' }, { id: 'd', kind: 'step' }],
    edges: [
      { id: 'p1', source: 'c', target: 'd' },
      { id: 'p2', source: 'd', target: 'c' },
    ],
  });
  assert.equal(cycle.ok, false, 'a cyclic patch was admitted');

  const orphanEmitter = validateGraphPatch(GRAPH, {
    emittedBy: 'ghost', nodes: [{ id: 'c', kind: 'step' }], edges: [],
  });
  assert.equal(orphanEmitter.ok, false);

  const empty = validateGraphPatch(GRAPH, { emittedBy: 'b', nodes: [], edges: [] });
  assert.equal(empty.ok, false, 'an empty patch was admitted');
});

test('the patch digest is stable and content-addressed', () => {
  const patch = {
    emittedBy: 'b',
    nodes: [{ id: 'c', kind: 'worker' }],
    edges: [{ id: 'p1', source: 'b', target: 'c' }],
  };
  const first = validateGraphPatch(GRAPH, patch);
  const second = validateGraphPatch(GRAPH, patch);
  assert.equal(first.ok, true);
  assert.equal(
    (first as Extract<typeof first, { ok: true }>).patchDigest,
    (second as Extract<typeof second, { ok: true }>).patchDigest,
  );
  const different = validateGraphPatch(GRAPH, {
    ...patch, nodes: [{ id: 'c', kind: 'model' }],
  });
  assert.notEqual(
    (first as Extract<typeof first, { ok: true }>).patchDigest,
    (different as Extract<typeof different, { ok: true }>).patchDigest,
  );
});

test('admission reaches nothing but crypto', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, 'graph-admission.ts'), 'utf-8');
  const imports = [...source.matchAll(/^import (?!type ).*?from '([^']+)';$/gms)].map((m) => m[1]);
  assert.deepEqual(imports, ['node:crypto'], 'admission grew a runtime dependency');
  for (const forbidden of ['process.env', 'readFileSync', 'Date.now', 'new Date', 'Math.random']) {
    assert.equal(source.includes(forbidden), false, `admission references ${forbidden}`);
  }
});
