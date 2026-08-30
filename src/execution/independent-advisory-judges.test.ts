import test from 'node:test';
import assert from 'node:assert/strict';

import {
  launchIndependentAdvisoryJudges,
  settleIndependentAdvisoryJudges,
} from './independent-advisory-judges.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('independent advisory judges all launch in one causal turn and do not hold primary work', async () => {
  const pending: Array<Promise<void>> = [];
  const events: string[] = [];
  const gates = [deferred(), deferred(), deferred()];

  const primaryBoundary = async (): Promise<void> => {
    await launchIndependentAdvisoryJudges(
      pending,
      gates.map((gate, index) => () => {
        events.push(`judge:${index}:launched`);
        return gate.promise.then(() => { events.push(`judge:${index}:settled`); });
      }),
    );
    events.push('primary:continued');
  };

  const primary = primaryBoundary();

  assert.deepEqual(
    events,
    ['judge:0:launched', 'judge:1:launched', 'judge:2:launched'],
    'every independent opinion launches before a promise continuation can settle',
  );
  assert.equal(pending.length, 3, 'all opinions are registered for the one run-end join');

  await primary;
  assert.equal(events.at(-1), 'primary:continued', 'primary work continues while all judges are unresolved');
  assert.equal(events.some((event) => event.endsWith(':settled')), false);

  const joined = settleIndependentAdvisoryJudges(pending);
  gates[2].resolve();
  gates[0].resolve();
  gates[1].resolve();
  await joined;
  assert.deepEqual(
    events.filter((event) => event.endsWith(':settled')).sort(),
    ['judge:0:settled', 'judge:1:settled', 'judge:2:settled'],
  );
});

test('advisory failures settle independently and never fail the primary lane', async () => {
  const pending: Array<Promise<void>> = [];
  let healthySettled = false;

  launchIndependentAdvisoryJudges(pending, [
    () => { throw new Error('synchronous advisory outage'); },
    async () => { throw new Error('asynchronous advisory outage'); },
    async () => { healthySettled = true; },
  ]);

  await assert.doesNotReject(settleIndependentAdvisoryJudges(pending));
  assert.equal(healthySettled, true, 'one failed opinion cannot suppress an independent sibling');
});

test('without a run registry the compatibility lane waits for all independent opinions', async () => {
  const gate = deferred();
  let waited = true;
  const compatibility = launchIndependentAdvisoryJudges(undefined, [
    () => gate.promise,
  ])?.then(() => { waited = false; });

  assert.equal(waited, true);
  gate.resolve();
  await compatibility;
  assert.equal(waited, false);
});
