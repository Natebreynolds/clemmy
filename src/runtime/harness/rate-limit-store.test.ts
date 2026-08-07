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
  codexQuotaExhausted,
  recordCodexUsageExhausted,
  recordCodexRateLimit,
  getRateLimitSnapshot,
  classifyCodexQuota,
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

test('classifyCodexQuota assigns slots by duration — the weekly-as-primary live shape', () => {
  // Live 2026-07-30: provider ships weekly (10080 min) as "primary" plus a
  // zero-duration placeholder secondary. The top bar rendered weekly 46%
  // under the 5h label and a fake "wk 0%".
  const live = classifyCodexQuota({
    primary: { usedPercent: 46, resetAt: 1, windowMinutes: 10080 },
    secondary: { usedPercent: 0, resetAt: 2, windowMinutes: 0 },
    capturedAt: 123,
  });
  assert.equal(live.weekly?.usedPercent, 46, 'the 7-day window lands in the weekly slot');
  assert.equal(live.fiveHour, undefined, 'a zero-duration placeholder is dropped, never a fake 0%');
  assert.equal(live.capturedAt, 123);

  // True dual-window shape: both slots filled by duration.
  const dual = classifyCodexQuota({
    primary: { usedPercent: 12, windowMinutes: 300 },
    secondary: { usedPercent: 34, windowMinutes: 10080 },
  });
  assert.equal(dual.fiveHour?.usedPercent, 12);
  assert.equal(dual.weekly?.usedPercent, 34);

  // Legacy captures without duration headers keep positional meaning.
  const legacy = classifyCodexQuota({
    primary: { usedPercent: 20 },
    secondary: { usedPercent: 5 },
  });
  assert.equal(legacy.fiveHour?.usedPercent, 20);
  assert.equal(legacy.weekly?.usedPercent, 5);

  assert.deepEqual(classifyCodexQuota(undefined), { capturedAt: undefined });
});

// ── Codex quota-aware availability (2026-08-07, the all-day 429 alert class) ──
test('codexQuotaExhausted: header truth, the 429 latch, and self-healing', () => {
  __resetRateLimitStoreForTests();
  assert.equal(codexQuotaExhausted(), false, 'no data → available (fail-open)');

  // Captured headers say a live window is at 100% with a future reset → exhausted.
  recordCodexRateLimit({
    get: (name: string) => ({
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-reset-after-seconds': '1800',
      'x-codex-primary-window-minutes': '300',
    })[name.toLowerCase()] ?? null,
  });
  assert.equal(codexQuotaExhausted(), true, 'a full window with a future reset blocks the lane');
  assert.equal(codexQuotaExhausted(Date.now() + 2000 * 1000), false, 'past the reset the lane self-heals');

  // A later capture with head-room clears the block.
  recordCodexRateLimit({
    get: (name: string) => ({
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-reset-after-seconds': '1800',
      'x-codex-primary-window-minutes': '300',
    })[name.toLowerCase()] ?? null,
  });
  assert.equal(codexQuotaExhausted(), false);

  // The 429 latch works with NO headers at all (the streaming-drop case)…
  __resetRateLimitStoreForTests();
  recordCodexUsageExhausted();
  assert.equal(codexQuotaExhausted(), true, 'a bare 429 latches exhaustion');
  assert.equal(codexQuotaExhausted(Date.now() + 31 * 60 * 1000), false, 'the default latch expires in 30 min');

  // …and a provider retry-after is honored but bounded to 6 hours.
  __resetRateLimitStoreForTests();
  recordCodexUsageExhausted(24 * 60 * 60 * 1000);
  assert.equal(codexQuotaExhausted(Date.now() + 5 * 60 * 60 * 1000), true);
  assert.equal(codexQuotaExhausted(Date.now() + 7 * 60 * 60 * 1000), false, 'latch never exceeds 6h');

  // A zero-duration placeholder window is never read as a real limit.
  __resetRateLimitStoreForTests();
  recordCodexRateLimit({
    get: (name: string) => ({
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-reset-after-seconds': '1800',
      'x-codex-primary-window-minutes': '0',
    })[name.toLowerCase()] ?? null,
  });
  assert.equal(codexQuotaExhausted(), false);
  __resetRateLimitStoreForTests();
});
