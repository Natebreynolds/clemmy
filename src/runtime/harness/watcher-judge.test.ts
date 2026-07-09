/**
 * Run: npx tsx --test src/runtime/harness/watcher-judge.test.ts
 *
 * WATCHER judge (trajectory co-pilot). Pins the pure contract: the cadence
 * gate, the one-line ON-TRACK/DRIFT|STEER verdict parse, and the goal-only
 * rubric/prompt (never demands artifacts the goal doesn't name).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWatcherPrompt,
  MAX_WATCHER_CHECKS,
  MAX_WATCHER_INJECTIONS,
  parseWatcherVerdict,
  shouldStartWatcherCheck,
  WATCHER_JUDGE_SYSTEM_PROMPT,
  watcherCheckIntervalTools,
  watcherJudgeEnabled,
} from './watcher-judge.js';

const baseGate = {
  enabled: true,
  totalToolCalls: 8,
  lastCheckedAtToolCalls: 0,
  checkIntervalTools: 8,
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
  assert.equal(shouldStartWatcherCheck({ ...baseGate, totalToolCalls: 7 }), false, 'below interval');
  assert.equal(shouldStartWatcherCheck({ ...baseGate, enabled: false }), false, 'disabled / not opted in');
  assert.equal(shouldStartWatcherCheck({ ...baseGate, checkInFlight: true }), false, 'never stacks checks');
  assert.equal(shouldStartWatcherCheck({ ...baseGate, injectionsUsed: MAX_WATCHER_INJECTIONS }), false, 'nudges, never nags');
  assert.equal(shouldStartWatcherCheck({ ...baseGate, checksUsed: MAX_WATCHER_CHECKS }), false, 'bounded checks');
});

test('gate: interval measures from the LAST check, not zero', () => {
  assert.equal(shouldStartWatcherCheck({ ...baseGate, totalToolCalls: 15, lastCheckedAtToolCalls: 8 }), false);
  assert.equal(shouldStartWatcherCheck({ ...baseGate, totalToolCalls: 16, lastCheckedAtToolCalls: 8 }), true);
});

test('parse: ON-TRACK is silent (no miss, no steer)', () => {
  const v = parseWatcherVerdict('ON-TRACK: steady progress');
  assert.deepEqual(v, { onTrack: true, miss: '', steer: '' });
  assert.deepEqual(parseWatcherVerdict('ONTRACK: fine'), { onTrack: true, miss: '', steer: '' });
});

test('parse: DRIFT carries the miss and the steer', () => {
  const v = parseWatcherVerdict('DRIFT: criterion 3 (per-firm research) untouched after 12 calls | STEER: research each firm before drafting its email.');
  assert.equal(v?.onTrack, false);
  assert.match(v?.miss ?? '', /per-firm research/);
  assert.match(v?.steer ?? '', /research each firm/);
});

test('parse: DRIFT without an explicit STEER falls back to the miss as the instruction', () => {
  const v = parseWatcherVerdict('DRIFT: the sheet was created in the wrong workspace');
  assert.equal(v?.onTrack, false);
  assert.equal(v?.steer, v?.miss);
});

test('parse: garbage, prose, and a bare DRIFT are null — the watcher says nothing it cannot back', () => {
  assert.equal(parseWatcherVerdict('here are my thoughts on the trajectory...'), null);
  assert.equal(parseWatcherVerdict('DRIFT:'), null);
  assert.equal(parseWatcherVerdict(''), null);
  assert.equal(parseWatcherVerdict(undefined), null);
});

test('rubric: goal-only + mid-run tolerance + silence-by-default are pinned', () => {
  assert.match(WATCHER_JUDGE_SYSTEM_PROMPT, /Judge against the GOAL ONLY/);
  assert.match(WATCHER_JUDGE_SYSTEM_PROMPT, /Never demand artifacts, steps, tools, or formats the goal does not name/);
  assert.match(WATCHER_JUDGE_SYSTEM_PROMPT, /incomplete work is EXPECTED and is NOT drift/);
  assert.match(WATCHER_JUDGE_SYSTEM_PROMPT, /ON-TRACK/);
  assert.doesNotMatch(WATCHER_JUDGE_SYSTEM_PROMPT, /URL|file path/, 'no artifact-shape prescriptions (the clean-rubric contract)');
});

test('prompt: renders goal, declared criteria, tool evidence, and the latest note', () => {
  const p = buildWatcherPrompt({
    objective: 'send tailored outreach to the 5 warm leads',
    successCriteria: ['each email references the firm\'s recent case', 'all 5 sends confirmed'],
    toolCallSummary: 'salesforce_query ×1, web_search ×3, outlook_draft ×2',
    latestAssistantNote: 'Drafting the remaining three now.',
    toolCallCount: 9,
  });
  assert.match(p, /Goal: send tailored outreach/);
  assert.match(p, /1\. each email references/);
  assert.match(p, /Tool calls so far \(9\)/);
  assert.match(p, /Drafting the remaining three/);
});

test('knobs: default on, interval defaults to 8 and rejects sub-2 overrides', () => {
  const prevOn = process.env.CLEMMY_WATCHER_JUDGE;
  const prevInt = process.env.CLEMMY_WATCHER_INTERVAL_TOOLS;
  try {
    delete process.env.CLEMMY_WATCHER_JUDGE;
    delete process.env.CLEMMY_WATCHER_INTERVAL_TOOLS;
    assert.equal(watcherJudgeEnabled(), true);
    assert.equal(watcherCheckIntervalTools(), 8);
    process.env.CLEMMY_WATCHER_JUDGE = 'off';
    assert.equal(watcherJudgeEnabled(), false);
    process.env.CLEMMY_WATCHER_INTERVAL_TOOLS = '1';
    assert.equal(watcherCheckIntervalTools(), 8, 'sub-2 interval rejected');
    process.env.CLEMMY_WATCHER_INTERVAL_TOOLS = '4';
    assert.equal(watcherCheckIntervalTools(), 4);
  } finally {
    if (prevOn === undefined) delete process.env.CLEMMY_WATCHER_JUDGE; else process.env.CLEMMY_WATCHER_JUDGE = prevOn;
    if (prevInt === undefined) delete process.env.CLEMMY_WATCHER_INTERVAL_TOOLS; else process.env.CLEMMY_WATCHER_INTERVAL_TOOLS = prevInt;
  }
});
