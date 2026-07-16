/**
 * Run: npx tsx --test src/execution/workflow-watchdog.test.ts
 *
 * Pure-function tests for the queued-stall detector. No I/O, no clock —
 * `now` is injected so the threshold logic is deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findStalledRuns,
  dropReportedBackTerminalRuns,
  reportedBackRunIdsFrom,
  workflowWatchdogAlertIdsFrom,
  recommendedRecoveryForStalledRun,
  type WatchdogRunView,
  type StalledRun,
} from './workflow-watchdog.js';

const T0 = 1_780_000_000_000; // fixed reference "now"
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString();
const FIVE_MIN = 5 * 60_000;

test('recommendedRecoveryForStalledRun maps every watchdog reason to a concrete Tasks action', () => {
  assert.deepEqual(
    recommendedRecoveryForStalledRun({ id: 'q1', workflow: 'wf', reason: 'queued_not_draining' }),
    {
      action: 'open_tasks',
      label: 'Open Tasks',
      detail: 'Open Tasks to start or reprioritize the queued run; restart the daemon if the queue still does not drain.',
      href: '/tasks',
    },
  );
  assert.equal(
    recommendedRecoveryForStalledRun({ id: 'p1', workflow: 'wf', reason: 'parked_awaiting_approval' }).action,
    'approve_or_reject',
  );
  assert.equal(
    recommendedRecoveryForStalledRun({ id: 'r1', workflow: 'wf', reason: 'running_silent' }).action,
    'cancel_and_resume',
  );
  assert.equal(
    recommendedRecoveryForStalledRun({ id: 't1', workflow: 'wf', reason: 'terminal_unnotified' }).action,
    'open_result',
  );
});

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

test('ignores terminal/other statuses; ACTIVE running runs are exempt only while alive', () => {
  const old = iso(60 * 60_000);
  const runs: WatchdogRunView[] = [
    // running + RECENT activity → alive, not stalled
    { id: 'a', workflow: 'wf', status: 'running', createdAt: old, lastActivityAt: iso(60_000) },
    { id: 'b', workflow: 'wf', status: 'completed', createdAt: old },
    { id: 'c', workflow: 'wf', status: 'error', createdAt: old },
    { id: 'd', workflow: 'wf', status: 'awaiting_approval', createdAt: old },
  ];
  assert.equal(findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN }).length, 0);
});

test('running_silent: a running run with NO step activity past the window is flagged (turn-stall layer 3)', () => {
  const runs: WatchdogRunView[] = [
    // wedged: running for an hour, last event 30 min ago
    { id: 'wedged', workflow: 'wf', status: 'running', createdAt: iso(60 * 60_000), lastActivityAt: iso(30 * 60_000) },
    // alive: event 1 min ago
    { id: 'alive', workflow: 'wf', status: 'running', createdAt: iso(60 * 60_000), lastActivityAt: iso(60_000) },
    // no events at all (lastActivityAt absent) → age from createdAt
    { id: 'never-started', workflow: 'wf', status: 'running', createdAt: iso(20 * 60_000) },
  ];
  const stalled = findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN, runningSilentStallMs: 10 * 60_000 });
  assert.deepEqual(stalled.map((r) => r.id).sort(), ['never-started', 'wedged']);
  assert.ok(stalled.every((r) => r.reason === 'running_silent'));
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

// ── terminal-unnotified report-back backstop ────────────────────────

test('flags a completed run that finished past the threshold but was never notified', () => {
  const runs: WatchdogRunView[] = [
    { id: 't1', workflow: 'wf', status: 'completed', finishedAt: iso(5 * 60_000) },
  ];
  const stalled = findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN });
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].id, 't1');
  assert.equal(stalled[0].reason, 'terminal_unnotified');
});

test('flags an errored run that was never notified', () => {
  const runs: WatchdogRunView[] = [
    { id: 't2', workflow: 'wf', status: 'error', finishedAt: iso(10 * 60_000) },
  ];
  const stalled = findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN });
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].reason, 'terminal_unnotified');
});

test('does NOT flag a terminal run that WAS notified', () => {
  const runs: WatchdogRunView[] = [
    { id: 't3', workflow: 'wf', status: 'completed', finishedAt: iso(10 * 60_000), notifiedAt: iso(10 * 60_000) },
  ];
  assert.equal(findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN }).length, 0);
});

test('flags a CANCELLED run that was never notified (was an uncovered terminal state)', () => {
  const runs: WatchdogRunView[] = [
    { id: 'tc', workflow: 'wf', status: 'cancelled', finishedAt: iso(10 * 60_000) },
  ];
  const stalled = findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN });
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].reason, 'terminal_unnotified');
});

test('does NOT flag a cancelled run that WAS notified', () => {
  const runs: WatchdogRunView[] = [
    { id: 'tc2', workflow: 'wf', status: 'cancelled', finishedAt: iso(10 * 60_000), notifiedAt: iso(10 * 60_000) },
  ];
  assert.equal(findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN }).length, 0);
});

test('does NOT flag a just-finished terminal run (notify may still be landing this tick)', () => {
  const runs: WatchdogRunView[] = [
    { id: 't4', workflow: 'wf', status: 'completed', finishedAt: iso(30_000) },
  ];
  assert.equal(findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN }).length, 0);
});

test('does NOT flag an ancient unnotified terminal run (outside the backlog window)', () => {
  const runs: WatchdogRunView[] = [
    { id: 't5', workflow: 'wf', status: 'completed', finishedAt: iso(24 * 60 * 60_000) },
  ];
  assert.equal(findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN }).length, 0);
});

test('skips a terminal-unnotified run with no finishedAt (cannot age it)', () => {
  const runs: WatchdogRunView[] = [
    { id: 't6', workflow: 'wf', status: 'completed' },
  ];
  assert.equal(findStalledRuns(runs, T0, { queuedStallMs: FIVE_MIN }).length, 0);
});

// ── ground-truth report-back filter (deploy-boundary false-positive guard) ──

test('dropReportedBackTerminalRuns: drops a terminal_unnotified run that has a delivered notification', () => {
  const stalled: StalledRun[] = [
    { id: 'legacy-done', workflow: 'outlook-triage-hourly', ageMs: 8 * 60_000, reason: 'terminal_unnotified' },
  ];
  // The run completed + reported back under a prior code version → no notifiedAt
  // marker, but the completion notification carries its runId. Must NOT alarm.
  const kept = dropReportedBackTerminalRuns(stalled, new Set(['legacy-done']));
  assert.equal(kept.length, 0);
});

test('dropReportedBackTerminalRuns: KEEPS a terminal_unnotified run with no delivered notification (genuine loss)', () => {
  const stalled: StalledRun[] = [
    { id: 'truly-lost', workflow: 'wf', ageMs: 8 * 60_000, reason: 'terminal_unnotified' },
  ];
  const kept = dropReportedBackTerminalRuns(stalled, new Set(['some-other-run']));
  assert.deepEqual(kept.map((r) => r.id), ['truly-lost']);
});

test('dropReportedBackTerminalRuns: never suppresses queued/parked reasons even if the runId reported before', () => {
  // A run can finish, report back, then be re-queued/parked under the same id —
  // the report-back set must only gate terminal_unnotified, not live stalls.
  const stalled: StalledRun[] = [
    { id: 'shared', workflow: 'wf', ageMs: 9 * 60_000, reason: 'queued_not_draining' },
    { id: 'shared2', workflow: 'wf', ageMs: 90 * 60_000, reason: 'parked_awaiting_approval' },
  ];
  const kept = dropReportedBackTerminalRuns(stalled, new Set(['shared', 'shared2']));
  assert.equal(kept.length, 2);
});

// ── delivery-aware ground truth: only a DELIVERED notification counts (GAP #1) ──

test('reportedBackRunIdsFrom: a DELIVERED notification counts as reported-back', () => {
  const ids = reportedBackRunIdsFrom([
    { id: 'n1', deliveredAt: iso(0), metadata: { runId: 'r1' } },
    { id: 'n2', deliveredDestinations: ['discord'], metadata: { runId: 'r2' } },
  ]);
  assert.ok(ids.has('r1') && ids.has('r2'));
});

test('reportedBackRunIdsFrom: a SILENT/UNDELIVERED notification does NOT count (no masking the silent loss)', () => {
  // The runner's silenced completion echo: carries runId but was never delivered.
  const ids = reportedBackRunIdsFrom([
    { id: 'echo', metadata: { runId: 'lost' } }, // no deliveredAt, no destinations
    { id: 'echo2', deliveredDestinations: [], metadata: { runId: 'lost2' } },
  ]);
  assert.ok(!ids.has('lost') && !ids.has('lost2'), 'undelivered records must not satisfy ground truth');
});

test('reportedBackRunIdsFrom: accepts a step notify_user card keyed by workflowRunId', () => {
  const ids = reportedBackRunIdsFrom([
    { id: 'step', deliveredAt: iso(0), metadata: { source: 'notify_user_tool', workflowRunId: 'wfr' } },
  ]);
  assert.ok(ids.has('wfr'), 'a delivered step card (workflowRunId) proves the run reported back');
});

test('reportedBackRunIdsFrom: ignores the watchdog\'s own stalled alerts', () => {
  const ids = reportedBackRunIdsFrom([
    { id: 'workflow-stalled-xyz', deliveredAt: iso(0), metadata: { runId: 'xyz' } },
  ]);
  assert.ok(!ids.has('xyz'), 'the watchdog alert is not the run reporting back');
});

test('workflowWatchdogAlertIdsFrom recognizes every stable watchdog namespace', () => {
  const ids = workflowWatchdogAlertIdsFrom([
    { id: 'workflow-stalled-queued-1' },
    { id: 'workflow-stalled-terminal-done-1' },
    { id: 'workflow-heartbeat-live-1' },
    {},
  ]);
  assert.deepEqual([...ids].sort(), ['workflow-stalled-queued-1', 'workflow-stalled-terminal-done-1']);
});

test('reportedBackRunIdsFrom: a delivered HEARTBEAT does not count as report-back (no masking a lost terminal result)', () => {
  const ids = reportedBackRunIdsFrom([
    { id: 'workflow-heartbeat-run9-2', deliveredAt: iso(0), metadata: { runId: 'run9', heartbeat: true } },
  ]);
  assert.ok(!ids.has('run9'), 'a "still running" ping is not the run reporting its outcome');
});

test('reportedBackRunIdsFrom: a delivered LOUD progress update (T4.1) does not count as report-back', () => {
  // The new channel-visible "Workflow update:" ping keeps the workflow-heartbeat-
  // id prefix and metadata.heartbeat exactly so this exclusion holds — a
  // delivered mid-run update must never mask a lost terminal report.
  const ids = reportedBackRunIdsFrom([
    { id: 'workflow-heartbeat-loud-run11-2', deliveredAt: iso(0), deliveredDestinations: ['discord'], metadata: { runId: 'run11', heartbeat: true, progressUpdate: true } },
  ]);
  assert.ok(!ids.has('run11'), 'a delivered loud progress update is not the run reporting its outcome');
});

test('reportedBackRunIdsFrom: a delivered APPROVAL/recovery card does not count as report-back', () => {
  const ids = reportedBackRunIdsFrom([
    { id: 'approval-apr123', deliveredAt: iso(0), metadata: { runId: 'run10' } },
  ]);
  assert.ok(!ids.has('run10'), 'a parked approval card is not a terminal outcome');
});

test('reportedBackRunIdsFrom + dropReportedBackTerminalRuns: silenced undelivered echo no longer masks a genuine loss', () => {
  const reported = reportedBackRunIdsFrom([
    { id: 'silenced-echo', metadata: { runId: 'self-notify-run' } }, // silent + undelivered
  ]);
  const stalled: StalledRun[] = [
    { id: 'self-notify-run', workflow: 'wf', ageMs: 8 * 60_000, reason: 'terminal_unnotified' },
  ];
  // Before the fix the undelivered echo would have masked this; now it's KEPT.
  assert.deepEqual(dropReportedBackTerminalRuns(stalled, reported).map((r) => r.id), ['self-notify-run']);
});
