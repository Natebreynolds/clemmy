/**
 * Conversation-facts self-tests: canned-leak detection against the exact
 * strings observed reaching users in the Aug 2026 forensics, parked-work
 * mention verdicts with ledger-supplied identifiers, and ask-before-effect
 * ordering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  askedBeforeExternalEffect,
  conversationDescriptives,
  detectCannedStrings,
  reportsParkedWork,
} from './conversation-facts.js';

test('detects every canned string observed in the live forensics', () => {
  const observed = [
    'Before Claude stopped, the action ledger recorded:\n• Sent a message',
    'Claude stopped before it finished the turn. I did not rerun the task on another model because that could repeat or conflict with the external action.',
    "I'm not marking this finished yet because I still need to verify the result.",
    "The user doesn't want to proceed with this tool use. The tool use was rejected.",
    'That read stopped after the provider was contacted, so I did not run it again.',
    'The connected read ran, but its result could not be safely presented.',
    'Verified activity this turn (4 successful calls): call tool ×2, background task status ×2. A reliable written summary of the results was not available.',
    'Stopped — this turn was cancelled. Nothing further will execute.',
  ];
  for (const text of observed) {
    const leaks = detectCannedStrings(text);
    assert.ok(leaks.length >= 1, `expected a leak for: ${text.slice(0, 60)}`);
    assert.ok(leaks[0].excerpt.length > 0);
  }
});

test('natural model voice produces zero leaks', () => {
  const natural = [
    'Done — both drafts are in your Scorpion Outlook, not sent. Bobby’s calls out the 58-day-old opp; Brett’s flags the silent one I’m most worried about.',
    'Sheet updated with all 24 events. Also caught and fixed a bug from the old version — the All Hands was mis-dated to Monday; it’s actually Tuesday.',
    'Salesforce shows only Brett and Bobby with past-due opportunities — that’s 2 reps, not 5. Want me to draft for those 2, or did you mean org-wide?',
  ];
  for (const text of natural) {
    assert.deepEqual(detectCannedStrings(text), [], `false positive on: ${text.slice(0, 50)}`);
  }
});

test('parked work must be mentioned; missing mentions are named', () => {
  const facts = [
    { identifier: 'Delete duplicate draft to brett.lorenzini', kind: 'parked_approval' as const },
    { identifier: 'AIRTABLE_CREATE_BASE', kind: 'failed_write' as const },
  ];
  const good = reportsParkedWork({
    finalText: 'Both drafts are rewritten in HTML. One thing needs you: the delete of the duplicate draft to Brett.Lorenzini is waiting on your approval. The Airtable base creation (AIRTABLE_CREATE_BASE) failed on a schema error — say the word and I retry it.',
    facts,
  });
  assert.equal(good.required, true);
  assert.equal(good.missing.length, 0);
  assert.equal(good.mentioned.length, 2);

  const bad = reportsParkedWork({
    finalText: 'Done — everything went out.',
    facts,
  });
  assert.equal(bad.missing.length, 2);
  assert.equal(bad.silentTerminal, false);

  const silent = reportsParkedWork({ finalText: '   ', facts });
  assert.equal(silent.silentTerminal, true);
});

test('no parked facts means nothing is required', () => {
  const verdict = reportsParkedWork({ finalText: 'Done.', facts: [] });
  assert.equal(verdict.required, false);
  assert.equal(verdict.missing.length, 0);
});

test('long opaque identifiers match on a 12-char prefix', () => {
  const verdict = reportsParkedWork({
    finalText: 'The approval apr-ym65abcdef1234 is still pending.',
    facts: [{ identifier: 'apr-ym65abcdef1234567890', kind: 'parked_approval' }],
  });
  assert.equal(verdict.mentioned.length, 1);
});

test('ask-before-effect ordering', () => {
  const askFirst = askedBeforeExternalEffect([
    { type: 'turn_started', seq: 1 },
    { type: 'awaiting_user_input', seq: 5 },
    { type: 'tool_called', seq: 9, effect: 'external_write' },
  ]);
  assert.equal(askFirst.asked, true);
  assert.equal(askFirst.askedBeforeFirstEffect, true);

  const effectFirst = askedBeforeExternalEffect([
    { type: 'tool_called', seq: 3, effect: 'external_write' },
    { type: 'awaiting_user_input', seq: 8 },
  ]);
  assert.equal(effectFirst.askedBeforeFirstEffect, false);

  const readOnly = askedBeforeExternalEffect([
    { type: 'tool_called', seq: 2, effect: 'read' },
    { type: 'awaiting_user_input', seq: 4 },
  ]);
  assert.equal(readOnly.askedBeforeFirstEffect, true, 'no external effect means the ask was in time');

  const neverAsked = askedBeforeExternalEffect([
    { type: 'tool_called', seq: 2, effect: 'external_write' },
  ]);
  assert.equal(neverAsked.asked, false);
  assert.equal(neverAsked.askedBeforeFirstEffect, false);
});

test('descriptives are counters, not judgments', () => {
  const result = conversationDescriptives('Short reply.');
  assert.equal(result.finalMessageChars, 12);
  assert.deepEqual(result.cannedLeaks, []);
});
