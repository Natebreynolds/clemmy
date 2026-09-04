import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveResultHandleFactsFromRaw } from './result-facts.js';

// Live 2026-09-04: three DataForSEO calls returned real records. This deriver
// said success=false (20000 >= 400) while the settlement independently called
// the same bytes a successful provider result. The disagreement threw
// "successful provider result did not produce redeemable result authority",
// rolled back the transaction, and the model was told the tool errored — so the
// SEO leg produced nothing and the Outlook drafts were never written.
const dataForSeoOk = {
  version: '0.1.20240801', status_code: 20000, status_message: 'Ok.',
  cost: 0.002, tasks_count: 1, tasks_error: 0,
  tasks: [{ id: '0904', status_code: 20000, status_message: 'Ok.',
    result: [{ target: 'example.com', rank: 412, backlinks: 1873 }] }],
};

test('a provider success code outside the HTTP range is not read as an HTTP failure', () => {
  const facts = deriveResultHandleFactsFromRaw(dataForSeoOk);
  assert.equal(facts.statusCode, 20000, 'the code is still surfaced');
  assert.equal(facts.success, true, '20000 is not an HTTP status and must not fail the >= 400 test');
  assert.ok(facts.recordCount >= 1, 'the records must survive');
});

// The other direction matters just as much: before the fix BOTH 20000 and 40501
// were false, so the heuristic gave this provider zero discrimination. A
// non-HTTP code must not be laundered into a pass.
test('an out-of-range code with no records and no success key stays unsuccessful', () => {
  const facts = deriveResultHandleFactsFromRaw({ status_code: 40501, status_message: 'Invalid Field' });
  assert.equal(facts.success, false, 'a provider error must not become a success');
});

test('real HTTP statuses are unchanged in both directions', () => {
  assert.equal(deriveResultHandleFactsFromRaw({ status: 404, error: 'not found' }).success, false);
  assert.equal(deriveResultHandleFactsFromRaw({ status: 500 }).success, false);
  assert.equal(deriveResultHandleFactsFromRaw({ status: 200, data: [{ a: 1 }] }).success, true);
});

test('an explicit success key still outranks an out-of-range code', () => {
  assert.equal(deriveResultHandleFactsFromRaw({ status_code: 99999, successful: false }).success, false);
  assert.equal(deriveResultHandleFactsFromRaw({ status_code: 99999, successful: true }).success, true);
  assert.equal(deriveResultHandleFactsFromRaw({ successful: true, data: [{ a: 1 }] }).success, true);
});
