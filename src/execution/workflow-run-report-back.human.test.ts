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
