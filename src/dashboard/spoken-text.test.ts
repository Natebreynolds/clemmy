/**
 * Run: npx tsx --test src/dashboard/spoken-text.test.ts
 *
 * Locks the markdown→speech conversion used by the one-loop voice surface.
 * The renderer inlines a mirror of these functions; this is the tested spec.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripMarkdownForSpeech, toSpokenSentences } from './spoken-text.js';

test('strips emphasis markers but keeps the words', () => {
  assert.equal(stripMarkdownForSpeech('I **really** want _this_ done'), 'I really want this done');
});

test('links/images reduce to their text; bare URLs become "the link"', () => {
  assert.equal(stripMarkdownForSpeech('See [the docs](https://x.com/y) now'), 'See the docs now');
  assert.equal(stripMarkdownForSpeech('![logo](https://x/y.png) hi'), 'logo hi');
  assert.equal(stripMarkdownForSpeech('Go to https://example.com/page for more'), 'Go to the link for more');
});

test('drops code fences entirely, keeps inline code text', () => {
  assert.equal(stripMarkdownForSpeech('Run ```js\nconst x=1\n``` after'), 'Run after');
  assert.equal(stripMarkdownForSpeech('Use `npm test` here'), 'Use npm test here');
});

test('strips headings, blockquotes, and list bullets at line starts', () => {
  assert.equal(stripMarkdownForSpeech('## Title\n- one\n- two'), 'Title one two');
  assert.equal(stripMarkdownForSpeech('> quoted line'), 'quoted line');
  assert.equal(stripMarkdownForSpeech('1. first\n2. second'), 'first second');
});

test('toSpokenSentences splits on sentence boundaries', () => {
  assert.deepEqual(
    toSpokenSentences('I pulled five accounts. Two need follow-up! Want details?'),
    ['I pulled five accounts.', 'Two need follow-up!', 'Want details?'],
  );
});

test('empty / whitespace / pure-markdown yields no sentences', () => {
  assert.deepEqual(toSpokenSentences(''), []);
  assert.deepEqual(toSpokenSentences('   '), []);
  assert.deepEqual(toSpokenSentences('```\ncode\n```'), []);
});

test('a markdown-heavy reply becomes clean speakable sentences', () => {
  const md = '**Done.** I emailed [Jane](mailto:j@x.com). Next: review the `draft`.';
  assert.deepEqual(
    toSpokenSentences(md),
    ['Done.', 'I emailed Jane.', 'Next: review the draft.'],
  );
});
