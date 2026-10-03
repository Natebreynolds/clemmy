/**
 * Run: node scripts/run-tests-isolated.mjs packages/chat-engine/src/delegated-task-activity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceActivity } from './reduce-activity.js';
import type { ActivityItem, HarnessEvent } from './types.js';

let seq = 0;
const ev = (data: Record<string, unknown>): HarnessEvent => ({ seq: ++seq, type: 'delegated_task_state', data } as HarnessEvent);
const fold = (events: HarnessEvent[]): ActivityItem[] => events.reduce<ActivityItem[]>((rows, event) => reduceActivity(rows, event), []);
const base = { taskId: 'bg-1', title: 'Draft the weekly briefing', agentName: 'Sales Assistant', projectName: 'Weekly Sales', contractVersion: 1 };

test('a delegated task is one row that names its owner and moves only when the task did', () => {
  const started = fold([ev({ ...base, phase: 'dispatched', status: 'pending' }), ev({ ...base, phase: 'started', status: 'running' })]);
  assert.equal(started.length, 1);
  assert.deepEqual([started[0]!.id, started[0]!.kind, started[0]!.label, started[0]!.detail, started[0]!.status],
    ['delegated-bg-1', 'agent', 'Sales Assistant · Draft the weekly briefing', 'Working', 'running']);

  const revised = fold([ev({ ...base, phase: 'started' }),
    ev({ ...base, phase: 'revised', contractVersion: 2, instruction: 'Focus on this week and exclude unqualified leads.' })]);
  assert.equal(revised[0]!.detail, 'Your correction was added (request v2): Focus on this week and exclude unqualified leads.');
  assert.equal(revised[0]!.status, 'running');

  const waiting = fold([ev({ ...base, phase: 'started' }), ev({ ...base, phase: 'needs_you', question: 'Which region?' })]);
  assert.deepEqual([waiting[0]!.detail, waiting[0]!.tone, waiting[0]!.status], ['Which region?', 'warning', 'running']);

  const finished = fold([ev({ ...base, phase: 'started' }), ev({ ...base, phase: 'finished', contractVersion: 2 })]);
  assert.deepEqual([finished[0]!.detail, finished[0]!.status, finished[0]!.tone], ['Finished (request v2)', 'done', 'success']);
  const stopped = fold([ev({ ...base, phase: 'started' }), ev({ ...base, phase: 'stopped' })]);
  assert.deepEqual([stopped[0]!.detail, stopped[0]!.status], ['Stopped', 'interrupted']);
  const failed = fold([ev({ ...base, phase: 'failed', reason: 'The reporting account is not connected.' })]);
  assert.deepEqual([failed[0]!.detail, failed[0]!.status, failed[0]!.tone], ['The reporting account is not connected.', 'failed', 'danger']);

  // Resumed after a stop: the same row runs again.
  const resumed = fold([ev({ ...base, phase: 'started' }), ev({ ...base, phase: 'stopped' }), ev({ ...base, phase: 'started' })]);
  assert.deepEqual([resumed.length, resumed[0]!.status, resumed[0]!.finishedAt], [1, 'running', undefined]);
});

test('a task Clem kept, a second task, and a state this surface does not know', () => {
  const rows = fold([
    ev({ taskId: 'bg-2', title: 'Tidy the notes', phase: 'started' }),
    ev({ ...base, phase: 'started' }),
    ev({ ...base, phase: 'teleported' }),
    ev({ title: 'No id', phase: 'started' }),
  ]);
  assert.deepEqual(rows.map((row) => row.label), ['Clem · Tidy the notes', 'Sales Assistant · Draft the weekly briefing']);
  assert.deepEqual(rows.map((row) => row.detail), ['Working', 'Working']);
});

test("the row shows the agent's latest check-in while it works, and an empty note changes nothing", () => {
  const rows = fold([
    ev({ taskId: 'lead-1', title: 'Fixture audit', phase: 'started', agentName: 'Fixture Lead' }),
    ev({ taskId: 'lead-1', title: 'Fixture audit', phase: 'check_in', agentName: 'Fixture Lead', note: 'Plan: four workers.' }),
    ev({ taskId: 'lead-1', title: 'Fixture audit', phase: 'check_in', agentName: 'Fixture Lead', note: '3 of 4 done; backlinks partial.' }),
    ev({ taskId: 'lead-1', title: 'Fixture audit', phase: 'check_in', agentName: 'Fixture Lead', note: '' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, 'Fixture Lead · Fixture audit');
  assert.equal(rows[0]!.detail, '3 of 4 done; backlinks partial.');
  assert.equal(rows[0]!.status, 'running');
});

test('a card shows the newest check-ins, oldest first, and an older Mac without them shows none', async () => {
  const { delegatedTaskCheckIns } = await import('./delegated-task.js');
  const many = Array.from({ length: 9 }, (_, i) => ({ at: `2026-10-03T12:0${i}:00Z`, note: `note ${i}` }));
  assert.deepEqual(delegatedTaskCheckIns({ checkIns: many }).map((entry) => entry.note), ['note 3', 'note 4', 'note 5', 'note 6', 'note 7', 'note 8']);
  assert.deepEqual(delegatedTaskCheckIns({}), []);
});
