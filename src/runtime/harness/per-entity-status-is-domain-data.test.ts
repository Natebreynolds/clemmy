import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectProviderEnvelope } from './provider-read-evidence.js';
import { deriveResultHandleFactsFromRaw } from './result-facts.js';

// The exact prospects/SEO shape: one request fanned out across geos, one geo
// errored. Measured before the fix: success=false with recordCount=3 — three
// good geos discarded because a fourth failed.
const fanOut = {
  status_code: 20000, status_message: 'Ok.', tasks_count: 3, tasks_error: 1,
  tasks: [
    { id: 'a', status_code: 20000, result: [{ keyword: 'family law tampa' }] },
    { id: 'b', status_code: 20000, result: [{ keyword: 'family law miami' }] },
    { id: 'c', status_code: 40501, status_message: 'Invalid Field.', result: null },
  ],
};

test('one failed row does not condemn the rows that succeeded', () => {
  const facts = deriveResultHandleFactsFromRaw(fanOut);
  assert.equal(facts.success, true, 'the READ succeeded — a failed task is domain data');
  assert.equal(facts.recordCount, 3, 'every task must survive');
});

test('a provider in-progress code on an identified row is not a failure', () => {
  for (const code of [40601, 40602, 40603]) {
    const envelope = { status_code: 20000, tasks: [{ id: 'a', status_code: code, status_message: 'queued' }] };
    assert.equal(
      inspectProviderEnvelope(envelope).verdict,
      'clean',
      `${code} is in-progress, not an error`,
    );
  }
});

// THE REGRESSION GUARD. Dropping the 40_000-60_000 band entirely would let real
// provider errors pass as success, because a status_message alone reads clean.
// The transport verdict belongs to the ENVELOPE, which has no business identity.
test('a top-level provider error code still contradicts', () => {
  for (const code of [40501, 50000]) {
    assert.equal(
      inspectProviderEnvelope({ status_code: code }).verdict,
      'contradicted',
      `top-level ${code} is a real failure and must still be caught`,
    );
  }
  assert.equal(
    inspectProviderEnvelope({ status_message: 'Invalid Field.' }).verdict,
    'clean',
    'the message alone does NOT catch it — which is why the band must stay',
  );
});

test('real HTTP statuses are untouched', () => {
  assert.equal(inspectProviderEnvelope({ status: 503 }).verdict, 'contradicted');
  assert.equal(deriveResultHandleFactsFromRaw({ status: 500 }).success, false);
  assert.equal(inspectProviderEnvelope({ status_code: 20000, status_message: 'Ok.' }).verdict, 'clean');
});

// A bare `status` on an identified entity was already skipped; that behaviour
// must not regress while the skip is widened to every status-shaped key.
test('the original bare-status entity skip still holds', () => {
  assert.equal(
    inspectProviderEnvelope({ orders: [{ id: 'o1', status: 'failed' }] }).verdict,
    'clean',
    'a failed order is still a successful read',
  );
});
