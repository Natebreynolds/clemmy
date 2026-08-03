import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-report-back-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { SessionStore } = await import('../memory/session-store.js');
const {
  _setWorkflowRunReportBackAfterExactReceiptObservationForTests,
  _setWorkflowRunReportBackBeforeCheckpointLockForTests,
  _setWorkflowRunReportBackDeliveryForTests,
  attemptWorkflowRunReportBack,
  checkpointWorkflowRunReportBack,
  recordAndAttemptWorkflowRunReportBack,
  workflowRunReportBackNeedsRetry,
  workflowRunReportBackRetryDue,
} = await import('./workflow-run-report-back.js');
const { cancelWorkflowRunAtBoundary } = await import('./workflow-run-cancellation.js');
const { runWorkflowWatchdog } = await import('./workflow-watchdog.js');
const { appendEvent, createSession, listEvents, openEventLog, updateSession } = await import('../runtime/harness/eventlog.js');
const {
  addNotification,
  exactOriginDeliveryDestinationId,
  exactOriginDeliveryMetadata,
  getNotification,
  getNotificationDestinationsForRecord,
  listNotifications,
  listQueuedNotificationDeliveries,
  reapStaleNotifications,
  replaceQueuedNotificationDeliveries,
  updateNotificationDeliveryStatus,
} = await import('../runtime/notifications.js');
const {
  createWorkflowChatDispatchPreparationAuthority,
  createWorkflowChatDispatchPreparedReceipt,
  createWorkflowOriginGroupCloseAuthority,
  createWorkflowOriginGroupClosedBatchReceipt,
  finalizeWorkflowOriginGroupClosedBatch,
  recordWorkflowChatDispatchPreparation,
  recordWorkflowOriginGroupClosedBatch,
  workflowChatDispatchQueueRequestDigest,
  workflowRunReportBackContentDigest,
  workflowRunOriginObserverId,
} = await import('./workflow-origin-group.js');
const { resolveWorkflowOriginReplyTarget } = await import('../runtime/workflow-origin-authority.js');
const {
  createFocus,
  getActiveFocus,
  getFocusWorkstate,
  linkFocusActionForSession,
} = await import('../memory/focus.js');

