/**
 * An unclassified thrown error on a HOST-PROVEN read is transient, never inert.
 *
 * Live 2026-09-08 08:00 PT: the daily-standup-email workflow blocked at its
 * first step with "The tool stopped after execution may have begun. I
 * preserved the call as uncertain and blocked replay" — for a non-mutating
 * outlook_list_events read whose thrown text matched no classifier rule.
 * Nothing irreversible can follow from a failed read; the model must be
 * allowed a bounded retry. A mutating or unproven call keeps the inert stop,
 * and a CALLER abort still holds without another model step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAttemptOutcome, recoveryDirectiveFor } from './attempt-outcome.js';

test('an unclassified thrown text on a proven read is transient and retried with backoff', () => {
  const out = classifyAttemptOutcome({ mutating: false, text: 'request stalled after 60000ms' } as never);
  assert.equal(out.kind, 'transient');
  assert.equal(recoveryDirectiveFor(out.kind).action, 'retry_with_backoff');
});

test('the same text on a mutating or unproven call stays inert', () => {
  assert.equal(classifyAttemptOutcome({ mutating: true, text: 'request stalled after 60000ms' } as never).kind, 'unknown');
  assert.equal(classifyAttemptOutcome({ text: 'request stalled after 60000ms' } as never).kind, 'unknown');
});

test('a caller abort after invocation still holds, read or not', () => {
  assert.equal(classifyAttemptOutcome({ cancelled: true, mutating: false } as never).kind, 'unknown');
  assert.equal(classifyAttemptOutcome({ cancelled: true, mutating: true } as never).kind, 'uncertain_write');
});
