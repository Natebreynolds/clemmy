import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAutoMemoryCandidates, extractProfilePatchFromMessage } from './auto-capture.js';

test('extractAutoMemoryCandidates captures Clementine product requirements', () => {
  const candidates = extractAutoMemoryCandidates(
    'I want Clementine to be a proactive autonomous agent with persistent memory and Discord workflows.',
  );

  assert.equal(candidates[0]?.kind, 'project');
  assert.match(candidates[0]?.content ?? '', /Clementine requirement/i);
  assert.match(candidates[0]?.content ?? '', /persistent memory/i);
});

test('extractAutoMemoryCandidates captures standing chat feedback', () => {
  const candidates = extractAutoMemoryCandidates(
    'I do not like generic working on it messages in Discord; I would rather see typing and tool streaming.',
  );

  assert.equal(candidates[0]?.kind, 'feedback');
  assert.match(candidates[0]?.content ?? '', /tool streaming/i);
});

test('extractAutoMemoryCandidates ignores low signal approvals', () => {
  assert.deepEqual(extractAutoMemoryCandidates('approve'), []);
  assert.deepEqual(extractAutoMemoryCandidates("let's do it"), []);
});

test('extractAutoMemoryCandidates avoids duplicate explicit remember facts', () => {
  const candidates = extractAutoMemoryCandidates(
    'Remember that Clementine should show typing and tool streaming in Discord.',
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.kind, 'project');
});

test('extractAutoMemoryCandidates keeps explicit remember for personal facts', () => {
  const candidates = extractAutoMemoryCandidates('Remember that my preferred contract reviewer is Sarah.');

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.kind, 'user');
});

test('extractProfilePatchFromMessage captures explicit communication preferences', () => {
  const patch = extractProfilePatchFromMessage('Call me Nate. Keep it concise and no preamble.');

  assert.equal(patch?.preferredName, 'Nate');
  assert.equal(patch?.communicationTone, 'terse');
});

test('extractProfilePatchFromMessage captures urgency tolerance', () => {
  assert.equal(extractProfilePatchFromMessage('This is too noisy, notify sparingly.')?.urgencyTolerance, 'low');
  assert.equal(extractProfilePatchFromMessage('Keep me updated with proactive check-ins.')?.urgencyTolerance, 'high');
});

// ---- #5: broadened capture (no longer dropped) ----

test('captures "remember to ..." (was dropped by the narrow regex)', () => {
  const c = extractAutoMemoryCandidates('Remember to call the vendor on Friday about the renewal.');
  assert.equal(c.length, 1);
  assert.match(c[0].content, /remember/i);
  assert.match(c[0].content, /vendor/i);
});

test('captures "note that ..." / "don\'t forget ..." store requests', () => {
  assert.equal(extractAutoMemoryCandidates('Note that the board meeting moved to the 14th.').length, 1);
  assert.equal(extractAutoMemoryCandidates("Don't forget the renewal is due end of month.").length, 1);
});

test('declarative fallback captures an un-cued durable fact', () => {
  const c = extractAutoMemoryCandidates('My CFO is Dana Wilson and she approves all spend over 5k.');
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'user');
  assert.match(c[0].content, /Dana Wilson/);
});

test('declarative fallback ignores questions and imperative tasks', () => {
  assert.deepEqual(extractAutoMemoryCandidates('What is my current Salesforce pipeline total?'), []);
  assert.deepEqual(extractAutoMemoryCandidates('Send the quarterly report to the leadership team today.'), []);
});

test('a "do you remember ..." question is not treated as a store request', () => {
  assert.deepEqual(extractAutoMemoryCandidates('Do you remember what we decided about pricing?'), []);
});

// ─── Standing-rule capture (the gap FEEDBACK_CUES + declarative fallback miss) ──

test('standing rule with a named resource is captured as a durable feedback fact', () => {
  const c = extractAutoMemoryCandidates(
    'Going forward, send the weekly digest to this sheet: https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD/edit',
  );
  assert.equal(c.length, 1, 'a gap-marker standing rule is captured (dropped entirely today)');
  assert.equal(c[0].kind, 'feedback');
  assert.match(c[0].content, /^Standing instruction:/);
  assert.match(c[0].content, /1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD/);
});

test('standing rule with recipient emails is captured', () => {
  const c = extractAutoMemoryCandidates('Every Monday, send the digest to alice@x.com and bob@y.com');
  assert.equal(c.length, 1);
  assert.match(c[0].content, /^Standing instruction:/);
  assert.match(c[0].content, /alice@x\.com/);
});

test('standing rule "by default use this list" phrasing is captured', () => {
  const c = extractAutoMemoryCandidates('By default, send my newsletter to the marketing list.');
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'feedback');
});

test('standing MARKER without a concrete target is NOT captured (false-positive guard)', () => {
  assert.deepEqual(extractAutoMemoryCandidates('Going forward be careful with the data.'), []);
  assert.deepEqual(extractAutoMemoryCandidates('Every Monday I try to plan the week.'), []);
});

test('a one-off imperative (no standing marker) is still NOT routed to a fact', () => {
  assert.deepEqual(extractAutoMemoryCandidates('Just send it to the usual list this once.'), []);
  // byte-identical regression guard: the pre-existing imperative-task case stays []
  assert.deepEqual(extractAutoMemoryCandidates('Send the quarterly report to the leadership team today.'), []);
});

test('"always"/"from now on" still route through FEEDBACK_CUES, not the standing branch (byte-identical)', () => {
  // These already matched FEEDBACK_CUES before this change; the gap branch is
  // length-gated so it must NOT add a second "Standing instruction:" candidate.
  const c = extractAutoMemoryCandidates('From now on, send the report to the board distro.');
  assert.ok(c.length >= 1);
  assert.ok(!c.some((cand) => cand.content.startsWith('Standing instruction:')), 'no duplicate standing-branch row');
});

// ─── safety-critical prohibitions are auto-pinned ─────────────────────────────

test('a "never <action>" prohibition is captured and marked pin=true', () => {
  const c = extractAutoMemoryCandidates('Never email the test list.');
  assert.equal(c.length, 1);
  assert.equal(c[0].pin, true, 'safety-critical prohibition is pinned');
});

test('a "do not <action>" prohibition the cues miss is captured as a pinned standing rule', () => {
  const c = extractAutoMemoryCandidates('Do not send anything to the prod distro.');
  assert.equal(c.length, 1);
  assert.match(c[0].content, /^Standing prohibition:/);
  assert.equal(c[0].pin, true);
});

test('an ordinary preference is captured but NOT pinned', () => {
  const c = extractAutoMemoryCandidates('I prefer concise, no-preamble replies.');
  assert.ok(c.length >= 1);
  assert.ok(!c[0].pin, 'a non-prohibition preference is not auto-pinned');
});

test('"never mind" and one-off / non-action negatives are NOT pinned prohibitions', () => {
  // idiom, no action verb
  assert.ok(!extractAutoMemoryCandidates('never mind, forget it').some((x) => x.pin));
  // negative but no comms/mutating action verb
  assert.ok(!extractAutoMemoryCandidates('do not worry about the deadline').some((x) => x.pin));
  // explicit one-off → not a durable prohibition
  assert.ok(!extractAutoMemoryCandidates('do not send that one this time').some((x) => x.pin));
});
