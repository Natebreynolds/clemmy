import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  modelInteractivePreActionableMs,
  modelStreamStallRetries,
} from './model-stall-policy.js';

const ORIGINAL = process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES;
const ORIGINAL_PRE_ACTIONABLE = process.env.CLEMMY_MODEL_INTERACTIVE_PRE_ACTIONABLE_MS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES;
  else process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES = ORIGINAL;
  if (ORIGINAL_PRE_ACTIONABLE === undefined) delete process.env.CLEMMY_MODEL_INTERACTIVE_PRE_ACTIONABLE_MS;
  else process.env.CLEMMY_MODEL_INTERACTIVE_PRE_ACTIONABLE_MS = ORIGINAL_PRE_ACTIONABLE;
});

test('the absolute pre-actionable wall is OFF by default; an explicit value arms it', () => {
  // Live 2026-09-02: the 60 s default declared the owner's chosen reasoning
  // brain 'unavailable' mid-think and benched it for the run.
  delete process.env.CLEMMY_MODEL_INTERACTIVE_PRE_ACTIONABLE_MS;
  assert.equal(modelInteractivePreActionableMs(), 0);

  process.env.CLEMMY_MODEL_INTERACTIVE_PRE_ACTIONABLE_MS = '1250';
  assert.equal(modelInteractivePreActionableMs(), 1_250);

  process.env.CLEMMY_MODEL_INTERACTIVE_PRE_ACTIONABLE_MS = 'off';
  assert.equal(modelInteractivePreActionableMs(), 0, 'invalid configuration fails to off');

  process.env.CLEMMY_MODEL_INTERACTIVE_PRE_ACTIONABLE_MS = '0';
  assert.equal(modelInteractivePreActionableMs(), 0, 'zero remains an explicit diagnostic kill-switch');
});

test('ordinary foreground stalls get exactly one clean pre-content retry by default', () => {
  delete process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES;
  assert.equal(modelStreamStallRetries(), 1);
});

test('an explicit diagnostic retry budget remains bounded and invalid values fail to one', () => {
  process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES = '3';
  assert.equal(modelStreamStallRetries(), 3);

  process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES = '-1';
  assert.equal(modelStreamStallRetries(), 1);

  process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES = 'not-a-number';
  assert.equal(modelStreamStallRetries(), 1);
});
