import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { reviewedClaimsRevision } from './reviewed-claims-revision.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const original = 'Kernel is selected. Both providers are connected with live credentials. The audit is included below.';
function revision(scope: 'claims' | 'reply_format', quotes: string[], reply: string) {
  return reviewedClaimsRevision({ feedback: { repairScope: scope, quotes, replyDigest: hash(original) },
    reply, replyDigest: hash(reply), stakes: 'read', settledCount: 0 });
}

test('removing a quoted substring cannot qualify a paraphrase of the same unsupported claim', () => {
  assert.equal(revision('claims', ['connected with live credentials'],
    'Kernel is selected. Both providers have live authenticated connections. The audit is included below.'), null);
});

test('removing a quoted claim cannot qualify new unrelated claims', () => {
  assert.equal(revision('claims', ['connected with live credentials'],
    'Kernel is selected. The customer approved every invoice and all messages were sent.'), null);
});

test('deleting quoted claims cannot prove the remaining response still contains every deliverable', () => {
  assert.equal(revision('claims', ['connected with live credentials'], 'Kernel is selected.'), null);
});

test('a quote in format feedback may be a rejected example rather than a qualified replacement', () => {
  assert.equal(revision('reply_format', ['All providers passed their live connection tests.'],
    'All providers passed their live connection tests.'), null);
});

test('a quoted replacement is not proof of unchanged whole-objective substance', () => {
  assert.equal(revision('reply_format', ['Kernel selected; credentials configured.'],
    'Kernel selected; credentials configured.'), null);
});

test('quote-only feedback cannot certify even a mechanical whitespace edit without whole-objective qualification', () => {
  const draft = '  Kernel is selected.  ';
  assert.equal(reviewedClaimsRevision({ feedback: { repairScope: 'reply_format', quotes: ['Kernel is selected.'],
    replyDigest: hash(draft) }, reply: draft.trim(), replyDigest: hash(draft.trim()), stakes: 'read', settledCount: 0 }), null);
});
