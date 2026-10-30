import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-voice-checkin-readonly-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { createBackgroundTask, updateBackgroundTask } = await import('../execution/background-tasks.js');
const { createCheckIn, getCheckIn } = await import('../agents/check-ins.js');
const { listInboxQuestions } = await import('../execution/inbox-questions.js');
const { listAwaitingInputWorkflowRuns } = await import('../execution/workflow-awaiting-input.js');
const { addNotification, loadNotifications } = await import('../runtime/notifications.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const { closeMemoryDb } = await import('../memory/db.js');
test.after(() => { closeEventLog(); closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });

function bytesBelow(directory: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, bytesBelow(path.join(directory, entry.name), relative));
    else if (entry.isFile()) result[relative] = createHash('sha256').update(readFileSync(path.join(directory, entry.name))).digest('hex');
  }
  return result;
}

test('read-only canonical question projection excludes stale generations without settling their records', () => {
  const task = createBackgroundTask({ title: 'Controlled check-in read fixture', prompt: 'Use an exact controlled question.' });
  updateBackgroundTask(task.id, { status: 'awaiting_input', pendingQuestionId: 'controlled-q1', pendingQuestion: 'Which controlled account should I use?' });
  const old = createCheckIn({ agentSlug: 'Clem', question: 'Which controlled account should I use?', linkedTaskId: task.id, linkedQuestionId: 'controlled-q1' });
  updateBackgroundTask(task.id, { status: 'awaiting_input', pendingQuestionId: 'controlled-q2', pendingQuestion: 'Which controlled period should I use?' });
  const before = bytesBelow(home);
  const rows = listInboxQuestions({ reconcile: false });
  assert.equal(rows.some(row => row.id === `checkin:${old.id}`), false);
  assert.equal(rows.some(row => row.id === 'task:controlled-q2'), true);
  assert.deepEqual(bytesBelow(home), before, 'the read may not close check-ins, mark notices read, or create recovery files');
  assert.equal(getCheckIn(old.id)?.status, 'open');
  listInboxQuestions();
  assert.equal(getCheckIn(old.id)?.status, 'closed', 'ordinary Inbox reconciliation retains its existing default');
});

test('read-only workflow question lookup does not reconcile stale notification carriers', () => {
  const runs = path.join(home, 'workflows', 'runs');
  mkdirSync(runs, { recursive: true });
  writeFileSync(path.join(runs, 'controlled-ended-run.json'), JSON.stringify({ id: 'controlled-ended-run', workflow: 'Controlled workflow', status: 'completed' }));
  const notice = { id: 'controlled-ended-notice', createdAt: '2026-10-29T18:00:00.000Z', read: false,
    kind: 'workflow' as const, title: 'Controlled workflow question', body: 'A controlled question carrier.',
    metadata: { status: 'awaiting_input', runId: 'controlled-ended-run', questionId: 'controlled-ended-question' } };
  addNotification(notice);
  const before = bytesBelow(home);
  assert.equal(listAwaitingInputWorkflowRuns({ reconcile: false }).some(row => row.runId === 'controlled-ended-run'), false);
  assert.deepEqual(bytesBelow(home), before);
  assert.equal(loadNotifications().find(row => row.id === notice.id)?.read, false);
  listAwaitingInputWorkflowRuns();
  assert.equal(loadNotifications().find(row => row.id === notice.id)?.read, true, 'default reconciliation remains unchanged');
});
