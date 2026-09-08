/**
 * Completion verification eligibility.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/completion-verification-gate.test.ts
 *
 * Fifteen Terra calls and four settled writes across C16/C17 produced ZERO
 * accepted completion verdicts. The gate was written to catch a completion
 * CLAIM with no evidence, so `meaningfulToolEvidence` caused a SKIP — making the
 * turns that actually wrote artifacts the only turns never verified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunObjectiveJudge } from './objective-judge.js';

const base = {
  optIn: true,
  actionIntent: true,
  meaningfulToolEvidence: true,
  continuationsUsed: 0,
  maxContinuations: 2,
  nextAction: 'completed',
  openApprovalCard: false,
  promiseShaped: false,
};

test('a settled source-bound effect makes the turn ELIGIBLE for verification', () => {
  // The exact C17 shape: an action objective, a real write, a concrete reply.
  assert.equal(shouldRunObjectiveJudge({ ...base, settledSourceEffects: 1 }), true);
});

test('REGRESSION: the same turn without the new signal is skipped', () => {
  // Proves the eligibility comes from settled effects, not from something else.
  assert.equal(shouldRunObjectiveJudge({ ...base, settledSourceEffects: 0 }), false);
  assert.equal(shouldRunObjectiveJudge(base), false);
});

test('a turn with NO settled effect keeps its original missing-evidence path', () => {
  assert.equal(
    shouldRunObjectiveJudge({ ...base, meaningfulToolEvidence: false, settledSourceEffects: 0 }),
    true,
    'a claim with no tool evidence must still be judged',
  );
});

test('a promise-shaped reply is still judged regardless of effects', () => {
  assert.equal(shouldRunObjectiveJudge({ ...base, promiseShaped: true, settledSourceEffects: 0 }), true);
});

test('NEGATIVE: an open approval card still suppresses judging', () => {
  assert.equal(
    shouldRunObjectiveJudge({ ...base, settledSourceEffects: 3, openApprovalCard: true }), false,
    'a pending approval must not be overridden by a completion verdict',
  );
});

test('NEGATIVE: conversation (no action intent) is not judged on settled effects', () => {
  assert.equal(shouldRunObjectiveJudge({ ...base, actionIntent: false, settledSourceEffects: 2 }), false);
});

test('NEGATIVE: an unfinished turn is not judged', () => {
  assert.equal(shouldRunObjectiveJudge({ ...base, settledSourceEffects: 2, nextAction: 'continue' }), false);
});

test('NEGATIVE: the continuation cap still bounds verification', () => {
  assert.equal(
    shouldRunObjectiveJudge({ ...base, settledSourceEffects: 2, continuationsUsed: 2 }), false,
    'verification must not become an unbounded judge loop',
  );
});

test('NEGATIVE: a caller that did not opt in is never judged', () => {
  assert.equal(shouldRunObjectiveJudge({ ...base, optIn: false, settledSourceEffects: 5 }), false);
});
