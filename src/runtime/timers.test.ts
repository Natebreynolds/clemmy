/**
 * Run: npx tsx --test src/runtime/timers.test.ts
 * set_timer firing half (2026-07-20): the tool used to be WRITE-ONLY — no
 * consumer existed, every reminder silently lost. These tests pin the
 * late-but-never-lost contract.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-timers-test-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { readTimers, writeTimers, fireDueTimers } = await import('./timers.js');
const { TIMERS_FILE } = await import('../tools/shared.js');
const { listNotifications } = await import('./notifications.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));

const NOW = 1_780_000_000_000;

test('a due timer fires as a notification and is removed; a future one stays', () => {
  writeTimers([
    { id: 'due-1', message: 'call the client back', fireAt: NOW - 60_000, createdAt: NOW - 30 * 60_000 },
    { id: 'future-1', message: 'file the brief', fireAt: NOW + 60 * 60_000, createdAt: NOW },
  ]);
  const fired = fireDueTimers(NOW);
  assert.equal(fired, 1);
  const notes = listNotifications();
  const reminder = notes.find((n) => n.id === 'timer-fired-due-1');
  assert.ok(reminder, 'the reminder actually reaches the user');
  assert.match(reminder!.body, /call the client back/);
  const remaining = readTimers();
  assert.deepEqual(remaining.map((t) => t.id), ['future-1'], 'fired removed, future kept');
});

test('late-but-never-lost: a timer overdue by hours fires with an honest delay note', () => {
  writeTimers([{ id: 'late-1', message: 'send the retainer', fireAt: NOW - 3 * 60 * 60_000, createdAt: NOW - 4 * 60 * 60_000 }]);
  assert.equal(fireDueTimers(NOW), 1);
  const reminder = listNotifications().find((n) => n.id === 'timer-fired-late-1');
  assert.ok(reminder);
  assert.match(reminder!.body, /delayed 180 min/, 'the user is told it is late, not gaslit');
});

test('a just-in-time fire carries no delay note', () => {
  writeTimers([{ id: 'ontime-1', message: 'stand-up', fireAt: NOW - 10_000, createdAt: NOW - 60_000 }]);
  fireDueTimers(NOW);
  const reminder = listNotifications().find((n) => n.id === 'timer-fired-ontime-1');
  assert.ok(reminder);
  assert.doesNotMatch(reminder!.body, /delayed/);
});

test('a corrupt store is quarantined + surfaced, never silently emptied', () => {
  writeFileSync(TIMERS_FILE, '{ not json', 'utf-8');
  const timers = readTimers();
  assert.deepEqual(timers, []);
  assert.equal(existsSync(TIMERS_FILE), false, 'corrupt file moved aside, not left to re-fail');
  const dir = path.dirname(TIMERS_FILE);
  assert.ok(readdirSync(dir).some((f) => f.includes('.timers.json.corrupt-')), 'bytes survive for repair');
  assert.ok(
    listNotifications().some((n) => n.title === 'Reminder store was corrupt'),
    'the user learns reminders are in limbo',
  );
});

test('an empty/absent store is a cheap no-op', () => {
  assert.equal(fireDueTimers(NOW), 0);
});
