/**
 * Run: npx tsx --test src/memory/maintenance.test.ts
 *
 * Characterizes isAtOrAfterDailyTime — the catch-up gate that replaced the
 * exact-minute nightly gate. The old gate (getHours()===H && getMinutes()===M)
 * fired ONLY during the one matching minute, so a laptop asleep across 4:30 AM
 * lost that day's memory.db backup. The new gate fires on the first tick at or
 * after the target time, guarded by the existing per-day fire-once stamp.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-maint-test-'));

const { isAtOrAfterDailyTime } = await import('./maintenance.js');

// Build a local-time Date at the given hour:minute (date itself is irrelevant).
const at = (hour: number, minute: number) => new Date(2026, 5, 8, hour, minute, 0, 0);

test('isAtOrAfterDailyTime: fires from the target minute onward (4:30 job)', () => {
  const H = 4, M = 30;
  // Before the gate → does not fire.
  assert.equal(isAtOrAfterDailyTime(at(3, 0), H, M), false, '3:00 is before 4:30');
  assert.equal(isAtOrAfterDailyTime(at(4, 29), H, M), false, '4:29 is before 4:30');
  // At the gate minute → fires (parity with the old exact-minute gate).
  assert.equal(isAtOrAfterDailyTime(at(4, 30), H, M), true, '4:30 is the gate');
  // AFTER the gate → fires (the catch-up the old gate silently dropped).
  assert.equal(isAtOrAfterDailyTime(at(4, 31), H, M), true, '4:31 catches up');
  assert.equal(isAtOrAfterDailyTime(at(7, 0), H, M), true, 'woke at 7:00 → still backs up');
  assert.equal(isAtOrAfterDailyTime(at(23, 59), H, M), true, 'late evening still catches up');
});

test('isAtOrAfterDailyTime: top-of-hour jobs (3:00, 4:00)', () => {
  assert.equal(isAtOrAfterDailyTime(at(2, 59), 3, 0), false);
  assert.equal(isAtOrAfterDailyTime(at(3, 0), 3, 0), true);
  assert.equal(isAtOrAfterDailyTime(at(3, 1), 3, 0), true);
  assert.equal(isAtOrAfterDailyTime(at(4, 0), 4, 0), true);
  assert.equal(isAtOrAfterDailyTime(at(3, 59), 4, 0), false);
});
