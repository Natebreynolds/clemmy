/**
 * T3.1 (conservative) — contract-evidence store.
 * Per-test temp dir via CLEMENTINE_HOME (BINDING) — set BEFORE any src import.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-contract-evidence-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const {
  observeStepOutputShape,
  deriveStableContract,
  isMeaningfulTightening,
  recordAndDeriveStableTightenings,
  MIN_RUNS_TO_TIGHTEN,
} = await import('./workflow-contract-evidence-store.js');

test('observeStepOutputShape: objects yield non-empty identifier keys; scalars/blocked yield null', () => {
  assert.deepEqual(observeStepOutputShape({ url: 'https://x.co', count: 3, blank: '', 'weird-key': 1 }), {
    type: 'object', keys: ['url', 'count'],
  });
  assert.deepEqual(observeStepOutputShape([1, 2]), { type: 'array', nonEmpty: true });
  assert.deepEqual(observeStepOutputShape([]), { type: 'array', nonEmpty: false });
  assert.equal(observeStepOutputShape('a report'), null);
  assert.equal(observeStepOutputShape(42), null);
  assert.equal(observeStepOutputShape({ blocked: true, reason: 'x' }), null);
  assert.equal(observeStepOutputShape(null), null);
});

test('deriveStableContract: NEVER tightens below the min-run threshold', () => {
  const obs = [{ type: 'object' as const, keys: ['name', 'email'] }, { type: 'object' as const, keys: ['name', 'email'] }];
  assert.ok(obs.length < MIN_RUNS_TO_TIGHTEN);
  assert.equal(deriveStableContract(obs), null);
});

test('deriveStableContract: required_keys = INTERSECTION across runs (the false-failure fix)', () => {
  // run1 had phone, run2/run3 did not — phone must NOT become required, or run2 would have failed.
  const derived = deriveStableContract([
    { type: 'object', keys: ['name', 'email', 'phone'] },
    { type: 'object', keys: ['name', 'email'] },
    { type: 'object', keys: ['name', 'email'] },
  ]);
  assert.deepEqual(derived, { type: 'object', required_keys: ['email', 'name'] });
});

test('deriveStableContract: array min_items:1 ONLY when every run was non-empty', () => {
  const always = deriveStableContract([
    { type: 'array', nonEmpty: true }, { type: 'array', nonEmpty: true }, { type: 'array', nonEmpty: true },
  ]);
  assert.deepEqual(always, { type: 'array', min_items: { '': 1 } });

  // a single empty run (e.g. "new leads today" = 0) means non-empty is NOT invariant → no min_items
  const sometimesEmpty = deriveStableContract([
    { type: 'array', nonEmpty: true }, { type: 'array', nonEmpty: false }, { type: 'array', nonEmpty: true },
  ]);
  assert.deepEqual(sometimesEmpty, { type: 'array' });
  assert.equal(isMeaningfulTightening(sometimesEmpty), false); // bare {type} isn't worth a rewrite
});

test('deriveStableContract: a type that flips object↔array is not stable → null', () => {
  const derived = deriveStableContract([
    { type: 'object', keys: ['a'] }, { type: 'array', nonEmpty: true }, { type: 'object', keys: ['a'] },
  ]);
  assert.equal(derived, null);
});

test('recordAndDeriveStableTightenings: only fires after MIN_RUNS invariant clean runs; skips declared/forEach', () => {
  const def = {
    name: 'daily', description: 'd', enabled: true, trigger: { manual: true },
    steps: [
      { id: 'gather', prompt: 'gather leads' },                              // eligible
      { id: 'declared', prompt: 'x', output: { type: 'object' as const } }, // author-declared → never touched
      { id: 'fan', prompt: 'y', forEach: 'gather' },                        // forEach wrapper → skipped
    ],
  };
  const cleanOutputs = { gather: [{ id: 1 }], declared: { a: 1 }, fan: [{ ok: true }] };

  // runs 1 and 2 accumulate evidence but do NOT tighten yet
  assert.deepEqual(recordAndDeriveStableTightenings('daily', def, cleanOutputs, '2026-07-01T00:00:00Z'), []);
  assert.deepEqual(recordAndDeriveStableTightenings('daily', def, cleanOutputs, '2026-07-02T00:00:00Z'), []);

  // run 3 → gather is now invariant-nonempty across 3 runs → tighten it (and only it)
  const third = recordAndDeriveStableTightenings('daily', def, cleanOutputs, '2026-07-03T00:00:00Z');
  assert.deepEqual(third.map((t) => t.stepId), ['gather']);
  assert.deepEqual(third[0].output, { type: 'array', min_items: { '': 1 } });
});

test('recordAndDeriveStableTightenings: an empty run inside the window prevents the array tightening', () => {
  const def = {
    name: 'leads', description: 'd', enabled: true, trigger: { manual: true },
    steps: [{ id: 'new', prompt: 'find new leads today' }],
  };
  recordAndDeriveStableTightenings('leads', def, { new: [{ id: 1 }] }, '2026-07-01T00:00:00Z');
  recordAndDeriveStableTightenings('leads', def, { new: [] }, '2026-07-02T00:00:00Z'); // a zero day
  const third = recordAndDeriveStableTightenings('leads', def, { new: [{ id: 2 }] }, '2026-07-03T00:00:00Z');
  // non-empty is NOT invariant (day 2 was empty) → no meaningful tightening → the zero day never false-fails
  assert.deepEqual(third, []);
});

