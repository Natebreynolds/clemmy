/**
 * Run: npx tsx --test src/execution/work-disposition-integrity.test.ts
 *
 * F5 substrate integrity. A manifest is the contract that says which work
 * exists and when it is finished. Each property below is a way that contract
 * could be satisfied by work that never happened, or by a plan that can never
 * finish — the failures that only show up after a user has waited an hour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  admitWorkDisposition,
  dispositionToDurableWork,
  expectedLedger,
  reducerReady,
  type WorkDisposition,
} from './work-disposition.js';

function disposition(over: Partial<WorkDisposition> = {}): WorkDisposition {
  return {
    kind: 'durable_manifest',
    objective: 'summarize last month of closed opportunities',
    successCriteria: ['every opportunity counted once'],
    missingRequiredInputs: [],
    effectCeiling: 'read',
    estimatedActivations: 2,
    manifest: {
      manifestId: 'mf-1',
      contractVersion: 'v1',
      canonicalItems: [{ id: 'opp-1' }, { id: 'opp-2' }, { id: 'opp-3' }],
      phases: [
        { id: 'read', dependsOn: [], runnerClass: 'worker' },
        { id: 'enrich', dependsOn: ['read'], runnerClass: 'worker' },
      ],
      reducer: { id: 'reduce', requiredPhases: ['read', 'enrich'], outputContract: 'report@1' },
    },
    ...over,
  } as WorkDisposition;
}

function admittedPlan(input: WorkDisposition = disposition()) {
  const admitted = admitWorkDisposition(input);
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const plan = dispositionToDurableWork((admitted as Extract<typeof admitted, { ok: true }>).disposition);
  assert.ok(plan);
  return plan!;
}

// ─── a plan that can never finish is never admitted ──────────────────────────

test('a duplicate phase id is refused — the ledger would be ambiguous', () => {
  const result = admitWorkDisposition(disposition({
    manifest: {
      manifestId: 'mf-1', contractVersion: 'v1',
      canonicalItems: [{ id: 'opp-1' }],
      phases: [
        { id: 'read', dependsOn: [], runnerClass: 'worker' },
        { id: 'read', dependsOn: [], runnerClass: 'worker' },
      ],
      reducer: { id: 'reduce', requiredPhases: ['read'], outputContract: 'report@1' },
    },
  }));
  assert.equal(result.ok, false);
  assert.ok((result as { errors: string[] }).errors.some((e) => /appears twice/.test(e)), JSON.stringify(result));
});

test('a phase dependency cycle is refused — nothing in it ever becomes runnable', () => {
  const result = admitWorkDisposition(disposition({
    manifest: {
      manifestId: 'mf-1', contractVersion: 'v1',
      canonicalItems: [{ id: 'opp-1' }],
      phases: [
        { id: 'read', dependsOn: ['enrich'], runnerClass: 'worker' },
        { id: 'enrich', dependsOn: ['read'], runnerClass: 'worker' },
      ],
      reducer: { id: 'reduce', requiredPhases: ['read', 'enrich'], outputContract: 'report@1' },
    },
  }));
  assert.equal(result.ok, false);
  assert.ok((result as { errors: string[] }).errors.some((e) => /cycle/.test(e)), JSON.stringify(result));
});

test('a longer cycle is still a cycle', () => {
  const result = admitWorkDisposition(disposition({
    manifest: {
      manifestId: 'mf-1', contractVersion: 'v1',
      canonicalItems: [{ id: 'opp-1' }],
      phases: [
        { id: 'a', dependsOn: ['c'], runnerClass: 'worker' },
        { id: 'b', dependsOn: ['a'], runnerClass: 'worker' },
        { id: 'c', dependsOn: ['b'], runnerClass: 'worker' },
      ],
      reducer: { id: 'reduce', requiredPhases: ['a'], outputContract: 'report@1' },
    },
  }));
  assert.equal(result.ok, false);
  assert.ok((result as { errors: string[] }).errors.some((e) => /cycle/.test(e)), JSON.stringify(result));
});

test('an acyclic diamond is admitted — the check rejects cycles, not shared dependencies', () => {
  const result = admitWorkDisposition(disposition({
    manifest: {
      manifestId: 'mf-1', contractVersion: 'v1',
      canonicalItems: [{ id: 'opp-1' }],
      phases: [
        { id: 'read', dependsOn: [], runnerClass: 'worker' },
        { id: 'left', dependsOn: ['read'], runnerClass: 'worker' },
        { id: 'right', dependsOn: ['read'], runnerClass: 'worker' },
        { id: 'merge', dependsOn: ['left', 'right'], runnerClass: 'worker' },
      ],
      reducer: { id: 'reduce', requiredPhases: ['merge'], outputContract: 'report@1' },
    },
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
});

// ─── explicit controls mean what they say ────────────────────────────────────

test('an explicit background request stays durable even with nothing to fan out', () => {
  const result = admitWorkDisposition(
    {
      kind: 'direct', objective: 'keep an eye on the renewal queue', successCriteria: [],
      missingRequiredInputs: [], effectCeiling: 'read', estimatedActivations: 1,
    } as WorkDisposition,
    { explicit: 'background' },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((result as Extract<typeof result, { ok: true }>).disposition.kind, 'durable_manifest',
    'an explicit background request was demoted to foreground because it had no manifest');
});

test('an explicit foreground request keeps work that fits in one window in the foreground', () => {
  const result = admitWorkDisposition(
    disposition({ estimatedActivations: 1 }),
    { explicit: 'foreground' },
  );
  assert.equal(result.ok, true);
  assert.equal((result as Extract<typeof result, { ok: true }>).disposition.kind, 'bounded_foreground');
});

// ─── readiness is the plan's ledger, not the caller's claim ──────────────────

test('the reducer is ready only when every canonical item settled in every required phase', () => {
  const plan = admittedPlan();
  const expected = expectedLedger(plan);
  assert.equal(expected.length, 6, 'three items across two required phases is six settlements');

  assert.equal(reducerReady({ plan, completed: [] }).ready, false);
  assert.equal(reducerReady({ plan, completed: expected.slice(0, 5) }).ready, false,
    'the reducer ran with one item x phase still outstanding');
  assert.deepEqual(reducerReady({ plan, completed: expected.slice(0, 5) }).missing, [expected[5]]);
  assert.equal(reducerReady({ plan, completed: expected }).ready, true);
});

test('settlements for work that is not in the plan never make the reducer ready', () => {
  const plan = admittedPlan();
  const forged = expectedLedger(plan).map((entry, index) => ({ ...entry, itemId: `forged-${index}` }));
  const verdict = reducerReady({ plan, completed: forged });
  assert.equal(verdict.ready, false,
    'six settlements for ids belonging to no item satisfied a six-settlement plan');
  assert.equal(verdict.unknown.length, forged.length, 'unrelated settlements were not reported');
  assert.equal(verdict.missing.length, 6);
});

test('one item settling the same phase twice does not stand in for another item', () => {
  const plan = admittedPlan();
  const expected = expectedLedger(plan);
  const repeated = [expected[0]!, expected[0]!, expected[0]!, expected[1]!, expected[2]!, expected[3]!];
  assert.equal(reducerReady({ plan, completed: repeated }).ready, false,
    'repeated settlements for one item counted as progress on others');
});

test('settling every item in only one of two required phases is not ready', () => {
  const plan = admittedPlan();
  const readOnly = expectedLedger(plan).filter((entry) => entry.phaseId === 'read');
  const verdict = reducerReady({ plan, completed: readOnly });
  assert.equal(verdict.ready, false, 'the reducer ran before a required phase had touched any item');
  assert.equal(verdict.missing.every((entry) => entry.phaseId === 'enrich'), true);
});
