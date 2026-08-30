import assert from 'node:assert/strict';
import test from 'node:test';

import { runOriginHandoffAdoption } from './origin-handoff-adoption.js';

function fixture(overrides?: {
  already?: boolean;
  adoptError?: unknown;
  finalizeError?: unknown;
  invalid?: boolean;
}) {
  const reports: Array<{ id: string; generation: number; outcome: string }> = [];
  let adopts = 0;
  let finalizes = 0;
  return {
    reports,
    get adopts() { return adopts; },
    get finalizes() { return finalizes; },
    deps: {
      alreadyAuthenticated: async () => Boolean(overrides?.already),
      adopt: async () => {
        adopts += 1;
        if (overrides?.adoptError) throw overrides.adoptError;
      },
      finalize: async () => {
        finalizes += 1;
        if (overrides?.finalizeError) throw overrides.finalizeError;
      },
      isExplicitlyInvalid: () => Boolean(overrides?.invalid),
      report: (id: string, generation: number, outcome: 'consumed' | 'invalid') => {
        reports.push({ id, generation, outcome });
      },
    },
  };
}

const value = { token: 'token', handoffId: 'handoff-7', generation: 7 };

test('matched adoption success emits one exact consumed acknowledgement', async () => {
  const f = fixture();
  assert.equal(await runOriginHandoffAdoption(value, f.deps), 'adopted');
  assert.equal(f.adopts, 1);
  assert.equal(f.finalizes, 1);
  assert.deepEqual(f.reports, [{ id: 'handoff-7', generation: 7, outcome: 'consumed' }]);
});

test('already authenticated adopted origin finalizes before acknowledging the lease', async () => {
  const f = fixture({ already: true });
  assert.equal(await runOriginHandoffAdoption(value, f.deps), 'already_authenticated');
  assert.equal(f.adopts, 0);
  assert.equal(f.finalizes, 1);
  assert.deepEqual(f.reports, [{ id: 'handoff-7', generation: 7, outcome: 'consumed' }]);
});

test('already authenticated unrelated origin retains a lease it cannot finalize', async () => {
  const f = fixture({ already: true, finalizeError: new Error('not adopted here') });
  assert.equal(await runOriginHandoffAdoption(value, f.deps), 'already_authenticated');
  assert.equal(f.adopts, 0);
  assert.equal(f.finalizes, 1);
  assert.deepEqual(f.reports, []);
});

test('explicit invalidity clears only the exact lease', async () => {
  const failure = new Error('invalid');
  const f = fixture({ adoptError: failure, invalid: true });
  await assert.rejects(runOriginHandoffAdoption(value, f.deps), failure);
  assert.deepEqual(f.reports, [{ id: 'handoff-7', generation: 7, outcome: 'invalid' }]);
});

test('transport, server, and acknowledgement failures retain the native lease', async () => {
  for (const failure of [new TypeError('offline'), new Error('503'), new Error('ACK mismatch')]) {
    const f = fixture({ adoptError: failure, invalid: false });
    await assert.rejects(runOriginHandoffAdoption(value, f.deps), failure);
    assert.deepEqual(f.reports, []);
  }
});

test('finalization failure after adoption retains the native lease', async () => {
  const failure = new Error('finalize 503');
  const f = fixture({ finalizeError: failure });
  await assert.rejects(runOriginHandoffAdoption(value, f.deps), failure);
  assert.equal(f.adopts, 1);
  assert.equal(f.finalizes, 1);
  assert.deepEqual(f.reports, []);
});
