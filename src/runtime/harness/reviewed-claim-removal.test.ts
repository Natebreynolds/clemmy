/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/reviewed-claim-removal.test.ts
 *
 * Live 2026-09-24/25: an answer was delivered "blocked" still containing the
 * figures its reviewer flagged. The host deletes exactly what the reviewer
 * quoted, and nothing else.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { removeReviewedClaims, reviewQuotes } from './reviewed-claim-removal.js';

const reply = [
  'Here is the snapshot for the firm.',
  '',
  'Organic traffic is about 1,200 visits a month. Revenue grew 40% this year. The site ranks for 180 keywords.',
  '',
  '- Top keyword: "family lawyer" at position 6',
  '- All three offices confirmed the new hours',
  '',
  'Next I can draft the outreach email.',
].join('\n');

test('only the sentences and list lines carrying the reviewer\'s quotes are removed, and the answer says so', () => {
  const reason = '(1) "Revenue grew 40% this year" — the report shows 14%; (2) “All three offices confirmed” — only two replied';
  assert.deepEqual(reviewQuotes(reason), ['Revenue grew 40% this year', 'All three offices confirmed']);
  const removed = removeReviewedClaims(reply, reason);
  assert.ok(removed);
  const body = removed.text.slice(0, removed.text.indexOf('\n\n_I took out'));
  assert.doesNotMatch(body, /Revenue grew 40%/);
  assert.doesNotMatch(body, /All three offices/);
  assert.match(removed.text, /Organic traffic is about 1,200 visits a month\. The site ranks for 180 keywords\./, 'the rest of the paragraph is untouched');
  assert.match(removed.text, /- Top keyword: "family lawyer" at position 6/);
  assert.match(removed.text, /Next I can draft the outreach email\./);
  assert.match(removed.text, /I took out 2 claims the review could not verify: “Revenue grew 40% this year”; “All three offices confirmed”\._$/);
});

test('a quote not found verbatim, no quotes, or removing most of the answer removes nothing', () => {
  assert.equal(removeReviewedClaims(reply, '(1) "revenue grew forty percent" — the report shows 14%'), null);
  assert.equal(removeReviewedClaims(reply, 'the figures do not match the report'), null);
  const short = 'Revenue grew 40% this year. Thanks!';
  assert.equal(removeReviewedClaims(short, '(1) "Revenue grew 40% this year" — wrong'), null);
});
