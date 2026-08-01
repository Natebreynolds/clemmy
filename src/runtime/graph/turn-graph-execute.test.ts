/**
 * Run: npx tsx --test src/runtime/graph/turn-graph-execute.test.ts
 *
 * The executing graph lane. Compiles a REAL multi-item action request through
 * the production compiler, then runs the plan it emits — so these pin the seam
 * between "the graph was planned" and "the graph ran", which is where the lane
 * was broken: the compiler emitted fanout → execute(per_item) → reduce, and
 * nothing executed it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileTurnGraph } from './turn-graph-compiler.js';
import type { TurnGraphPolicySnapshot } from './turn-graph-ir.js';
import {
  effectiveConcurrency,
  executeTurnGraphFanout,
  isFanoutGraph,
  turnGraphExecutableNodes,
  type TurnGraphItem,
} from './turn-graph-execute.js';

const IDENTITY = { sessionId: 'sess-graph-exec', turn: 1, sourceUserSeq: 10 };
/** Immutable per-turn policy, same shape the compiler suite pins. */
const POLICY: TurnGraphPolicySnapshot = {
  version: 'turn-policy-v1',
  autoApproveScope: 'yolo',
  proactiveWorkAllowed: true,
  allowComposioActions: true,
  allowComputerActions: true,
  requireWorkflowApprovalForExecution: true,
  batchConfirmThreshold: 5,
};
const MULTI_ITEM_REQUEST =
  'research these 10 firms and draft a short outreach email for each of them';

function compile(input: string) {
  return compileTurnGraph({ identity: IDENTITY, input, sessionKind: 'chat', surface: 'home', policy: POLICY }).graph;
}

function items(n: number): TurnGraphItem[] {
  return Array.from({ length: n }, (_v, i) => ({ id: `firm-${i + 1}`, prompt: `enrich firm ${i + 1}` }));
}

test('a real multi-item request compiles to a fan-out lane the executor recognizes', () => {
  const ir = compile(MULTI_ITEM_REQUEST);
  assert.equal(isFanoutGraph(ir), true, 'the compiler already plans per-item fan-out for this shape');
  const kinds = turnGraphExecutableNodes(ir).map((node) => node.kind);
  assert.deepEqual(kinds, ['fanout', 'execute', 'reduce'], 'and the executor claims exactly those nodes');
});

test('every item runs exactly once', () => {
  // The wasteful-rework class: the same target scraped two or three times
  // across waves. Identity is the contract.
  const ir = compile(MULTI_ITEM_REQUEST);
  const seen: string[] = [];
  return executeTurnGraphFanout({
    ir,
    items: items(10),
    runners: { execute: async ({ item }) => { seen.push(item.id); return `done ${item.id}`; } },
  }).then((execution) => {
    assert.equal(seen.length, 10);
    assert.equal(new Set(seen).size, 10, 'no item ran twice');
    assert.equal(execution.complete, true);
    assert.equal(execution.branches.length, 10);
  });
});

test('duplicate identities collapse before dispatch, not after', () => {
  const ir = compile(MULTI_ITEM_REQUEST);
  let dispatched = 0;
  const dupes: TurnGraphItem[] = [
    { id: 'firm-a', prompt: 'first' },
    { id: 'firm-a', prompt: 'same target, rewritten label' },
    { id: 'firm-b', prompt: 'other' },
  ];
  return executeTurnGraphFanout({
    ir,
    items: dupes,
    runners: { execute: async () => { dispatched += 1; return null; } },
  }).then((execution) => {
    assert.equal(dispatched, 2, 'the same id is the same work — paying for it twice is the bug');
    assert.equal(execution.branches.length, 2);
  });
});

test('branches actually run in parallel, bounded by the compiled ceiling', async () => {
  // A lane that "fans out" serially is the loop wearing a graph's clothes.
  const ir = compile(MULTI_ITEM_REQUEST);
  let live = 0;
  let peak = 0;
  const execution = await executeTurnGraphFanout({
    ir,
    items: items(10),
    runners: {
      execute: async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 5));
        live -= 1;
        return null;
      },
    },
  });
  assert.ok(peak > 1, `expected real concurrency, peaked at ${peak}`);
  assert.ok(peak <= execution.concurrency, `peak ${peak} exceeded the compiled ceiling ${execution.concurrency}`);
});

