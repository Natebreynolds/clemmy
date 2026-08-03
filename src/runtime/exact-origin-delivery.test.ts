import test from 'node:test';
import assert from 'node:assert/strict';

import {
  exactOriginDeliveryDestinationId,
  exactOriginDeliveryMetadata,
  exactOriginDeliveryTarget,
  hasExactOriginDeliveryReceipt,
  hasExpectedExactOriginDeliveryReceipt,
  normalizeExactOriginDeliveryTarget,
} from './exact-origin-delivery.js';

test('persisted exact Slack targets use the same encoded channel and thread grammar as admission', () => {
  assert.deepEqual(normalizeExactOriginDeliveryTarget({
    type: 'slack_channel',
    channelId: 'C0EXACT',
    threadTs: '1785760000.123456',
  }), {
    type: 'slack_channel',
    channelId: 'C0EXACT',
    threadTs: '1785760000.123456',
  });

  for (const target of [
    { type: 'slack_channel', channelId: 'general' },
    { type: 'slack_channel', channelId: '#general' },
    { type: 'slack_channel', channelId: 'C_BAD' },
    { type: 'slack_channel', channelId: 'C0EXACT', threadTs: '1785760000.123' },
    { type: 'slack_channel', channelId: 'C0EXACT', threadTs: 'not-a-timestamp' },
  ]) {
    assert.equal(normalizeExactOriginDeliveryTarget(target), undefined, JSON.stringify(target));
    assert.throws(
      () => exactOriginDeliveryMetadata(target as never),
      /invalid exact-origin delivery target/i,
      JSON.stringify(target),
    );
    assert.equal(exactOriginDeliveryTarget({
      metadata: { exactOriginDelivery: { version: 1, target } },
    }), undefined, JSON.stringify(target));
  }
});

test('a corrupt string cannot impersonate the exact delivered-destination receipt array', () => {
  const target = { type: 'slack_channel' as const, channelId: 'C0EXACT' };
  const receipt = exactOriginDeliveryDestinationId(target);
  assert.ok(receipt);
  const carrier = {
    metadata: exactOriginDeliveryMetadata(target),
    deliveredDestinations: receipt,
  };
  assert.equal(hasExpectedExactOriginDeliveryReceipt(carrier), false);
  assert.equal(hasExactOriginDeliveryReceipt(carrier, target), false);
});
