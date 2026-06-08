/**
 * Run: npx tsx --test src/runtime/harness/objective-judge.test.ts
 *
 * Pure + fail-open behavior of the objective judge. The live model call is
 * NOT unit-tested (covered via the loop's injected judgeFn tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildObjectiveJudgePrompt, judgeObjectiveComplete, shouldRunObjectiveJudge, isPromiseShapedReply, clipForJudge, JUDGE_RESPONSE_MAX_CHARS } = await import('./objective-judge.js');

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

// ── Promise-shaped completion (the "I'll do that next" chatbot turn) ──────────

test('gate: FIRES for a promise-shaped reply even when it looks low-effort (the incident)', () => {
  // The exact shape that slipped through: non-action intent, 1 tool call, done.
  assert.equal(
    shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, totalToolCalls: 1, promiseShaped: true }),
    true,
  );
  // Without the promise signal, the same low-effort turn is NOT judged (unchanged).
  assert.equal(
    shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, totalToolCalls: 1, promiseShaped: false }),
    false,
  );
});

test('isPromiseShapedReply: future-tense promise with no artifact → true', () => {
  for (const p of [
    "Got it. I'll prep them as review-ready drafts, not send them yet.",
    'Going to put that report together for you.',
    "Let me go pull all the data and build the file.",
  ]) {
    assert.equal(isPromiseShapedReply(p), true, `promise: ${p}`);
  }
});

test('isPromiseShapedReply: a real artifact/result suppresses the promise signal → false', () => {
  for (const r of [
    "Done — created the sheet: https://example.com/s/123",
    "Here's the summary of all 44 records.",
    "I've drafted the report and saved it to /tmp/out.html",
    'Found 5 accounts matching your filter.',
    '', // empty
  ]) {
    assert.equal(isPromiseShapedReply(r), false, `not a bare promise: ${r}`);
  }
});

test('buildObjectiveJudgePrompt includes the objective and the assistant response', () => {
  const prompt = buildObjectiveJudgePrompt('build a report on X', 'Done — saved to /tmp/report.md');
  assert.match(prompt, /build a report on X/);
  assert.match(prompt, /\/tmp\/report\.md/);
});

test('clipForJudge passes a sub-cap body through untouched', () => {
  const r = clipForJudge('a short response');
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'a short response');
});

test('clipForJudge windows head+tail and self-describes the elision', () => {
  const head = 'HEAD_MARKER ' + 'a'.repeat(JUDGE_RESPONSE_MAX_CHARS);
  const tailEvidence = ' saved to https://example.com/sheet TAIL_MARKER';
  const full = head + 'z'.repeat(2000) + tailEvidence;
  const r = clipForJudge(full);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < full.length, 'output is shorter than the full input');
  assert.ok(r.text.length <= JUDGE_RESPONSE_MAX_CHARS + 200, 'output stays near the cap (plus the small marker)');
  assert.match(r.text, /HEAD_MARKER/, 'keeps the head');
  assert.match(r.text, /TAIL_MARKER/, 'keeps the tail where artifact evidence clusters');
  assert.match(r.text, /elided from the MIDDLE for length/, 'tells the judge the middle was cut for length');
});

test('buildObjectiveJudgePrompt directs the judge not to penalize a windowed reply', () => {
  const prompt = buildObjectiveJudgePrompt('build a big report', 'B'.repeat(JUDGE_RESPONSE_MAX_CHARS + 5000));
  assert.match(prompt, /do not mark the objective incomplete merely because/i);
});

test('judgeObjectiveComplete fails OPEN (done:true) when there is no response text to judge', async () => {
  const v = await judgeObjectiveComplete('build a report', '');
  assert.equal(v.done, true);
});

test('judgeObjectiveComplete fails OPEN when the objective is empty', async () => {
  const v = await judgeObjectiveComplete('', 'some response');
  assert.equal(v.done, true);
});

test('buildObjectiveJudgePrompt injects the skill-execution rubric when skills were loaded', async () => {
  const { buildObjectiveJudgePrompt } = await import('./objective-judge.js');
  const p = buildObjectiveJudgePrompt('clone and improve the site', 'I built and deployed it.', {
    skills: [{ name: 'redesign-skill', body: 'Step 1: generate hero imagery. Step 2: build. Step 3: deploy.' }],
    toolCallSummary: 'run_shell_command×13, skill_read×4',
  });
  assert.match(p, /verify they were EXECUTED/i);
  assert.match(p, /redesign-skill/);
  assert.match(p, /generate hero imagery/);
  assert.match(p, /run_shell_command×13/);
});

test('buildObjectiveJudgePrompt without skill context is unchanged (no rubric injected)', async () => {
  const { buildObjectiveJudgePrompt } = await import('./objective-judge.js');
  const p = buildObjectiveJudgePrompt('do a thing', 'done');
  assert.doesNotMatch(p, /SKILLS LOADED THIS SESSION/);
  assert.match(p, /respond with the structured verdict/);
});
