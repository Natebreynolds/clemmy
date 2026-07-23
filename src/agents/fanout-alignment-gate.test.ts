import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolation FIRST: the gate reads the session event log.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-alignment-gate-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { createSession, appendEvent, resetEventLog } = await import('../runtime/harness/eventlog.js');
const {
  classifyFanoutAlignmentBounce,
  clearFanoutAlignmentBouncesForTest,
  maybeFanoutAlignmentBounce,
} = await import('./fanout-alignment-gate.js');

beforeEach(() => clearFanoutAlignmentBouncesForTest());

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('pure classification: first-contact mass fan-out bounces; conversation or small batch does not', () => {
  assert.equal(classifyFanoutAlignmentBounce({ itemCount: 30, userMessageCount: 1 }), true, 'the live case: 30 agents on turn one');
  assert.equal(classifyFanoutAlignmentBounce({ itemCount: 30, userMessageCount: 2 }), false, 'a conversation already happened = aligned');
  assert.equal(classifyFanoutAlignmentBounce({ itemCount: 3, userMessageCount: 1 }), false, 'ordinary small fan-out starts immediately');
  assert.equal(classifyFanoutAlignmentBounce({ itemCount: 9, userMessageCount: 1 }), false, 'below threshold');
});

test('session gate: one bounce, steer teaches the beat, retry goes through', () => {
  resetEventLog();
  createSession({ id: 'sess-align-1', kind: 'chat' });
  appendEvent({ sessionId: 'sess-align-1', turn: 0, role: 'user', type: 'user_input_received', data: { text: 'get 30 market leaders and email them' } });
  const first = maybeFanoutAlignmentBounce({ sessionId: 'sess-align-1', itemCount: 30 });
  assert.equal(first.bounce, true);
  assert.match(first.steer ?? '', /PAUSE before fan-out/);
  assert.match(first.steer ?? '', /plain-words message/);
  assert.match(first.steer ?? '', /background|hold|do it now/i);
  const retry = maybeFanoutAlignmentBounce({ sessionId: 'sess-align-1', itemCount: 30 });
  assert.equal(retry.bounce, false, 'the retry always proceeds');
});

test('an already-conversing session never bounces; synthetic events do not count as conversation', () => {
  resetEventLog();
  createSession({ id: 'sess-align-2', kind: 'chat' });
  appendEvent({ sessionId: 'sess-align-2', turn: 0, role: 'user', type: 'user_input_received', data: { text: 'find my untouched accounts' } });
  appendEvent({ sessionId: 'sess-align-2', turn: 1, role: 'user', type: 'user_input_received', data: { text: 'yes those 30, draft in my name' } });
  assert.equal(maybeFanoutAlignmentBounce({ sessionId: 'sess-align-2', itemCount: 30 }).bounce, false);

  createSession({ id: 'sess-align-3', kind: 'chat' });
  appendEvent({ sessionId: 'sess-align-3', turn: 0, role: 'user', type: 'user_input_received', data: { text: 'do the thing' } });
  appendEvent({ sessionId: 'sess-align-3', turn: 0, role: 'user', type: 'user_input_received', data: { text: '[replay note]', synthetic: true, source: 'approval-replay' } });
  assert.equal(maybeFanoutAlignmentBounce({ sessionId: 'sess-align-3', itemCount: 30 }).bounce, true, 'a synthetic note is not the user conversing');
});

test('background/workflow sessions and the kill-switch fail open', () => {
  resetEventLog();
  assert.equal(maybeFanoutAlignmentBounce({ sessionId: 'background:bg-x1', itemCount: 30 }).bounce, false, 'handoff sessions aligned in the origin chat');
  assert.equal(maybeFanoutAlignmentBounce({ sessionId: 'workflow:123:step', itemCount: 30 }).bounce, false);
  process.env.CLEMMY_FANOUT_ALIGNMENT_BEAT = 'off';
  try {
    createSession({ id: 'sess-align-4', kind: 'chat' });
    appendEvent({ sessionId: 'sess-align-4', turn: 0, role: 'user', type: 'user_input_received', data: { text: 'go' } });
    assert.equal(maybeFanoutAlignmentBounce({ sessionId: 'sess-align-4', itemCount: 30 }).bounce, false);
  } finally {
    delete process.env.CLEMMY_FANOUT_ALIGNMENT_BEAT;
  }
});

test('armed flow: policy classifier arms, ANY execution door bounces once, research never blocked', async () => {
  const { armFirstContactBeat, maybeBounceMassExecution } = await import('./fanout-alignment-gate.js');
  clearFanoutAlignmentBouncesForTest();
  // Arm: first-contact chat with mass work (the 2026-07-22 acceptance shape).
  armFirstContactBeat({ sessionId: 'sess-armed-1', sessionKind: 'chat', itemCount: 30, userMessageCount: 1 });
  const first = maybeBounceMassExecution('sess-armed-1');
  assert.equal(first.bounce, true, 'the first mass-execution call bounces (whichever door)');
  assert.match(first.steer ?? '', /PAUSE before fan-out/);
  assert.equal(maybeBounceMassExecution('sess-armed-1').bounce, false, 'one-shot: the retry proceeds');
  // Never armed → never bounced (read-only research and ordinary sessions).
  assert.equal(maybeBounceMassExecution('sess-armed-2').bounce, false);
  // Conversing session never arms.
  armFirstContactBeat({ sessionId: 'sess-armed-3', sessionKind: 'chat', itemCount: 30, userMessageCount: 3 });
  assert.equal(maybeBounceMassExecution('sess-armed-3').bounce, false);
  // Non-chat kinds never arm.
  armFirstContactBeat({ sessionId: 'sess-armed-4', sessionKind: 'workflow', itemCount: 30, userMessageCount: 1 });
  assert.equal(maybeBounceMassExecution('sess-armed-4').bounce, false);
});

// Heavy per-item tool advisory (live 2026-07-23): a 120-account run planned a
// browser session PER ITEM; only a mid-run human steer saved the budget.
// Advisory-only: it never blocks, fires once per session, and only for large
// fan-outs whose packet names browser/screenshot-class tools.
test('browser-per-item fan-outs draw ONE cost advisory; cheap or small fan-outs draw none', async () => {
  const { maybeHeavyPerItemToolAdvisory, _resetHeavyAdvisoryForTests } = await import('./fanout-alignment-gate.js');
  _resetHeavyAdvisoryForTests();
  const packet = JSON.stringify({ objective: 'capture each firm homepage', instructions: 'use browser_harness_run to screenshot each site', items: [] });
  const first = maybeHeavyPerItemToolAdvisory('sess-heavy', 120, packet);
  assert.ok(first && /cost advisory/.test(first), 'large browser fan-out advises');
  assert.match(first!, /batch scrape API|reused browser session/);
  assert.equal(maybeHeavyPerItemToolAdvisory('sess-heavy', 120, packet), null, 'one advisory per session');
  _resetHeavyAdvisoryForTests();
  assert.equal(maybeHeavyPerItemToolAdvisory('sess-heavy', 5, packet), null, 'small fan-outs are fine');
  assert.equal(maybeHeavyPerItemToolAdvisory('sess-heavy', 120, JSON.stringify({ instructions: 'composio scrape each site' })), null, 'cheap per-item tools draw nothing');
});
