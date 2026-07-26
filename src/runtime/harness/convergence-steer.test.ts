/**
 * Run: npx tsx --test src/runtime/harness/convergence-steer.test.ts
 *
 * The lane-agnostic convergence detector: after Clem asks a question and the
 * user answers, the next turn carries the answer forward without re-asking it
 * or treating every exploratory reply as permission to execute.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-converge-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { createSession, appendEvent, resetEventLog } = await import('./eventlog.js');
const { priorTurnEndedAwaitingClarification, sessionHasBackgroundOffer, convergenceSteerEnabled, CONVERGENCE_STEER } = await import('./convergence-steer.js');

after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test('no prior clarifying question → no convergence', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  assert.equal(priorTurnEndedAwaitingClarification(sess.id), false);
  assert.equal(priorTurnEndedAwaitingClarification(undefined), false);
  assert.equal(sessionHasBackgroundOffer(sess.id), false);
});

test('a bare awaiting_user_input (standard harness lane shape) → converge', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'awaiting_user_input', data: { question: 'win-back or diagnosis?' } });
  assert.equal(priorTurnEndedAwaitingClarification(sess.id), true);
});

test('conversation_completed{awaitingUser:true} (brain lane shape) → converge; a normal completion does NOT', () => {
  resetEventLog();
  const a = createSession({ kind: 'chat' });
  appendEvent({ sessionId: a.id, turn: 1, role: 'system', type: 'conversation_completed', data: { awaitingUser: true, summary: 'refresh daily or on click?' } });
  assert.equal(priorTurnEndedAwaitingClarification(a.id), true);
  const b = createSession({ kind: 'chat' });
  appendEvent({ sessionId: b.id, turn: 1, role: 'system', type: 'conversation_completed', data: { summary: 'built the workspace' } });
  assert.equal(priorTurnEndedAwaitingClarification(b.id), false);
});

test('execution AFTER the ask clears convergence (the answer was already acted on)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'awaiting_user_input', data: { question: 'which sheet?' } });
  appendEvent({ sessionId: sess.id, turn: 2, role: 'Clem', type: 'external_write', data: { toolName: 'gmail__send_email' } });
  assert.equal(priorTurnEndedAwaitingClarification(sess.id), false, 'a send after the ask means the loop already moved on');
});

test('background, approval, stall, and infrastructure pauses never masquerade as clarification', () => {
  for (const source of [
    'offer_background',
    'stall_recovery',
    'infra_error_recovery',
    'decision_awaiting_approval',
    'decision_awaiting_handoff_terminal',
  ]) {
    resetEventLog();
    const sess = createSession({ kind: 'chat' });
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'Clem',
      type: 'awaiting_user_input',
      data: { question: 'choose', source },
    });
    assert.equal(priorTurnEndedAwaitingClarification(sess.id), false, source);
  }
});

test('conversation_completed preserves the paired awaiting source classification', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: 'background, hold, or now?', source: 'offer_background' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { awaitingUser: true },
  });
  assert.equal(priorTurnEndedAwaitingClarification(sess.id), false);
  assert.equal(sessionHasBackgroundOffer(sess.id), true, 'routing choice suppresses another offer without becoming clarification convergence');
});

test('a newer approval card clears an older clarification outcome', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'Clem', type: 'awaiting_user_input', data: { question: 'which sheet?' } });
  appendEvent({ sessionId: sess.id, turn: 2, role: 'Clem', type: 'approval_requested', data: { approvalId: 'approval-1' } });
  assert.equal(priorTurnEndedAwaitingClarification(sess.id), false);
});

test('kill-switch CLEMMY_BRAIN_CONVERGE=off disables the steer', () => {
  const prev = process.env.CLEMMY_BRAIN_CONVERGE;
  process.env.CLEMMY_BRAIN_CONVERGE = 'off';
  assert.equal(convergenceSteerEnabled(), false);
  delete process.env.CLEMMY_BRAIN_CONVERGE;
  assert.equal(convergenceSteerEnabled(), true);
  if (prev !== undefined) process.env.CLEMMY_BRAIN_CONVERGE = prev;
});

test('the steer preserves answers without forcing exploratory conversation into execution', () => {
  assert.match(CONVERGENCE_STEER, /never re-ask the resolved point/i);
  assert.match(CONVERGENCE_STEER, /Preserve exact identifiers, labels, paths, quantities/i);
  assert.match(CONVERGENCE_STEER, /do not normalize a literal value/i);
  assert.match(CONVERGENCE_STEER, /If the user has now committed or the request is execution-ready, act autonomously/i);
  assert.match(CONVERGENCE_STEER, /still comparing, brainstorming, shaping, or deciding, continue that conversation naturally/i);
  assert.match(CONVERGENCE_STEER, /not automatic permission for external writes or durable execution/i);
  assert.doesNotMatch(CONVERGENCE_STEER, /you now have enough|EXECUTE the work this turn/i);
  assert.match(CONVERGENCE_STEER, /background/i);
  assert.match(CONVERGENCE_STEER, /changed topics/i);
});
