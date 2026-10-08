import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMissingConversation, shouldRetrySessionLoad } from './session-load.js';

// A Windows tester (10-08) saw every chat as "This conversation could not be
// found" while the daemon restarted, and the remembered chat was forgotten.
test('only a 404 is a missing conversation; no answer from the daemon is not', () => {
  assert.equal(isMissingConversation({ status: 404 }), true);
  for (const error of [{ status: 0 }, { status: 502 }, { status: 503 }, new Error('timeout'), null]) {
    assert.equal(isMissingConversation(error), false);
  }
});

test('an unreachable daemon is retried a few times; a new chat that 404s is not retried', () => {
  assert.equal(shouldRetrySessionLoad(0, { status: 0 }), true);
  assert.equal(shouldRetrySessionLoad(2, { status: 503 }), true);
  assert.equal(shouldRetrySessionLoad(3, { status: 503 }), false);
  assert.equal(shouldRetrySessionLoad(0, { status: 404 }), false);
});
