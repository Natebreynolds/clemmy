/**
 * THE HOST HOLDS THE QUESTION — ASK IT.
 *
 * Live 2026-09-08 on the calendar task: discovery returned
 * account_selection_required with two exact Outlook accounts. Opus asked the
 * user after one refusal; GLM 5.2 ignored the typed "ask the user" reason three
 * times and then exhausted the governor; Grok 4.6 wandered through spaces,
 * skills and MCP status until it was stopped. In every case the host already
 * knew the question and the exact choices. A governor-exhausted fresh turn
 * with an unresolved account choice must end as that question, never blocked.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PRIOR_HOME = process.env.CLEMENTINE_HOME;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-account-question-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
const eventlog = await import('./eventlog.js');
const { hostAccountQuestionForExhaustedTurn } = await import('./loop.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_HOME;
});

function seed(sessionId: string, choices: string[]) {
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const user = eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'prep my week' } });
  eventlog.appendEvent({
    sessionId, turn: 1, role: 'system', type: 'tool_returned',
    data: {
      tool: 'tool_search', sourceUserSeq: user.seq,
      result: JSON.stringify({ results: [{ name: 'OUTLOOK_GET_CALENDAR_VIEW', planningRefStatus: 'account_selection_required', accountChoices: choices }] }),
    },
  });
  return user.seq;
}
const exhausted = (sessionId: string) => ({
  sessionId, turn: 1, status: 'blocked' as const, blockedReason: 'control_no_progress_exhausted',
  blockedDetail: 'authority_acquisition:no_new_evidence', error: 'stopped', toolCalls: 9,
} as never);

test('a governor-exhausted turn with two connected accounts becomes the host\'s own question', () => {
  const sessionId = 'sess-host-account-question';
  const seq = seed(sessionId, ['nathan.reynolds@scorpion.co', 'nathan@breakthroughcoaching.ai']);
  const out = hostAccountQuestionForExhaustedTurn(exhausted(sessionId), { sessionId, sourceUserSeq: seq });
  assert.equal(out.status, 'awaiting_user_input');
  assert.equal((out as { blockedReason?: string }).blockedReason, undefined);
  const awaiting = eventlog.listEvents(sessionId, { types: ['awaiting_user_input'] }).at(-1);
  assert.ok(awaiting, 'the host published its own awaiting row');
  assert.deepEqual(awaiting?.data.options, ['nathan.reynolds@scorpion.co', 'nathan@breakthroughcoaching.ai']);
  assert.equal(awaiting?.data.source, 'host_account_selection');
  assert.equal(awaiting?.data.sourceUserSeq, seq);
  assert.match(String(awaiting?.data.question), /which account/i);
  // idempotent: asking again for the same turn adds no second row
  hostAccountQuestionForExhaustedTurn(exhausted(sessionId), { sessionId, sourceUserSeq: seq });
  assert.equal(eventlog.listEvents(sessionId, { types: ['awaiting_user_input'] }).length, 1);
});

test('a single connected account, or a stop for any other reason, passes through untouched', () => {
  const one = 'sess-host-account-single';
  const seqOne = seed(one, ['nathan.reynolds@scorpion.co']);
  assert.equal(hostAccountQuestionForExhaustedTurn(exhausted(one), { sessionId: one, sourceUserSeq: seqOne }).status, 'blocked');
  const other = 'sess-host-account-other-reason';
  const seqOther = seed(other, ['a@x.co', 'b@y.co']);
  const notExhausted = { ...(exhausted(other) as object), blockedReason: 'tool_effect_uncertain' } as never;
  assert.equal(hostAccountQuestionForExhaustedTurn(notExhausted, { sessionId: other, sourceUserSeq: seqOther }).status, 'blocked');
  assert.equal(eventlog.listEvents(other, { types: ['awaiting_user_input'] }).length, 0);
});