test('one failing item never takes the batch down', async () => {
  const ir = compile(MULTI_ITEM_REQUEST);
  const execution = await executeTurnGraphFanout({
    ir,
    items: items(6),
    runners: {
      execute: async ({ item }) => {
        if (item.id === 'firm-3') throw new Error('provider timed out');
        return `ok ${item.id}`;
      },
    },
  });
  assert.equal(execution.branches.length, 6, 'every item still reports');
  assert.deepEqual(execution.failedItemIds, ['firm-3']);
  assert.equal(execution.complete, false, 'a partial run must never read as complete');
  assert.match(execution.branches[2]!.error ?? '', /timed out/);
});

test('results keep stable item order regardless of completion order', async () => {
  // A reducer merging in finish order returns a different answer for identical
  // inputs on every run. Determinism is a property of the lane, not of luck.
  const ir = compile(MULTI_ITEM_REQUEST);
  const execution = await executeTurnGraphFanout({
    ir,
    items: items(5),
    runners: {
      execute: async ({ item }) => {
        const delay = item.id === 'firm-1' ? 25 : 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return item.id;
      },
    },
  });
  assert.deepEqual(
    execution.branches.map((branch) => branch.itemId),
    ['firm-1', 'firm-2', 'firm-3', 'firm-4', 'firm-5'],
  );
});

test('the reducer sees failures too, so a partial run cannot be summarized as whole', async () => {
  const ir = compile(MULTI_ITEM_REQUEST);
  let sawBranches = 0;
  let sawFailures = 0;
  const execution = await executeTurnGraphFanout({
    ir,
    items: items(4),
    runners: {
      execute: async ({ item }) => {
        if (item.id === 'firm-2') throw new Error('nope');
        return item.id;
      },
      reduce: async ({ branches }) => {
        sawBranches = branches.length;
        sawFailures = branches.filter((branch) => !branch.ok).length;
        return { merged: branches.filter((branch) => branch.ok).map((branch) => branch.output) };
      },
    },
  });
  assert.equal(sawBranches, 4, 'the reducer is handed every branch');
  assert.equal(sawFailures, 1, 'including the one that failed');
  assert.deepEqual(execution.reduced, { merged: ['firm-1', 'firm-3', 'firm-4'] });
});

test('worker lifecycle is observable — the telemetry that read zero', async () => {
  const ir = compile(MULTI_ITEM_REQUEST);
  const started: string[] = [];
  const settled: string[] = [];
  await executeTurnGraphFanout({
    ir,
    items: items(3),
    runners: {
      execute: async ({ item }) => item.id,
      onBranchStart: ({ item }) => { started.push(item.id); },
      onBranchSettle: (result) => { settled.push(result.itemId); },
    },
  });
  assert.equal(started.length, 3, 'nonzero worker starts');
  assert.equal(settled.length, 3, 'and every one settles');
});

test('an aborted run reports cancelled branches rather than fabricating results', async () => {
  const ir = compile(MULTI_ITEM_REQUEST);
  const controller = new AbortController();
  controller.abort();
  const execution = await executeTurnGraphFanout({
    ir,
    items: items(3),
    runners: { execute: async () => { throw new Error('must not dispatch'); } },
    signal: controller.signal,
  });
  assert.equal(execution.complete, false);
  assert.equal(execution.failedItemIds.length, 3);
  for (const branch of execution.branches) assert.match(branch.error ?? '', /cancelled/);
});

test('a single-action request is not forced through the fan-out lane', () => {
  // The executor must not manufacture topology. One thing to do is one node.
  const ir = compile('send the quarterly update to the team');
  assert.equal(isFanoutGraph(ir), false);
});

test('concurrency never exceeds the work present', () => {
  const ir = compile(MULTI_ITEM_REQUEST);
  const executeNode = ir.nodes.find((node) => node.kind === 'execute')!;
  assert.equal(effectiveConcurrency(executeNode, 2), 2, 'two items never open eight lanes');
  assert.equal(effectiveConcurrency(executeNode, 0), 1, 'and never fewer than one');
});
