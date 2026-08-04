/**
 * Run: npx tsx --test src/runtime/graph/graph-journal.test.ts
 *
 * A resume may trust only what it can prove. These tests pin the refusals: a
 * journal from a different admission, a completion the graph does not contain,
 * and a completed set that is not causally closed are all rejected rather than
 * repaired — because building production authority on a node-ID-only journal
 * is the exact mistake the charter forbids.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { admitGraph, type AdmittedBudget } from './graph-admission.js';
import {
  validateJournalForResume,
  type GraphJournalEntry,
  type NodeSettledEntry,
} from './graph-journal.js';
import type { ExecutableGraph } from './graph-executor.js';

const GRAPH: ExecutableGraph = {
  graphId: 'j1',
  nodes: [{ id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }, { id: 'c', kind: 'step' }],
  edges: [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c' },
  ],
};

const BUDGET: AdmittedBudget = {
  maxNodes: 10, maxWaves: 10, maxConcurrency: 2, maxElapsedMs: 60_000, maxExpansions: 1,
};

function admission() {
  const result = admitGraph({
    graph: GRAPH, compilerVersion: 'c1', policyHash: 'p1', catalogHash: 'k1', budget: BUDGET,
  });
  assert.equal(result.ok, true);
  return (result as Extract<typeof result, { ok: true }>).admission;
}

function settled(over: Partial<NodeSettledEntry> & Pick<NodeSettledEntry, 'nodeId'>): NodeSettledEntry {
  return {
    type: 'node_settled',
    admissionDigest: admission().admissionDigest,
    nodeDigest: 'nd',
    inputDigest: 'id',
    attemptId: `at-${over.nodeId}`,
    wave: 0,
    status: 'completed',
    ...over,
  };
}

test('a causally closed journal resumes, and only completions grant reuse', () => {
  const entries: GraphJournalEntry[] = [
    settled({ nodeId: 'a' }),
    settled({ nodeId: 'b', outputRef: 'art-b' }),
    settled({ nodeId: 'c', status: 'failed', reason: 'provider 500', settlementClass: 'node' }),
  ];
  const result = validateJournalForResume(GRAPH, admission(), entries);
  assert.equal(result.ok, true, JSON.stringify(result));
  const ok = result as Extract<typeof result, { ok: true }>;
  assert.deepEqual([...ok.completed.keys()].sort(), ['a', 'b']);
  assert.equal(ok.completed.get('b')?.outputRef, 'art-b', 'the settled artifact ref was lost');
  assert.equal(ok.completed.has('c'), false, 'a FAILED settlement granted reuse');
});

test('a journal from a different admission is a different run', () => {
  const entries: GraphJournalEntry[] = [
    { ...settled({ nodeId: 'a' }), admissionDigest: 'someone-elses-run' },
  ];
  const result = validateJournalForResume(GRAPH, admission(), entries);
  assert.equal(result.ok, false, 'an entry from another admission was trusted');
  assert.match((result as Extract<typeof result, { ok: false }>).errors[0]!, /admission/);
});

test('a completion the graph does not contain refuses the journal', () => {
  const result = validateJournalForResume(GRAPH, admission(), [settled({ nodeId: 'ghost' })]);
  assert.equal(result.ok, false, 'a completion for an unknown node was trusted');
});

test('a completed set that is not causally closed refuses the journal', () => {
  // c completed but b has NO settlement at all — this history cannot have
  // happened under the executor, so it is not this run's journal.
  const result = validateJournalForResume(GRAPH, admission(), [
    settled({ nodeId: 'a' }),
    settled({ nodeId: 'c' }),
  ]);
  assert.equal(result.ok, false, 'a causally impossible journal was accepted');
  assert.match((result as Extract<typeof result, { ok: false }>).errors[0]!, /causally/);
});

test('a failure-routed history IS causally closed', () => {
  // b settled as failed; c completed via a failure edge in the live run.
  // The validator requires a settlement for b, not a completion.
  const result = validateJournalForResume(GRAPH, admission(), [
    settled({ nodeId: 'a' }),
    settled({ nodeId: 'b', status: 'failed', reason: 'x', settlementClass: 'node' }),
    settled({ nodeId: 'c' }),
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('an interrupted attempt is neither completed nor fatal', () => {
  const entries: GraphJournalEntry[] = [
    settled({ nodeId: 'a' }),
    {
      type: 'node_started',
      admissionDigest: admission().admissionDigest,
      nodeId: 'b', nodeDigest: 'nd', inputDigest: 'id', attemptId: 'at-b-crashed', wave: 1,
    },
  ];
  const result = validateJournalForResume(GRAPH, admission(), entries);
  assert.equal(result.ok, true);
  const ok = result as Extract<typeof result, { ok: true }>;
  assert.deepEqual([...ok.completed.keys()], ['a'], 'a crashed start was treated as done');
});

test('a patch-added node may complete without refusing the journal', () => {
  const adm = admission();
  const entries: GraphJournalEntry[] = [
    settled({ nodeId: 'a' }),
    {
      type: 'patch_admitted',
      admissionDigest: adm.admissionDigest,
      emittedBy: 'a',
      patchDigest: 'pd',
      addedNodeIds: ['w1'],
      addedEdgeIds: ['pe1'],
    },
    settled({ nodeId: 'w1' }),
  ];
  const result = validateJournalForResume(GRAPH, adm, entries);
  assert.equal(result.ok, true, JSON.stringify(result));
  const ok = result as Extract<typeof result, { ok: true }>;
  assert.equal(ok.completed.has('w1'), true);
  assert.equal(ok.patches.length, 1);
});
