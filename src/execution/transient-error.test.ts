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
import { isAuthRecoverableError, isTransientStepError, isUnparseableToolCallError } from './transient-error.js';

test('isUnparseableToolCallError: parse-failure is FALLOVER-eligible but NOT same-model retryable', () => {
  const pf = new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed).");
  // It is a parse-failure → fall over to a DIFFERENT brain…
  assert.equal(isUnparseableToolCallError(pf), true);
  // …but it is NOT transient (so it never triggers a wasteful same-model retry).
  assert.equal(isTransientStepError(pf), false);
  // A plain overload is the opposite: transient-retryable, not a parse failure.
  assert.equal(isUnparseableToolCallError(new Error('API Error: 529 Overloaded')), false);
  // A deterministic error is neither.
  assert.equal(isUnparseableToolCallError(new Error('missing required field actorId')), false);
});

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

test('isAuthRecoverableError catches exactly what isTransientStepError MISSES — the fallback gap (2026-07-20)', () => {
  // The bug: an expired Claude token is a 401 — which isTransientStepError
  // classifies DETERMINISTIC (not retryable), so the workflow lane hard-failed
  // instead of switching brains. Auth-expiry is recoverable by a DIFFERENT brain,
  // so it needs its own classifier — and every lane must share this one.
  const authStrings = [
    'Claude Code returned an error result: API Error: 401 Unauthorized',
    'API Error: 403 Forbidden',
    'OAuth token has expired. Please re-authenticate.',
    'invalid_grant',
    'refresh token not found or invalid',
    'the subscription has expired',
    'not authenticated',
  ];
  for (const m of authStrings) {
    assert.equal(isAuthRecoverableError(new Error(m)), true, `auth-recoverable: ${m}`);
    // The whole point: these are NOT transient, so before this classifier existed
    // the fallover gate rejected them and the step died.
    assert.equal(isTransientStepError(new Error(m)) && /401|403|expired|invalid_grant|authenticat/i.test(m), false, `not transient: ${m}`);
  }
  // Typed brain-auth errors are recognized by NAME (robust to message drift).
  assert.equal(isAuthRecoverableError(Object.assign(new Error('x'), { name: 'ClaudeAuthError' })), true);
  assert.equal(isAuthRecoverableError(Object.assign(new Error('x'), { name: 'ClaudeSdkAuthExpiredError' })), true);
  // NOT auth: an overload or a generic deterministic error must stay out.
  assert.equal(isAuthRecoverableError(new Error('API Error: 529 Overloaded')), false);
  assert.equal(isAuthRecoverableError(new Error('missing required field actorId')), false);
});
