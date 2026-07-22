/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-policy npx tsx --test src/agents/proactivity-policy.test.ts
 *
 * Covers the C2 inbox-watch policy fields: sensible defaults + clamped ranges,
 * round-tripped through save/load. Temp CLEMENTINE_HOME so it never touches real state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-policy-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { saveProactivityPolicy, loadProactivityPolicy, DEFAULT_PROACTIVITY_POLICY } =
  await import('./proactivity-policy.js');

test('inbox-watch defaults: enabled, 15 min, 5 cards', () => {
  assert.equal(DEFAULT_PROACTIVITY_POLICY.inboxWatchEnabled, true);
  assert.equal(DEFAULT_PROACTIVITY_POLICY.inboxWatchMinutes, 15);
  assert.equal(DEFAULT_PROACTIVITY_POLICY.inboxWatchMax, 5);
  // An empty save yields the defaults (default-on).
  const p = saveProactivityPolicy({});
  assert.equal(p.inboxWatchEnabled, true);
  assert.equal(p.inboxWatchMinutes, 15);
  assert.equal(p.inboxWatchMax, 5);
});

test('inbox-watch settings round-trip through save/load', () => {
  saveProactivityPolicy({ inboxWatchEnabled: false, inboxWatchMinutes: 30, inboxWatchMax: 8 });
  const p = loadProactivityPolicy();
  assert.equal(p.inboxWatchEnabled, false);
  assert.equal(p.inboxWatchMinutes, 30);
  assert.equal(p.inboxWatchMax, 8);
});

test('inbox-watch values are clamped to sane ranges', () => {
  const tooLow = saveProactivityPolicy({ inboxWatchMinutes: 1, inboxWatchMax: 0 });
  assert.equal(tooLow.inboxWatchMinutes, 5, 'minutes floored at 5');
  assert.equal(tooLow.inboxWatchMax, 1, 'max floored at 1');
  const tooHigh = saveProactivityPolicy({ inboxWatchMinutes: 9999, inboxWatchMax: 999 });
  assert.equal(tooHigh.inboxWatchMinutes, 240, 'minutes capped at 240');
  assert.equal(tooHigh.inboxWatchMax, 20, 'max capped at 20');
});

test('calendar-watch defaults + clamp', () => {
  const d = saveProactivityPolicy({});
  assert.equal(d.calendarWatchEnabled, true);
  assert.equal(d.calendarWatchMinutes, 30);
  assert.equal(d.calendarWatchMax, 5);
  const clamped = saveProactivityPolicy({ calendarWatchMinutes: 9999, calendarWatchMax: 0 });
  assert.equal(clamped.calendarWatchMinutes, 240, 'minutes capped at 240');
  assert.equal(clamped.calendarWatchMax, 1, 'max floored at 1');
});

test('a partial save MERGES — a later patch that omits inboxWatchEnabled keeps the prior value', () => {
  saveProactivityPolicy({ inboxWatchEnabled: false });
  const merged = saveProactivityPolicy({ inboxWatchMinutes: 20 }); // omit enabled → keeps false
  assert.equal(merged.inboxWatchEnabled, false, 'PATCH semantics: omitted field retains the saved value');
  assert.equal(merged.inboxWatchMinutes, 20);
});

test('autoApproveScope is a clean binary: legacy "balanced" coerces to strict; unknown → strict', () => {
  // The setting is Auto-approve (yolo) vs Approve (strict); 'balanced' was a
  // pure alias of strict and is coerced on read so the internals match the UI.
  assert.equal(saveProactivityPolicy({ autoApproveScope: 'balanced' }).autoApproveScope, 'strict');
  assert.equal(saveProactivityPolicy({ autoApproveScope: 'yolo' }).autoApproveScope, 'yolo');
  assert.equal(saveProactivityPolicy({ autoApproveScope: 'strict' }).autoApproveScope, 'strict');
  assert.equal(saveProactivityPolicy({ autoApproveScope: 'workspace' }).autoApproveScope, 'workspace');
  assert.equal(saveProactivityPolicy({ autoApproveScope: 'nonsense' }).autoApproveScope, 'strict');
});
