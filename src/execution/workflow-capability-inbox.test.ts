import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-capability-inbox-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { projectWorkflowCapabilityInboxGate } = await import('./workflow-capability-inbox.js');
const {
  addNotification,
  getNotification,
  isNeedsAttentionNotification,
  loadNotifications,
  listQueuedNotificationDeliveries,
  markNotificationGroupRead,
  markNotificationRead,
  markWorkflowCapabilityNotificationsSettled,
  replaceQueuedNotificationDeliveries,
} = await import('../runtime/notifications.js');

test.after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

test('ambiguous account projection is exact, bounded, and carries the complete-set digest', () => {
  const candidates = Array.from({ length: 20 }, (_, index) => ({
    capabilityId: `capability-${String(index).padStart(2, '0')}`,
    accountId: `account-${String(index).padStart(2, '0')}`,
  }));
  const digest = 'a'.repeat(64);
  const gate = projectWorkflowCapabilityInboxGate({
    id: 'workflow-run-a-capability-sheets',
    kind: 'workflow',
    metadata: {
      workflow: 'Renewal workbook',
      runId: 'run-a',
      status: 'blocked_capability',
      stepId: 'publish',
      tool: 'GOOGLESHEETS_BATCH_UPDATE',
      toolkit: 'googlesheets',
      reason: 'ambiguous-account',
      retryAt: '2026-08-30T20:00:00.000Z',
      retryCount: 3,
      provenNoDispatch: true,
      resolution: {
        kind: 'choose_account',
        accountCandidates: candidates,
        choiceSetDigest: digest,
        choiceTotal: candidates.length,
        choicesTruncated: true,
      },
    },
  });
  assert.ok(gate);
  assert.equal(gate.resolution.kind, 'choose_account');
  if (gate.resolution.kind !== 'choose_account') return;
  assert.equal(gate.resolution.candidates.length, 16);
  assert.deepEqual(gate.resolution.candidates[1], {
    label: 'account-01',
    capabilityId: 'capability-01',
    accountId: 'account-01',
  });
  assert.equal(gate.resolution.choiceSetDigest, digest);
  assert.equal(gate.resolution.choiceTotal, 20);
  assert.equal(gate.resolution.choicesTruncated, true);
});

test('malformed action metadata fails closed to run review', () => {
  const gate = projectWorkflowCapabilityInboxGate({
    id: 'workflow-run-b-capability-mail',
    kind: 'workflow',
    metadata: {
      workflow: 'Renewal mail', runId: 'run-b', status: 'blocked_capability',
      stepId: 'send', tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail',
      reason: 'ambiguous-account', retryCount: 1, provenNoDispatch: true,
      resolution: { kind: 'choose_account', accountCandidates: [], choiceSetDigest: 'bad' },
    },
  });
  assert.equal(gate?.resolution.kind, 'review_run');
});

test('legacy canonical capability carriers remain Needs You without title regex or migrated metadata', () => {
  assert.equal(isNeedsAttentionNotification({
    title: 'Workflow paused — exact action metadata unavailable',
    metadata: {
      status: 'blocked_capability',
      provenNoDispatch: true,
      runId: 'legacy-gate',
    },
  }), true);
  assert.equal(isNeedsAttentionNotification({
    title: 'Workflow paused — exact action metadata unavailable',
    metadata: {
      status: 'blocked_capability',
      provenNoDispatch: true,
      needsAttention: false,
      capabilitySettledAt: new Date().toISOString(),
    },
  }), false);

  const id = 'workflow-legacy-upgrade-capability-drive';
  addNotification({
    id,
    kind: 'workflow',
    title: 'Workflow dependency',
    body: 'Legacy copy.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: {
      workflow: 'Legacy workflow',
      runId: 'legacy-upgrade-run',
      status: 'blocked_capability',
      provenNoDispatch: true,
    },
  });
  addNotification({
    id,
    kind: 'workflow',
    title: 'Workflow needs you — connect drive',
    body: 'Open Connections, then retry this exact gate.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: {
      workflow: 'Legacy workflow',
      runId: 'legacy-upgrade-run',
      status: 'blocked_capability',
      stepId: 'read',
      tool: 'DRIVE_LIST',
      toolkit: 'drive',
      reason: 'not-connected',
      retryCount: 2,
      provenNoDispatch: true,
      needsAttention: true,
      resolution: { kind: 'connect_and_retry', retryCount: 2 },
    },
  });
  assert.equal(getNotification(id)?.metadata?.needsAttention, true);
  assert.equal(getNotification(id)?.metadata?.retryCount, 2);
  assert.match(getNotification(id)?.body ?? '', /retry this exact gate/i);
  assert.equal(markNotificationRead(id)?.read, false);
  assert.deepEqual(markNotificationGroupRead(id), []);
  assert.equal(getNotification(id)?.read, false, 'generic read/dismiss is not gate resolution authority');
});

