/**
 * Run: npx tsx --test src/execution/bounded-pool.test.ts
 *
 * Proves the scheduling guarantees the run-drain relies on: the cap is
 * never exceeded, every item runs exactly once, and one throwing worker
 * doesn't abort the pool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedPool } from './bounded-pool.js';

const tick = () => new Promise((r) => setTimeout(r, 1));

test('never exceeds the concurrency cap', async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await runBoundedPool(items, 3, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await tick();
    active -= 1;
  });
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded cap 3`);
  assert.ok(peak >= 2, `expected real concurrency, peak was ${peak}`);
});

test('processes every item exactly once', async () => {
  const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);
  const seen = new Set<string>();
  let count = 0;
  await runBoundedPool(items, 5, async (it) => {
    count += 1;
    seen.add(it);
    await tick();
  });
  assert.equal(count, 50);
  assert.equal(seen.size, 50);
});

test('one throwing worker does not abort the pool; onError gets it', async () => {
  const items = [0, 1, 2, 3, 4];
  const completed: number[] = [];
  const errored: number[] = [];
  await runBoundedPool(
    items,
    2,
    async (n) => {
      if (n === 2) throw new Error('boom');
      await tick();
      completed.push(n);
    },
    (_err, n) => errored.push(n),
  );
  assert.deepEqual(completed.sort(), [0, 1, 3, 4]);
  assert.deepEqual(errored, [2]);
});

test('empty input is a no-op', async () => {
  let ran = 0;
  await runBoundedPool([], 4, async () => { ran += 1; });
  assert.equal(ran, 0);
});

test('concurrency 1 is fully sequential (order preserved)', async () => {
  const items = [0, 1, 2, 3];
  const order: number[] = [];
  await runBoundedPool(items, 1, async (n) => {
    order.push(n);
    await tick();
  });
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test('cap is clamped to item count (concurrency > items)', async () => {
  let active = 0;
  let peak = 0;
  await runBoundedPool([1, 2], 10, async () => {
    active += 1; peak = Math.max(peak, active); await tick(); active -= 1;
  });
  assert.ok(peak <= 2);
});
