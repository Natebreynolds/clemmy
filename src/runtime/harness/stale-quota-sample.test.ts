import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./rate-limit-store.ts', import.meta.url), 'utf8');
const BODY = SRC.split('export function codexQuotaExhausted(')[1]!.split('\n}')[0]!;

// Observed 2026-09-05: capturedAt 17:36 with weekly resetAt 09-11 and
// usedPercent 100 disabled the Codex lane for six days while the owner had
// quota. Self-sustaining, because the only writer of the sample is a Codex
// response and codexAvailable() gates the call that would produce one.
test('a usedPercent sample only gates while the capture is FRESH', () => {
  assert.match(BODY, /captureIsFresh/, 'freshness must gate the percentage inference');
  assert.match(BODY, /now - capturedAt\)? <= CODEX_QUOTA_SAMPLE_FRESH_MS/);
  const freshAt = BODY.indexOf('if (captureIsFresh)');
  const pctAt = BODY.indexOf('window.usedPercent >= 100');
  assert.ok(freshAt > 0 && pctAt > freshAt, 'the percentage check must sit INSIDE the freshness guard');
});

// The 429 latch is the mechanism actually designed for backoff and must remain
// absolute — a stale-sample fix must never weaken it.
test('the exhaustedUntil latch is still checked first and unconditionally', () => {
  const latchAt = BODY.indexOf('codex.exhaustedUntil');
  const freshAt = BODY.indexOf('captureIsFresh');
  assert.ok(latchAt > 0 && latchAt < freshAt, 'the latch must precede and bypass the freshness logic');
  assert.match(BODY, /codex\.exhaustedUntil > now\) return true;/);
});

test('a missing or zero capture timestamp is never treated as fresh', () => {
  assert.match(BODY, /capturedAt > 0 &&/, 'an absent capturedAt must not count as a fresh sample');
});

test('the freshness bound is configurable but defaults to a short window', () => {
  assert.match(SRC, /CODEX_QUOTA_SAMPLE_FRESH_MS/);
  assert.match(SRC, /CLEMMY_CODEX_QUOTA_SAMPLE_FRESH_MS/);
  assert.match(SRC, /'900000'/, 'default 15 minutes — well under any weekly reset window');
});
