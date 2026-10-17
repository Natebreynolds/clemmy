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
