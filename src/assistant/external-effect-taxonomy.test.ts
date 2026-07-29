import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyExternalEffectRequest,
  type ExternalEffectKind,
} from './external-effect-taxonomy.js';
import { classifyMessageIntent, type MessageIntent } from './message-intent.js';
import {
  objectiveRequiresFreshExternalWrite,
  objectiveRequiresMutatingEvidence,
} from '../runtime/harness/tool-evidence.js';
import { classifyTurnIntent, type TurnIntent } from '../runtime/harness/turn-intent.js';

interface ConsequentialCase {
  text: string;
  kind: ExternalEffectKind;
}

const CONSEQUENTIAL_CASES: readonly ConsequentialCase[] = [
  { text: 'RSVP yes to the invitation.', kind: 'invitation_response' },
  { text: 'Decline the calendar invitation.', kind: 'invitation_response' },
  { text: 'Like this post.', kind: 'social_reaction' },
  { text: 'Like Alice’s Instagram post.', kind: 'social_reaction' },
  { text: 'Retweet it.', kind: 'social_repost' },
  { text: 'Repost this on LinkedIn.', kind: 'social_repost' },
  { text: 'Buy the conference tickets.', kind: 'commerce' },
  { text: 'Buy the annual plan.', kind: 'commerce' },
  { text: 'Order the groceries.', kind: 'commerce' },
  { text: 'Order a pizza for 7pm.', kind: 'commerce' },
  { text: 'Reserve a table for four.', kind: 'reservation' },
  { text: 'Reserve a table for four at Nobu.', kind: 'reservation' },
  { text: 'Book a flight to Seattle.', kind: 'reservation' },
  { text: 'Book a hotel in Seattle.', kind: 'reservation' },
  { text: 'Book a table at Nobu.', kind: 'reservation' },
  { text: 'Make a reservation at Nobu.', kind: 'reservation' },
  { text: 'Cancel my reservation.', kind: 'reservation' },
  { text: 'Cancel my flight.', kind: 'reservation' },
  { text: 'Sign the DocuSign agreement.', kind: 'document_signature' },
  { text: 'Approve PR #42.', kind: 'code_host_change' },
  { text: 'Close issue 123.', kind: 'work_item_change' },
  { text: 'Assign the ticket to Alice.', kind: 'work_item_change' },
  { text: 'Star the repository.', kind: 'code_host_change' },
  { text: 'Vote in the launch poll.', kind: 'poll_vote' },
  { text: 'Vote yes in the poll.', kind: 'poll_vote' },
  { text: 'Check me in for tomorrow’s flight.', kind: 'flight_check_in' },
  { text: 'Follow Alice.', kind: 'social_follow' },
  { text: 'Unfollow @acme.', kind: 'social_follow' },
  { text: 'Put this event on my calendar.', kind: 'calendar_change' },
  { text: 'Put dinner on my calendar.', kind: 'calendar_change' },
  { text: 'Could you RSVP no to the invite?', kind: 'invitation_response' },
  { text: 'Okay, buy it now.', kind: 'commerce' },
  { text: 'Compare the plans, then buy the annual one.', kind: 'commerce' },
  { text: 'Draft the post; then repost it on LinkedIn.', kind: 'social_repost' },
  { text: 'Do not like the first post; repost the second one.', kind: 'social_repost' },
];

test('shared external-effect taxonomy: direct effects arm every consequential classifier', () => {
  for (const { text, kind } of CONSEQUENTIAL_CASES) {
    const effect = classifyExternalEffectRequest(text);
    assert.equal(effect.requested, true, text);
    assert.ok(effect.kinds.includes(kind), `${text} should include ${kind}`);
    assert.equal(classifyMessageIntent(text).intent, 'action', `${text}: message intent`);
    assert.equal(objectiveRequiresMutatingEvidence(text), true, `${text}: mutation evidence`);
    assert.equal(objectiveRequiresFreshExternalWrite(text), true, `${text}: fresh receipt`);
    assert.equal(classifyTurnIntent(text), 'action', `${text}: turn intent`);
  }
});

interface AdversarialCase {
  text: string;
  messageIntent: MessageIntent;
  mutating: boolean;
  turnIntent: TurnIntent;
}

const ADVERSARIAL_CASES: readonly AdversarialCase[] = [
  {
    text: 'Compare plans before I buy.',
    messageIntent: 'lookup',
    mutating: false,
    turnIntent: 'qa',
  },
  {
    text: 'Draft a social post.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
  {
    text: 'Draft an email to Alice.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
  {
    text: 'How do I RSVP to an invitation?',
    messageIntent: 'lookup',
    mutating: false,
    turnIntent: 'qa',
  },
  {
    text: 'Can you explain how to RSVP?',
    messageIntent: 'lookup',
    mutating: false,
    turnIntent: 'qa',
  },
  {
    text: 'Should I approve PR #42?',
    messageIntent: 'lookup',
    mutating: false,
    turnIntent: 'qa',
  },
  {
    text: "Don't close issue 123.",
    messageIntent: 'tool_intent',
    mutating: false,
    turnIntent: 'qa',
  },
  {
    text: 'Ask me before you buy anything.',
    messageIntent: 'tool_intent',
    mutating: false,
    turnIntent: 'qa',
  },
  {
    text: 'Only buy it after I approve.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
  {
    text: 'Write a report comparing the ordering options.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
  {
    text: 'Create a guide to closing GitHub issues.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
  {
    text: 'Call the helper function.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
  {
    text: 'Merge the local branch.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
  {
    text: 'Comment on the implementation locally.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
  {
    text: 'Order the array alphabetically.',
    messageIntent: 'tool_intent',
    mutating: false,
    turnIntent: 'qa',
  },
  {
    text: 'Follow these setup instructions.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
  {
    text: 'Book the local test fixture.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
  {
    text: 'Cancel the local cron job.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
  {
    text: 'Reserve a memory buffer.',
    messageIntent: 'tool_intent',
    mutating: false,
    turnIntent: 'qa',
  },
  {
    text: 'Make a reservation mock in the local UI.',
    messageIntent: 'action',
    mutating: true,
    turnIntent: 'qa',
  },
];

test('shared external-effect taxonomy: advice, deferral, artifacts, and local code stay receipt-free', () => {
  for (const expected of ADVERSARIAL_CASES) {
    const effect = classifyExternalEffectRequest(expected.text);
    assert.equal(effect.requested, false, expected.text);
    assert.deepEqual(effect.kinds, [], expected.text);
    assert.equal(
      classifyMessageIntent(expected.text).intent,
      expected.messageIntent,
      `${expected.text}: message intent`,
    );
    assert.equal(
      objectiveRequiresMutatingEvidence(expected.text),
      expected.mutating,
      `${expected.text}: mutation evidence`,
    );
    assert.equal(
      objectiveRequiresFreshExternalWrite(expected.text),
      false,
      `${expected.text}: fresh receipt`,
    );
    assert.equal(
      classifyTurnIntent(expected.text),
      expected.turnIntent,
      `${expected.text}: turn intent`,
    );
  }
});
