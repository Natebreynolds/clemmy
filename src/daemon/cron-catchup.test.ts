/**
 * Run: npx tsx --test src/daemon/cron-catchup.test.ts
 * Cron sleep/downtime catch-up (2026-07-20, schedules audit G2): cron used to
 * match ONLY `now` each tick — a laptop asleep at fire time silently skipped
 * the occurrence. It now evaluates the backfilled window via the workflow
 * scheduler's tested primitive and collapses N misses into one fire.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cron-catchup-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.DISCORD_ENABLED = 'false';
process.env.SLACK_ENABLED = 'false';
process.env.WEBHOOK_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { cronMatchedKeysInWindow } = await import('./runner.js');
const { scheduleCatchupWindow } = await import('../execution/workflow-scheduler.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

// A fixed "now": 2026-07-20 17:03 UTC.
const NOW = Date.UTC(2026, 6, 20, 17, 3, 20);

test('overnight sleep: a daily 09:00 job matches exactly once in the backfilled window', () => {
  const lastTick = Date.UTC(2026, 6, 19, 22, 0, 5); // lid closed 22:00 yesterday
  const window = scheduleCatchupWindow(lastTick, NOW);
  const keys = cronMatchedKeysInWindow('0 9 * * *', window, undefined);
  assert.equal(keys.length, 1, 'the missed 09:00 occurrence is found');
  assert.match(keys[0], /T\d{2}:00$/);
});

test('a 15-minute job missed for 65 minutes collapses to its matched keys (fire-once uses the LATEST)', () => {
  const lastTick = NOW - 65 * 60_000;
  const window = scheduleCatchupWindow(lastTick, NOW);
  const keys = cronMatchedKeysInWindow('*/15 * * * *', window, undefined);
  // Window 15:59→17:03 contains 16:00, 16:15, 16:30, 16:45, 17:00.
  assert.equal(keys.length, 5, 'all missed quarter-hours found (collapse rule fires ONE run on the latest)');
  assert.equal(keys[keys.length - 1] > keys[0], true, 'chronological — latest last');
});

test('normal tick (no gap): only the current minute is evaluated, dedupe holds', () => {
  const window = scheduleCatchupWindow(NOW - 15_000, NOW);
  assert.equal(window.length, 1, 'same-minute tick evaluates just now');
  const key = cronMatchedKeysInWindow('* * * * *', window, undefined)[0];
  assert.ok(key);
  assert.deepEqual(cronMatchedKeysInWindow('* * * * *', window, key), [], 'already-fired minute never re-fires');
});

test('first-ever tick: no spurious backfill', () => {
  const window = scheduleCatchupWindow(undefined, NOW);
  assert.equal(window.length, 1);
});

test('a week offline: backfill is capped at 24h (older occurrences stay missed, by design)', () => {
  const lastTick = NOW - 7 * 24 * 60 * 60_000;
  const window = scheduleCatchupWindow(lastTick, NOW);
  const keys = cronMatchedKeysInWindow('0 9 * * *', window, undefined);
  assert.equal(keys.length, 1, 'only the in-window (last 24h) daily occurrence backfills');
});
