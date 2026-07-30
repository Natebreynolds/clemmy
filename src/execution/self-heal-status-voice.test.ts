import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowRunnerInternalsForTest } from './workflow-runner.js';

/**
 * Regression pin for the model-voice rule (2026-07-24, binding): harness-authored
 * status text delivered to the user must NOT ventriloquize Clem's first-person
 * voice. The self-heal notification body runs in daemon post-run processing with
 * no model in the loop, so it is DATA — a neutral statement of the automatic
 * action — and the fresh run's own report-back owns the authored voice.
 *
 * Before this pin the body read "I auto-applied a fix … It's running in the
 * background and will report back here". These assertions exercise the real
 * render helpers (not a mock) so the first-person shape cannot return unnoticed.
 */
const { renderSelfHealRequeuedStatus, renderSelfHealRequeueFailedStatus } =
  workflowRunnerInternalsForTest;

// A first-person subject pronoun as a whole word, or the exact cosplay phrases
// the old strings used. Deliberately not matching "It"/"its" (neutral) — only
// Clem speaking as herself.
const FIRST_PERSON_VOICE = /\bI\b|\bI'(?:ve|ll|m)\b|\bmy\b|\bme\b|I auto-applied|It's running/;

const fix = { stepId: 'draft-email', description: 'widened the column read to A:H' };

test('self-heal requeued status states the facts without first-person voice', () => {
  const status = renderSelfHealRequeuedStatus(fix, 2, 3);
  assert.doesNotMatch(status, FIRST_PERSON_VOICE);
  // Facts preserved: which step, which fix, which attempt.
  assert.match(status, /draft-email/);
  assert.match(status, /widened the column read to A:H/);
  assert.match(status, /attempt 2 of 3/);
});

test('self-heal requeue-failed status states the blocker without first-person voice', () => {
  const status = renderSelfHealRequeueFailedStatus(fix, 'the queue was full');
  assert.doesNotMatch(status, FIRST_PERSON_VOICE);
  assert.match(status, /draft-email/);
  assert.match(status, /widened the column read to A:H/);
  assert.match(status, /the queue was full/);
});
