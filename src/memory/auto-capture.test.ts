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
