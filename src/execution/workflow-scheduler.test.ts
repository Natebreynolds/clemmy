/**
 * Run: npx tsx --test src/execution/workflow-scheduler.test.ts
 *
 * G3 — timezone-aware cron matching. "daily 8am" must mean the OWNER's 8am, not
 * the daemon host's. Default (no tz) stays byte-identical to host-local.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronMatches, wallClockInZone, scheduleCatchupWindow } from './workflow-scheduler.js';

const MIN = 60_000;

test('scheduleCatchupWindow: first tick (no prior eval) → only now, no backfill', () => {
  const now = Date.UTC(2026, 5, 7, 10, 30) + 12_345; // mid-minute
  const w = scheduleCatchupWindow(undefined, now);
  assert.equal(w.length, 1);
  assert.equal(w[0].getTime(), Date.UTC(2026, 5, 7, 10, 30)); // minute-floored
});

test('scheduleCatchupWindow: normal 15s tick (same minute) → just now (no double-eval)', () => {
  const baseMin = Date.UTC(2026, 5, 7, 10, 30);
  const w = scheduleCatchupWindow(baseMin, baseMin + 15_000);
  assert.equal(w.length, 1);
  assert.equal(w[0].getTime(), baseMin);
});

test('scheduleCatchupWindow: after a sleep, backfills every missed minute (after last, through now)', () => {
  const last = Date.UTC(2026, 5, 7, 8, 0);
  const now = Date.UTC(2026, 5, 7, 8, 5);
  const w = scheduleCatchupWindow(last, now).map((d) => d.getTime());
  assert.deepEqual(w, [last + MIN, last + 2 * MIN, last + 3 * MIN, last + 4 * MIN, last + 5 * MIN]);
});

test('scheduleCatchupWindow: a long outage is capped at 24h of backfill', () => {
  const now = Date.UTC(2026, 5, 7, 12, 0);
  const last = now - 5 * 24 * 60 * MIN; // 5 days ago
  const w = scheduleCatchupWindow(last, now);
  assert.equal(w.length, 24 * 60 + 1, 'capped to last 24h (1440 min) + the now minute');
  assert.equal(w[w.length - 1].getTime(), now);
});

// A fixed UTC instant: 2026-06-02T15:00:00Z = 08:00 America/Los_Angeles (PDT, -7).
const INSTANT = new Date('2026-06-02T15:00:00Z');

test('G3: "0 8 * * *" matches at 8am in the workflow timezone, not host time', () => {
  assert.equal(cronMatches('0 8 * * *', INSTANT, 'America/Los_Angeles'), true, '08:00 PT → match');
  assert.equal(cronMatches('0 15 * * *', INSTANT, 'America/Los_Angeles'), false, '15:00 is UTC, not PT');
  // In UTC the same instant is 15:00, so the UTC-interpreted 8am does NOT fire.
  assert.equal(cronMatches('0 8 * * *', INSTANT, 'UTC'), false);
  assert.equal(cronMatches('0 15 * * *', INSTANT, 'UTC'), true);
});

test('G3: no timezone → host-local semantics (byte-identical to legacy getHours)', () => {
  const wc = wallClockInZone(INSTANT, undefined);
  assert.equal(wc.hour, INSTANT.getHours());
  assert.equal(wc.minute, INSTANT.getMinutes());
  assert.equal(wc.dayOfWeek, INSTANT.getDay());
  // cronMatches with no tz uses the host's local fields.
  const hostHourExpr = `0 ${INSTANT.getHours()} * * *`;
  assert.equal(cronMatches(hostHourExpr, INSTANT), true);
});

test('G3: an invalid/unknown timezone falls back to host-local (never throws the tick)', () => {
  const wc = wallClockInZone(INSTANT, 'Not/AZone');
  assert.equal(wc.hour, INSTANT.getHours(), 'bad tz → host local, no throw');
  assert.doesNotThrow(() => cronMatches('0 8 * * *', INSTANT, 'Not/AZone'));
});

test('G3: day-of-week + day-of-month also resolve in the target zone', () => {
  // 2026-06-02T03:30Z is still 2026-06-01 (Mon, 20:30) in Los Angeles.
  const lateUtc = new Date('2026-06-02T03:30:00Z');
  const la = wallClockInZone(lateUtc, 'America/Los_Angeles');
  assert.equal(la.dayOfMonth, 1, 'still the 1st in LA');
  assert.equal(la.dayOfWeek, 1, 'Monday in LA');
  const utc = wallClockInZone(lateUtc, 'UTC');
  assert.equal(utc.dayOfMonth, 2, 'the 2nd in UTC');
});
