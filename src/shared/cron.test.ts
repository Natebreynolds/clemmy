/**
 * Run: npx tsx --test src/shared/cron.test.ts
 *
 * getNextRun was extracted from orchestration-tools into this shared leaf module
 * so the Slack command center's "Upcoming" section can compute next-run without
 * importing the MCP tool layer. These pin its behavior (with an injected `now` so
 * the assertions are deterministic).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCronExpression, getNextRun } from './cron.js';

test('validateCronExpression accepts valid 5-field exprs and rejects junk', () => {
  assert.equal(validateCronExpression('0 9 * * 1-5'), true);
  assert.equal(validateCronExpression('*/30 * * * *'), true);
  assert.equal(validateCronExpression('0 9 * *'), false, 'needs 5 fields');
  assert.equal(validateCronExpression('bogus'), false);
});

test('getNextRun returns the next matching minute (ISO) for a valid expr', () => {
  // Monday 2026-06-01 08:00 local → next "0 9 * * *" (9am daily) is the same day 09:00.
  const now = new Date(2026, 5, 1, 8, 0, 0);
  const next = getNextRun('0 9 * * *', now);
  assert.ok(next, 'a next run is found');
  const d = new Date(next!);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 0);
  assert.ok(d.getTime() > now.getTime(), 'strictly in the future');
});

test('getNextRun handles step fields and returns null for invalid exprs', () => {
  const now = new Date(2026, 5, 1, 8, 7, 0);
  const next = getNextRun('*/15 * * * *', now); // every 15 min → next is :15
  assert.ok(next);
  assert.equal(new Date(next!).getMinutes() % 15, 0);
  assert.equal(getNextRun('not a cron', now), null);
});
