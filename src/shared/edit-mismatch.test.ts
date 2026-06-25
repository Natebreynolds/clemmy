/**
 * Run: npx tsx --test src/shared/edit-mismatch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mismatchHint } from './edit-mismatch.js';

test('empty find → null (nothing to match)', () => {
  assert.equal(mismatchHint('hello world', ''), null);
});

test('fully-present find → null (not a real miss)', () => {
  assert.equal(mismatchHint('const x = 1;', 'x = 1'), null);
});

test('partial prefix divergence pinpoints matchedChars + both sides', () => {
  // haystack has "foo  bar" (two spaces); find has "foo bar" (one space).
  const hint = mismatchHint('foo  bar', 'foo bar');
  assert.ok(hint);
  assert.equal(hint.matchedChars, 4); // "foo " (the first space matches one of the two)
  // findHad shows what diverged in the find; haystackHad shows the view side.
  assert.equal(hint.findHad, JSON.stringify('bar'));
  assert.equal(hint.haystackHad, JSON.stringify(' bar'));
});

test('tab-vs-space divergence is made visible via JSON quoting', () => {
  const hint = mismatchHint('a\tb', 'a b');
  assert.ok(hint);
  assert.equal(hint.matchedChars, 1);
  assert.equal(hint.findHad, JSON.stringify(' b'));
  assert.equal(hint.haystackHad, JSON.stringify('\tb'));
});

test('no shared prefix at all → matchedChars 0', () => {
  const hint = mismatchHint('zzz', 'abc');
  assert.ok(hint);
  assert.equal(hint.matchedChars, 0);
});
