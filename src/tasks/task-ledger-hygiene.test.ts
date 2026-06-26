/**
 * Run: npx tsx --test src/tasks/task-ledger-hygiene.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-task-hygiene-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  runTaskLedgerHygiene,
} = await import('./task-ledger-hygiene.js');
const { TASKS_FILE, ensureTasksFile, parseTasks } = await import('../tools/shared.js');

const EXECUTIONS_FILE = path.join(TMP_HOME, 'state', 'executions.json');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function seed(): void {
  mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
  ensureTasksFile();
  writeFileSync(
    TASKS_FILE,
    [
      '---',
      'type: tasks',
      '---',
      '',
      '# Tasks',
      '',
      '## Pending',
      '',
      '- [ ] {T-001} Stale manual row !!high 📅 2026-01-01',
      '- [x] {T-002} Already checked but still under Pending !!medium',
      '- [ ] {T-003} Completed execution-owned row !!high',
      '- [ ] {T-004} Legit current manual row !!high 📅 2099-01-01',
      '',
      '## Completed',
      '',
      '- [x] {T-005} Existing completed row !!low',
      '',
    ].join('\n'),
    'utf-8',
  );

  const now = '2026-06-26T12:00:00.000Z';
  writeFileSync(
    EXECUTIONS_FILE,
    JSON.stringify([
      {
        id: 'exec-done',
        sessionId: 'sess-task-hygiene',
        channel: 'test',
        title: 'done',
        objective: 'done',
        reason: 'test',
        status: 'completed',
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        startedFromMessage: 'test',
        confidence: 0.9,
        reasons: ['test'],
        taskBindings: [
          { taskId: 'T-003', description: 'Completed execution-owned row', status: 'pending', createdAt: now },
        ],
      },
    ], null, 2),
    'utf-8',
  );
}

test('task ledger hygiene repairs owner-completed rows, stale unowned rows, and compacts Pending', () => {
  seed();
  const result = runTaskLedgerHygiene({
    apply: true,
    closeUnownedBefore: '2026-06-25',
    now: new Date('2026-06-26T12:00:00.000Z'),
  });

  assert.equal(result.pendingTasks, 3);
  assert.equal(result.completedOwnerTasks, 1);
  assert.equal(result.staleUnownedTasks, 1);
  assert.equal(result.checkedTaskRows, 2);
  assert.equal(result.compactedTaskRows, 3);
  assert.equal(result.updatedBindings, 1);

  const body = readFileSync(TASKS_FILE, 'utf-8');
  const pendingSection = body.slice(body.indexOf('## Pending'), body.indexOf('## Completed'));
  const completedSection = body.slice(body.indexOf('## Completed'));
  assert.doesNotMatch(pendingSection, /T-001|T-002|T-003/);
  assert.match(pendingSection, /T-004/);
  assert.match(completedSection, /T-001/);
  assert.match(completedSection, /T-002/);
  assert.match(completedSection, /T-003/);
  assert.match(completedSection, /T-005/);

  const tasks = parseTasks(body);
  assert.equal(tasks.find((task) => task.id === 'T-001')?.status, 'completed');
  assert.equal(tasks.find((task) => task.id === 'T-003')?.status, 'completed');
  assert.equal(tasks.find((task) => task.id === 'T-004')?.status, 'pending');

  const executions = JSON.parse(readFileSync(EXECUTIONS_FILE, 'utf-8'));
  assert.equal(executions[0].taskBindings[0].status, 'completed');
  assert.ok(executions[0].taskBindings[0].completedAt);
});
