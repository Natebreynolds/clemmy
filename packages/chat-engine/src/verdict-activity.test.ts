import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceActivity } from './reduce-activity.js';
import type { ActivityItem, HarnessEvent } from './types.js';

const verdict = (data: Record<string, unknown>): HarnessEvent =>
  ({ seq: 1, type: 'verdict_recorded', data });

const row = (data: Record<string, unknown>): ActivityItem =>
  reduceActivity([], verdict(data))[0];

test('a passing verdict shows its scorecard and settles clean', () => {
  const r = row({ door: 'completion', pass: true, criteriaMet: 4, criteriaTotal: 4 });
  assert.equal(r.label, 'Verdict · completion 4/4: passed');
  assert.equal(r.status, 'done');
  assert.equal(r.tone, undefined);
});

test('a rejection is a failed check and keeps the reviewer’s reason', () => {
  const r = row({ door: 'completion', pass: false, criteriaMet: 2, criteriaTotal: 4, reason: 'Two accounts were never checked.' });
  assert.equal(r.label, 'Verdict · completion 2/4: not passed');
  assert.equal(r.status, 'failed');
  assert.equal(r.detail, 'Two accounts were never checked.');
});

test('a failed-open verdict reads as unverified, not as a rejection', () => {
  // The regression: "the reviewer said no" and "there was no reviewer" both
  // rendered as a failed check, so an unchecked answer looked rejected and a
  // real rejection looked routine.
  const r = row({ door: 'completion', pass: false, failedOpen: true });
  assert.equal(r.label, 'Verdict · completion: accepted without review');
  assert.equal(r.status, 'done', 'an absent reviewer did not fail the work');
  assert.equal(r.tone, 'warning', 'but it is not a clean pass either');
  assert.match(r.detail ?? '', /not checked/);
});

test('a failed-open verdict never renders as a plain pass', () => {
  const r = row({ door: 'completion', pass: true, failedOpen: true });
  assert.equal(r.label, 'Verdict · completion: accepted without review');
  assert.equal(r.tone, 'warning');
});