test.after(() => {
  _setWorkflowRunReportBackAfterExactReceiptObservationForTests();
  _setWorkflowRunReportBackBeforeCheckpointLockForTests();
  _setWorkflowRunReportBackDeliveryForTests();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const REPORT_MODULE_URL = new URL('./workflow-run-report-back.ts', import.meta.url).href;

async function waitForFile(file: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runFile(runId: string): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  return path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
}

function writeRun(runId: string, originSessionId?: string): string {
  const file = runFile(runId);
  writeFileSync(file, JSON.stringify({
    id: runId,
    workflow: 'Ack Workflow',
    status: 'completed',
    finishedAt: new Date().toISOString(),
    ...(originSessionId ? { originSessionId } : {}),
  }), 'utf-8');
  return file;
}

function readRun(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any>;
}

function addLateOrigin(runId: string, originSessionId: string): void {
  const runKey = createHash('sha256').update(runId).digest('hex');
  const originKey = createHash('sha256').update(originSessionId).digest('hex');
  const dir = path.join(WORKFLOW_RUNS_DIR, '.run-origins', runKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${originKey}.json`), JSON.stringify({
    version: 1,
    runId,
    originSessionId,
    recordedAt: new Date().toISOString(),
  }), 'utf-8');
}

let exactPreparationSeq = 10_000;

function addExactOriginGroup(
  runIds: readonly string[],
  originSessionId: string,
  sourceUserSeq: number,
) {
  const observerId = workflowRunOriginObserverId({ sessionId: originSessionId, sourceUserSeq });
  const replyTarget = resolveWorkflowOriginReplyTarget(originSessionId);
  assert.ok(replyTarget, `test origin ${originSessionId} must have an exact reply target`);
  const observer = {
    sessionId: originSessionId,
    sourceUserSeq,
    replyTarget,
  };
  const receipts = runIds.map((runId) => {
    const authority = createWorkflowChatDispatchPreparationAuthority({
      runId,
      observer,
      queueRequestDigest: workflowChatDispatchQueueRequestDigest({
        workflowName: 'Ack Workflow',
        normalizedInputs: { runId },
      }),
    });
    exactPreparationSeq += 1;
    return recordWorkflowChatDispatchPreparation(createWorkflowChatDispatchPreparedReceipt(authority, {
      eventId: `report-back-prepared-${exactPreparationSeq}`,
      eventSeq: exactPreparationSeq,
      preparedAt: new Date(1_800_000_000_000 + exactPreparationSeq).toISOString(),
    }));
  });
  const closeAuthority = createWorkflowOriginGroupCloseAuthority(receipts);
  exactPreparationSeq += 1;
  recordWorkflowOriginGroupClosedBatch({
    receipt: createWorkflowOriginGroupClosedBatchReceipt(closeAuthority, {
      eventId: `report-back-closed-${exactPreparationSeq}`,
      eventSeq: exactPreparationSeq,
      closedAt: new Date(1_800_000_000_000 + exactPreparationSeq).toISOString(),
    }),
    preparedReceipts: receipts,
  });
  const active = finalizeWorkflowOriginGroupClosedBatch(closeAuthority.sourceGroupId, {
    beforeMemberRelease: () => {},
  });
  return { observerId, active };
}

function addExactOrigin(runId: string, originSessionId: string, sourceUserSeq: number): string {
  return addExactOriginGroup([runId], originSessionId, sourceUserSeq).observerId;
}

function addAcceptedSource(input: {
  sessionId: string;
  channel: string;
  metadata?: Record<string, unknown>;
  text?: string;
  create?: boolean;
}) {
  if (input.create !== false) {
    createSession({
      id: input.sessionId,
      kind: 'chat',
      channel: input.channel,
      metadata: input.metadata ?? {},
    });
  }
  return appendEvent({
    sessionId: input.sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: input.text ?? 'Run the review.' },
  });
}

test('failed origin write stays unacknowledged and a later retry marks notified exactly once', () => {
  const runId = 'report-retry';
  const origin = 'report-retry-origin';
  const file = writeRun(runId, origin);
  _setWorkflowRunReportBackDeliveryForTests(() => ({
    acknowledged: false,
    written: false,
    disposition: 'failed',
  }));

  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'durable result',
  }), false);
  const failed = readRun(file);
  assert.equal(failed.notifiedAt, undefined, 'failed origin write cannot close report-back');
  assert.deepEqual(failed.reportBack.acknowledgedOriginSessionIds, []);
  assert.equal(workflowRunReportBackNeedsRetry(failed), true);

  _setWorkflowRunReportBackDeliveryForTests();
  runWorkflowWatchdog();
  const delivered = readRun(file);
  assert.equal(typeof delivered.reportBackAcknowledgedAt, 'string');
  assert.equal(delivered.notifiedAt, undefined, 'origin acknowledgement is not dashboard notification evidence');
  assert.deepEqual(delivered.reportBack.acknowledgedOriginSessionIds, [origin]);
  assert.equal(workflowRunReportBackNeedsRetry(delivered), false);
  assert.equal(
    new SessionStore().get(origin).turns.filter((turn) => turn.text.startsWith(`[workflow run ${runId} `)).length,
    1,
  );
});

test('terminal workflow report-back reconciles the linked conversation action', () => {
  const runId = 'report-linked-workstate';
  const origin = 'report-linked-origin';
  createFocus({
    resourceRef: `session:${origin}`,
    title: 'Weekly planning',
    summary: 'Run the agreed calendar update.',
    resourceKind: 'thread',
    relatedSessionId: origin,
  });
  assert.equal(linkFocusActionForSession(origin, {
    id: runId,
    label: 'Calendar update',
    status: 'running',
    kind: 'workflow',
    ref: runId,
  })?.status, 'updated');

  const file = writeRun(runId, origin);
  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Calendar update',
    outcome: 'done',
    detail: 'Three dinner blocks were created and verified.',
  }), true);

  const action = getFocusWorkstate(getActiveFocus())?.actions.find((item) => item.ref === runId);
  assert.equal(action?.status, 'done');
  assert.equal(action?.note, 'Completed and reported back.');
});

test('crash-after-delivery retry treats the existing idempotent turn as an acknowledgement', () => {
  const runId = 'report-duplicate-ack';
  const origin = 'report-duplicate-origin';
  const file = writeRun(runId, origin);
  const store = new SessionStore();
  store.appendTurn(origin, {
    role: 'user',
    text: `[workflow run ${runId} completed] Ack Workflow\n\nalready delivered`,
    createdAt: new Date().toISOString(),
  });

  assert.equal(checkpointWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'durable result',
  }), true);
  assert.equal(attemptWorkflowRunReportBack(file), true);
  const delivered = readRun(file);
  assert.equal(typeof delivered.reportBackAcknowledgedAt, 'string');
  assert.equal(delivered.notifiedAt, undefined);
  assert.deepEqual(delivered.reportBack.acknowledgedOriginSessionIds, [origin]);
  assert.equal(
    new SessionStore().get(origin).turns.filter((turn) => turn.text.startsWith(`[workflow run ${runId} `)).length,
    1,
    'idempotent acknowledgement does not append a second terminal turn',
  );
});

test('origin completion never impersonates the dashboard notification marker', () => {
  const file = writeRun('report-marker-split');
  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'dashboard card still required',
  }), true);
  const delivered = readRun(file);
  assert.equal(typeof delivered.reportBackAcknowledgedAt, 'string');
  assert.equal(delivered.notifiedAt, undefined);
  assert.equal(workflowRunReportBackNeedsRetry(delivered), false);
});

test('a late observer sidecar reopens the acknowledged generation until that origin is delivered', () => {
  const runId = 'report-late-origin';
  const firstOrigin = 'report-origin-a';
  const lateOrigin = 'report-origin-b';
  const file = writeRun(runId, firstOrigin);
  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'durable result',
  }), true);
  assert.equal(workflowRunReportBackNeedsRetry(readRun(file)), false);

  addLateOrigin(runId, lateOrigin);
  assert.equal(
    workflowRunReportBackNeedsRetry(readRun(file)),
    true,
    'late observer is required even though the earlier origin generation was acknowledged',
  );
  assert.equal(attemptWorkflowRunReportBack(file), true);
  const delivered = readRun(file);
  assert.deepEqual(
    [...delivered.reportBack.acknowledgedOriginSessionIds].sort(),
    [firstOrigin, lateOrigin].sort(),
  );
  for (const origin of [firstOrigin, lateOrigin]) {
    assert.equal(
      new SessionStore().get(origin).turns.filter((turn) => turn.text.startsWith(`[workflow run ${runId} `)).length,
      1,
      `${origin} receives exactly one terminal turn`,
    );
  }
});

test('an exact desktop observer settles the original source directly without the legacy synthetic relay', () => {
  const runId = 'report-exact-desktop';
  const origin = 'report-exact-desktop-origin';
  const source = addAcceptedSource({ sessionId: origin, channel: 'desktop' });
  const file = writeRun(runId, origin);
  const observerId = addExactOrigin(runId, origin, source.seq);
  let legacyCalls = 0;
  _setWorkflowRunReportBackDeliveryForTests(() => {
    legacyCalls += 1;
    throw new Error('legacy relay must not run for a v2 observer');
  });
  try {
    assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
      workflowName: 'Ack Workflow',
      outcome: 'done',
      detail: 'No new Platform 4.9 items. The tracker was refreshed.',
    }), true);
  } finally {
    _setWorkflowRunReportBackDeliveryForTests();
  }

  const delivered = readRun(file);
  assert.equal(legacyCalls, 0);
  assert.deepEqual(delivered.reportBack.acknowledgedOriginSessionIds, []);
  assert.deepEqual(delivered.reportBack.acknowledgedOriginObserverIds, [observerId]);
  const terminals = listEvents(origin, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.sourceUserSeq, source.seq);
  assert.equal(terminals[0].data.reply, 'No new Platform 4.9 items. The tracker was refreshed.');
  assert.equal(
    listEvents(origin, { types: ['user_input_received'] })
      .filter((event) => event.data.synthetic === true).length,
    0,
  );
  const receiptCarrier = listNotifications(2_000).find(
    (entry) => entry.metadata?.originObserverId === observerId,
  );
  assert.equal(receiptCarrier?.silent, true, 'origin_chat terminal must not create a second desktop toast');
});

test('an observed exact receipt survives indefinitely until group settlement consumes it', () => {
  const runId = 'report-exact-observation-crash';
  const origin = 'report-exact-observation-crash-origin';
  const source = addAcceptedSource({ sessionId: origin, channel: 'desktop' });
  const file = writeRun(runId, origin);
  const observerId = addExactOrigin(runId, origin, source.seq);
  _setWorkflowRunReportBackAfterExactReceiptObservationForTests(() => {
    throw new Error('injected crash after provider receipt observation');
  });
  try {
    assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
      workflowName: 'Ack Workflow',
      outcome: 'done',
      detail: 'The provider delivered this exact terminal.',
    }), false);
  } finally {
    _setWorkflowRunReportBackAfterExactReceiptObservationForTests();
  }

  const notificationId = `workflow-${runId}-origin-${observerId.replace(/^workflow-origin-v2:/, '')}`;
  const observed = getNotification(notificationId);
  assert.equal(typeof observed?.exactDeliveryReceiptSettlementPendingAt, 'string');
  assert.equal(observed?.exactDeliveryReceiptSettlementDigest, undefined);

  const afterThirtyOneDays = Date.now() + 31 * 24 * 60 * 60_000;
  reapStaleNotifications(afterThirtyOneDays);
  assert.ok(getNotification(notificationId), 'pending observation is exempt from hard-age pruning');

  assert.equal(attemptWorkflowRunReportBack(file, afterThirtyOneDays), true);
  let settledCarrier = getNotification(notificationId);
  assert.equal(settledCarrier?.exactDeliveryReceiptSettlementPendingAt, undefined);
  assert.match(settledCarrier?.exactDeliveryReceiptSettlementDigest ?? '', /^[a-f0-9]{64}$/);
  assert.equal(
    settledCarrier?.exactDeliveryReceiptSettlementSourceGroupId,
    getNotification(notificationId)?.metadata?.sourceGroupId,
  );

  // Upgrade fixture: 3.6.2-era settled carriers have the digest but not the
  // newly explicit source-group association. They remain readable/retained,
  // and replay validates the real group receipt before backfilling the field.
  const notificationFile = path.join(TMP_HOME, 'state', 'notifications.json');
  const legacyCarriers = JSON.parse(readFileSync(notificationFile, 'utf-8')) as Array<Record<string, any>>;
  const legacyCarrier = legacyCarriers.find((entry) => entry.id === notificationId);
  assert.ok(legacyCarrier);
  delete legacyCarrier.exactDeliveryReceiptSettlementSourceGroupId;
  writeFileSync(notificationFile, JSON.stringify(legacyCarriers), 'utf-8');
  assert.equal(getNotification(notificationId)?.exactDeliveryReceiptSettlementSourceGroupId, undefined);
  const reopenedForMigration = readRun(file);
  delete reopenedForMigration.reportBackAcknowledgedAt;
  reopenedForMigration.reportBack.acknowledgedOriginObserverIds = [];
  reopenedForMigration.reportBack.acknowledgedOriginObserverSettlements = {};
  writeFileSync(file, JSON.stringify(reopenedForMigration), 'utf-8');
  assert.equal(attemptWorkflowRunReportBack(file, afterThirtyOneDays + 1), true);
  settledCarrier = getNotification(notificationId);
  assert.equal(
    settledCarrier?.exactDeliveryReceiptSettlementSourceGroupId,
    settledCarrier?.metadata?.sourceGroupId,
    'validated replay backfills legacy settlement association',
  );

  // The real immutable group receipt—not the carrier-local digest—releases
  // exact evidence when ordinary count compaction later needs the slot.
  assert.ok(settledCarrier);
  const newerOrdinary = Array.from({ length: 1_000 }, (_, index) => ({
    id: `real-settlement-prune-${index}`,
    kind: 'system' as const,
    title: `Ordinary ${index}`,
    body: `Ordinary ${index}`,
    createdAt: new Date(afterThirtyOneDays + index + 1).toISOString(),
    read: false,
    silent: true,
  }));
  writeFileSync(
    path.join(TMP_HOME, 'state', 'notifications.json'),
    JSON.stringify([settledCarrier, ...newerOrdinary]),
    'utf-8',
  );
  replaceQueuedNotificationDeliveries([]);
  const compacted = listNotifications(2_000);
  assert.equal(compacted.length, 1_000);
  assert.equal(
    compacted.some((entry) => entry.id === notificationId),
    false,
    'verified group settlement makes the older exact carrier prunable',
  );
});

test('a conflicting durable carrier settlement digest is corrupt evidence, not endless delivery retry', () => {
  const runId = 'report-exact-carrier-settlement-conflict';
  const origin = 'report-exact-carrier-settlement-conflict-origin';
  const source = addAcceptedSource({ sessionId: origin, channel: 'desktop' });
  const file = writeRun(runId, origin);
  const observerId = addExactOrigin(runId, origin, source.seq);
  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'The canonical result owns one settlement generation.',
  }), true);

  const notificationId = `workflow-${runId}-origin-${observerId.replace(/^workflow-origin-v2:/, '')}`;
  const notificationFile = path.join(TMP_HOME, 'state', 'notifications.json');
  const carriers = JSON.parse(readFileSync(notificationFile, 'utf-8')) as Array<Record<string, any>>;
  const carrier = carriers.find((entry) => entry.id === notificationId);
  assert.ok(carrier);
  const legitimateDigest = carrier.exactDeliveryReceiptSettlementDigest;
  carrier.exactDeliveryReceiptSettlementDigest = legitimateDigest === 'f'.repeat(64)
    ? 'e'.repeat(64)
    : 'f'.repeat(64);
  writeFileSync(notificationFile, JSON.stringify(carriers), 'utf-8');

  const reopened = readRun(file);
  delete reopened.reportBackAcknowledgedAt;
  reopened.reportBack.acknowledgedOriginObserverIds = [];
  reopened.reportBack.acknowledgedOriginObserverSettlements = {};
  writeFileSync(file, JSON.stringify(reopened), 'utf-8');

  assert.equal(attemptWorkflowRunReportBack(file), false);
  const after = readRun(file);
  assert.equal(after.reportBackRetry.kind, 'corrupt_evidence');
  assert.match(after.reportBackRetry.lastError, /conflicting carrier settlement authority/i);
});

test('an exact Discord observer remains pending until the precise channel receipt exists', () => {
  const runId = 'report-exact-discord';
  const origin = 'report-exact-discord-origin';
  const channelId = '987654321';
  const source = addAcceptedSource({
    sessionId: origin,
    channel: 'discord',
    metadata: { channelId },
  });
  const file = writeRun(runId, origin);
  const observerId = addExactOrigin(runId, origin, source.seq);

  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'The review completed and the tracker was refreshed.',
  }), false, 'a transcript terminal is not an external delivery receipt');
  const pending = readRun(file);
  assert.equal(pending.reportBackAcknowledgedAt, undefined);
  assert.deepEqual(pending.reportBack.acknowledgedOriginObserverIds ?? [], []);
  assert.equal(listEvents(origin, { types: ['conversation_completed'] }).length, 1);

  const notification = listNotifications(2_000).find(
    (entry) => entry.metadata?.originObserverId === observerId,
  );
  assert.ok(notification);
  assert.deepEqual(getNotificationDestinationsForRecord(notification), [{
    id: exactOriginDeliveryDestinationId({ type: 'discord_channel', channelId }),
    name: exactOriginDeliveryDestinationId({ type: 'discord_channel', channelId }),
    type: 'discord_channel',
    channelId,
    enabled: true,
    createdAt: notification.createdAt,
  }]);
  const exactReceipt = exactOriginDeliveryDestinationId({ type: 'discord_channel', channelId });
  assert.ok(exactReceipt);
  updateNotificationDeliveryStatus(notification.id, {
    deliveredAt: new Date().toISOString(),
    deliveredDestinations: [exactReceipt],
  });

  const retryAt = Date.parse(readRun(file).reportBackRetry.nextAttemptAt);
  assert.equal(attemptWorkflowRunReportBack(file, retryAt), true);
  const delivered = readRun(file);
  assert.deepEqual(delivered.reportBack.acknowledgedOriginObserverIds, [observerId]);
  assert.equal(typeof delivered.reportBackAcknowledgedAt, 'string');
  assert.equal(
    listEvents(origin, { types: ['conversation_completed'] }).length,
    1,
    'receipt retry reuses the committed terminal instead of writing another one',
  );
});

test('a later session rebind cannot redirect an admitted exact observer', () => {
  const runId = 'report-exact-immutable-target';
  const origin = 'report-exact-immutable-target-origin';
  const admittedChannelId = 'admitted-channel';
  const source = addAcceptedSource({
    sessionId: origin,
    channel: 'discord',
    metadata: { channelId: admittedChannelId },
  });
  const file = writeRun(runId, origin);
  const observerId = addExactOrigin(runId, origin, source.seq);
  updateSession(origin, { metadata: { channelId: 'attacker-rebind-channel' } });

  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'The review completed.',
  }), false);
  const pending = readRun(file);
  assert.equal(pending.reportBackAcknowledgedAt, undefined);
  assert.deepEqual(pending.reportBack.acknowledgedOriginObserverIds ?? [], []);
  assert.equal(workflowRunReportBackNeedsRetry(pending), true);
  const notification = listNotifications(2_000).find(
    (entry) => entry.metadata?.originObserverId === observerId,
  );
  assert.ok(notification);
  const destinations = getNotificationDestinationsForRecord(notification);
  assert.equal(destinations.length, 1);
  assert.equal(destinations[0].channelId, admittedChannelId);
  assert.notEqual(destinations[0].channelId, 'attacker-rebind-channel');
  assert.equal(listEvents(origin, { types: ['conversation_completed'] }).length, 1);
});

test('a missing immutable accepted source is corrupt evidence, not an unbounded delivery retry', () => {
  const runId = 'report-exact-missing-source';
  const origin = 'report-exact-missing-source-origin';
  const source = addAcceptedSource({ sessionId: origin, channel: 'desktop' });
  const file = writeRun(runId, origin);
  addExactOrigin(runId, origin, source.seq);
  openEventLog().prepare('DELETE FROM events WHERE id = ?').run(source.id);

  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'This result has no accepted source owner.',
  }), false);
  const after = readRun(file);
  assert.equal(after.reportBackRetry.kind, 'corrupt_evidence');
  assert.equal(after.reportBackRetry.failureCount, 1);
  assert.equal(listNotifications(2_000).some(
    (entry) => entry.metadata?.runId === runId,
  ), false);
});

test('conflicting stable exact-notification evidence is quarantinable corruption', () => {
  const runId = 'report-exact-notification-conflict';
  const origin = 'report-exact-notification-conflict-origin';
  const source = addAcceptedSource({
    sessionId: origin,
    channel: 'discord',
    metadata: { channelId: 'C_INTENDED_EXACT_TARGET' },
  });
  const file = writeRun(runId, origin);
  const observerId = addExactOrigin(runId, origin, source.seq);
  const notificationId = `workflow-${runId}-origin-${observerId.replace(/^workflow-origin-v2:/, '')}`;
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Conflicting immutable carrier',
    body: 'A different body already owns this stable notification id.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: {
      originObserverId: observerId,
      runId: 'different-run',
      ...exactOriginDeliveryMetadata({
        type: 'discord_channel',
        channelId: 'C_WRONG_EXACT_TARGET',
      }),
    },
  });
  // Model a lost/cleared cursor. The canonical retry must inspect immutable
  // carrier identity before it is allowed to repair or kick the wrong target.
  replaceQueuedNotificationDeliveries([]);

  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'The canonical workflow result.',
  }), false);
  const after = readRun(file);
  assert.equal(after.reportBackRetry.kind, 'corrupt_evidence');
  assert.equal(after.reportBackRetry.failureCount, 1);
  assert.equal(listNotifications(2_000).find((entry) => entry.id === notificationId)?.body,
    'A different body already owns this stable notification id.');
  assert.equal(
    listQueuedNotificationDeliveries().some((job) => job.notificationId === notificationId),
    false,
    'conflicting exact evidence causes no requeue side effect before quarantine',
  );
});

test('a settled terminal no longer acknowledges a later valid-shaped report mutation', () => {
  const runId = 'report-settlement-terminal-mutation';
  const origin = 'report-settlement-terminal-mutation-origin';
  const source = addAcceptedSource({ sessionId: origin, channel: 'desktop' });
  const file = writeRun(runId, origin);
  addExactOrigin(runId, origin, source.seq);
  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'Actually delivered text.',
  }), true);

  const mutated = readRun(file);
  mutated.reportBack.detail = 'DIFFERENT undelivered text.';
  writeFileSync(file, JSON.stringify(mutated), 'utf-8');
  assert.equal(workflowRunReportBackNeedsRetry(readRun(file)), true);
  assert.equal(attemptWorkflowRunReportBack(file), false);
  assert.equal(readRun(file).reportBackRetry.kind, 'corrupt_evidence');
});

test('two accepted sources in one reusable chat remain distinct workflow observers', () => {
  const runId = 'report-two-sources-one-session';
  const origin = 'report-two-sources-origin';
  const sourceA = addAcceptedSource({
    sessionId: origin,
    channel: 'desktop',
    text: 'Run the first review.',
  });
  const sourceB = addAcceptedSource({
    sessionId: origin,
    channel: 'desktop',
    text: 'Run the second review.',
    create: false,
  });
  const file = writeRun(runId, origin);
  const observerA = addExactOrigin(runId, origin, sourceA.seq);
  const observerB = addExactOrigin(runId, origin, sourceB.seq);

  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'Both requested observations are now current.',
  }), true);
  const delivered = readRun(file);
  assert.deepEqual(
    [...delivered.reportBack.acknowledgedOriginObserverIds].sort(),
    [observerA, observerB].sort(),
  );
  assert.deepEqual(
    listEvents(origin, { types: ['conversation_completed'] })
      .map((event) => event.data.sourceUserSeq)
      .sort((left, right) => Number(left) - Number(right)),
    [sourceA.seq, sourceB.seq],
  );
});

test('one surviving observer cannot hide a second accepted source whose active sidecar was lost', () => {
  const runId = 'report-partial-observer-loss';
  const originA = 'report-partial-observer-origin-a';
  const originB = 'report-partial-observer-origin-b';
  const sourceA = addAcceptedSource({
    sessionId: originA,
    channel: 'desktop',
    text: 'Run the review for source A.',
  });
  const sourceB = addAcceptedSource({
    sessionId: originB,
    channel: 'desktop',
    text: 'Attach the same review to source B.',
  });
  const file = writeRun(runId, originA);
  const observerA = addExactOrigin(runId, originA, sourceA.seq);
  const observerB = addExactOrigin(runId, originB, sourceB.seq);
  const runKey = createHash('sha256').update(runId).digest('hex');
  rmSync(path.join(
    WORKFLOW_RUNS_DIR,
    '.run-origins',
    runKey,
    `${observerB.replace(/^workflow-origin-v2:/, '')}.json`,
  ));

  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'Both accepted sources must receive this result or neither may close.',
  }), false);
  const after = readRun(file);
  assert.equal(after.reportBackRetry.kind, 'corrupt_evidence');
  assert.equal(after.reportBackAcknowledgedAt, undefined);
  assert.deepEqual(after.reportBack.acknowledgedOriginObserverIds ?? [], []);
  assert.equal(listEvents(originA, { types: ['conversation_completed'] }).length, 0);
  assert.equal(listEvents(originB, { types: ['conversation_completed'] }).length, 0);
  assert.equal(
    listNotifications(2_000).some((entry) => (
      entry.metadata?.originObserverId === observerA
      || entry.metadata?.originObserverId === observerB
    )),
    false,
    'partial recipient authority must fail before any survivor-only delivery side effect',
  );
});

test('a valid preparation still awaiting activation is pending delivery, not corrupt quarantine', () => {
  const runId = 'report-pending-second-observer';
  const originA = 'report-pending-second-observer-origin-a';
  const originB = 'report-pending-second-observer-origin-b';
  const sourceA = addAcceptedSource({ sessionId: originA, channel: 'desktop' });
  const sourceB = addAcceptedSource({ sessionId: originB, channel: 'desktop' });
  const file = writeRun(runId, originA);
  addExactOrigin(runId, originA, sourceA.seq);
  const replyTarget = resolveWorkflowOriginReplyTarget(originB);
  assert.ok(replyTarget);
  const pendingAuthority = createWorkflowChatDispatchPreparationAuthority({
    runId,
    observer: {
      sessionId: originB,
      sourceUserSeq: sourceB.seq,
      replyTarget,
    },
    queueRequestDigest: workflowChatDispatchQueueRequestDigest({
      workflowName: 'Ack Workflow',
      normalizedInputs: { runId, pending: 'true' },
    }),
  });
  exactPreparationSeq += 1;
  recordWorkflowChatDispatchPreparation(createWorkflowChatDispatchPreparedReceipt(
    pendingAuthority,
    {
      eventId: `report-back-pending-${exactPreparationSeq}`,
      eventSeq: exactPreparationSeq,
      preparedAt: new Date(1_800_000_000_000 + exactPreparationSeq).toISOString(),
    },
  ));

  assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'Wait until every accepted source has active routing authority.',
  }), false);
  const pending = readRun(file);
  assert.equal(pending.reportBackRetry.kind, 'delivery');
  assert.equal(pending.reportBackRetry.quarantinedAt, undefined);
  assert.match(pending.reportBackRetry.lastError, /waiting for source group .* to activate/i);
  assert.equal(listEvents(originA, { types: ['conversation_completed'] }).length, 0);
  assert.equal(listEvents(originB, { types: ['conversation_completed'] }).length, 0);
});

test('one accepted source with two out-of-order runs publishes one ordered reducer terminal', () => {
  const origin = 'report-one-source-two-runs-origin';
  const source = addAcceptedSource({
    sessionId: origin,
    channel: 'desktop',
    text: 'Run both reviews and give me one answer.',
  });
  const runA = 'report-group-run-a';
  const runB = 'report-group-run-b';
  const fileA = writeRun(runA, origin);
  const fileB = writeRun(runB, origin);
  const { observerId, active } = addExactOriginGroup([runA, runB], origin, source.seq);

  assert.equal(recordAndAttemptWorkflowRunReportBack(fileB, {
    workflowName: 'Second Review',
    outcome: 'done',
    detail: 'Second result completed first.',
  }), false, 'a fast member cannot publish before the sealed group is terminal');
  assert.equal(listEvents(origin, { types: ['conversation_completed'] }).length, 0);

  assert.equal(recordAndAttemptWorkflowRunReportBack(fileA, {
    workflowName: 'First Review',
    outcome: 'done',
    detail: 'First result completed second.',
  }), true);
  assert.equal(attemptWorkflowRunReportBack(fileB), true, 'the earlier member converges on the shared receipt');

  const terminals = listEvents(origin, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.sourceUserSeq, source.seq);
  assert.equal(terminals[0].data.presentation.identity.runId, active.sealed.sourceGroupId);
  const reply = String(terminals[0].data.reply);
  assert.match(reply, /2 workflows finished for this request/);
  assert.ok(reply.indexOf('First Review') < reply.indexOf('Second Review'), 'sealed membership owns reducer order');
  assert.match(reply, /First result completed second/);
  assert.match(reply, /Second result completed first/);
  assert.equal(
    listEvents(origin, { types: ['user_input_received'] })
      .filter((event) => event.data.synthetic === true).length,
    0,
  );

  for (const file of [fileA, fileB]) {
    const run = readRun(file);
    assert.deepEqual(run.reportBack.acknowledgedOriginObserverIds, [observerId]);
    assert.equal(typeof run.reportBackAcknowledgedAt, 'string');
  }
  const groupNotifications = listNotifications(2_000).filter(
    (entry) => entry.metadata?.sourceGroupId === active.sealed.sourceGroupId,
  );
  assert.equal(groupNotifications.length, 1);
  assert.deepEqual(groupNotifications[0].metadata?.runIds, [runA, runB]);
  assert.equal(groupNotifications[0].silent, true);

  rmSync(fileA, { force: true });
  assert.equal(
    workflowRunReportBackNeedsRetry(readRun(fileB)),
    false,
    'a survivor remains settled after an older sibling run is reaped',
  );
  const forgedSurvivor = readRun(fileB);
  forgedSurvivor.reportBack.detail = 'Mutated after the aggregate terminal was delivered.';
  forgedSurvivor.reportBack.acknowledgedOriginObserverSettlements[observerId].reportBackDigest =
    workflowRunReportBackContentDigest(forgedSurvivor.reportBack);
  writeFileSync(fileB, JSON.stringify(forgedSurvivor), 'utf-8');
  assert.equal(
    workflowRunReportBackNeedsRetry(readRun(fileB)),
    true,
    'recomputing a same-file projection cannot rewrite immutable settlement membership',
  );
});

test('a corrupt member prevents the whole source-group reducer from publishing', () => {
  const origin = 'report-group-corrupt-origin';
  const source = addAcceptedSource({ sessionId: origin, channel: 'desktop' });
  const runA = 'report-group-corrupt-a';
  const runB = 'report-group-corrupt-b';
  const fileA = writeRun(runA, origin);
  const fileB = writeRun(runB, origin);
  const { active } = addExactOriginGroup([runA, runB], origin, source.seq);
  const corrupt = readRun(fileB);
  corrupt.reportBack = {
    version: 1,
    workflowName: 'Corrupt Second Review',
    outcome: 'done',
    detail: 'This must never be promoted.',
    acknowledgedOriginSessionIds: 'not-an-array',
  };
  writeFileSync(fileB, JSON.stringify(corrupt), 'utf-8');

  assert.equal(recordAndAttemptWorkflowRunReportBack(fileA, {
    workflowName: 'First Review',
    outcome: 'done',
    detail: 'Valid first result.',
  }), false);
  const after = readRun(fileA);
  assert.equal(after.reportBackRetry.kind, 'corrupt_evidence');
  assert.equal(workflowRunReportBackNeedsRetry(after), true);
  assert.equal(listEvents(origin, { types: ['conversation_completed'] }).length, 0);
  assert.equal(
    listNotifications(2_000).filter(
      (entry) => entry.metadata?.sourceGroupId === active.sealed.sourceGroupId,
    ).length,
    0,
  );
});

test('a valid-shaped sibling record with the wrong internal id cannot enter the reducer', () => {
  const origin = 'report-group-sibling-identity-origin';
  const source = addAcceptedSource({ sessionId: origin, channel: 'desktop' });
  const runA = 'report-group-sibling-identity-a';
  const runB = 'report-group-sibling-identity-b';
  const fileA = writeRun(runA, origin);
  const fileB = writeRun(runB, origin);
  const { active } = addExactOriginGroup([runA, runB], origin, source.seq);
  const substituted = readRun(fileB);
  substituted.id = 'report-group-sibling-identity-substitute';
  substituted.reportBack = {
    version: 1,
    workflowName: 'Substituted Second Review',
    outcome: 'done',
    detail: 'Valid-shaped content from the wrong canonical record.',
    acknowledgedOriginSessionIds: [],
  };
  writeFileSync(fileB, JSON.stringify(substituted), 'utf-8');

  assert.equal(recordAndAttemptWorkflowRunReportBack(fileA, {
    workflowName: 'First Review',
    outcome: 'done',
    detail: 'Valid first result.',
  }), false);
  const after = readRun(fileA);
  assert.equal(after.reportBackRetry.kind, 'corrupt_evidence');
  assert.match(after.reportBackRetry.lastError, /mismatched canonical identity/i);
  assert.equal(listEvents(origin, { types: ['conversation_completed'] }).length, 0);
  assert.equal(
    listNotifications(2_000).some(
      (entry) => entry.metadata?.sourceGroupId === active.sealed.sourceGroupId,
    ),
    false,
  );
});

test('a canonical run path cannot process a different run id copied into it', () => {
  const origin = 'report-current-path-identity-origin';
  const source = addAcceptedSource({ sessionId: origin, channel: 'desktop' });
  const canonicalRunId = 'report-current-path-owner';
  const substitutedRunId = 'report-current-path-substitute';
  const canonicalFile = writeRun(canonicalRunId, origin);
  const substitutedFile = writeRun(substitutedRunId, origin);
  addExactOrigin(substitutedRunId, origin, source.seq);
  writeFileSync(canonicalFile, JSON.stringify(readRun(substitutedFile)), 'utf-8');

  assert.equal(recordAndAttemptWorkflowRunReportBack(canonicalFile, {
    workflowName: 'Substituted Review',
    outcome: 'done',
    detail: 'This must remain bound to the substituted run canonical path.',
  }), false);
  assert.equal(readRun(canonicalFile).reportBack, undefined);
  assert.equal(listEvents(origin, { types: ['conversation_completed'] }).length, 0);
  assert.equal(
    listNotifications(2_000).some((entry) => entry.metadata?.runId === substitutedRunId),
    false,
  );
});

test('a corrupt durable report envelope fails closed even when an old notifiedAt marker exists', () => {
  const runId = 'report-corrupt-envelope';
  const file = writeRun(runId, 'report-corrupt-origin');
  const run = readRun(file);
  run.notifiedAt = new Date().toISOString();
  run.reportBack = {
    version: 1,
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'durable result',
    acknowledgedOriginSessionIds: 'not-an-array',
  };
  writeFileSync(file, JSON.stringify(run), 'utf-8');
  assert.equal(workflowRunReportBackNeedsRetry(readRun(file)), true);
  assert.equal(attemptWorkflowRunReportBack(file), false);
});

test('checkpoint input cannot pre-ack an exact observer', () => {
  const runId = 'report-preack-rejected';
  const origin = 'report-preack-origin';
  const source = addAcceptedSource({
    sessionId: origin,
    channel: 'discord',
    metadata: { channelId: 'preack-channel' },
  });
  const file = writeRun(runId, origin);
  const observerId = addExactOrigin(runId, origin, source.seq);
  const untrusted = {
    workflowName: 'Ack Workflow',
    outcome: 'done' as const,
    detail: 'durable result',
    acknowledgedOriginObserverIds: [observerId],
  };
  assert.equal(checkpointWorkflowRunReportBack(file, untrusted), true);
  assert.deepEqual(readRun(file).reportBack.acknowledgedOriginObserverIds ?? [], []);
  assert.equal(attemptWorkflowRunReportBack(file), false);
  assert.deepEqual(readRun(file).reportBack.acknowledgedOriginObserverIds ?? [], []);
});

test('a forged durable observer ack cannot substitute for target-bound group settlement', () => {
  const runId = 'report-forged-observer-ack';
  const origin = 'report-forged-observer-origin';
  const source = addAcceptedSource({
    sessionId: origin,
    channel: 'discord',
    metadata: { channelId: '123456789012345678' },
  });
  const file = writeRun(runId, origin);
  const observerId = addExactOrigin(runId, origin, source.seq);
  assert.equal(checkpointWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'A provider receipt is still required.',
  }), true);

  const forged = readRun(file);
  forged.reportBack.acknowledgedOriginObserverIds = [observerId];
  forged.reportBackAcknowledgedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(forged), 'utf-8');

  assert.equal(workflowRunReportBackNeedsRetry(readRun(file)), true);
  assert.equal(attemptWorkflowRunReportBack(file), false);
  const after = readRun(file);
  assert.deepEqual(after.reportBack.acknowledgedOriginObserverIds ?? [], []);
  assert.equal(after.reportBackAcknowledgedAt, undefined);
});

test('corrupt observer sidecars cannot fall back to the inline legacy session route', () => {
  const runId = 'report-corrupt-sidecar-no-fallback';
  const origin = 'report-corrupt-sidecar-origin';
  const file = writeRun(runId, origin);
  const runKey = createHash('sha256').update(runId).digest('hex');
  const dir = path.join(WORKFLOW_RUNS_DIR, '.run-origins', runKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'corrupt.json'), '{not-json', 'utf-8');
  let legacyCalls = 0;
  _setWorkflowRunReportBackDeliveryForTests(() => {
    legacyCalls += 1;
    return { acknowledged: true, written: true, disposition: 'written' };
  });
  try {
    assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
      workflowName: 'Ack Workflow',
      outcome: 'done',
      detail: 'must remain pending',
    }), false);
  } finally {
    _setWorkflowRunReportBackDeliveryForTests();
  }
  assert.equal(legacyCalls, 0);
  assert.equal(new SessionStore().get(origin).turns.length, 0);
  assert.equal(workflowRunReportBackNeedsRetry(readRun(file)), true);
});

test('a missing exact observer sidecar cannot reopen the mutable legacy session route', () => {
  const runId = 'report-missing-sidecar-no-fallback';
  const origin = 'report-missing-sidecar-origin';
  const source = addAcceptedSource({
    sessionId: origin,
    channel: 'discord',
    metadata: { channelId: '123456789012345679' },
  });
  const file = writeRun(runId, origin);
  addExactOrigin(runId, origin, source.seq);
  const runKey = createHash('sha256').update(runId).digest('hex');
  rmSync(path.join(WORKFLOW_RUNS_DIR, '.run-origins', runKey), {
    recursive: true,
    force: true,
  });

  let legacyCalls = 0;
  _setWorkflowRunReportBackDeliveryForTests(() => {
    legacyCalls += 1;
    return { acknowledged: true, written: true, disposition: 'written' };
  });
  try {
    assert.equal(recordAndAttemptWorkflowRunReportBack(file, {
      workflowName: 'Ack Workflow',
      outcome: 'done',
      detail: 'Must remain bound to the missing exact authority.',
    }), false);
  } finally {
    _setWorkflowRunReportBackDeliveryForTests();
  }
  assert.equal(legacyCalls, 0);
  assert.equal(readRun(file).reportBackRetry.kind, 'corrupt_evidence');
  assert.deepEqual(readRun(file).reportBack.acknowledgedOriginSessionIds, []);
});

test('cancellation winning immediately before checkpoint cannot accept a stale success envelope', () => {
  const runId = 'report-cancel-checkpoint-race';
  const file = runFile(runId);
  writeFileSync(file, JSON.stringify({
    id: runId,
    workflow: 'Ack Workflow',
    status: 'running',
  }), 'utf-8');
  _setWorkflowRunReportBackBeforeCheckpointLockForTests(() => {
    const result = cancelWorkflowRunAtBoundary({
      runId,
      reason: 'cancel won boundary',
      source: 'report-race-test',
    });
    assert.equal(result.status, 'cancelled');
  });
  try {
    assert.equal(checkpointWorkflowRunReportBack(file, {
      workflowName: 'Ack Workflow',
      outcome: 'done',
      detail: 'stale success',
    }), false);
  } finally {
    _setWorkflowRunReportBackBeforeCheckpointLockForTests();
  }
  const run = readRun(file);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.reportBack.outcome, 'failed');
  assert.equal(run.reportBack.detail, 'cancel won boundary');
});

test('the first exact terminal envelope is immutable even when another lane is status-compatible', () => {
  const file = writeRun('report-envelope-immutable', 'report-envelope-origin');
  assert.equal(checkpointWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'first exact body',
  }), true);
  assert.equal(checkpointWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'blocked',
    detail: 'different compatible body',
  }), false);
  assert.equal(readRun(file).reportBack.detail, 'first exact body');
  assert.equal(readRun(file).reportBack.outcome, 'done');
});

test('a locked old attempt cannot overwrite or split a competing exact envelope', async () => {
  const runId = 'report-locked-generation';
  const file = writeRun(runId);
  assert.equal(checkpointWorkflowRunReportBack(file, {
    workflowName: 'Ack Workflow',
    outcome: 'done',
    detail: 'first exact body',
  }), true);
  const ready = path.join(TMP_HOME, `${runId}.ready`);
  const release = path.join(TMP_HOME, `${runId}.release`);
  const attemptResult = path.join(TMP_HOME, `${runId}.attempt-result`);
  const checkpointResult = path.join(TMP_HOME, `${runId}.checkpoint-result`);
  const childCode = String.raw`
    import { writeFileSync } from 'node:fs';
    const mod = await import(process.env.CLEM_REPORT_MODULE_URL);
    const result = process.env.CLEM_REPORT_OP === 'attempt'
      ? mod.attemptWorkflowRunReportBack(process.env.CLEM_REPORT_FILE)
      : mod.checkpointWorkflowRunReportBack(process.env.CLEM_REPORT_FILE, JSON.parse(process.env.CLEM_REPORT_INPUT));
    writeFileSync(process.env.CLEM_REPORT_RESULT, String(result), 'utf-8');
  `;
  const attempt = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEM_REPORT_MODULE_URL: REPORT_MODULE_URL,
      CLEM_REPORT_OP: 'attempt',
      CLEM_REPORT_FILE: file,
      CLEM_REPORT_RESULT: attemptResult,
      CLEMENTINE_TEST_REPORT_BACK_LOCK_READY: ready,
      CLEMENTINE_TEST_REPORT_BACK_LOCK_RELEASE: release,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let checkpoint: ReturnType<typeof spawn> | undefined;
  try {
    await waitForFile(ready);
    checkpoint = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEM_REPORT_MODULE_URL: REPORT_MODULE_URL,
        CLEM_REPORT_OP: 'checkpoint',
        CLEM_REPORT_FILE: file,
        CLEM_REPORT_RESULT: checkpointResult,
        CLEM_REPORT_INPUT: JSON.stringify({
          workflowName: 'Ack Workflow',
          outcome: 'blocked',
          detail: 'competing body',
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(checkpointResult), false, 'checkpoint waits behind the in-flight merge lock');
    writeFileSync(release, 'continue', 'utf-8');
    const [[attemptCode], [checkpointCode]] = await Promise.all([
      once(attempt, 'close') as Promise<[number | null]>,
      once(checkpoint, 'close') as Promise<[number | null]>,
    ]);
    assert.equal(attemptCode, 0);
    assert.equal(checkpointCode, 0);
    assert.equal(readFileSync(attemptResult, 'utf-8'), 'true');
    assert.equal(readFileSync(checkpointResult, 'utf-8'), 'false');
    const final = readRun(file);
    assert.equal(final.reportBack.detail, 'first exact body');
    assert.equal(typeof final.reportBackAcknowledgedAt, 'string');
    assert.equal(final.notifiedAt, undefined);
  } finally {
    if (attempt.exitCode === null) attempt.kill('SIGKILL');
    if (checkpoint?.exitCode === null) checkpoint.kill('SIGKILL');
  }
});

test('corrupt report evidence backs off and then quarantines without clearing pending truth', () => {
  const runId = 'report-corrupt-backoff';
  const file = writeRun(runId, 'report-corrupt-backoff-origin');
  const run = readRun(file);
  run.notifiedAt = new Date(0).toISOString();
  run.reportBack = { version: 1, outcome: 'done', acknowledgedOriginSessionIds: 'invalid' };
  writeFileSync(file, JSON.stringify(run), 'utf-8');

  let now = 1_000_000;
  assert.equal(attemptWorkflowRunReportBack(file, now), false);
  let after = readRun(file);
  assert.equal(after.reportBackRetry.failureCount, 1);
  assert.equal(after.notifiedAt, new Date(0).toISOString(), 'origin retry cannot erase dashboard notification evidence');
  assert.equal(after.reportBackAcknowledgedAt, undefined);
  assert.equal(workflowRunReportBackNeedsRetry(after), true);
  assert.equal(workflowRunReportBackRetryDue(after, now), false);
  const unchanged = readFileSync(file, 'utf-8');
  assert.equal(attemptWorkflowRunReportBack(file, now), false);
  assert.equal(readFileSync(file, 'utf-8'), unchanged, 'not-due timer ticks perform no rewrite/fsync');

  now = Date.parse(after.reportBackRetry.nextAttemptAt);
  assert.equal(attemptWorkflowRunReportBack(file, now), false);
  after = readRun(file);
  assert.equal(after.reportBackRetry.failureCount, 2);
  now = Date.parse(after.reportBackRetry.nextAttemptAt);
  assert.equal(attemptWorkflowRunReportBack(file, now), false);
  after = readRun(file);
  assert.equal(after.reportBackRetry.failureCount, 3);
  assert.equal(typeof after.reportBackRetry.quarantinedAt, 'string');
  assert.equal(workflowRunReportBackNeedsRetry(after), true);
  assert.equal(workflowRunReportBackRetryDue(after, now + 365 * 24 * 60 * 60_000), false);
});
