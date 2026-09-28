import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectReviewVerdict } from './score-turn-rounds.mts';

test('failed-open completion is unreviewed even when the delivery verdict says fulfills', () => {
  const verdict = projectReviewVerdict(316547, { kind: 'completion', fulfills: true, failedOpen: true, reviewFailure: 'timeout' });
  assert.equal(verdict.fulfills, null);
  assert.equal(verdict.reportedFulfills, true);
  assert.equal(verdict.failedOpen, true);
  assert.equal(verdict.reviewFailure, 'timeout');
  assert.equal(projectReviewVerdict(1, { fulfills: true }).fulfills, true);
  assert.equal(projectReviewVerdict(2, { fulfills: false }).fulfills, false);
  assert.equal(projectReviewVerdict(3, { fulfills: false, carriedVerdict: true }).carriedVerdict, true);
});
