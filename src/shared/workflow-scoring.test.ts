/**
 * Run: npx tsx --test src/shared/workflow-scoring.test.ts
 *
 * Canonical tokenizer/stemmer. The matchers that consume it
 * (workflow-resolve, context-packet) have their own
 * 39 tests that act as the characterization safety net; these pin the
 * primitive itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, stemToken } from './workflow-scoring.js';

test('tokenize: lowercases, splits on non-alphanumeric, drops short tokens', () => {
  assert.deepEqual(tokenize('Morning Prospect Prep!'), ['morning', 'prospect', 'prep']);
  assert.deepEqual(tokenize('a to of in'), []); // all < 3 chars
});

test('tokenize: drops stopwords (caller policy)', () => {
  assert.deepEqual(
    tokenize('run my email flow', { stopwords: new Set(['run', 'my', 'flow']) }),
    ['email'],
  );
});

test('tokenize: minLen is configurable (run-guard uses 4)', () => {
  assert.deepEqual(tokenize('seo abc test', { minLen: 4 }), ['test']);
});

test('tokenize: stem=true stems and re-checks length/stopword on the stem', () => {
  assert.deepEqual(tokenize('prospecting leads', { stem: true }), ['prospect', 'lead']);
  // a token whose stem becomes a stopword is dropped
  assert.deepEqual(tokenize('runs', { stem: true, stopwords: new Set(['run']) }), []);
});

test('tokenize: handles empty / null-ish input', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(undefined as unknown as string), []);
});

test('stemToken: matches the original light stemmer', () => {
  assert.equal(stemToken('running'), 'runn');
  assert.equal(stemToken('audited'), 'audit');
  assert.equal(stemToken('batches'), 'batch');
  assert.equal(stemToken('leads'), 'lead');
  assert.equal(stemToken('ss'), 'ss');      // too short, untouched
  assert.equal(stemToken('boss'), 'boss');  // -ss not stripped
});
