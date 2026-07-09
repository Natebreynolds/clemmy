/**
 * Run: npx tsx --test src/execution/stale-task-heartbeat.test.ts
 *
 * The heartbeat half of the 2026-06-21 auto-expire spin: a weekly nudge that
 * surfaces finished/parked background tasks idle past the stale threshold and
 * asks the user to archive them (instead of silently reaping). Own temp home so
 * addNotification writes nowhere real; env set BEFORE the dynamic import because
 * notifications.ts captures its file path at module load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BackgroundTaskRecord } from './background-tasks.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-stale-hb-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_STALE_TASK_HEARTBEAT = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { runStaleTaskHeartbeat } = await import('./background-task-watchdog.js');
const { loadNotifications } = await import('../runtime/notifications.js');
const { STALE_TASK_AGE_MS } = await import('./background-tasks.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = STALE_TASK_AGE_MS + DAY; // anything with updatedAt=epoch is 8 days old → stale
const EPOCH = new Date(0).toISOString();

function rec(over: Partial<BackgroundTaskRecord>): BackgroundTaskRecord {
  return {
    id: 'id', title: 't', prompt: 'p', status: 'done', runSessionId: 's',
    maxMinutes: 10, source: 'desktop', createdAt: EPOCH, updatedAt: EPOCH, ...over,
  };
}

function stalePrompts() {
  return loadNotifications().filter((n) => typeof n.id === 'string' && n.id.startsWith('bgtask-stale-prompt-'));
}

test('surfaces ONE nudge for finished + parked stale tasks, with accurate counts', () => {
  const tasks = [
    rec({ id: 'f1', title: 'old enrichment', status: 'done' }),
    rec({ id: 'f2', title: 'failed pull', status: 'failed' }),
    rec({ id: 'p1', title: 'waiting on you', status: 'awaiting_input' }),
    rec({ id: 'p2', title: 'waiting to continue', status: 'awaiting_continue' }),
  ];
  const out = runStaleTaskHeartbeat(tasks, NOW);
  assert.equal(out.stale, 4);
  const prompts = stalePrompts();
  assert.equal(prompts.length, 1, 'exactly one batched nudge');
  assert.match(prompts[0].title, /4 old background tasks — archive them\?/);
  assert.equal(prompts[0].metadata?.staleCount, 4);
  assert.equal(prompts[0].metadata?.finished, 2);
  assert.equal(prompts[0].metadata?.parked, 2);
  assert.deepEqual([...(prompts[0].metadata?.staleTaskIds as string[])].sort(), ['f1', 'f2', 'p1', 'p2']);
});

test('dedup: a second sweep in the same 7-day window does not add another nudge', () => {
  for (const n of loadNotifications()) { /* leave as-is; same-week id dedups */ }
  const before = stalePrompts().length;
  runStaleTaskHeartbeat([rec({ id: 'f1', title: 'old enrichment', status: 'done' })], NOW);
  assert.equal(stalePrompts().length, before, 'same-week bucket id → no duplicate nudge');
});

test('dedup survives notification pruning because the heartbeat marker is durable', () => {
  const weekNow = NOW + STALE_TASK_AGE_MS;
  const task = rec({ id: 'pruned-1', title: 'old pruned task', status: 'done' });
  const first = runStaleTaskHeartbeat([task], weekNow);
  assert.equal(first.stale, 1);
  assert.equal(stalePrompts().some((n) => n.id === `bgtask-stale-prompt-${Math.floor(weekNow / STALE_TASK_AGE_MS)}`), true);

  writeFileSync(path.join(TMP_HOME, 'state', 'notifications.json'), '[]', 'utf-8');
  const second = runStaleTaskHeartbeat([task], weekNow);
  assert.equal(second.stale, 1);
  assert.equal(stalePrompts().length, 0, 'pruned notification is not recreated every watchdog tick');
});

test('active (pending/running) and fresh tasks never trigger a nudge', () => {
  const before = stalePrompts().length;
  const out = runStaleTaskHeartbeat([
    rec({ id: 'a1', status: 'pending' }),         // active, however old
    rec({ id: 'a2', status: 'running' }),         // active
    rec({ id: 'fresh', status: 'done', updatedAt: new Date(NOW - 1000).toISOString() }), // 1s old
  ], NOW);
  assert.equal(out.stale, 0);
  assert.equal(stalePrompts().length, before, 'no new nudge');
});

test('kill-switch CLEMMY_STALE_TASK_HEARTBEAT=off disables the nudge', () => {
  const before = stalePrompts().length;
  process.env.CLEMMY_STALE_TASK_HEARTBEAT = 'off';
  try {
    const out = runStaleTaskHeartbeat([rec({ id: 'z1', status: 'done' })], NOW + 100 * STALE_TASK_AGE_MS);
    assert.equal(out.stale, 0);
    assert.equal(stalePrompts().length, before, 'no nudge emitted while disabled');
  } finally {
    process.env.CLEMMY_STALE_TASK_HEARTBEAT = 'on';
  }
});
