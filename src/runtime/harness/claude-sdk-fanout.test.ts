import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFanoutSlot, _resetFanoutConcurrencyForTest } from './claude-sdk-fanout.js';

// Review FANOUT-1: the fan-out must never spawn more than N workers at once (each is a
// headless `claude` subprocess). These exercise the module-level semaphore directly.

async function measurePeak(n: number): Promise<{ peak: number; done: number }> {
  _resetFanoutConcurrencyForTest();
  let active = 0;
  let peak = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: n }, () =>
      withFanoutSlot(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        done += 1;
      }),
    ),
  );
  return { peak, done };
}

test('fan-out concurrency: 20 concurrent workers never exceed the default cap of 8', async () => {
  delete process.env.CLEMMY_CLAUDE_SDK_FANOUT_CONCURRENCY;
  const { peak, done } = await measurePeak(20);
  assert.ok(peak <= 8, `peak concurrency ${peak} must be <= 8`);
  assert.ok(peak >= 2, 'should actually run in parallel up to the cap');
  assert.equal(done, 20, 'every worker completes — none stranded by the semaphore');
});

test('fan-out concurrency: honors CLEMMY_CLAUDE_SDK_FANOUT_CONCURRENCY', async () => {
  const prev = process.env.CLEMMY_CLAUDE_SDK_FANOUT_CONCURRENCY;
  process.env.CLEMMY_CLAUDE_SDK_FANOUT_CONCURRENCY = '3';
  try {
    const { peak, done } = await measurePeak(15);
    assert.ok(peak <= 3, `peak ${peak} must be <= 3`);
    assert.equal(done, 15);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CLAUDE_SDK_FANOUT_CONCURRENCY;
    else process.env.CLEMMY_CLAUDE_SDK_FANOUT_CONCURRENCY = prev;
  }
});

test('fan-out concurrency: a throwing worker still releases its slot (no deadlock)', async () => {
  _resetFanoutConcurrencyForTest();
  delete process.env.CLEMMY_CLAUDE_SDK_FANOUT_CONCURRENCY;
  // 12 tasks, all throw — if release didn't run in finally, later waiters would hang.
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => withFanoutSlot(async () => { throw new Error('boom'); })),
  );
  assert.equal(results.filter((r) => r.status === 'rejected').length, 12);
  // and the semaphore is fully drained afterward — a fresh batch runs to completion.
  const { done } = await measurePeak(10);
  assert.equal(done, 10);
});
