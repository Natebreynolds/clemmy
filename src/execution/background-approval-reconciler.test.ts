/** Run: node scripts/run-tests-isolated.mjs src/execution/background-approval-reconciler.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-background-approval-reconcile-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_HARNESS_BACKGROUND = 'off';

const background = await import('./background-tasks.js');
const reconciler = await import('./background-approval-reconciler.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const notifications = await import('../runtime/notifications.js');
const { ApprovalStore } = await import('../runtime/approval-store.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

let sequence = 0;

function createTask(label: string) {
  sequence += 1;
  const task = background.createBackgroundTask({
    title: `${label}-${sequence}`,
    prompt: `Complete ${label}-${sequence}.`,
    source: 'daemon',
  });
  eventlog.createSession({ id: task.runSessionId, kind: 'execution' });
  return task;
}

function registerApproval(sessionId: string) {
  return approvalRegistry.register({
    sessionId,
    subject: 'Send one exact background-task result',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'SEND_EXACT_RESULT', payload: 'frozen' },
  });
}

test('approved canonical decision queues the exact task once and duplicate boot/tick passes are inert', () => {
  const task = createTask('approved');
  const row = registerApproval(task.runSessionId);
  assert.equal(background.markBackgroundTaskAwaitingApproval(task.id, row.approvalId, 'Waiting.')?.status, 'awaiting_approval');
  assert.equal(approvalRegistry.resolve(row.approvalId, 'approved', 'test-human').ok, true);

  let kicks = 0;
  background.registerBackgroundDrainKick(() => { kicks += 1; });
  const first = reconciler.reconcileBackgroundTaskApprovals({ approvalId: row.approvalId });
  assert.equal(first.queuedApproved, 1);
  assert.equal(first.queuedRejected, 0);
  const queued = background.getBackgroundTask(task.id);
  assert.equal(queued?.status, 'pending');
  assert.deepEqual(queued?.approvalResolution, {
    approvalId: row.approvalId,
    approved: true,
    queuedAt: queued?.approvalResolution?.queuedAt,
  });
  assert.equal(kicks, 1, 'the durable queue CAS requests one immediate drain');

  const second = reconciler.reconcileBackgroundTaskApprovals({ approvalId: row.approvalId });
  assert.equal(second.scanned, 0, 'second boot/tick cannot enqueue the already-owned task again');
  assert.equal(kicks, 1);
  assert.equal(background.getBackgroundTask(task.id)?.approvalResolution?.queuedAt, queued?.approvalResolution?.queuedAt);
  background.archiveBackgroundTask(task.id);
});

for (const resolution of ['rejected', 'expired', 'cancelled_by_system'] as const) {
  test(`${resolution} canonical decision terminalizes without provider or model dispatch`, async () => {
    const task = createTask(resolution);
    const row = registerApproval(task.runSessionId);
    assert.equal(background.markBackgroundTaskAwaitingApproval(task.id, row.approvalId, 'Waiting.')?.status, 'awaiting_approval');
    assert.equal(approvalRegistry.resolve(row.approvalId, resolution, 'test-human').ok, true);

    const reconciled = reconciler.reconcileBackgroundTaskApprovals({ approvalId: row.approvalId });
    assert.equal(reconciled.queuedRejected, 1);
    assert.equal(background.getBackgroundTask(task.id)?.approvalResolution?.approved, false);

    let legacyDispatches = 0;
    let modelDispatches = 0;
    assert.equal(await background.processBackgroundTasks({
      getRuntime() {
        return {
          async resolveApproval() {
            legacyDispatches += 1;
            throw new Error('legacy provider dispatch must remain unreachable');
          },
        };
      },
      async respond() {
        modelDispatches += 1;
        throw new Error('model dispatch must remain unreachable');
      },
    } as never, 1), 1);
    assert.equal(legacyDispatches, 0);
    assert.equal(modelDispatches, 0);
    assert.equal(background.getBackgroundTask(task.id)?.status, 'aborted');
  });
}

test('missing canonical and legacy rows become one visible typed block with restart/cancel guidance', () => {
  const task = createTask('missing');
  const approvalId = 'apr-missing-background-owner';
  assert.equal(background.markBackgroundTaskAwaitingApproval(task.id, approvalId, 'Waiting.')?.status, 'awaiting_approval');

  const first = reconciler.reconcileBackgroundTaskApprovals({ approvalId });
  assert.equal(first.blockedMissing, 1);
  const blocked = background.getBackgroundTask(task.id);
  assert.equal(blocked?.status, 'blocked');
  assert.match(blocked?.error ?? '', /absent from both durable approval stores/i);
  assert.match(blocked?.outcomeSnapshot?.nextAction ?? '', /cancel.*restart|restart.*cancel/i);
  assert.equal(blocked?.outcomeSnapshot?.resumable, true);

  const visible = notifications.listNotifications(200).filter((item) => (
    item.metadata?.backgroundTaskId === task.id
    && item.metadata?.approvalReconciliation === 'approval_registry_missing'
    && !item.read
  ));
  assert.equal(visible.length, 1);
  assert.equal(reconciler.reconcileBackgroundTaskApprovals({ approvalId }).scanned, 0);
  const replayed = notifications.listNotifications(200).filter((item) => (
    item.metadata?.backgroundTaskId === task.id
    && item.metadata?.approvalReconciliation === 'approval_registry_missing'
    && !item.read
  ));
  assert.equal(replayed.length, 1, 'a second boot does not duplicate the blocked card/report');
});

test('mismatched and multiply-bound registry rows block without queueing authority', () => {
  const mismatch = createTask('mismatch');
  const otherSessionId = `background:other-${sequence}`;
  eventlog.createSession({ id: otherSessionId, kind: 'execution' });
  const mismatchedRow = registerApproval(otherSessionId);
  background.markBackgroundTaskAwaitingApproval(mismatch.id, mismatchedRow.approvalId, 'Waiting.');
  assert.equal(reconciler.reconcileBackgroundTaskApprovals({ approvalId: mismatchedRow.approvalId }).blockedMismatch, 1);
  assert.equal(background.getBackgroundTask(mismatch.id)?.status, 'blocked');

  const first = createTask('duplicate-a');
  const second = createTask('duplicate-b');
  const sharedSessionId = `background:duplicate-owner-${sequence}`;
  eventlog.createSession({ id: sharedSessionId, kind: 'execution' });
  background.updateBackgroundTask(first.id, { runSessionId: sharedSessionId });
  background.updateBackgroundTask(second.id, { runSessionId: sharedSessionId });
  const duplicatedRow = registerApproval(sharedSessionId);
  background.markBackgroundTaskAwaitingApproval(first.id, duplicatedRow.approvalId, 'Waiting.');
  background.markBackgroundTaskAwaitingApproval(second.id, duplicatedRow.approvalId, 'Waiting.');
  approvalRegistry.resolve(duplicatedRow.approvalId, 'approved', 'test-human');

  const duplicate = reconciler.reconcileBackgroundTaskApprovals({ approvalId: duplicatedRow.approvalId });
  assert.equal(duplicate.blockedAmbiguous, 2);
  assert.equal(duplicate.queuedApproved, 0);
  assert.equal(background.getBackgroundTask(first.id)?.status, 'blocked');
  assert.equal(background.getBackgroundTask(second.id)?.status, 'blocked');
});

test('late, consumed, or malformed approval authority blocks without dispatch', () => {
  for (const shape of ['late', 'consumed', 'malformed_pending'] as const) {
    const task = createTask(`invalid-${shape}`);
    const row = registerApproval(task.runSessionId);
    background.markBackgroundTaskAwaitingApproval(task.id, row.approvalId, 'Waiting.');
    if (shape !== 'malformed_pending') {
      approvalRegistry.resolve(row.approvalId, 'approved', 'test-human');
    }
    const db = eventlog.openEventLog();
    if (shape === 'late') {
      db.prepare('UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?')
        .run('2000-01-01T00:00:00.000Z', row.approvalId);
    } else if (shape === 'consumed') {
      db.prepare('UPDATE pending_approvals SET consumed_at = ? WHERE approval_id = ?')
        .run(new Date().toISOString(), row.approvalId);
    } else {
      db.prepare('UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?')
        .run('not-a-timestamp', row.approvalId);
    }

    const invalid = reconciler.reconcileBackgroundTaskApprovals({ approvalId: row.approvalId });
    assert.equal(invalid.blockedInvalid, 1);
    assert.equal(invalid.queuedApproved, 0);
    assert.equal(background.getBackgroundTask(task.id)?.status, 'blocked');
  }
});

test('legacy pending approval remains parked instead of being mislabeled missing during an upgrade', () => {
  const task = createTask('legacy-pending');
  const approvalId = `legacy-${sequence}`;
  new ApprovalStore().add({
    id: approvalId,
    sessionId: task.runSessionId,
    agentName: 'legacy-agent',
    toolName: 'legacy_send',
    createdAt: new Date().toISOString(),
    status: 'pending',
    state: '{}',
  });
  background.markBackgroundTaskAwaitingApproval(task.id, approvalId, 'Waiting.');
  const result = reconciler.reconcileBackgroundTaskApprovals({ approvalId });
  assert.equal(result.legacyPending, 1);
  assert.equal(result.blockedMissing, 0);
  assert.equal(background.getBackgroundTask(task.id)?.status, 'awaiting_approval');
  background.archiveBackgroundTask(task.id);
});

test('legacy approved authority without lifetime or consumption proof blocks instead of dispatching', () => {
  const task = createTask('legacy-approved-unverifiable');
  const approvalId = `legacy-approved-${sequence}`;
  new ApprovalStore().add({
    id: approvalId,
    sessionId: task.runSessionId,
    agentName: 'legacy-agent',
    toolName: 'legacy_send',
    createdAt: new Date().toISOString(),
    status: 'approved',
    state: '{}',
  });
  background.markBackgroundTaskAwaitingApproval(task.id, approvalId, 'Waiting.');

  const result = reconciler.reconcileBackgroundTaskApprovals({ approvalId });
  assert.equal(result.blockedInvalid, 1);
  assert.equal(result.queuedApproved, 0);
  assert.equal(background.getBackgroundTask(task.id)?.status, 'blocked');
  assert.equal(background.getBackgroundTask(task.id)?.approvalResolution, undefined);
});

test('registry storage exception leaves the task parked for retry and never invents a decision', () => {
  const task = createTask('storage-error');
  const approvalId = 'apr-storage-error';
  background.markBackgroundTaskAwaitingApproval(task.id, approvalId, 'Waiting.');
  let queued = 0;
  let blocked = 0;
  const result = reconciler.reconcileBackgroundTaskApprovals(
    { approvalId },
    {
      listAwaitingTasks: () => [background.getBackgroundTask(task.id)!],
      getCanonicalApproval: () => { throw new Error('database is temporarily unavailable'); },
      getLegacyApproval: () => undefined,
      queueDecision: () => { queued += 1; return null; },
      blockBinding: () => { blocked += 1; return null; },
    },
  );
  assert.equal(result.failed, 1);
  assert.equal(queued, 0);
  assert.equal(blocked, 0);
  assert.equal(background.getBackgroundTask(task.id)?.status, 'awaiting_approval');
  background.archiveBackgroundTask(task.id);
});

test('installed listener queues a decision once; boot and tick replays observe the same durable owner', () => {
  reconciler.installBackgroundTaskApprovalReconciler();
  const task = createTask('listener');
  const row = registerApproval(task.runSessionId);
  background.markBackgroundTaskAwaitingApproval(task.id, row.approvalId, 'Waiting.');
  assert.equal(approvalRegistry.resolve(row.approvalId, 'rejected', 'test-human').ok, true);
  assert.equal(background.getBackgroundTask(task.id)?.status, 'pending', 'registry listener queued the task synchronously');
  assert.equal(background.getBackgroundTask(task.id)?.approvalResolution?.approved, false);
  assert.equal(reconciler.reconcileBackgroundTaskApprovals({ approvalId: row.approvalId }).scanned, 0);
  assert.equal(reconciler.reconcileBackgroundTaskApprovals({ approvalId: row.approvalId }).scanned, 0);
  background.archiveBackgroundTask(task.id);
});

test('daemon installs the listener, reconciles on boot, and reconciles before every background drain', () => {
  const source = readFileSync(new URL('../daemon/runner.ts', import.meta.url), 'utf8');
  const install = source.indexOf('installBackgroundTaskApprovalReconciler();');
  const boot = source.indexOf('const approvals = reconcileBackgroundTaskApprovals();', install);
  const chatResume = source.indexOf("const { startChatApprovalResume }");
  assert.ok(install >= 0 && boot > install && chatResume > boot, 'background approval ownership settles before generic chat resume');

  const drain = source.indexOf('const drainBackgroundTasks = () => {');
  const tick = source.indexOf('const approvals = reconcileBackgroundTaskApprovals();', drain);
  const process = source.indexOf('processBackgroundTasks(assistant)', drain);
  assert.ok(drain >= 0 && tick > drain && process > tick, 'ordinary tick reconciles exact decisions before claiming pending tasks');
});