test('reconciliation revives a historically read capability gate unless exact settlement won', () => {
  const id = 'workflow-historical-toast-capability-drive';
  const canonical = {
    id,
    kind: 'workflow' as const,
    title: 'Workflow needs you — connect drive',
    body: 'Open Connections, then retry this exact gate.',
    createdAt: '2026-08-30T18:00:00.000Z',
    read: false,
    metadata: {
      workflow: 'Historical toast workflow',
      runId: 'historical-toast-run',
      status: 'blocked_capability',
      stepId: 'read',
      tool: 'DRIVE_LIST',
      toolkit: 'drive',
      reason: 'not-connected',
      retryCount: 4,
      provenNoDispatch: true,
      needsAttention: true,
      resolution: { kind: 'connect_and_retry', retryCount: 4 },
    },
  };

  // Persist the state produced by older desktop shells: opening the toast was
  // incorrectly treated as resolution even though no exact settlement exists.
  addNotification({
    ...canonical,
    title: 'Historical workflow dependency',
    body: 'Opened by an older desktop shell.',
    read: true,
    metadata: { ...canonical.metadata, needsAttention: false },
  });
  addNotification(canonical);
  assert.equal(getNotification(id)?.read, false);
  assert.equal(getNotification(id)?.metadata?.needsAttention, true);

  markWorkflowCapabilityNotificationsSettled('historical-toast-run', {
    capabilityResolutionStatus: 'readmitted',
  });
  addNotification(canonical);
  assert.equal(getNotification(id)?.read, true, 'exact settlement remains terminal for this gate generation');
  assert.equal(getNotification(id)?.metadata?.needsAttention, false);
  assert.equal(typeof getNotification(id)?.metadata?.capabilitySettledAt, 'string');
});

test('capability settlement retires only the stable gate, never the terminal report', () => {
  addNotification({
    id: 'workflow-settle-capability-gmail', kind: 'workflow', title: 'Workflow needs you', body: '',
    createdAt: '2026-08-30T18:00:00.000Z', read: false,
    metadata: { runId: 'settle-run', status: 'blocked_capability', needsAttention: true },
  });
  addNotification({
    id: 'workflow-settle-completed', kind: 'workflow', title: 'Workflow completed', body: 'Done',
    createdAt: '2026-08-30T18:01:00.000Z', read: false,
    metadata: { runId: 'settle-run', status: 'completed' },
  });
  const changed = markWorkflowCapabilityNotificationsSettled('settle-run', { capabilityResolutionStatus: 'readmitted' });
  assert.deepEqual(changed.map((row) => row.id), ['workflow-settle-capability-gmail']);
  assert.equal(getNotification('workflow-settle-capability-gmail')?.read, true);
  assert.equal(getNotification('workflow-settle-capability-gmail')?.metadata?.needsAttention, false);
  assert.equal(getNotification('workflow-settle-completed')?.read, false);
});

test('a newer capability gate generation atomically supersedes stale choices for the same run', () => {
  const stableId = 'workflow-reblock-capability-sheets';
  addNotification({
    id: stableId, kind: 'workflow', title: 'Choose old account', body: 'Old choices',
    createdAt: '2026-08-30T18:02:00.000Z', read: false,
    metadata: {
      runId: 'reblock-run', status: 'blocked_capability', stepId: 'publish', tool: 'SHEETS_UPDATE', retryCount: 1,
      needsAttention: true, resolution: { kind: 'choose_account', choiceSetDigest: 'a'.repeat(64) },
    },
  });
  const oldJob = listQueuedNotificationDeliveries().find((job) => job.notificationId === stableId);
  assert.ok(oldJob);
  replaceQueuedNotificationDeliveries([
    ...listQueuedNotificationDeliveries().filter((job) => job.notificationId !== stableId),
    { ...oldJob, completedDestinationIds: ['old-generation-destination'] },
  ]);
  addNotification({
    id: stableId, kind: 'workflow', title: 'Choose current account', body: 'Current choices',
    createdAt: '2026-08-30T18:03:00.000Z', read: false,
    metadata: {
      runId: 'reblock-run', status: 'blocked_capability', stepId: 'publish', tool: 'SHEETS_UPDATE', retryCount: 2,
      needsAttention: true, resolution: { kind: 'choose_account', choiceSetDigest: 'b'.repeat(64) },
    },
  });

  const currentGate = getNotification(stableId);
  assert.equal(currentGate?.read, false);
  assert.equal(currentGate?.title, 'Choose current account');
  assert.equal(currentGate?.body, 'Current choices');
  assert.equal(currentGate?.metadata?.retryCount, 2);
  assert.equal(currentGate?.metadata?.needsAttention, true);
  assert.deepEqual(
    listQueuedNotificationDeliveries().find((job) => job.notificationId === stableId)?.completedDestinationIds,
    [],
    'the new carrier generation cannot inherit old completed-destination cursors',
  );
  assert.equal(
    loadNotifications().filter((row) => row.metadata?.runId === 'reblock-run').length,
    1,
  );
});

test('Clem model-tool retries use the same exact gate CAS as authenticated Inboxes', () => {
  const source = readFileSync(new URL('../tools/orchestration-tools.ts', import.meta.url), 'utf8');
  assert.match(source, /runner\.resolveWorkflowCapabilityRetry\(\{/);
  assert.doesNotMatch(source, /runner\.resumeCapabilityBlockedWorkflowRun\(/);
  assert.match(source, /retry requires the exact step_id, tool, and retry_count/);
  assert.match(source, /action="retry".*step_id=.*tool=.*retry_count=/s);
});
