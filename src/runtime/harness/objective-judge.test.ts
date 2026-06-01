/**
 * Run: npx tsx --test src/runtime/harness/objective-judge.test.ts
 *
 * Pure + fail-open behavior of the objective judge. The live model call is
 * NOT unit-tested (covered via the loop's injected judgeFn tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildObjectiveJudgePrompt, judgeObjectiveComplete, shouldRunObjectiveJudge } = await import('./objective-judge.js');

const baseGate = {
  optIn: true,
  actionIntent: false,
  totalToolCalls: 0,
  workThreshold: 3,
  continuationsUsed: 0,
  maxContinuations: 3,
  nextAction: 'completed',
};

test('gate: fires for an explicit ACTION intent even with few tool calls', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: true, totalToolCalls: 0 }), true);
});

test('gate: fires for a LOOKUP-classified turn that did real work (≥ threshold tool calls)', () => {
  // "find me the accounts and drop them in a sheet" classifies as lookup but is
  // multi-step action — many tool calls. This is the bug the run exposed.
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, totalToolCalls: 7 }), true);
});

test('gate: does NOT fire for a trivial lookup (few tool calls, non-action)', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, totalToolCalls: 2 }), false);
});

test('gate: does NOT fire when the caller did not opt in', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, optIn: false, actionIntent: true, totalToolCalls: 9 }), false);
});

test('gate: does NOT fire once the continuation budget is exhausted', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: true, continuationsUsed: 3 }), false);
});

test('gate: does NOT fire when nextAction is not completed (e.g. awaiting approval)', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: true, nextAction: 'awaiting_approval' }), false);
});

test('buildObjectiveJudgePrompt includes the objective and the assistant response', () => {
  const prompt = buildObjectiveJudgePrompt('build a report on X', 'Done — saved to /tmp/report.md');
  assert.match(prompt, /build a report on X/);
  assert.match(prompt, /\/tmp\/report\.md/);
});

test('judgeObjectiveComplete fails OPEN (done:true) when there is no response text to judge', async () => {
  const v = await judgeObjectiveComplete('build a report', '');
  assert.equal(v.done, true);
});

test('judgeObjectiveComplete fails OPEN when the objective is empty', async () => {
  const v = await judgeObjectiveComplete('', 'some response');
  assert.equal(v.done, true);
});
