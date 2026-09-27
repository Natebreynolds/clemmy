/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/pass-cursor.test.ts
 *
 * Resumable pass progress: the attempt is recorded before any unit runs, a
 * pass resumes at most once a day, cursor writes are throttled (by an
 * injected clock) except on failure, and the file store is replaced whole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  MAX_PASS_ATTEMPTS_PER_DAY,
  PassProgress,
  comparePassKeys,
  filePassCursorIO,
  localDayKey,
  memoryPassCursorIO,
} = await import('./pass-cursor.js');

type Stats = { n: number };

test('a pass resumes at most once a day', () => {
  assert.equal(MAX_PASS_ATTEMPTS_PER_DAY, 2);
  const io = memoryPassCursorIO();
  const day = '2026-09-27';
  const first = new PassProgress<Stats>({ io, passId: 'p', day, minWriteIntervalMs: 0 });
  assert.equal(first.attempt, 1);
  assert.equal(first.resume, null);
  assert.equal(io.read('p')?.attempts, 1, 'the attempt is recorded before any unit runs');
  first.checkpoint({ after: 7, partial: { key: 8, done: [3] }, stats: { n: 5 } });

  const second = new PassProgress<Stats>({ io, passId: 'p', day, minWriteIntervalMs: 0 });
  assert.equal(second.attempt, 2);
  assert.deepEqual(second.resume, { after: 7, partial: { key: 8, done: [3] }, stats: { n: 5 } });
  second.checkpoint({ after: 9, partial: null, stats: { n: 6 } });

  const third = new PassProgress<Stats>({ io, passId: 'p', day, minWriteIntervalMs: 0 });
  assert.equal(third.attempt, 3);
  assert.equal(third.resume, null, 'the third attempt the same day starts over');
  assert.deepEqual(io.read('p'), { day, after: null, partial: null, stats: null, startedAt: io.read('p')!.startedAt, attempts: 3 });

  const nextDay = new PassProgress<Stats>({ io, passId: 'p', day: '2026-09-28', minWriteIntervalMs: 0 });
  assert.equal(nextDay.attempt, 1);
  assert.equal(nextDay.resume, null);
  nextDay.complete();
  assert.equal(io.read('p'), null);
});

test('checkpoints are written at most once per interval, and flush writes the latest at once', () => {
  const io = memoryPassCursorIO();
  let now = 1_000;
  const progress = new PassProgress<Stats>({ io, passId: 'p', day: '2026-09-27', now: () => now, minWriteIntervalMs: 2_000 });
  now += 500;
  progress.checkpoint({ after: 1, partial: null, stats: { n: 1 } });
  assert.equal(io.read('p')?.after, null, 'within 2 s of the attempt record: held');
  now += 1_600;
  progress.checkpoint({ after: 2, partial: null, stats: { n: 2 } });
  assert.equal(io.read('p')?.after, 2, 'after 2 s: written');
  now += 100;
  progress.checkpoint({ after: 3, partial: null, stats: { n: 3 } });
  assert.equal(io.read('p')?.after, 2);
  progress.flush();
  assert.deepEqual(io.read('p')?.stats, { n: 3 }, 'a failing pass writes its last committed position');
});

test('a pass without a store still runs: nothing is read or written', () => {
  const progress = new PassProgress<Stats>({ passId: 'p' });
  assert.equal(progress.resume, null);
  assert.equal(progress.attempt, 1);
  progress.checkpoint({ after: 1, partial: null, stats: { n: 1 } });
  progress.flush();
  progress.complete();
});

test('a store that throws never stops the pass', () => {
  const broken = { read: () => { throw new Error('read'); }, write: () => { throw new Error('write'); }, clear: () => { throw new Error('clear'); } };
  const progress = new PassProgress<Stats>({ io: broken, passId: 'p', minWriteIntervalMs: 0 });
  assert.equal(progress.resume, null);
  progress.checkpoint({ after: 1, partial: null, stats: { n: 1 } });
  progress.flush();
  progress.complete();
});

test('the file store replaces the file whole and reads a damaged file as empty', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-pass-cursor-'));
  const file = path.join(dir, 'state', 'memory-pass-cursors.json');
  const io = filePassCursorIO(file);
  assert.equal(io.read('a'), null);
  const cursor = { day: '2026-09-27', after: [1, '2026-09-01T00:00:00.000Z', 42], partial: null, stats: { n: 1 }, startedAt: '2026-09-27T04:45:00.000Z', attempts: 1 };
  io.write('a', cursor);
  io.write('b', { ...cursor, attempts: 2 });
  assert.deepEqual(io.read('a'), cursor);
  assert.equal(io.read('b')?.attempts, 2);
  io.clear('a');
  assert.equal(io.read('a'), null);
  assert.equal(io.read('b')?.attempts, 2);
  assert.deepEqual(readdirSync(path.dirname(file)), ['memory-pass-cursors.json'], 'no temp file is left behind');
  writeFileSync(file, '{"passes": {"b": ');
  assert.equal(io.read('b'), null);
  io.write('c', cursor);
  assert.deepEqual(io.read('c'), cursor);
  writeFileSync(file, JSON.stringify({ passes: { d: { day: 7 } } }));
  assert.equal(io.read('d'), null, 'a malformed cursor is not resumed');
});

test('order keys compare component by component, each in its own direction', () => {
  assert.ok(comparePassKeys(3, 5) < 0);
  assert.ok(comparePassKeys([1, 'b', 9], [1, 'a', 9]) > 0);
  const order = [-1, -1, -1] as const;
  assert.ok(comparePassKeys([1, '2026-09-02', 5], [0, '2026-09-03', 9], order) < 0, 'active first');
  assert.ok(comparePassKeys([1, '2026-09-03', 5], [1, '2026-09-02', 9], order) < 0, 'newest first');
  assert.ok(comparePassKeys([1, '2026-09-03', 9], [1, '2026-09-03', 5], order) < 0, 'highest id first');
  assert.equal(comparePassKeys([1, 'x', 5], [1, 'x', 5], order), 0);
  assert.match(localDayKey(new Date(2026, 8, 7, 23, 59)), /^2026-09-07$/);
});
