/**
 * Run: npx tsx --test src/runtime/harness/claude-usage.test.ts
 *
 * Claude's 5h/weekly windows come from GET /api/oauth/usage (the CLI paths never
 * surface the rate-limit headers). This pins the parser against the REAL endpoint
 * body shape captured live: { five_hour: {utilization, resets_at}, seven_day: {…} }.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeUsage } from './claude-usage.js';

// Verbatim shape from a live GET https://api.anthropic.com/api/oauth/usage.
const LIVE_BODY = {
  five_hour: { utilization: 8.0, resets_at: '2026-06-28T08:09:59.985678+00:00', limit_dollars: null },
  seven_day: { utilization: 72.0, resets_at: '2026-06-30T02:59:59.985697+00:00', limit_dollars: null },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 9.0, resets_at: '2026-06-30T02:59:59.985703+00:00' },
  extra_usage: { is_enabled: false },
};

test('parses five_hour → 5h and seven_day → weekly with ISO resets', () => {
  const now = Date.now();
  const snap = parseClaudeUsage(LIVE_BODY, now);
  assert.ok(snap);
  assert.equal(snap!.fiveHour?.usedPercent, 8);
  assert.equal(snap!.weekly?.usedPercent, 72);
  assert.equal(snap!.fiveHour?.resetAt, Date.parse('2026-06-28T08:09:59.985678+00:00'));
  assert.equal(snap!.weekly?.resetAt, Date.parse('2026-06-30T02:59:59.985697+00:00'));
  assert.equal(snap!.capturedAt, now);
});

test('utilization rounds + clamps to 0–100', () => {
  const snap = parseClaudeUsage({ five_hour: { utilization: 12.6 }, seven_day: { utilization: 142 } }, 1);
  assert.equal(snap!.fiveHour?.usedPercent, 13);
  assert.equal(snap!.weekly?.usedPercent, 100);
});

test('missing resets_at → resetAt undefined (still returns the percent)', () => {
  const snap = parseClaudeUsage({ five_hour: { utilization: 5 } }, 1);
  assert.equal(snap!.fiveHour?.usedPercent, 5);
  assert.equal(snap!.fiveHour?.resetAt, undefined);
  assert.equal(snap!.weekly, undefined);
});

test('garbage / empty body → null (no windows to show)', () => {
  assert.equal(parseClaudeUsage(null, 1), null);
  assert.equal(parseClaudeUsage({}, 1), null);
  assert.equal(parseClaudeUsage({ five_hour: { utilization: 'nope' } }, 1), null);
  assert.equal(parseClaudeUsage('not an object', 1), null);
});
