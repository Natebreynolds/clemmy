/**
 * Run: npx tsx --test src/execution/transient-error.test.ts
 *
 * Locks the transient-vs-deterministic classification — especially the
 * provider-overload cases (Claude Code / Codex surface "API Error: 529
 * Overloaded" as a plain Error with the status in the MESSAGE, not as
 * err.status), which previously fell through as non-transient and made a
 * 529 dead-end a workflow step instead of retrying.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientStepError } from './transient-error.js';

test('provider overloads surfaced in the message are transient (the 529 regression)', () => {
  // The exact strings from the two failed scheduled runs.
  assert.equal(isTransientStepError(new Error('Claude Code returned an error result: API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.')), true);
  assert.equal(isTransientStepError(new Error('Claude Code returned an error result: API Error: 500 Internal server error. This is a server-side issue, usually temporary.')), true);
  assert.equal(isTransientStepError(new Error('API Error: 503 Service Unavailable')), true);
  assert.equal(isTransientStepError(new Error('API Error: 502 Bad Gateway')), true);
});

test('infra/network errors stay transient', () => {
  for (const m of ['ETIMEDOUT', 'ECONNRESET', 'socket hang up', 'fetch failed', 'rate limit exceeded', 'gateway timeout']) {
    assert.equal(isTransientStepError(new Error(m)), true, m);
  }
  // err.status path (when a provider DOES attach a numeric status).
  assert.equal(isTransientStepError(Object.assign(new Error('boom'), { status: 529 })), true);
  assert.equal(isTransientStepError(Object.assign(new Error('boom'), { status: 503 })), true);
});

test('deterministic failures are NOT transient (no thrash)', () => {
  for (const m of [
    'waiting for approval timed out',          // contains "timed out" but is non-retryable
    'exceeded approval wait budget',
    'step output failed its contract',
    'missing required input: account_id',
    'API Error: 400 Bad Request: invalid schema',
    'API Error: 404 not found',
    'API Error: 401 unauthorized',
    'deterministic runner exited non-zero',
  ]) {
    assert.equal(isTransientStepError(new Error(m)), false, m);
  }
  assert.equal(isTransientStepError(Object.assign(new Error('bad'), { status: 400 })), false);
});

test('undici-style wrapped cause is unwrapped (bounded)', () => {
  const wrapped = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('upstream'), { code: 'ECONNRESET' }) });
  assert.equal(isTransientStepError(wrapped), true);
});
