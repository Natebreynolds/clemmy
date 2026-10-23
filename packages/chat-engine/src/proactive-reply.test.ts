import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentProactiveReceipt, proactiveReplySettled } from './proactive-reply.js';
test('unresolved and unknown replies keep the owner controls available', () => {
  for (const outcome of ['unclear', 'changed', 'unknown', '']) assert.equal(proactiveReplySettled(outcome), false);
  for (const outcome of ['gone','started','approved','declined','cleared','later','rule_added','answered']) assert.equal(proactiveReplySettled(outcome), true);
});
test('a late receipt cannot settle a newer version of the same item', () => {
  const receipt = { voiceDigest:'before', settled:true };
  assert.equal(currentProactiveReceipt(receipt, 'after'), undefined);
  assert.equal(currentProactiveReceipt(receipt, 'before'), receipt);
});


test('a stale check-in decline reports the persisted disposition, never the clicked intention', async () => {
  const { checkInProposalDecisionFeedback } = await import('./proactive-reply.js');
  const stale = checkInProposalDecisionFeedback('decline', 'approved', 'Controlled fixture');
  assert.equal(stale.tone, 'error');
  assert.match(stale.text, /already approved/);
  assert.doesNotMatch(stale.text, /turned down|won.t set up/i);
  assert.equal(checkInProposalDecisionFeedback('decline', 'rejected', 'Controlled fixture').tone, 'success');
  assert.equal(checkInProposalDecisionFeedback('keep', 'approved', 'Controlled fixture').tone, 'success');
  assert.equal(checkInProposalDecisionFeedback('decline', undefined, 'Controlled fixture').tone, 'error');
});
