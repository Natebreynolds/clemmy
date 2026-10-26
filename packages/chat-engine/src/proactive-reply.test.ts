import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentProactiveReceipt, proactiveReplySettled } from './proactive-reply.js';
test('unresolved and unknown replies keep the owner controls available', () => {
  for (const outcome of ['unclear', 'changed', 'unknown', '']) assert.equal(proactiveReplySettled(outcome), false);
  for (const outcome of ['gone','started','approved','declined','cleared','later','rule_added','answered']) assert.equal(proactiveReplySettled(outcome), true);
});
test('starting a follow-up conversation leaves the original decision available', () => {
  assert.equal(proactiveReplySettled('started', false), false,
    'accepting a question is not a decision on the original item');
  assert.equal(proactiveReplySettled('started'), true,
    'existing started receipts retain their settled meaning');
  assert.equal(proactiveReplySettled('started', true), true);
  assert.equal(proactiveReplySettled('unknown', true), false,
    'a flag cannot make an unknown outcome authoritative');
});
test('a late receipt cannot settle a newer version of the same item', () => {
  const receipt = { voiceDigest:'before', settled:true };
  assert.equal(currentProactiveReceipt(receipt, 'after'), undefined);
  assert.equal(currentProactiveReceipt(receipt, 'before'), receipt);
});
test('an unsettled conversation receipt belongs only to the version that accepted it', () => {
  const receipt = { voiceDigest: 'before', settled: proactiveReplySettled('started', false),
    sessionId: 'sess-controlled-follow-up' };
  const current = currentProactiveReceipt(receipt, 'before');
  assert.equal(current?.settled, false, 'the current item still offers its decision controls');
  assert.equal(current?.sessionId, 'sess-controlled-follow-up', 'its accepted conversation remains reachable');
  assert.equal(currentProactiveReceipt(receipt, 'after'), undefined,
    'a late reply cannot supply a receipt or thread for a newer item version');
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
