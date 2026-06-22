/**
 * Run: npx tsx --test src/runtime/harness/boundary-judge.test.ts
 *
 * Cross-family BOUNDARY judge (Lane A Phase 1 — eval-as-harness).
 *
 * The per-turn completion / grounding / goal-fidelity checkers must not be
 * graded by the brain's OWN model family (the 2026 "coherence trap" — a Codex
 * brain checked by a Codex judge, or GLM by GLM under all_in, produces
 * correlated errors that inflate confidence without adding information). This
 * pins the PURE family decision (no provider/token dependency): given the brain
 * family + which families are logged in, the judge resolves to a CHEAP model
 * from a DIFFERENT family, or null (→ caller fails open same-family, tagged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseBoundaryJudgeFamily } from './debate-model.js';

test('codex brain + both families → cheap CLAUDE judge (cross-family, the common-default fix)', () => {
  const t = chooseBoundaryJudgeFamily('codex', true, true);
  assert.equal(t?.provider, 'claude');
  assert.equal(t?.modelId, 'claude-haiku-4-5');
});

test('codex brain + only codex logged in → null (no different family → fail open, tagged self-judge)', () => {
  assert.equal(chooseBoundaryJudgeFamily('codex', false, true), null);
});

test('codex brain + only claude logged in → claude judge', () => {
  assert.equal(chooseBoundaryJudgeFamily('codex', true, false)?.provider, 'claude');
});

test('claude brain + both families → cheap CODEX (gpt-fast) judge (already cross-family today, now explicit)', () => {
  const t = chooseBoundaryJudgeFamily('claude', true, true);
  assert.equal(t?.provider, 'codex');
  assert.equal(t?.modelId, 'gpt-5.4-mini');
});

test('claude brain + only claude logged in → null (no different family → fail open)', () => {
  assert.equal(chooseBoundaryJudgeFamily('claude', true, false), null);
});

test('byo (GLM all_in) brain + both → prefers cheap CLAUDE (the all_in self-judge fix)', () => {
  assert.equal(chooseBoundaryJudgeFamily('byo', true, true)?.provider, 'claude');
});

test('byo brain + only codex → codex judge (any different family beats self-grading)', () => {
  const t = chooseBoundaryJudgeFamily('byo', false, true);
  assert.equal(t?.provider, 'codex');
  assert.equal(t?.modelId, 'gpt-5.4-mini');
});

test('byo brain + no flagship logged in → null (fail open same-family, tagged)', () => {
  assert.equal(chooseBoundaryJudgeFamily('byo', false, false), null);
});
