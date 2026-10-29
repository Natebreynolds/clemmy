/** Run: node scripts/run-tests-isolated.mjs src/execution/missed-while-closed.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-missed-while-closed-'));
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const missed = await import('./missed-while-closed.js');

const notice = (read = false) => ({
  id: 'system-workflows-missed-while-closed-1', kind: 'workflow' as const, title: '2 scheduled workflows didn\'t run', body: 'facts',
  createdAt: '2026-10-29T23:03:47.000Z', read,
  metadata: { errorCategory: missed.MISSED_WHILE_CLOSED, needsAttention: true, heartbeatId: 'schedules', itemKey: 'missed-while-closed:1',
    missed: [{ workflow: 'fixture-team-update', dueAt: '2026-10-29T23:00:00.000Z', times: 1 },
      { workflow: 'fixture-channel-review', dueAt: '2026-10-29T23:00:00.000Z', times: 2 }] },
});

test('the owner runs one now and skips the other; the list settles and keeps showing the run', () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'fixture-run-1.json'), JSON.stringify({ id: 'fixture-run-1', status: 'running', stepsCompleted: 1, stepsTotal: 3, currentStepId: 'pull' }));
  const marked: string[] = [];
  const open = [notice()];
  const first = missed.readMissedWhileClosed(open);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0]!.items.map((item) => [item.name, item.times, item.decision]), [['Fixture Team Update', 1, undefined], ['Fixture Channel Review', 2, undefined]]);
  assert.equal(first[0]!.settled, false);

  assert.deepEqual(missed.decideMissedRun({ noticeId: open[0]!.id, workflow: 'fixture-team-update', action: 'run', runId: 'fixture-run-1' },
    { notifications: open, markRead: (id) => marked.push(id) }), { ok: true, settled: false });
  assert.deepEqual(marked, [], 'not settled while one is undecided');
  assert.deepEqual(missed.decideMissedRun({ noticeId: open[0]!.id, workflow: 'fixture-channel-review', action: 'skip' },
    { notifications: open, markRead: (id) => marked.push(id) }), { ok: true, settled: true });
  assert.deepEqual(marked, [open[0]!.id], 'Needs you clears once every one is decided');

  const settled = missed.readMissedWhileClosed([notice(true)]);
  assert.equal(settled.length, 1, 'a settled list stays to show its runs');
  assert.equal(settled[0]!.settled, true);
  assert.deepEqual(settled[0]!.items[0]!.run, { status: 'running', stepsCompleted: 1, stepsTotal: 3, currentStepId: 'pull' });
  assert.equal(settled[0]!.items[1]!.decision?.action, 'skip');

  missed.dismissMissedNotice(open[0]!.id);
  assert.deepEqual(missed.readMissedWhileClosed([notice(true)]), [], 'the owner closes the record');
});

test('a decision names a workflow on the list, and a run names the run it started', () => {
  const open = [notice()];
  assert.equal(missed.decideMissedRun({ noticeId: open[0]!.id, workflow: 'not-on-the-list', action: 'skip' }, { notifications: open, markRead() {} }).ok, false);
  assert.equal(missed.decideMissedRun({ noticeId: open[0]!.id, workflow: 'fixture-team-update', action: 'run' }, { notifications: open, markRead() {} }).ok, false);
  assert.equal(missed.decideMissedRun({ noticeId: 'gone', workflow: 'fixture-team-update', action: 'skip' }, { notifications: open, markRead() {} }).ok, false);
});
