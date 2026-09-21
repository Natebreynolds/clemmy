/**
 * The zero-tool shortcut needs POSITIVE evidence, not an unrecognised sentence.
 *
 * THE INCIDENT THIS CLOSES (live 2026-09-20, source 268980). "how many meetings
 * does tim have tomorrow checking salesfroce and for who" was ruled closed-world
 * and compiled direct_reply with maxTools:0. Discovery never ran; Clem announced
 * a Salesforce check she had no authority to perform; two completion reviews
 * correctly rejected the empty answer and every retry recomputed the same
 * shortcut. 124 seconds, zero tool calls.
 *
 * The cause was never the misspelling — the correctly spelled sentence fails
 * identically. The old gate fired on the ABSENCE of a first-person pronoun, one
 * of eight possessive nouns, or one of six prepositions. So "checking
 * salesforce" was closed-world while "in salesforce" was not, and any question
 * about a third person was structurally invisible to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMessageIntent,
  isSelfContainedComputation,
  selfContainedConversation,
} from './message-intent.js';

const cheap = (text: string) => selfContainedConversation(text, classifyMessageIntent(text));

test('the exact failing request keeps its tools', () => {
  assert.equal(cheap('how many meetings does tim have tomorrow checking salesfroce and for who'), false);
});

test('spelling is not the variable', () => {
  // Both spellings must behave the same. Before the fix both were ALSO the
  // same — both wrongly cheap — so this pins the pair, not just one side.
  for (const text of [
    'how many meetings does tim have tomorrow checking salesfroce and for who',
    'how many meetings does tim have tomorrow checking salesforce and for who',
  ]) assert.equal(cheap(text), false, text);
});

test('phrasing is not the variable', () => {
  // "checking X" vs "in X" used to decide whether tools existed at all.
  for (const verb of ['checking', 'in', 'from', 'against', 'look at', 'pull from', 'over in']) {
    assert.equal(cheap(`how many meetings does tim have tomorrow ${verb} salesforce`), false, verb);
  }
});

test('a question about someone else is not closed-world', () => {
  for (const text of [
    'what deals is tim working on',
    'who is covering the acme account next week',
    'how many calls did the west team log yesterday',
  ]) assert.equal(cheap(text), false, text);
});

test('an unfamiliar tool nobody has heard of still keeps its tools', () => {
  // Discovery is exactly what would resolve this; the shortcut must not
  // pre-empt it because the name is unknown to any list.
  for (const text of [
    'pull the latest from acmecrm for tim',
    'what does quorbitals say about our pipeline',
  ]) assert.equal(cheap(text), false, text);
});

test('greetings stay cheap', () => {
  for (const text of ['hey', 'hey hows it going', 'thanks!', 'good morning']) {
    assert.equal(cheap(text), true, text);
  }
});

test('arithmetic stays cheap', () => {
  for (const text of ['what is 2x3', 'whats 15% of 80', 'what is 12 divided by 4', 'calculate 7 * 6']) {
    assert.equal(cheap(text), true, text);
  }
});

test('arithmetic is identified positively, not by what it lacks', () => {
  assert.equal(isSelfContainedComputation('2x3'), true);
  assert.equal(isSelfContainedComputation('15% of 80'), true);
  // A digit is not enough: one domain noun and it is no longer self-contained.
  assert.equal(isSelfContainedComputation('3 meetings tomorrow'), false);
  assert.equal(isSelfContainedComputation('how many meetings does tim have on the 3rd'), false);
  // No digits at all is not a computation.
  assert.equal(isSelfContainedComputation('what is a crm'), false);
});

// ─── The hole the first fix left open ──────────────────────────────────────
// Adversarial review, 2026-09-20: trusting intent==='casual' reinstated the
// absence test one level down. classifyMessageIntent's casual branch guards
// itself with greetingOpensHostedOrLookupAsk, whose body IS
// refersToUserOrHostedWorld — and it strips only greeting openers, never
// acknowledgements. Measured on the shipped classifier before this pin:
// "ok what meetings does tim have tomorrow" -> casual/0.9 -> zero tools. That
// is the incident sentence with one word in front.

test('an opener does not make what follows it closed-world', () => {
  for (const text of [
    'ok what meetings does tim have tomorrow',
    'hey when is the acme renewal',
    'hey check salesforce for tim',
    'thanks, does acme have an open deal?',
    'yo did tim reply',
    'cool who owns the acme account',
    'hi is tim out today',
    'perfect, and acme?',
    'hey can you check tim\u2019s calendar',
  ]) assert.equal(cheap(text), false, text);
});

test('an opener with nothing after it is still cheap', () => {
  for (const text of [
    'hey', 'hi', 'thanks!', 'good morning', 'ok', 'perfect', 'cool',
    'hey hows it going', 'whats up', 'you there', 'later',
  ]) assert.equal(cheap(text), true, text);
});

test('a run of openers is still a closed turn', () => {
  assert.equal(cheap('hey ok thanks'), true);
});

test('an opener in front of arithmetic stays cheap', () => {
  assert.equal(cheap('ok what is 2x3'), true);
  assert.equal(cheap('thanks, whats 15% of 80'), true);
});
