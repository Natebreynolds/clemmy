import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
  PROOF_SERVER_TURN_BUDGET_MS,
  PROOF_TURN_COMPLETION_HEADROOM_MS,
} from './timeouts.js';

test('proof chat client outlives the server turn budget and recovery tail', () => {
  assert.ok(
    PROOF_CLIENT_COMPLETION_TIMEOUT_MS > PROOF_SERVER_TURN_BUDGET_MS,
    'the proof client must not abort while the daemon can still recover and complete',
  );
  assert.equal(
    PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
    PROOF_SERVER_TURN_BUDGET_MS + PROOF_TURN_COMPLETION_HEADROOM_MS,
  );
  assert.ok(
    PROOF_TURN_COMPLETION_HEADROOM_MS >= 60_000,
    'leave enough time for recovery, verification, and the final HTTP response',
  );
});
