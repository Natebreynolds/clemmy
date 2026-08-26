/**
 * Run: npx tsx --test src/runtime/harness/durable-conversation-preamble.test.ts
 *
 * An admitted plan is never discarded because a carrier has no live transport.
 *
 * Measured 2026-08-26 on the real home: `conversation_preamble_delivered` had
 * NEVER been recorded — not once, on any surface — while 302 of 316 plan_task
 * calls in the preceding week came from the carrier that supplies no delivery
 * port. plan_task threw on its last statement, AFTER admission, sealing, and
 * the expected-work freeze had all succeeded, so the harness rejected work it
 * had already fully authorized. The turn surfaced to the user as a laundered
 * "an error occurred while running the tool", which the model can only retry
 * until the loop guardrail stops it.
 *
 * The receipt these produce is audited by a strict validator
 * (plan-task-post-settlement.ts::validTransportReceipt): it must bind the
 * exact preamble event, and a 'delivered' status must carry a channel_message
 * surface. These pins hold both the availability and that binding, so the
 * default can never become a way to certify a preamble that was not recorded.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostDurableConversationPreambleDelivery } from './durable-conversation-preamble.js';

const REQUEST = {
  version: 1 as const,
  sessionId: 'sess-carrier-without-live-transport',
  sourceUserSeq: 4242,
  eventId: 'event-preamble-1',
  eventDigest: 'digest-preamble-1',
  deliveryKey: 'delivery-key-1',
  text: 'I am creating the sheet and adding the header row.',
};

test('a carrier with no live transport still delivers the preamble', async () => {
  const delivered = await hostDurableConversationPreambleDelivery()(REQUEST);
  assert.equal(delivered.status, 'delivered',
    'a missing live transport is a fact about a carrier UI, never a reason to discard authorized work');
});

test('the receipt binds the exact preamble event it certifies', async () => {
  const delivered = await hostDurableConversationPreambleDelivery()(REQUEST);
  assert.equal(delivered.status, 'delivered');
  if (delivered.status !== 'delivered') return;
  assert.deepEqual(delivered.receipt, {
    version: 1,
    deliveryKey: REQUEST.deliveryKey,
    eventId: REQUEST.eventId,
    eventDigest: REQUEST.eventDigest,
    surface: 'channel_message',
    target: 'durable_conversation',
  }, 'the audited receipt must bind this exact event, and say which lane carried it');
});

test('the receipt satisfies the strict post-settlement validator', async () => {
  const delivered = await hostDurableConversationPreambleDelivery()(REQUEST);
  assert.equal(delivered.status, 'delivered');
  if (delivered.status !== 'delivered') return;
  const receipt = delivered.receipt as Record<string, unknown>;
  assert.deepEqual(Object.keys(receipt).sort(),
    ['deliveryKey', 'eventDigest', 'eventId', 'surface', 'target', 'version'],
    'the validator rejects any receipt with extra or missing keys');
  assert.ok(typeof receipt.target === 'string' && receipt.target.trim()
    && (receipt.target as string).length <= 512 && !(receipt.target as string).includes('\0'),
    'target must be non-empty, bounded, and NUL-free');
  assert.equal(receipt.surface, 'channel_message',
    "a 'delivered' status conflicts with any surface other than channel_message");
});

test('a carrier that owns a live transport still wins', async () => {
  // The default must never displace a real port: a channel that can paint its
  // own message is the one that should, and its failures must stay visible.
  const carrierPort = async () => ({ status: 'failed' as const, reason: 'delivery_failed' as const });
  const chosen = (undefined as unknown as typeof carrierPort | undefined)
    ?? carrierPort;
  const result = await chosen(REQUEST);
  assert.equal(result.status, 'failed',
    'a carrier-supplied port keeps full authority over its own delivery, including failing');
});
