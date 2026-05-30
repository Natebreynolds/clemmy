import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientStepError, runWithStepRetry } from './workflow-runner.js';

// ── isTransientStepError ───────────────────────────────────────────

test('isTransientStepError: network/timeout/rate-limit signals are transient', () => {
  assert.ok(isTransientStepError(new Error('socket hang up')));
  assert.ok(isTransientStepError(new Error('request timed out after 30s')));
  assert.ok(isTransientStepError(new Error('Service Unavailable')));
  assert.ok(isTransientStepError(new Error('429 Too Many Requests')));
  assert.ok(isTransientStepError(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })));
  assert.ok(isTransientStepError(Object.assign(new Error('boom'), { status: 502 })));
});

test('isTransientStepError: bare HTTP numbers in a message are NOT transient (only structured status is)', () => {
  // "expected 500 rows" must not be retried just because it contains 500.
  assert.ok(!isTransientStepError(new Error('expected 500 rows but got 0')));
  assert.ok(!isTransientStepError(new Error('account 502 not found')));
  assert.ok(!isTransientStepError(new Error('network_id field is required')));
  // ...but a structured status field IS honored.
  assert.ok(isTransientStepError(Object.assign(new Error('upstream failed'), { status: 503 })));
});

test('isTransientStepError: deterministic + approval failures are NOT transient (override wins)', () => {
  assert.ok(!isTransientStepError(new Error('missing required input "url"')));
  assert.ok(!isTransientStepError(new Error('output failed its contract: missing key id')));
  assert.ok(!isTransientStepError(new Error('was not approved (rejected)')));
  // The approval-timeout message contains "timed out" but must NOT retry.
  assert.ok(!isTransientStepError(new Error('workflow step "send" timed out waiting for approval after 86400s')));
  assert.ok(!isTransientStepError(new Error('workflow step "send" exceeded approval wait budget (86400000ms)')));
  assert.ok(!isTransientStepError(new Error('TypeError: x is not a function')));
  assert.ok(!isTransientStepError(undefined));
});

// ── runWithStepRetry ───────────────────────────────────────────────

const noSleep = async () => {};

test('runWithStepRetry: returns immediately on first success (no retries)', async () => {
  let calls = 0;
  const out = await runWithStepRetry(async () => { calls += 1; return 'ok'; }, {
    budget: 3, backoffBaseMs: 1, isRetryable: () => true, sleep: noSleep,
  });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('runWithStepRetry: retries a transient failure then succeeds', async () => {
  let calls = 0;
  const retries: number[] = [];
  const out = await runWithStepRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('socket hang up');
    return 'recovered';
  }, {
    budget: 3,
    backoffBaseMs: 1,
    isRetryable: () => true,
    onRetry: ({ attempt }) => retries.push(attempt),
    sleep: noSleep,
  });
  assert.equal(out, 'recovered');
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]); // two retries before the 3rd attempt won
});

test('runWithStepRetry: exhausts budget then throws the last error', async () => {
  let calls = 0;
  await assert.rejects(
    runWithStepRetry(async () => { calls += 1; throw new Error('still timing out'); }, {
      budget: 2, backoffBaseMs: 1, isRetryable: () => true, sleep: noSleep,
    }),
    /still timing out/,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test('runWithStepRetry: a non-retryable error throws immediately (no retries)', async () => {
  let calls = 0;
  await assert.rejects(
    runWithStepRetry(async () => { calls += 1; throw new Error('bad input'); }, {
      budget: 5, backoffBaseMs: 1, isRetryable: () => false, sleep: noSleep,
    }),
    /bad input/,
  );
  assert.equal(calls, 1);
});

test('runWithStepRetry: budget 0 → never retries', async () => {
  let calls = 0;
  await assert.rejects(
    runWithStepRetry(async () => { calls += 1; throw new Error('socket hang up'); }, {
      budget: 0, backoffBaseMs: 1, isRetryable: () => true, sleep: noSleep,
    }),
  );
  assert.equal(calls, 1);
});

test('runWithStepRetry: exponential backoff delays + afterBackoff hook fire', async () => {
  const delays: number[] = [];
  let afterCount = 0;
  await assert.rejects(runWithStepRetry(async () => { throw new Error('timeout'); }, {
    budget: 3,
    backoffBaseMs: 100,
    isRetryable: () => true,
    sleep: async (ms) => { delays.push(ms); },
    afterBackoff: () => { afterCount += 1; },
  }));
  assert.deepEqual(delays, [100, 200, 400]); // 100 * 2^(n-1)
  assert.equal(afterCount, 3);
});

test('runWithStepRetry: afterBackoff can abort by throwing (cancellation)', async () => {
  let calls = 0;
  await assert.rejects(
    runWithStepRetry(async () => { calls += 1; throw new Error('timeout'); }, {
      budget: 5,
      backoffBaseMs: 1,
      isRetryable: () => true,
      sleep: noSleep,
      afterBackoff: () => { throw new Error('run cancelled'); },
    }),
    /run cancelled/,
  );
  assert.equal(calls, 1); // cancelled during the first backoff, before re-run
});
