/**
 * Run: npx tsx --test src/memory/recall.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFtsQuery } from './recall.js';

test('builds OR-clause from multi-token query', () => {
  const fts = buildFtsQuery('memory recall architecture');
  // Each token should appear quoted and with prefix variant.
  assert.match(fts, /"memory"/);
  assert.match(fts, /memory\*/);
  assert.match(fts, /"recall"/);
  assert.match(fts, /recall\*/);
  assert.match(fts, /"architecture"/);
  assert.match(fts, /architecture\*/);
  // Clauses joined by OR.
  assert.match(fts, / OR /);
});

test('returns empty string for empty / single-char input', () => {
  assert.equal(buildFtsQuery(''), '');
  assert.equal(buildFtsQuery('a'), '');
  assert.equal(buildFtsQuery('   '), '');
});

test('dedups repeated tokens', () => {
  const fts = buildFtsQuery('clemmy clemmy clemmy');
  // Should appear at most once each in quoted and prefix forms.
  const quoted = (fts.match(/"clemmy"/g) ?? []).length;
  const prefix = (fts.match(/clemmy\*/g) ?? []).length;
  assert.equal(quoted, 1, 'quoted clemmy should appear once');
  assert.equal(prefix, 1, 'prefix clemmy should appear once');
});

test('strips FTS5-reserved characters from tokens', () => {
  // FTS5 syntax chars in input — we tokenize on non-alphanumerics so they vanish.
  const fts = buildFtsQuery('memory "fts" * (recall)');
  // Output should not include raw quote/paren/asterisk-as-syntax in dangerous places.
  // The tokenizer keeps memory, fts, recall.
  assert.match(fts, /"memory"/);
  assert.match(fts, /"fts"/);
  assert.match(fts, /"recall"/);
  // No bare parens or unmatched quotes.
  assert.equal(fts.split('"').length % 2, 1, 'balanced quote count');
});

test('lower-cases input tokens', () => {
  const fts = buildFtsQuery('MEMORY Recall ARCHITECTURE');
  assert.match(fts, /"memory"/);
  assert.match(fts, /"recall"/);
  assert.match(fts, /"architecture"/);
  assert.doesNotMatch(fts, /"MEMORY"/);
});

test('drops tokens shorter than 2 chars', () => {
  const fts = buildFtsQuery('a bb ccc');
  assert.doesNotMatch(fts, /"a"/);
  assert.match(fts, /"bb"/);
  assert.match(fts, /"ccc"/);
});

test('handles underscores in tokens (e.g. snake_case identifiers)', () => {
  const fts = buildFtsQuery('memory_search user_id');
  // Underscores survive the non-alphanumeric split because we allow [a-z0-9_].
  assert.match(fts, /"memory_search"/);
  assert.match(fts, /"user_id"/);
});
