/**
 * Run: npx tsx --test src/execution/store.test.ts
 *
 * Covers the v0.2.8 durability primitives:
 *
 *   - sweepCrashedExecutions: active execution with a stale
 *     `lastHeartbeatAt` (> 5 min default) is transitioned to
 *     `completed` with a "heartbeat stalled" blocker. Active
 *     executions with a fresh heartbeat are left alone. Active
 *     executions that have NEVER had a heartbeat written are NOT
 *     swept by this function — that's the existing
 *     `sweepStaleExecutions`'s job (60-min activity-based fallback).
 *
 *   - sweepStaleBlockedExecutions: blocked execution whose
 *     `updatedAt` is older than the threshold (6h default) is
 *     transitioned to `completed` with an auto-fail blocker.
 *     Blocked executions with a recent `updatedAt` are left alone.
 *
 *   - Round-trip persistence: the sweepers mutate the JSON file on
 *     disk; a second `loadExecutions()` sees the new state.
 *
 * Per-test temp dir via CLEMENTINE_HOME so we don't trample the
 * user's real ~/.clementine-next state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-store-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
// The store imports addNotification, which writes to disk. Make sure
// the state dir exists before any code path tries to write.
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { sweepCrashedExecutions, sweepStaleBlockedExecutions } = await import('./store.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');

const EXECUTIONS_FILE = path.join(TMP_HOME, 'state', 'executions.json');

function nowMinusMinutes(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seedExecutions(records: Array<Record<string, unknown>>): void {
  writeFileSync(EXECUTIONS_FILE, JSON.stringify(records, null, 2), 'utf-8');
}

function readExecutions(): Array<Record<string, unknown>> {
  if (!existsSync(EXECUTIONS_FILE)) return [];
  return JSON.parse(readFileSync(EXECUTIONS_FILE, 'utf-8')) as Array<Record<string, unknown>>;
}

function baseExecution(overrides: Record<string, unknown>): Record<string, unknown> {
  const iso = new Date().toISOString();
  return {
    id: `exec-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: 'sess-test',
    title: 'test',
    objective: 'test',
    reason: 'test',
    status: 'active',
    createdAt: iso,
    updatedAt: iso,
    lastActivityAt: iso,
    startedFromMessage: 'hi',
    confidence: 0.5,
    reasons: [],
    ...overrides,
  };
}

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('sweepCrashedExecutions: active with stale heartbeat is auto-failed', () => {
  seedExecutions([
    baseExecution({
      id: 'crashed',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(10),
      lastActivityAt: nowMinusMinutes(10),
    }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 1);
  const after = readExecutions();
  assert.equal(after[0].status, 'completed');
  assert.match(String(after[0].blocker), /Controller heartbeat stalled/);
});

test('sweepCrashedExecutions: stale heartbeat but recent execution activity is left alone', () => {
  seedExecutions([
    baseExecution({
      id: 'recent-activity',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(1),
      lastActivityAt: nowMinusMinutes(1),
    }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0);
  const after = readExecutions();
  assert.equal(after[0].status, 'active');
});

test('sweepCrashedExecutions: stale heartbeat but recent harness activity is left alone', () => {
  resetEventLog();
  createSession({ id: 'sess-recent-harness', kind: 'chat', title: 'recent harness' });
  appendEvent({
    sessionId: 'sess-recent-harness',
    turn: 1,
    role: 'assistant',
    type: 'tool_returned',
    data: { tool: 'run_shell_command' },
  });
  seedExecutions([
    baseExecution({
      id: 'recent-harness',
      sessionId: 'sess-recent-harness',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(10),
      lastActivityAt: nowMinusMinutes(10),
    }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0);
  const after = readExecutions();
  assert.equal(after[0].status, 'active');
});

test('sweepCrashedExecutions: stale heartbeat but nextReviewAt in the FUTURE is left alone (v0.5.64 schedule-aware)', () => {
  seedExecutions([
    baseExecution({
      id: 'scheduled-future',
      sessionId: 'sess-sched-future',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(10),
      lastActivityAt: nowMinusMinutes(10),
      // controller scheduled the next review 25 min out — the stale heartbeat
      // is BY DESIGN, not a crash. Must NOT be swept.
      nextReviewAt: new Date(Date.now() + 25 * 60_000).toISOString(),
    }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0, 'execution waiting for a future-scheduled review must not be swept');
  const after = readExecutions();
  assert.equal(after[0].status, 'active');
});

test('sweepCrashedExecutions: stale heartbeat AND nextReviewAt OVERDUE is still swept (real starvation)', () => {
  seedExecutions([
    baseExecution({
      id: 'scheduled-overdue',
      sessionId: 'sess-sched-overdue',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(10),
      updatedAt: nowMinusMinutes(10),
      lastActivityAt: nowMinusMinutes(10),
      // review was due 8 min ago but the controller never ticked it — genuine
      // crash/starvation, still swept.
      nextReviewAt: nowMinusMinutes(8),
    }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 1, 'an overdue-but-stale execution is a real crash signal and is swept');
  const after = readExecutions();
  assert.equal(after[0].status, 'completed');
});

test('sweepCrashedExecutions: CLEMMY_SWEEP_HONOR_NEXT_REVIEW=off reverts to sweeping future-review executions', () => {
  const prev = process.env.CLEMMY_SWEEP_HONOR_NEXT_REVIEW;
  process.env.CLEMMY_SWEEP_HONOR_NEXT_REVIEW = 'off';
  try {
    seedExecutions([
      baseExecution({
        id: 'sched-flag-off',
        sessionId: 'sess-sched-flagoff',
        status: 'active',
        lastHeartbeatAt: nowMinusMinutes(10),
        updatedAt: nowMinusMinutes(10),
        lastActivityAt: nowMinusMinutes(10),
        nextReviewAt: new Date(Date.now() + 25 * 60_000).toISOString(),
      }),
    ]);
    const swept = sweepCrashedExecutions();
    assert.equal(swept, 1, 'kill-switch off => prior behavior (swept regardless of nextReviewAt)');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_SWEEP_HONOR_NEXT_REVIEW;
    else process.env.CLEMMY_SWEEP_HONOR_NEXT_REVIEW = prev;
  }
});

test('sweepCrashedExecutions: active with fresh heartbeat is left alone', () => {
  seedExecutions([
    baseExecution({ id: 'fresh', status: 'active', lastHeartbeatAt: nowMinusMinutes(1) }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0);
  const after = readExecutions();
  assert.equal(after[0].status, 'active');
});

test('sweepCrashedExecutions: active without ANY heartbeat is left alone (legacy fallback path)', () => {
  seedExecutions([
    baseExecution({ id: 'noheartbeat', status: 'active' }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0);
  const after = readExecutions();
  assert.equal(after[0].status, 'active');
});

test('sweepCrashedExecutions: blocked execution is NOT swept by the crash reaper', () => {
  seedExecutions([
    baseExecution({ id: 'blocked', status: 'blocked', lastHeartbeatAt: nowMinusMinutes(60) }),
  ]);
  const swept = sweepCrashedExecutions();
  assert.equal(swept, 0);
  const after = readExecutions();
  assert.equal(after[0].status, 'blocked');
});

test('sweepCrashedExecutions: custom threshold honored', () => {
  seedExecutions([
    baseExecution({
      id: 'mid',
      status: 'active',
      lastHeartbeatAt: nowMinusMinutes(2),
      updatedAt: nowMinusMinutes(2),
      lastActivityAt: nowMinusMinutes(2),
    }),
  ]);
  // 60s threshold — 2-min-old heartbeat IS stale.
  const swept = sweepCrashedExecutions(60_000);
  assert.equal(swept, 1);
});

test('sweepStaleBlockedExecutions: blocked with stale updatedAt is auto-failed', () => {
  seedExecutions([
    baseExecution({ id: 'stuck', status: 'blocked', updatedAt: nowMinusMinutes(60 * 7) }),
  ]);
  const swept = sweepStaleBlockedExecutions();
  assert.equal(swept, 1);
  const after = readExecutions();
  assert.equal(after[0].status, 'completed');
  assert.match(String(after[0].blocker), /Blocked for \d+h/);
});

test('sweepStaleBlockedExecutions: blocked with recent updatedAt is left alone', () => {
  seedExecutions([
    baseExecution({ id: 'recent-blocked', status: 'blocked', updatedAt: nowMinusMinutes(60) }),
  ]);
  const swept = sweepStaleBlockedExecutions();
  assert.equal(swept, 0);
});

test('sweepStaleBlockedExecutions: active execution is NOT swept by the blocked reaper', () => {
  seedExecutions([
    baseExecution({ id: 'still-active', status: 'active', updatedAt: nowMinusMinutes(60 * 24) }),
  ]);
  const swept = sweepStaleBlockedExecutions();
  assert.equal(swept, 0);
});

test('sweepers leave file on disk untouched when there is nothing to sweep', () => {
  seedExecutions([
    baseExecution({ id: 'untouched', status: 'active', lastHeartbeatAt: nowMinusMinutes(1) }),
  ]);
  const before = readFileSync(EXECUTIONS_FILE, 'utf-8');
  sweepCrashedExecutions();
  sweepStaleBlockedExecutions();
  const after = readFileSync(EXECUTIONS_FILE, 'utf-8');
  assert.equal(after, before);
});
