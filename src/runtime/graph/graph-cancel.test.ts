/** Run: node scripts/run-tests-isolated.mjs src/runtime/graph/graph-cancel.test.ts */
import test from 'node:test';
import assert from 'node:assert/strict';

import { admitGraph, type GraphAdmission } from './graph-admission.js';
import type { GraphJournalEntry, NodeSettledEntry } from './graph-journal.js';
import {
  runGraph,
  type ExecutableGraph,
  type NodeOutcome,
} from './graph-executor.js';

const BUDGET = {
  maxNodes: 100, maxWaves: 100, maxConcurrency: 1, maxElapsedMs: 60_000, maxExpansions: 0,
};

function admitted(graph: ExecutableGraph): GraphAdmission {
  const result = admitGraph({ graph, compilerVersion: 'cancel', policyHash: 'p', catalogHash: 'k', budget: BUDGET });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).admission;
}

function attempts(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

function memoryAdapter() {
  const entries: GraphJournalEntry[] = [];
  return { entries, adapter: { async append(entry: GraphJournalEntry) { entries.push(entry); } } };
}

const TWO_SINK: ExecutableGraph = {
  graphId: 'walking-cancel',
  nodes: [
    { id: 'dest-a', kind: 'write' },
    { id: 'dest-b', kind: 'write' },
  ],
  edges: [{ id: 'e-ab', source: 'dest-a', target: 'dest-b', when: 'success' }],
};

test('cancel after dest A completes: dest A is completed_after_cancel, dest B never starts', async () => {
  const controller = new AbortController();
  const { entries, adapter } = memoryAdapter();
  const ran = new Set<string>();
  const result = await runGraph(TWO_SINK, {
    runner: {
      run(node): NodeOutcome {
        ran.add(node.id);
        if (node.id === 'dest-a') {
          controller.abort();
          return { status: 'completed', outputRef: 'art-a' };
        }
        return { status: 'completed', outputRef: 'art-b' };
      },
    },
    admission: admitted(TWO_SINK),
    journalAdapter: adapter,
    clock: () => 0,
    signal: controller.signal,
    attemptIds: attempts('c'),
  });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual([...ran], ['dest-a']);
  assert.deepEqual(result.cancelled, ['dest-a']);
  assert.deepEqual(result.completed, []);
  assert.ok(result.unreached.includes('dest-b'));
  const settled = entries.find((entry): entry is NodeSettledEntry => entry.type === 'node_settled');
  assert.equal(settled?.status, 'cancelled');
  assert.equal(settled?.settlementClass, 'completed_after_cancel');
  assert.deepEqual(settled?.firedEdgeIds, [], 'a cancelled write must not publish success edges');
});

test('cancel before dest A dispatch: neither sink starts', async () => {
  const controller = new AbortController();
  controller.abort();
  const { adapter } = memoryAdapter();
  const ran = new Set<string>();
  const result = await runGraph(TWO_SINK, {
    runner: {
      run(node): NodeOutcome {
        ran.add(node.id);
        return { status: 'completed', outputRef: node.id };
      },
    },
    admission: admitted(TWO_SINK),
    journalAdapter: adapter,
    clock: () => 0,
    signal: controller.signal,
    attemptIds: attempts('pre'),
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(ran.size, 0);
  assert.deepEqual(result.cancelled, []);
  assert.ok(result.unreached.includes('dest-a'));
  assert.ok(result.unreached.includes('dest-b'));
});

test('an in-flight throw after abort is uncertain_after_cancel, not a failed success path', async () => {
  const graph: ExecutableGraph = { graphId: 'uncertain-cancel', nodes: [{ id: 'n', kind: 'write' }], edges: [] };
  const controller = new AbortController();
  const { entries, adapter } = memoryAdapter();
  const result = await runGraph(graph, {
    runner: {
      run(): NodeOutcome {
        controller.abort();
        throw new Error('provider dropped the socket');
      },
    },
    admission: admitted(graph),
    journalAdapter: adapter,
    clock: () => 0,
    signal: controller.signal,
    attemptIds: attempts('u'),
  });
  assert.equal(result.status, 'cancelled');
  const settled = entries.find((entry): entry is NodeSettledEntry => entry.type === 'node_settled');
  assert.equal(settled?.status, 'cancelled');
  assert.equal(settled?.settlementClass, 'uncertain_after_cancel');
  assert.deepEqual(settled?.firedEdgeIds, []);
});
