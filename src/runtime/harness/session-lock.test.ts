/**
 * Run: npx tsx --test src/runtime/harness/session-lock.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-session-lock-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HARNESS_SESSION_LOCK = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { withSessionLock, __resetSessionLocks } = await import('./session-lock.js');
const { createSession, openEventLog, closeEventLog } = await import('./eventlog.js');

test.after(() => {
  try { closeEventLog(); } catch { /* best effort */ }
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test.beforeEach(() => {
  __resetSessionLocks();
});

test('withSessionLock serializes same-id work in order', async () => {
  const session = createSession({ kind: 'chat' });
  const completionOrder: number[] = [];
  const tasks = Array.from({ length: 10 }, (_, i) =>
    withSessionLock(session.id, async () => {
      // Stagger the delay so a naive parallel impl would complete in
      // reverse-of-start order; the lock forces start-order completion.
      await new Promise((r) => setTimeout(r, 50 - i * 4));
      completionOrder.push(i);
    }),
  );
  await Promise.all(tasks);
  assert.deepEqual(completionOrder, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('withSessionLock runs DIFFERENT sessions in parallel', async () => {
  const sA = createSession({ kind: 'chat' });
  const sB = createSession({ kind: 'chat' });
  const start = Date.now();
  await Promise.all([
    withSessionLock(sA.id, async () => { await new Promise((r) => setTimeout(r, 100)); }),
    withSessionLock(sB.id, async () => { await new Promise((r) => setTimeout(r, 100)); }),
  ]);
  const elapsed = Date.now() - start;
  // Parallel = ~100ms. Serial would be ~200ms. Allow some jitter.
  assert.ok(elapsed < 180, `expected parallel across sessions, got ${elapsed}ms`);
});

test('withSessionLock propagates work errors and releases the lock', async () => {
  const session = createSession({ kind: 'chat' });
  let caught: unknown;
  try {
    await withSessionLock(session.id, () => {
      throw new Error('work boom');
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal((caught as Error).message, 'work boom');

  // Next acquire must succeed — the failed work must have released
  // the lock on the way out (not held it forever).
  let secondRan = false;
  await withSessionLock(session.id, () => {
    secondRan = true;
  });
  assert.equal(secondRan, true);
});

test('withSessionLock is a no-op pass-through when flag is off', async () => {
  const prev = process.env.HARNESS_SESSION_LOCK;
  process.env.HARNESS_SESSION_LOCK = 'off';
  try {
    const session = createSession({ kind: 'chat' });
    // Without the lock, two long-running tasks on the same session
    // run in parallel — total wall time ≈ 100ms not 200ms.
    const start = Date.now();
    await Promise.all([
      withSessionLock(session.id, async () => { await new Promise((r) => setTimeout(r, 100)); }),
      withSessionLock(session.id, async () => { await new Promise((r) => setTimeout(r, 100)); }),
    ]);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 180, `expected no-op parallel with flag off, got ${elapsed}ms`);
  } finally {
    process.env.HARNESS_SESSION_LOCK = prev;
  }
});

test('a stale cross-process lock row is reclaimed', async () => {
  const session = createSession({ kind: 'chat' });
  const db = openEventLog();

  // Plant a stale row from a non-existent PID with expires_at in the
  // past. The next withSessionLock should steal it.
  const farPastExpires = Date.now() - 10_000;
  db.prepare(
    'INSERT INTO session_locks (session_id, owner_pid, owner_token, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(session.id, 9_999_999, 'stale-token', farPastExpires - 1000, farPastExpires);

  let ran = false;
  await withSessionLock(session.id, () => {
    ran = true;
  });
  assert.equal(ran, true);

  // The row should be gone after our release.
  const left = db.prepare('SELECT COUNT(*) AS c FROM session_locks WHERE session_id = ?').get(session.id) as { c: number };
  assert.equal(left.c, 0);
});
