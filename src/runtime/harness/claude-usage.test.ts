/**
 * Run: npx tsx --test src/runtime/harness/claude-usage.test.ts
 *
 * Claude's 5h/weekly windows come from GET /api/oauth/usage (the CLI paths never
 * surface the rate-limit headers). This pins the parser against the REAL endpoint
 * body shape captured live: { five_hour: {utilization, resets_at}, seven_day: {…} }.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_QUOTA_SAMPLE_FRESH_MS, claudeUsageExhaustion, parseClaudeUsage } from './claude-usage.js';

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

test('surfaces an active model-scoped weekly cap even when overall weekly usage has headroom', () => {
  const snap = parseClaudeUsage({
    five_hour: { utilization: 0, resets_at: '2026-07-28T05:39:59.996529+00:00' },
    seven_day: { utilization: 94, resets_at: '2026-07-28T02:59:59.996550+00:00' },
    extra_usage: {
      is_enabled: false,
      user_disabled: true,
      spend_limit_reached: false,
    },
    limits: [
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 94,
        resets_at: '2026-07-28T02:59:59.996550+00:00',
        scope: null,
        is_active: false,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 100,
        resets_at: '2026-07-28T03:00:00.996850+00:00',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        is_active: true,
      },
    ],
  }, 123);
  assert.ok(snap);
  assert.equal(snap!.weekly?.usedPercent, 94, 'overall weekly headroom remains visible');
  assert.deepEqual(snap!.scopedWeekly, {
    usedPercent: 100,
    resetAt: Date.parse('2026-07-28T03:00:00.996850+00:00'),
    active: true,
    modelLabel: 'Fable',
  });
  assert.equal(snap!.extraUsageEnabled, false);
  assert.equal(snap!.extraUsageUserDisabled, true);
});

// The checker reads this rule to decide whether the Claude account can serve a
// review (judge-family.ts checkerQuotaExhaustion). Only proof counts.
const NOW = Date.parse('2026-09-25T12:00:00Z');
const HOUR = 3_600_000;
const usedUp = { usedPercent: 100, resetAt: NOW + HOUR };

test('exhaustion: a fresh reading of a used-up plan window with its reset ahead is proof', () => {
  assert.deepEqual(claudeUsageExhaustion({ fiveHour: usedUp, capturedAt: NOW - 60_000 }, NOW),
    { window: 'five_hour', usedPercent: 100, resetAt: NOW + HOUR, capturedAt: NOW - 60_000 });
  assert.equal(claudeUsageExhaustion({ fiveHour: { usedPercent: 12, resetAt: NOW + HOUR }, weekly: usedUp, capturedAt: NOW }, NOW)?.window,
    'seven_day', 'a used-up week blocks the account too');
  assert.equal(claudeUsageExhaustion({ fiveHour: usedUp, extraUsageEnabled: false, capturedAt: NOW }, NOW)?.window, 'five_hour');
});

test('exhaustion: headroom, a missing or passed reset, extra usage and old readings prove nothing', () => {
  assert.equal(claudeUsageExhaustion(null, NOW), null);
  assert.equal(claudeUsageExhaustion({ fiveHour: { usedPercent: 99, resetAt: NOW + HOUR }, capturedAt: NOW }, NOW), null);
  assert.equal(claudeUsageExhaustion({ fiveHour: { usedPercent: 100 }, capturedAt: NOW }, NOW), null);
  assert.equal(claudeUsageExhaustion({ fiveHour: { usedPercent: 100, resetAt: NOW - 1 }, capturedAt: NOW }, NOW), null);
  assert.equal(claudeUsageExhaustion({ fiveHour: usedUp, extraUsageEnabled: true, capturedAt: NOW }, NOW), null,
    'with extra usage on the account keeps serving past the plan window');
  assert.equal(claudeUsageExhaustion({ fiveHour: usedUp, capturedAt: NOW - CLAUDE_QUOTA_SAMPLE_FRESH_MS }, NOW)?.window,
    'five_hour', 'at the freshness bound the reading still counts');
  assert.equal(claudeUsageExhaustion({ fiveHour: usedUp, capturedAt: NOW - CLAUDE_QUOTA_SAMPLE_FRESH_MS - 1 }, NOW), null,
    'past it, the account is dialed again and the provider decides');
});

test('exhaustion: a model-scoped cap alone is left to the provider’s own refusal', () => {
  assert.equal(claudeUsageExhaustion({
    fiveHour: { usedPercent: 10, resetAt: NOW + HOUR }, weekly: { usedPercent: 40, resetAt: NOW + 50 * HOUR },
    scopedWeekly: { usedPercent: 100, resetAt: NOW + 50 * HOUR, active: true, modelLabel: 'Scoped' },
    capturedAt: NOW,
  }, NOW), null, 'the reading names the capped model only by display name');
});
