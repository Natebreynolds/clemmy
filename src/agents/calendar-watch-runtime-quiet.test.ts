/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/calendar-watch-runtime-quiet.test.ts
 *
 * A home with no calendar connected is quiet, not failing. Live (blank home,
 * 2026-09-22): the first tick said "Read failed" and armed the 5-minute
 * failed-read retry.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-calwatch-quiet-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { runCalendarWatchTick, calendarWatchStatus, isCalendarWatchDue, connectedCalendarOperations } = await import('./calendar-watch-runtime.js');

test('with no calendar connected a tick is quiet, records no failure, and keeps the normal cadence', async () => {
  assert.equal(connectedCalendarOperations().length, 0, 'a blank home has no calendar operation');
  const tick = await runCalendarWatchTick({ source: 'manual', force: true });
  assert.equal(tick.quiet, true);
  assert.equal(tick.readFailures, 0);
  assert.equal(tick.produced, 0);
  assert.match(tick.summary, /No calendar connected yet/);
  const status = calendarWatchStatus();
  assert.equal(status.lastError, undefined, 'nothing failed');
  assert.equal(status.metrics.ticks, 1);
  assert.equal(status.metrics.quietTicks, 1);
  assert.match(status.lastFinding?.summary ?? '', /No calendar connected yet/);
  const due = isCalendarWatchDue();
  assert.equal(due.due, false);
  assert.equal(due.reason, 'not_yet');
  const nextMs = Date.parse(due.nextAt ?? '');
  assert.ok(nextMs - Date.now() > 20 * 60_000, 'the normal cadence applies, not the failed-read retry');
});
