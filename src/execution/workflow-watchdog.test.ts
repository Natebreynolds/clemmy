/**
 * Run: npx tsx --test src/execution/workflow-watchdog.test.ts
 *
 * Pure-function tests for the queued-stall detector. No I/O, no clock —
 * `now` is injected so the threshold logic is deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStalledRuns, type WatchdogRunView } from './workflow-watchdog.js';

const T0 = 1_780_000_000_000; // fixed reference "now"
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString();
const FIVE_MIN = 5 * 60_000;

test('flags a run queued past the threshold', () => {
  const runs: WatchdogRunView[] = [
    { id: 'r1', workflow: 'proposal-audit-brief', status: 'queued', createdAt: iso(6 * 60_000) },
  ];
  const stalled = findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN });
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].id, 'r1');
  assert.equal(stalled[0].reason, 'queued_not_draining');
  assert.ok(stalled[0].ageMs >= FIVE_MIN);
});

test('does NOT flag a freshly-queued run (will be picked up next tick)', () => {
  const runs: WatchdogRunView[] = [
    { id: 'r1', workflow: 'wf', status: 'queued', createdAt: iso(30_000) },
  ];
  assert.equal(findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN }).length, 0);
});

test('ignores non-queued statuses (running/completed/error/awaiting_approval)', () => {
  const old = iso(60 * 60_000);
  const runs: WatchdogRunView[] = [
    { id: 'a', workflow: 'wf', status: 'running', createdAt: old },
    { id: 'b', workflow: 'wf', status: 'completed', createdAt: old },
    { id: 'c', workflow: 'wf', status: 'error', createdAt: old },
    { id: 'd', workflow: 'wf', status: 'awaiting_approval', createdAt: old },
  ];
  assert.equal(findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN }).length, 0);
});

test('treats a missing status as queued (the bare run stub from the dashboard)', () => {
  const runs: WatchdogRunView[] = [
    { id: 'stub', workflow: 'proposal-audit-brief', createdAt: iso(10 * 60_000) },
  ];
  const stalled = findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN });
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].id, 'stub');
});

test('skips runs with an unparseable/absent createdAt (cannot age them)', () => {
  const runs: WatchdogRunView[] = [
    { id: 'x', workflow: 'wf', status: 'queued' },
    { id: 'y', workflow: 'wf', status: 'queued', createdAt: 'not-a-date' },
  ];
  assert.equal(findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN }).length, 0);
});

test('the audit-pileup scenario: five same-workflow runs all queued and old → all flagged', () => {
  const runs: WatchdogRunView[] = Array.from({ length: 5 }, (_, i) => ({
    id: `audit-${i}`,
    workflow: 'proposal-audit-brief',
    status: 'queued',
    createdAt: iso((10 + i) * 60_000),
  }));
  const stalled = findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN });
  assert.equal(stalled.length, 5);
});

// ── parked-run orphan safety net ────────────────────────────────────

test('findStalledRuns flags a run parked past the parked threshold (ages from parkedAt)', () => {
  const now = Date.parse('2026-05-28T02:00:00Z');
  const stalled = findStalledRuns(
    [{ id: 'p1', workflow: 'wf', status: 'parked', createdAt: '2026-05-27T00:00:00Z', parkedAt: '2026-05-28T00:30:00Z' }],
    now,
    { queuedStallMs: 5 * 60_000, parkedStallMs: 60 * 60_000 },
  );
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].id, 'p1');
  assert.equal(stalled[0].reason, 'parked_awaiting_approval');
  assert.equal(Math.round(stalled[0].ageMs / 60_000), 90);
});

test('findStalledRuns ignores a freshly-parked run within the parked threshold', () => {
  const now = Date.parse('2026-05-28T00:50:00Z');
  const stalled = findStalledRuns(
    [{ id: 'p1', workflow: 'wf', status: 'parked', parkedAt: '2026-05-28T00:30:00Z' }],
    now,
    { queuedStallMs: 5 * 60_000, parkedStallMs: 60 * 60_000 },
  );
  assert.equal(stalled.length, 0);
});

test('findStalledRuns falls back to createdAt for a legacy parked run with no parkedAt', () => {
  const now = Date.parse('2026-05-28T02:00:00Z');
  const stalled = findStalledRuns(
    [{ id: 'p1', workflow: 'wf', status: 'parked', createdAt: '2026-05-28T00:30:00Z' }],
    now,
    { queuedStallMs: 5 * 60_000, parkedStallMs: 60 * 60_000 },
  );
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].reason, 'parked_awaiting_approval');
});
