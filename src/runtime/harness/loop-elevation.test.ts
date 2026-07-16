/**
 * Run: npx tsx --test src/runtime/harness/loop-elevation.test.ts
 *
 * Pure predicate behind the surgical long-run elevation (#1): a forward-
 * progressing run about to hit the STEP cap auto-elevates instead of pausing
 * for a manual `continue`. Crucially a NO-OP on a long/unlimited (autoContinue)
 * instance — that is the regression guard for Nathan's config.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-loop-elev-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
writeFileSync(path.join(TMP, 'state', 'machine-id'), 'machine-A\n');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { shouldElevateOnStepProgress } = await import('./loop.js');

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const base = {
  alreadyElevated: false,
  preset: 'standard',
  autoContinueOnLimit: false,
  explicitMaxSteps: false,
  stepIndex: 40,
  maxSteps: 40,
};

test('elevates a progressing standard run at the step cap', () => {
  assert.equal(shouldElevateOnStepProgress(base), true);
});

test('NO-OP when autoContinue already on (long/unlimited — Nathan’s config)', () => {
  // The regression guard: his instance never elevates here because maxSteps is
  // already 1,000,000 and the cap is never approached; even if it were, this
  // returns false.
  assert.equal(shouldElevateOnStepProgress({ ...base, autoContinueOnLimit: true }), false);
});

test('NO-OP on a non-standard preset', () => {
  assert.equal(shouldElevateOnStepProgress({ ...base, preset: 'long' }), false);
  assert.equal(shouldElevateOnStepProgress({ ...base, preset: 'unlimited' }), false);
});

test('NO-OP when already elevated (one-way ratchet)', () => {
  assert.equal(shouldElevateOnStepProgress({ ...base, alreadyElevated: true }), false);
});

test('NO-OP when the caller pinned an explicit maxSteps', () => {
  assert.equal(shouldElevateOnStepProgress({ ...base, explicitMaxSteps: true }), false);
});

test('does NOT fire before the step cap is reached', () => {
  assert.equal(shouldElevateOnStepProgress({ ...base, stepIndex: 20, maxSteps: 40 }), false);
});
