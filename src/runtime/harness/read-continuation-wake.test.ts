/** Pure fake-clock controls; no clock, timer, storage, provider or model I/O. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planReadContinuationWake, READ_CONTINUATION_TIMER_MAX_MS, type ReadContinuationWakeInput } from './read-continuation-wake.js';

test('zero delay is ready at its retained anchor, and readiness never changes that anchor', () => {
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 0, delayMs: 0, nowMs: 0 }), { status: 'ready', notBeforeAtMs: 0 });
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 100, delayMs: 0, nowMs: 150 }), { status: 'ready', notBeforeAtMs: 100 });
});

test('a partial wait and simulated restart preserve the original due time instead of restarting backoff', () => {
  const retained = Object.freeze({ anchorAtMs: 10_000, delayMs: 2_500 });
  let fakeNow = 10_500;
  assert.deepEqual(planReadContinuationWake({ ...retained, nowMs: fakeNow }), { status: 'waiting', notBeforeAtMs: 12_500, remainingMs: 2_000 });
  const reopened = JSON.parse(JSON.stringify(retained));
  fakeNow = 12_000;
  assert.deepEqual(planReadContinuationWake({ ...reopened, nowMs: fakeNow }), { status: 'waiting', notBeforeAtMs: 12_500, remainingMs: 500 });
  fakeNow = 12_500;
  assert.deepEqual(planReadContinuationWake({ ...reopened, nowMs: fakeNow }), { status: 'ready', notBeforeAtMs: 12_500 });
});

test('an elapsed delay after downtime is immediately ready without another full delay', () => {
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 1_000, delayMs: 5_000, nowMs: 90_000 }), { status: 'ready', notBeforeAtMs: 6_000 });
});

test('clock rollback before the retained anchor waits and never grants early readiness', () => {
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 10_000, delayMs: 500, nowMs: 9_000 }), { status: 'waiting', notBeforeAtMs: 10_500, remainingMs: 1_500 });
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 10_000, delayMs: 0, nowMs: 9_999 }), { status: 'waiting', notBeforeAtMs: 10_000, remainingMs: 1 });
});

test('invalid timestamps and delays fail closed before deadline or readiness decisions', () => {
  const valid = { anchorAtMs: 100, delayMs: 20, nowMs: 200, deadlineAtMs: 150 };
  for (const invalid of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null, undefined]) {
    for (const [field, reason] of [['anchorAtMs', 'anchor_invalid'], ['delayMs', 'delay_invalid'], ['nowMs', 'now_invalid']] as const) {
      assert.deepEqual(planReadContinuationWake({ ...valid, [field]: invalid } as ReadContinuationWakeInput), { status: 'invalid', reason });
    }
    if (invalid !== undefined) assert.deepEqual(planReadContinuationWake({ ...valid, deadlineAtMs: invalid } as ReadContinuationWakeInput), { status: 'invalid', reason: 'deadline_invalid' });
  }
});

test('the Node timer delay ceiling is inclusive; larger delay and unsafe timestamp addition are invalid', () => {
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 0, delayMs: READ_CONTINUATION_TIMER_MAX_MS, nowMs: 0 }), {
    status: 'waiting', notBeforeAtMs: READ_CONTINUATION_TIMER_MAX_MS, remainingMs: READ_CONTINUATION_TIMER_MAX_MS,
  });
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 0, delayMs: READ_CONTINUATION_TIMER_MAX_MS + 1, nowMs: 0 }), { status: 'invalid', reason: 'delay_invalid' });
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: Number.MAX_SAFE_INTEGER, delayMs: 1, nowMs: 0 }), { status: 'invalid', reason: 'due_overflow' });
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: Number.MAX_SAFE_INTEGER, delayMs: 0, nowMs: 0 }), {
    status: 'waiting', notBeforeAtMs: Number.MAX_SAFE_INTEGER, remainingMs: Number.MAX_SAFE_INTEGER,
  });
});

test('deadline equality expires and a due time at or beyond the deadline has no usable read window', () => {
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 100, delayMs: 10, nowMs: 120, deadlineAtMs: 120 }), { status: 'expired', deadlineAtMs: 120 });
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 100, delayMs: 20, nowMs: 100, deadlineAtMs: 120 }), { status: 'expired', deadlineAtMs: 120 });
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 100, delayMs: 21, nowMs: 100, deadlineAtMs: 120 }), { status: 'expired', deadlineAtMs: 120 });
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 100, delayMs: 19, nowMs: 118, deadlineAtMs: 120 }), { status: 'waiting', notBeforeAtMs: 119, remainingMs: 1 });
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 100, delayMs: 19, nowMs: 119, deadlineAtMs: 120 }), { status: 'ready', notBeforeAtMs: 119 });
  assert.deepEqual(planReadContinuationWake({ anchorAtMs: 0, delayMs: 0, nowMs: 0, deadlineAtMs: 0 }), { status: 'expired', deadlineAtMs: 0 });
});

test('planning leaves frozen input unchanged and returned plans cannot affect a later decision', () => {
  const input = Object.freeze({ anchorAtMs: 1_000, delayMs: 500, nowMs: 1_200, deadlineAtMs: 2_000 });
  const before = JSON.stringify(input);
  const first = planReadContinuationWake(input);
  assert.deepEqual(first, { status: 'waiting', notBeforeAtMs: 1_500, remainingMs: 300 });
  (first as unknown as { notBeforeAtMs: number }).notBeforeAtMs = 1;
  assert.deepEqual(planReadContinuationWake(input), { status: 'waiting', notBeforeAtMs: 1_500, remainingMs: 300 });
  assert.equal(JSON.stringify(input), before);
});
