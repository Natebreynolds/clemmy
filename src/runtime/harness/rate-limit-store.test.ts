/**
 * Run: npx tsx --test src/runtime/harness/rate-limit-store.test.ts
 *
 * The rate-limit store parses provider rate-limit response headers into the
 * normalized 5h/weekly quota snapshot the top-bar chips render — and, crucially,
 * a call with NO quota headers preserves the last-known snapshot (Codex drops its
 * x-codex-* headers intermittently on streaming responses, and a chip must never
 * blank to "unknown" mid-session).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Keep the store in-memory (no disk write to the operator's live state file).
process.env.NODE_ENV = 'test';
const {
  recordCodexRateLimit,
  getRateLimitSnapshot,
  __resetRateLimitStoreForTests,
} = await import('./rate-limit-store.js');

test('Codex: primary→5h, secondary→weekly; reset-after-seconds → absolute resetAt', () => {
  __resetRateLimitStoreForTests();
  const before = Date.now();
  recordCodexRateLimit({
    'x-codex-primary-used-percent': '42',
    'x-codex-primary-reset-after-seconds': '3600',
    'x-codex-primary-window-minutes': '300',
    'x-codex-secondary-used-percent': '18',
    'x-codex-secondary-reset-after-seconds': '604800',
  });
  const { codex } = getRateLimitSnapshot();
  assert.equal(codex?.primary?.usedPercent, 42);
  assert.equal(codex?.secondary?.usedPercent, 18);
  assert.equal(codex?.primary?.windowMinutes, 300);
  // resetAt is now + 3600s, in ms, within a small tolerance.
  assert.ok((codex?.primary?.resetAt ?? 0) >= before + 3600_000 - 2000);
  assert.ok((codex?.primary?.resetAt ?? 0) <= Date.now() + 3600_000 + 2000);
});

test('Codex: a call with NO x-codex-* headers preserves the last-known snapshot (streaming drop)', () => {
  __resetRateLimitStoreForTests();
  recordCodexRateLimit({ 'x-codex-primary-used-percent': '55', 'x-codex-secondary-used-percent': '20' });
  recordCodexRateLimit({ 'openai-request-id': 'req_123' }); // unrelated headers only
  const { codex } = getRateLimitSnapshot();
  assert.equal(codex?.primary?.usedPercent, 55, 'kept last-known instead of blanking');
  assert.equal(codex?.secondary?.usedPercent, 20);
});

test('works with a real Headers object (not just a plain record)', () => {
  __resetRateLimitStoreForTests();
  const h = new Headers();
  h.set('x-codex-primary-used-percent', '90');
  h.set('x-codex-secondary-used-percent', '12');
  recordCodexRateLimit(h);
  assert.equal(getRateLimitSnapshot().codex?.primary?.usedPercent, 90);
});

test('percentages clamp to 0–100 and round', () => {
  __resetRateLimitStoreForTests();
  recordCodexRateLimit({ 'x-codex-primary-used-percent': '142.6', 'x-codex-secondary-used-percent': '-5' });
  const { codex } = getRateLimitSnapshot();
  assert.equal(codex?.primary?.usedPercent, 100);
  assert.equal(codex?.secondary?.usedPercent, 0);
});

test('malformed headers never throw (best-effort capture)', () => {
  __resetRateLimitStoreForTests();
  assert.doesNotThrow(() => recordCodexRateLimit(undefined as unknown as Record<string, string>));
  assert.doesNotThrow(() => recordCodexRateLimit({ 'x-codex-primary-used-percent': 'not-a-number' }));
  // nothing parseable → snapshot stays empty, no crash
  assert.equal(getRateLimitSnapshot().codex, undefined);
});
