/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/review-continuation.test.ts
 *
 * A re-review whose evidence changed in the middle sends the blocks that are
 * new or changed and names the blocks that are gone, never the whole part.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { blockChanges, evidenceBlocks } = await import('./review-continuation.js');

const artifactA = '- artifact write_file#1 (handle h1)\n  written by THIS request as its write #1; receipt digest aaaa\n  <<<PART file h1 — ALL 20 bytes>>>\nfirst revision text\n  <<<END h1>>>';
const artifactB = '- artifact write_file#2 (handle h1)\n  written by THIS request as its write #2; receipt digest bbbb\n  <<<PART file h1 — ALL 21 bytes>>>\nsecond revision text\n  <<<END h1>>>';
const read1 = 'read_file [logicalCall=c3, outcome=succeeded]: authenticated receipt; handle=rh_1';
const read2 = 'read_file [logicalCall=c5, outcome=succeeded]: authenticated receipt; handle=rh_2';
const header = 'Artifacts written by THIS request, with their current saved content:';

test('host blocks split on their own headings', () => {
  const blocks = evidenceBlocks([header, artifactA, 'Retained READ results for THIS accepted source:', read1].join('\n'));
  assert.deepEqual(blocks.map((b) => b.split('\n')[0]), [header, '- artifact write_file#1 (handle h1)', 'Retained READ results for THIS accepted source:', read1]);
});

test('a rewrite in the middle sends the new block and names the superseded one', () => {
  const first = [header, artifactA, 'Retained READ results for THIS accepted source:', read1].join('\n');
  const now = [header, '- artifact write_file#1 (handle h1) — an EARLIER revision by this same request, later superseded. Not evidence of the final state.', artifactB, 'Retained READ results for THIS accepted source:', read1, read2].join('\n');
  const message = blockChanges('the evidence', first, now);
  assert.match(message, /Changes to the evidence since your last review/);
  assert.match(message, /No longer current \(1 block/);
  assert.match(message, /- - artifact write_file#1 \(handle h1\)$/m);
  assert.match(message, /second revision text/);
  assert.match(message, /logicalCall=c5/);
  assert.doesNotMatch(message, /first revision text/);
  assert.doesNotMatch(message, /logicalCall=c3/);
  // The unchanged blocks (the header, the first read) are not repeated.
  assert.equal(message.split('\n').filter((line) => line === header).length, 0);
});

test('a part with no recognisable blocks is replaced whole', () => {
  const message = blockChanges('the coverage ledger', 'ledger v1 line', 'ledger v2 line');
  assert.match(message, /^The coverage ledger now reads \(this replaces the earlier version\):\nledger v2 line$/);
});
