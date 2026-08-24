import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runConversationDisposition,
} from './run-conversation-disposition.js';
import type { RunConversationStatus } from './loop.js';

test('runConversationDisposition preserves every loop status one-to-one', () => {
  const statuses: RunConversationStatus[] = [
    'completed',
    'dispatched',
    'held',
    'awaiting_user_input',
    'awaiting_approval',
    'killed',
    'limit_exceeded',
    'blocked',
    'failed',
  ];
  for (const status of statuses) {
    assert.equal(runConversationDisposition({ status }).kind, status);
  }
});

test('a legacy held result stays nonterminal under an explicit recovery owner', () => {
  assert.deepEqual(runConversationDisposition({ status: 'held' }), {
    kind: 'held',
    hold: { owner: 'host', wake: 'recovery', reason: 'recovery_pending' },
    recoveredContract: true,
  });
});
