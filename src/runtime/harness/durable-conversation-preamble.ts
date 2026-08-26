import type {
  ConversationPreambleDeliveryCallback,
  ConversationPreambleDeliveryResult,
} from '../../types.js';

/**
 * The delivery a carrier gets when it has no live transport of its own.
 *
 * A carrier with an editable live message (a channel placeholder) supplies its
 * own port and paints the preamble into that message. Every other carrier —
 * desktop, mobile, and the API surfaces — renders the conversation FROM the
 * durable event log, and plan_task has already appended the preamble there
 * before delivery is attempted. For those carriers the durable append IS the
 * delivery: there is no second place to put it, and nothing is left unsaid.
 *
 * Measured 2026-08-26: requiring a carrier-supplied port made an admitted,
 * sealed, expected-work-frozen plan throw on the last statement of plan_task.
 * Only one carrier had ever supplied one, while 302 of 316 plan_task calls in
 * the preceding week came from a carrier that had not — so the gate rejected
 * work it had already fully authorized, on the surface nearly all real work
 * arrives through. The turn then died as a laundered tool error the model
 * could only retry, which is what a user sees as "something went wrong."
 *
 * A missing live transport is a fact about a carrier's UI, never a reason to
 * discard authorized work. This grants no outcome, effect, or continuation
 * authority — it certifies exactly one thing, that the acknowledgement the
 * user will read is durably recorded before any tool runs.
 */
export function hostDurableConversationPreambleDelivery(): ConversationPreambleDeliveryCallback {
  return async (request): Promise<ConversationPreambleDeliveryResult> => ({
    status: 'delivered',
    receipt: {
      version: 1,
      deliveryKey: request.deliveryKey,
      eventId: request.eventId,
      eventDigest: request.eventDigest,
      // The conversation itself is the message lane on these carriers; the
      // target names the lane so an auditor can tell it from a channel edit.
      surface: 'channel_message',
      target: 'durable_conversation',
    },
  });
}
