/**
 * Run: npx tsx --test src/runtime/harness/watcher-judge.test.ts
 *
 * WATCHER judge (trajectory co-pilot). Pins the pure contract: the cadence
 * gate, the knobs, and the evidence window. The verdict itself is Jev's
 * (watcher-judge-jev-first.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  latestWatcherAssistantNote,
  lastCoveredWatcherReview,
  MAX_WATCHER_CHECKS,
  MAX_WATCHER_INJECTIONS,
  rearmedWatcherCadence,
  shouldStartWatcherCheck,
  watcherCheckIntervalTools,
  watcherJudgeEnabled,
  workflowWatcherJudgeEnabled,
} from './watcher-judge.js';

const baseGate = {
  enabled: true,
  totalToolCalls: 12,
  lastCheckedAtToolCalls: 0,
  checkIntervalTools: 12,
  injectionsUsed: 0,
  maxInjections: MAX_WATCHER_INJECTIONS,
  checksUsed: 0,
  maxChecks: MAX_WATCHER_CHECKS,
  checkInFlight: false,
};

test('gate: fires when the tool-call interval has elapsed on an enabled run', () => {
  assert.equal(shouldStartWatcherCheck(baseGate), true);
});

test('gate: silent below the interval, when disabled, mid-flight, or out of injections', () => {
  assert.equal(shouldStartWatcherCheck({ ...baseGate, totalToolCalls: 11 }), false, 'below interval');
  assert.equal(shouldStartWatcherCheck({ ...baseGate, enabled: false }), false, 'disabled / not opted in');
  assert.equal(shouldStartWatcherCheck({ ...baseGate, checkInFlight: true }), false, 'never stacks checks');
  assert.equal(shouldStartWatcherCheck({ ...baseGate, injectionsUsed: MAX_WATCHER_INJECTIONS }), false, 'nudges, never nags');
  assert.equal(shouldStartWatcherCheck({ ...baseGate, checksUsed: MAX_WATCHER_CHECKS }), false, 'bounded checks');
});

test('gate: interval measures from the LAST check, not zero', () => {
  assert.equal(shouldStartWatcherCheck({ ...baseGate, totalToolCalls: 23, lastCheckedAtToolCalls: 12 }), false);
  assert.equal(shouldStartWatcherCheck({ ...baseGate, totalToolCalls: 24, lastCheckedAtToolCalls: 12 }), true);
});

test('knobs: chat defaults on, workflow mount defaults off, and the global kill-switch wins', () => {
  const prevOn = process.env.CLEMMY_WATCHER_JUDGE;
  const prevWorkflowOn = process.env.CLEMMY_WORKFLOW_WATCHER_JUDGE;
  const prevInt = process.env.CLEMMY_WATCHER_INTERVAL_TOOLS;
  try {
    delete process.env.CLEMMY_WATCHER_JUDGE;
    delete process.env.CLEMMY_WORKFLOW_WATCHER_JUDGE;
    delete process.env.CLEMMY_WATCHER_INTERVAL_TOOLS;
    assert.equal(watcherJudgeEnabled(), true);
    assert.equal(workflowWatcherJudgeEnabled(), false);
    process.env.CLEMMY_WORKFLOW_WATCHER_JUDGE = 'on';
    assert.equal(workflowWatcherJudgeEnabled(), true);
    assert.equal(watcherCheckIntervalTools(), 12);
    process.env.CLEMMY_WATCHER_JUDGE = 'off';
    assert.equal(watcherJudgeEnabled(), false);
    assert.equal(workflowWatcherJudgeEnabled(), false);
    process.env.CLEMMY_WATCHER_INTERVAL_TOOLS = '1';
    assert.equal(watcherCheckIntervalTools(), 12, 'sub-2 interval rejected');
    process.env.CLEMMY_WATCHER_INTERVAL_TOOLS = '4';
    assert.equal(watcherCheckIntervalTools(), 4);
  } finally {
    if (prevOn === undefined) delete process.env.CLEMMY_WATCHER_JUDGE; else process.env.CLEMMY_WATCHER_JUDGE = prevOn;
    if (prevWorkflowOn === undefined) delete process.env.CLEMMY_WORKFLOW_WATCHER_JUDGE; else process.env.CLEMMY_WORKFLOW_WATCHER_JUDGE = prevWorkflowOn;
    if (prevInt === undefined) delete process.env.CLEMMY_WATCHER_INTERVAL_TOOLS; else process.env.CLEMMY_WATCHER_INTERVAL_TOOLS = prevInt;
  }
});

test('gate: a fan-out re-arm waives only the interval — every other cap still holds', () => {
  // One parent tool call holds the loop for the whole batch, so the interval
  // can never elapse while children run; the re-arm makes a check due now.
  const midBatch = { ...baseGate, totalToolCalls: 1, lastCheckedAtToolCalls: 0 };
  assert.equal(shouldStartWatcherCheck(midBatch), false, 'the plain cadence is silent mid-batch');
  assert.equal(shouldStartWatcherCheck(rearmedWatcherCadence(midBatch)), true, 're-armed: due now');
  assert.equal(shouldStartWatcherCheck(rearmedWatcherCadence({ ...midBatch, checkInFlight: true })), false, 'never stacks on an in-flight check');
  assert.equal(shouldStartWatcherCheck(rearmedWatcherCadence({ ...midBatch, checksUsed: MAX_WATCHER_CHECKS })), false, 'same check budget');
  assert.equal(shouldStartWatcherCheck(rearmedWatcherCadence({ ...midBatch, injectionsUsed: MAX_WATCHER_INJECTIONS })), false, 'same injection budget');
  assert.equal(shouldStartWatcherCheck(rearmedWatcherCadence({ ...midBatch, enabled: false })), false, 'kill-switch still wins');
  // Re-arming is pure: the caller's gate input is untouched.
  assert.equal(midBatch.lastCheckedAtToolCalls, 0);
});

test('the watcher reads only this turn\'s public progress note, never prior turns or reasoning', () => {
  const note = 'Public progress ' + 'context '.repeat(300) + 'TAIL: checking the comparison.';
  const history = [
    { type: 'message', role: 'assistant', content: 'Old request note.' },
    { type: 'message', role: 'user', content: 'Current objective.' },
    { type: 'reasoning', content: 'Private reasoning is not a progress note.' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: note }] },
    { type: 'function_call_result', output: 'Tool text is not the agent note.' },
  ];
  assert.equal(latestWatcherAssistantNote(history, 2), note);
  assert.equal(latestWatcherAssistantNote(history.slice(0, 3), 2), '');
});


test('an unavailable or stale window cannot hide pending evidence from the next review', () => {
  const completed = (cursor: number, extra = {}) => ({ data: { kind: 'trajectory_review', phase: 'completed',
    sourceUserSeq: 7, objectiveDigest: 'current-objective', verdict: 'on_track',
    readEvidenceCursor: cursor, ...extra } });
  const rows = [completed(10), completed(20, { verdict: 'unavailable' }),
    completed(30, { stale: true }), completed(40, { sourceUserSeq: 8 }),
    completed(50, { objectiveDigest: 'abandoned-objective' }), completed(60, { evidenceAvailable: false })];
  assert.equal(lastCoveredWatcherReview(rows as never, 7, 'current-objective')?.data.readEvidenceCursor, 10);
  assert.equal(lastCoveredWatcherReview(rows.slice(1) as never, 7, 'current-objective'), undefined);
});
