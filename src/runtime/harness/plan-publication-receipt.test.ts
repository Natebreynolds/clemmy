import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationReviewStatus, planPublicationMessage } from './plan-publication-receipt.js';

test('publication reports only the exact candidate review, including recovery', () => {
  assert.equal(publicationReviewStatus('current', [{ planDigest: 'old', fulfills: true }]), 'unverified');
  assert.equal(publicationReviewStatus('current', [{ planDigest: 'current', fulfills: true, failedOpen: true }]), 'unverified');
  const status = publicationReviewStatus('current', [{ planDigest: 'current', fulfills: false }, { planDigest: 'old', fulfills: true }]);
  assert.equal(status, 'rejected');
  for (const recovered of [false, true]) {
    assert.match(planPublicationMessage('ready', status, recovered), /unresolved gaps/);
    assert.doesNotMatch(planPublicationMessage('ready', status, recovered), /user can Execute/);
  }
  assert.equal(publicationReviewStatus('current', [{ planDigest: 'current', fulfills: true }]), 'passed');
  assert.match(planPublicationMessage('ready', 'passed', false), /review passed/);
  assert.match(planPublicationMessage('needs_input', 'passed', false), /answer continues planning/);
});
