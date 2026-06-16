import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubInternalNarration } from './scrub-internal-narration.js';

// --- the observed leak (sess-mqft9oaa, 2026-06-15 22:57) -------------------
// A fresh "hey hows it going" thread; user asked for 25 Salesforce prospects;
// cross-session recall surfaced the day's earlier Revill audits and the model
// narrated its context-hygiene check INTO the user-facing reply.

test('strips the exact observed Revill "active context" preamble, keeps the question', () => {
  const leaked =
    'I checked the active context. The Salesforce prospect request is a new topic, not the stale Revill audit thread, so I’m not using that focus.\n\n' +
    'To pull the right 25, should I use your usual Nate-owned law-firm / market-leader prospect lane, or all Salesforce prospects untouched in the last 20 days?';
  const cleaned = scrubInternalNarration(leaked);
  assert.equal(
    cleaned,
    'To pull the right 25, should I use your usual Nate-owned law-firm / market-leader prospect lane, or all Salesforce prospects untouched in the last 20 days?',
  );
  assert.ok(!/active context|Revill|that focus/i.test(cleaned));
});

test('strips a mixed leading paragraph but keeps the real answer in it', () => {
  const leaked =
    'I checked the active context and this is a new topic. Here are the 3 overdue follow-ups: Acme, Globex, Initech.';
  const cleaned = scrubInternalNarration(leaked);
  assert.equal(cleaned, 'Here are the 3 overdue follow-ups: Acme, Globex, Initech.');
});

test('strips a multi-paragraph narration preamble', () => {
  const leaked =
    'I checked the active context.\n\n' +
    'That focus is from a prior session, so I’m not using that focus.\n\n' +
    'Sure — which inbox should I pull from?';
  const cleaned = scrubInternalNarration(leaked);
  assert.equal(cleaned, 'Sure — which inbox should I pull from?');
});

// --- must NOT touch legitimate replies -------------------------------------

test('leaves a normal answer untouched', () => {
  const reply = 'Brooke emailed you at 9:14am about the renewal — want me to draft a reply?';
  assert.equal(scrubInternalNarration(reply), reply);
});

test('leaves an answer that legitimately mentions "focus" of the work untouched', () => {
  const reply = 'I kept the focus on local rankings for these three firms. Want the full list?';
  assert.equal(scrubInternalNarration(reply), reply);
});

test('does not strip narration-like wording that appears AFTER real content', () => {
  const reply =
    'Here are your 5 drafts. I also checked the active context to be safe — nothing else was pending.';
  // Leading sentence is real content, so nothing is stripped.
  assert.equal(scrubInternalNarration(reply), reply);
});

test('never blanks an all-narration reply (returns original)', () => {
  const reply = 'I checked the active context. That focus is from a prior session.';
  assert.equal(scrubInternalNarration(reply), reply);
});

// --- edge cases ------------------------------------------------------------

test('handles empty / whitespace input', () => {
  assert.equal(scrubInternalNarration(''), '');
  assert.equal(scrubInternalNarration('   '), '   ');
});

test('handles a single clean sentence', () => {
  assert.equal(scrubInternalNarration('Done — sent.'), 'Done — sent.');
});
