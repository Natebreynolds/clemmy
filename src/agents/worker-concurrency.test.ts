/**
 * Run: npx tsx --test src/agents/worker-concurrency.test.ts
 *
 * The per-session worker fan-out gate: at most K executions in flight per session,
 * the rest queue FIFO and start as slots free — the throttle that stops a parallel
 * "fan out N items" turn from storming a rate limit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { acquireWorkerSlot, _activeWorkerSlots, _activeGlobalWorkerSlots, _resetWorkerConcurrencyForTest } = await import('./worker-concurrency.js');

function withEnv(over: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(over)) {
    prev[k] = process.env[k];
    if (over[k] === undefined) delete process.env[k];
    else process.env[k] = over[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(over)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

test('never more than K in flight; every acquire eventually runs', async () => {
  await withEnv({ CLEMMY_WORKER_MAX_CONCURRENCY: '3' }, async () => {
    _resetWorkerConcurrencyForTest();
    const K = 3;
    const total = 30;
    let inFlight = 0;
    let maxObserved = 0;
    let completed = 0;

    async function worker(): Promise<void> {
      const release = await acquireWorkerSlot('sess-A');
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      // Yield a few microtasks to interleave — simulates async work.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      completed += 1;
      release();
    }

    await Promise.all(Array.from({ length: total }, () => worker()));
    assert.equal(completed, total, 'all workers completed');
    assert.ok(maxObserved <= K, `never exceeded the cap (saw ${maxObserved} ≤ ${K})`);
    assert.ok(maxObserved >= 1, 'work actually ran concurrently');
    assert.equal(_activeWorkerSlots('sess-A'), 0, 'gate fully drained');
  });
});

test('queued acquires wait until a slot frees (FIFO hand-off)', async () => {
  await withEnv({ CLEMMY_WORKER_MAX_CONCURRENCY: '1' }, async () => {
    _resetWorkerConcurrencyForTest();
    const order: number[] = [];
    const r1 = await acquireWorkerSlot('sess-B'); // holds the only slot
    let r2done = false;
    let r3done = false;
    const p2 = acquireWorkerSlot('sess-B').then((r) => { order.push(2); r2done = true; return r; });
    const p3 = acquireWorkerSlot('sess-B').then((r) => { order.push(3); r3done = true; return r; });
    await Promise.resolve();
    assert.equal(r2done, false, 'second acquire blocks while the slot is held');
    assert.equal(r3done, false, 'third acquire blocks too');

    r1(); // free the slot → hands to waiter #2 (FIFO)
    const r2 = await p2;
    assert.equal(r2done, true);
    assert.equal(r3done, false, 'waiter #3 still blocked behind #2');
    r2(); // → hands to waiter #3
    await p3;
    assert.deepEqual(order, [2, 3], 'waiters resumed in FIFO order');
  });
});

test('double-release is idempotent (never corrupts the count)', async () => {
  await withEnv({ CLEMMY_WORKER_MAX_CONCURRENCY: '2' }, async () => {
    _resetWorkerConcurrencyForTest();
    const r = await acquireWorkerSlot('sess-C');
    assert.equal(_activeWorkerSlots('sess-C'), 1);
    r();
    r(); // second call is a no-op
    assert.equal(_activeWorkerSlots('sess-C'), 0, 'gate drained, not driven negative');
  });
});

test('kill-switch (=0 / off) disables the gate — unbounded concurrency', async () => {
  for (const val of ['0', 'off', 'unlimited']) {
    await withEnv({ CLEMMY_WORKER_MAX_CONCURRENCY: val }, async () => {
      _resetWorkerConcurrencyForTest();
      // Acquire far more than any real cap without releasing — none should block.
      const releases = await Promise.all(Array.from({ length: 50 }, () => acquireWorkerSlot('sess-D')));
      assert.equal(releases.length, 50, `all 50 acquired immediately with kill-switch=${val}`);
      releases.forEach((r) => r());
    });
  }
});

test('per-session isolation — one busy session does not block another', async () => {
  await withEnv({ CLEMMY_WORKER_MAX_CONCURRENCY: '1' }, async () => {
    _resetWorkerConcurrencyForTest();
    const a = await acquireWorkerSlot('sess-E'); // fills sess-E
    let bAcquired = false;
    const pb = acquireWorkerSlot('sess-F').then((r) => { bAcquired = true; return r; });
    const b = await pb;
    assert.equal(bAcquired, true, 'a different session gets its own slot immediately');
    a(); b();
  });
});

test('GLOBAL ceiling bounds total workers ACROSS sessions (cross-session storm cap)', async () => {
  await withEnv({ CLEMMY_WORKER_MAX_CONCURRENCY: '6', CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL: '4' }, async () => {
    _resetWorkerConcurrencyForTest();
    // 3 sessions × 2 workers = 6 desired; per-session cap (6) would allow all, but the
    // GLOBAL cap (4) holds the line across sessions.
    let running = 0;
    const releases: Array<() => void> = [];
    const attempts = ['s1', 's1', 's2', 's2', 's3', 's3'].map((s) =>
      acquireWorkerSlot(s).then((r) => { running += 1; releases.push(r); return r; }));
    await new Promise((r) => setTimeout(r, 15)); // let the acquires settle
    assert.equal(_activeGlobalWorkerSlots(), 4, 'exactly 4 hold a global slot');
    assert.equal(running, 4, 'only 4 run; the other 2 wait on the global ceiling despite free per-session slots');
    releases[0](); releases[1](); // free 2 → the 2 waiters proceed
    await Promise.all(attempts);
    assert.equal(running, 6, 'all 6 eventually run as global slots free (throttle, never drop)');
    releases.forEach((r) => r());
    assert.equal(_activeGlobalWorkerSlots(), 0, 'global gate fully drains');
  });
});

test('GLOBAL ceiling default (12) never further limits a single session on the default per-session cap (6)', async () => {
  await withEnv({ CLEMMY_WORKER_MAX_CONCURRENCY: undefined, CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL: undefined }, async () => {
    _resetWorkerConcurrencyForTest();
    // One session, 6 workers = the per-session default; global default (12) ≥ 6 so nothing extra blocks.
    const releases = await Promise.all(Array.from({ length: 6 }, () => acquireWorkerSlot('solo')));
    assert.equal(releases.length, 6, 'all 6 acquire immediately — global default does not bite a single session');
    releases.forEach((r) => r());
  });
});
