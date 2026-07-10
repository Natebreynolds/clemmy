/**
 * Run: npx tsx --test src/runtime/harness/convergence-steer.test.ts
 *
 * The lane-agnostic convergence detector: after Clem asks a clarifying question
 * and the user answers, the next turn gets an EXECUTE-now steer — the enforceable
 * backstop to the "it kept asking me redundant questions" regression, on BOTH the
 * Codex/GPT loop lane and the Claude SDK brain lane.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-converge-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { createSession, appendEvent, resetEventLog } = await import('./eventlog.js');
const { priorTurnEndedAwaitingClarification, convergenceSteerEnabled, CONVERGENCE_STEER } = await import('./convergence-steer.js');

after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test('no prior clarifying question → no convergence', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  assert.equal(priorTurnEndedAwaitingClarification(sess.id), false);
  assert.equal(priorTurnEndedAwaitingClarification(undefined), false);
});

test('a bare awaiting_user_input (Codex/GPT lane shape) → converge', () => {
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

test('kill-switch CLEMMY_BRAIN_CONVERGE=off disables the steer', () => {
  const prev = process.env.CLEMMY_BRAIN_CONVERGE;
  process.env.CLEMMY_BRAIN_CONVERGE = 'off';
  assert.equal(convergenceSteerEnabled(), false);
  delete process.env.CLEMMY_BRAIN_CONVERGE;
  assert.equal(convergenceSteerEnabled(), true);
  if (prev !== undefined) process.env.CLEMMY_BRAIN_CONVERGE = prev;
});

test('the steer text tells the model to execute and not re-ask / not stack a background offer', () => {
  assert.match(CONVERGENCE_STEER, /EXECUTE the work this turn/);
  assert.match(CONVERGENCE_STEER, /do NOT ask another separate clarifying question/);
  assert.match(CONVERGENCE_STEER, /background/i);
});
