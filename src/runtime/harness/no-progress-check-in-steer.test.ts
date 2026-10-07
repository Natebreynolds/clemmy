/**
 * The no-progress check-in asks the model for the kind of ending the stop
 * deserves. A provider that refused the exact request has already answered;
 * the person is owed that answer, not a question that invites workarounds.
 * Live 2026-10-06: Slack said not_found twice for "delete that reminder
 * again and tell me what happened"; the generic check-in asked whether to
 * try "another workspace", the owner said yes, and the next turn chased a
 * second Slack account that does not exist and ended blocked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const loop = await import('./loop.js');

test('a provider-refusal stop is steered to deliver the provider answer', () => {
  const steer = loop.noProgressCheckInSteerFor('execution:invalid_arguments:request:0123456789abcdef');
  assert.equal(steer, loop.PROVIDER_REFUSAL_ANSWER_STEER);
  assert.match(steer, /nothing was changed/i);
  assert.match(steer, /Do not call tools now/);
  assert.match(steer, /what the provider said/);
  assert.match(steer, /Do not propose workarounds/);
  // The legacy stage spelling (a checkpoint written before the request
  // identity joined the stage) is the same class of stop.
  assert.equal(loop.noProgressCheckInSteerFor('execution:invalid_arguments'), loop.PROVIDER_REFUSAL_ANSWER_STEER);
});

test('every other exhaustion keeps the explain-and-ask check-in', () => {
  for (const detail of [undefined, '', 'repeated_refused_frame', 'schema_invalid:call:0123456789abcdef', 'execution:transient']) {
    assert.equal(loop.noProgressCheckInSteerFor(detail), loop.NO_PROGRESS_CHECK_IN_STEER, String(detail));
  }
});
