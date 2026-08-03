/**
 * Run: npx tsx --test src/runtime/harness/loop-elevation.test.ts
 *
 * Pure predicate behind the surgical long-run elevation (#1): a forward-
 * progressing run about to hit the STEP cap auto-elevates instead of pausing
 * for a manual `continue`. Long/unlimited presets keep their own authored
 * ceilings; a legacy auto-continue preference cannot widen an activation.
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
const { resolveConversationStepCeiling, shouldElevateOnStepProgress } = await import('./loop.js');

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const base = {
  alreadyElevated: false,
  preset: 'standard',
  explicitMaxSteps: false,
  stepIndex: 40,
  maxSteps: 40,
};

test('elevates a progressing standard run at the step cap', () => {
  assert.equal(shouldElevateOnStepProgress(base), true);
});

test('bounded standard → long promotion remains available', () => {
  assert.equal(shouldElevateOnStepProgress(base), true);
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

test('one-activation ceiling honors each preset and an explicit caller override', () => {
  assert.equal(resolveConversationStepCeiling(undefined, {
    preset: 'standard', maxConversationSteps: 40, autoContinueOnLimit: false,
  }), 40);
  assert.equal(resolveConversationStepCeiling(undefined, {
    preset: 'long', maxConversationSteps: 160, autoContinueOnLimit: true,
  }), 160, 'long never receives a hidden million-step lift');
  assert.equal(resolveConversationStepCeiling(undefined, {
    preset: 'unlimited', maxConversationSteps: 1_000_000, autoContinueOnLimit: true,
  }), 1_000_000, 'explicit supervised-unlimited remains available');
  assert.equal(resolveConversationStepCeiling(7, {
    preset: 'unlimited', maxConversationSteps: 1_000_000, autoContinueOnLimit: true,
  }), 7, 'a caller-pinned ceiling remains authoritative');
});
