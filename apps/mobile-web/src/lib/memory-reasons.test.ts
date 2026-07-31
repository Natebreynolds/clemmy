import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeReasons } from './memory-reasons';

// The recall engine describes itself in instrumentation terms. Shipping those
// strings to a phone unchanged is the regression this guards: the screen is
// meant to tell you why something surfaced, not to show you the scorer.
test('recall reasons read as language, not instrumentation', () => {
  const out = humanizeReasons(['semantic similarity 0.82', 'lexical relevance 0.44', 'source-backed']);
  assert.deepEqual(out, ['related meaning', 'matching words', 'source-backed']);
  for (const chip of out) assert.doesNotMatch(chip, /[0-9]/, 'no raw scores may reach the UI');
});

test('weak signals are dropped rather than dressed up', () => {
  // A 0.06 lexical match is noise. Calling it "matching words" would be a
  // small lie, and small lies about relevance are why people stop trusting
  // search.
  assert.deepEqual(humanizeReasons(['lexical relevance 0.06']), []);
  assert.deepEqual(humanizeReasons(['semantic similarity 0.90', 'lexical relevance 0.02']), ['related meaning']);
});

test('unrecognised reasons survive, minus any trailing score', () => {
  // The engine may add reasons we have not seen; dropping them silently would
  // hide real explanation, so the fallback keeps the label.
  assert.deepEqual(humanizeReasons(['graph neighbour 0.71']), ['graph neighbour']);
  assert.deepEqual(humanizeReasons(undefined), []);
  assert.deepEqual(humanizeReasons([]), []);
});

test('duplicates collapse and the list stays short', () => {
  const out = humanizeReasons([
    'semantic similarity 0.80', 'semantic similarity 0.60',
    'lexical relevance 0.50', 'source-backed', 'graph neighbour', 'pinned',
  ]);
  assert.deepEqual(out, ['related meaning', 'matching words', 'source-backed']);
});
