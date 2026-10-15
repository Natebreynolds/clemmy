import assert from 'node:assert/strict';
import test from 'node:test';
process.env.NODE_ENV = 'test';
const { humanReportDetail } = await import('./workflow-run-report-back.js');

test('a report-back handed over as a JSON message envelope is read for its message', () => {
  const detail = JSON.stringify({ message: 'Hey Nate — the inbox review found 40 messages, including one that needs a reply.' });
  const out = humanReportDetail(detail);
  assert.doesNotMatch(out, /^\s*\{/, 'no braces reach the person');
  assert.match(out, /Hey Nate — the inbox review found 40 messages/);
});

test('prose, arrays and malformed JSON pass through untouched', () => {
  assert.equal(humanReportDetail('Hey Nate — done.'), 'Hey Nate — done.');
  assert.equal(humanReportDetail('[1,2]'), '[1,2]');
  assert.equal(humanReportDetail('{not json'), '{not json');
  assert.equal(humanReportDetail(''), '');
});

test('a write tool\'s machine receipt is the host\'s evidence; the report keeps the sentence that says what was written', () => {
  const detail = [
    'Committed file at notes/out.md (69 chars). [clementine:host-local-write-commit:v1] {"version":1,"createdId":"file-1","handle":"state/local-file-revisions/1/current.json","contentDigest":"abc"}',
    'artifactId: local-file-receipt:v1:W2NsZW1lbnRpbmU6',
    'handle: state/local-file-revisions/1/current.json',
    'contentDigest: abc',
    'receipt: [clementine:host-local-write-commit:v1] {"version":1,"createdId":"file-1"}',
    'path: notes/out.md',
    '',
    'Why this needs a look: target not confirmed.',
  ].join('\n');
  const out = humanReportDetail(detail);
  assert.doesNotMatch(out, /clementine:host-local-write-commit|artifactId|contentDigest|createdId/);
  assert.match(out, /^Committed file at notes\/out\.md \(69 chars\)\./);
  assert.match(out, /path: notes\/out\.md/);
  assert.match(out, /Why this needs a look: target not confirmed\./);
});
