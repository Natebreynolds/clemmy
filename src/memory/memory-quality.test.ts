import assert from 'node:assert/strict';
import test from 'node:test';
import { derivedFactRejectionReason } from './memory-quality.js';

test('derived fact quality rejects requests, runtime actions, ids, and snapshots', () => {
  assert.equal(derivedFactRejectionReason('Can you search the CRM for Dana?'), 'transient_request');
  assert.equal(derivedFactRejectionReason('Clementine searched the CRM for Dana.'), 'assistant_action_history');
  assert.equal(derivedFactRejectionReason('The sync completed successfully.'), 'ephemeral_tool_status');
  assert.equal(derivedFactRejectionReason('Request ID: req_82f6a93c'), 'runtime_identifier');
  assert.equal(derivedFactRejectionReason('The current temperature in Seattle is 63 degrees.'), 'ephemeral_snapshot');
});

test('derived fact quality preserves durable people, project, preference, and failure knowledge', () => {
  const durable = [
    'Dana Smith is the billing contact for Acme.',
    'The Acme renewal closes on September 30.',
    'The user prefers CRM exports grouped by account owner.',
    'Email outreach execution fails when the sender domain is not verified.',
    'The weekly design review is held in person on Tuesdays.',
  ];
  for (const claim of durable) assert.equal(derivedFactRejectionReason(claim), null, claim);
});
