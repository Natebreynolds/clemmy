/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-scheduler-missed-while-closed.test.ts
 *
 * Owner 2026-10-29: "Clem should be smart enough to ask: hey, we missed these
 * workflows while down, want me to run any of them?" Live, two 4 PM runs that
 * came due while the app was closed both fired on reopen into one queue; the
 * second waited 27 minutes and its time-bound step refused. A run that came due
 * while Clementine was closed is now offered, not fired; lateness while she is
 * open still fires as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clementine-missed-while-closed-'));
process.env.CLEMENTINE_HOME = home;

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { processWorkflowSchedules, _testOnly_setSchedulerProcessId } = await import('./workflow-scheduler.js');
const { writeWorkflowAndSyncTriggers } = await import('./workflow-write.js');
const { loadNotifications } = await import('../runtime/notifications.js');

const runFiles = () => { try { return readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json')); } catch { return []; } };
const missedNotices = () => loadNotifications().filter((n) => n.metadata?.errorCategory === 'workflow_missed_while_closed');

for (const name of ['fixture-team-update', 'fixture-channel-review']) {
  writeWorkflowAndSyncTriggers(name, {
    name, description: `Controlled fixture ${name}.`, enabled: true,
    trigger: { schedule: '0 16 * * *', timezone: 'UTC' },
    steps: [{ id: 'main', prompt: 'Controlled fixture step.' }],
  });
}

test('runs that came due while Clementine was closed are offered in one notice, not fired', async () => {
  _testOnly_setSchedulerProcessId('before-close');
  const before = await processWorkflowSchedules(new Date('2026-07-15T15:58:00.000Z'));
  assert.deepEqual(before.fired, []);

  // Clementine closes at 15:58 and reopens at 16:03; both 4 PM runs fell due in between.
  _testOnly_setSchedulerProcessId('after-reopen');
  const reopened = await processWorkflowSchedules(new Date('2026-07-15T16:03:30.000Z'));
  assert.deepEqual(reopened.fired, [], 'nothing missed while closed starts on its own');
  assert.deepEqual([...(reopened.offered ?? [])].sort(), ['fixture-channel-review', 'fixture-team-update']);
  assert.deepEqual(runFiles(), []);

  const notices = missedNotices();
  assert.equal(notices.length, 1, 'one notice for the reopen, not one per workflow');
  const notice = notices[0]!;
  assert.equal(notice.metadata?.needsAttention, true);
  assert.equal(notice.metadata?.heartbeatId, 'schedules');
  assert.match(String(notice.metadata?.itemKey), /^missed-while-closed:/);
  assert.match(notice.title, /^2 scheduled workflows didn't run while Clementine was closed/);
  assert.match(notice.body, /Fixture Team Update: due /);
  assert.match(notice.body, /Fixture Channel Review: due /);
  assert.match(notice.body, /A run started now counts from now\./);

  // The next tick of the same Clementine neither fires them nor asks again.
  const next = await processWorkflowSchedules(new Date('2026-07-15T16:04:00.000Z'));
  assert.deepEqual(next.fired, []);
  assert.equal(next.offered, undefined);
  assert.equal(missedNotices().length, 1);
});

test('a run that is only late while Clementine is open still fires', async () => {
  _testOnly_setSchedulerProcessId('open-all-along');
  await processWorkflowSchedules(new Date('2026-07-16T15:58:00.000Z'));
  // Same Clementine, a tick that came late (a busy event loop, not a closed app).
  const late = await processWorkflowSchedules(new Date('2026-07-16T16:03:30.000Z'));
  assert.deepEqual([...late.fired].sort(), ['fixture-channel-review', 'fixture-team-update']);
  assert.equal(late.offered, undefined);
  assert.equal(missedNotices().length, 1, 'no new notice');
});
