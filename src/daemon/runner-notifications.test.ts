/**
 * Run: npx tsx --test src/daemon/runner-notifications.test.ts
 *
 * Focused daemon notification-delivery regressions. These tests keep
 * CLEMENTINE_HOME isolated and do not start the daemon loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-daemon-notif-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.DISCORD_ENABLED = 'false';
process.env.SLACK_ENABLED = 'false';
process.env.WEBHOOK_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  addNotification,
  bindNotificationDeliveryPlan,
  exactOriginDeliveryDestinationId,
  exactOriginDeliveryMetadata,
  getNotification,
  getNotificationDestinationsForRecord,
  listNotifications,
  listNotificationDestinations,
  listQueuedNotificationDeliveries,
  recoverCorruptedNotificationDeliveryQueue,
  removeNotificationDestination,
  requeueNotificationDelivery,
  replaceQueuedNotificationDeliveries,
  updateNotificationDeliveryStatus,
  upsertNotificationDestination,
} = await import('../runtime/notifications.js');
const {
  _setNotificationDeliveryForTests,
  processNotificationDeliveries,
} = await import('./runner.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const assistantStub = {
  getRuntime() {
    return {
      listPendingApprovals() {
        return [];
      },
    };
  },
} as never;

test('U5 (v2.3.0): a LOUD notification with nothing configured resolves the desktop leg and DELIVERS', async () => {
  addNotification({
    id: 'loud-desktop-1',
    kind: 'system',
    title: 'Loud with no external destinations',
    body: 'The desktop leg is the guaranteed surface.',
    createdAt: new Date().toISOString(),
    read: false,
  });
  await processNotificationDeliveries(assistantStub);
  assert.equal(
    listQueuedNotificationDeliveries().some((job) => job.notificationId === 'loud-desktop-1'),
    false,
    'the loud record delivered via the desktop leg — never deferred (the 2026-07-22 stuck-jobs class)',
  );
  assert.doesNotMatch(getNotification('loud-desktop-1')?.deliveryError ?? '', /no notification destinations/i);
});

// The no-destination backoff machinery has NO reachable case post-U5: loud
// records always resolve the desktop leg and deliver; silent records are
// dashboard-only and never enqueue delivery jobs. Only the legacy-record
// cleanup below still matters (queues written by pre-U5 versions).
test('legacy no-destination setup warnings are cleaned from the delivery queue', async () => {
  addNotification({
    id: 'legacy-no-destinations-warning',
    kind: 'system',
    title: '1 notification cannot be delivered',
    body: 'No notification destination is configured.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { errorCategory: 'no_destinations' },
  });

  await processNotificationDeliveries(assistantStub);

  assert.equal(
    listQueuedNotificationDeliveries().some((job) => job.notificationId === 'legacy-no-destinations-warning'),
    false,
    'legacy no-destination setup warnings are removed from the external delivery queue',
  );
  assert.match(
    getNotification('legacy-no-destinations-warning')?.deliveryError ?? '',
    /dashboard-only/i,
    'legacy setup warning remains in Activity but is marked dashboard-only for delivery',
  );
});

test('restart reconciliation trusts only a durable receipt for the currently authorized exact destination', async () => {
  const deliveredId = 'exact-receipt-survived-queue-crash';
  const deliveredTarget = { type: 'discord_channel', channelId: 'C_EXACT_DURABLE' } as const;
  const deliveredReceipt = exactOriginDeliveryDestinationId(deliveredTarget);
  assert.ok(deliveredReceipt);
  addNotification({
    id: deliveredId,
    kind: 'workflow',
    title: 'Exact terminal result',
    body: 'One exact result body.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: exactOriginDeliveryMetadata(deliveredTarget),
  });
  updateNotificationDeliveryStatus(deliveredId, {
    deliveredAt: new Date().toISOString(),
    deliveredDestinations: [deliveredReceipt],
  });
  // Simulate process death after notifications.json was fsynced but before
  // the queue replacement persisted the completed destination cursor.
  replaceQueuedNotificationDeliveries([{
    notificationId: deliveredId,
    queuedAt: new Date().toISOString(),
    completedDestinationIds: [],
  }]);

  let providerSends = 0;
  _setNotificationDeliveryForTests(async () => {
    providerSends += 1;
  });
  try {
    await processNotificationDeliveries(assistantStub);
    assert.equal(providerSends, 0, 'durable exact receipt prevents a restart duplicate send');
    assert.equal(
      listQueuedNotificationDeliveries().some((job) => job.notificationId === deliveredId),
      false,
      'stale pre-receipt queue cursor is cleared after reconciliation',
    );

    const mismatchedId = 'wrong-exact-receipt-does-not-ack';
    const currentTarget = {
      type: 'slack_channel',
      channelId: 'C0CURRENT',
      threadTs: '1700000000.000200',
    } as const;
    const wrongTarget = {
      type: 'slack_channel',
      channelId: currentTarget.channelId,
      threadTs: '1700000000.000199',
    } as const;
    const currentReceipt = exactOriginDeliveryDestinationId(currentTarget);
    const wrongReceipt = exactOriginDeliveryDestinationId(wrongTarget);
    assert.ok(currentReceipt && wrongReceipt && currentReceipt !== wrongReceipt);
    addNotification({
      id: mismatchedId,
      kind: 'workflow',
      title: 'Exact threaded terminal result',
      body: 'Only the current admitted thread may acknowledge this result.',
      createdAt: new Date().toISOString(),
      read: false,
      metadata: exactOriginDeliveryMetadata(currentTarget),
    });
    updateNotificationDeliveryStatus(mismatchedId, {
      deliveredAt: new Date().toISOString(),
      deliveredDestinations: [wrongReceipt],
    });
    replaceQueuedNotificationDeliveries([{
      notificationId: mismatchedId,
      queuedAt: new Date().toISOString(),
      completedDestinationIds: [],
    }]);

    await processNotificationDeliveries(assistantStub);
    assert.equal(providerSends, 1, 'receipt for another thread cannot suppress the authorized send');
    assert.equal(
      listQueuedNotificationDeliveries().some((job) => job.notificationId === mismatchedId),
      false,
    );
    assert.ok(
      getNotification(mismatchedId)?.deliveredDestinations?.includes(currentReceipt),
      'successful authorized send records the current exact receipt',
    );
  } finally {
    _setNotificationDeliveryForTests(null);
  }
});

test('a notification enqueued while another provider send is blocked survives pass settlement', async () => {
  replaceQueuedNotificationDeliveries([]);
  const targetA = { type: 'discord_channel', channelId: 'C_BLOCKED_A' } as const;
  const targetB = { type: 'discord_channel', channelId: 'C_ENQUEUED_B' } as const;
  addNotification({
    id: 'blocked-send-a',
    kind: 'workflow',
    title: 'Blocked send A',
    body: 'A is already in the worker snapshot.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: exactOriginDeliveryMetadata(targetA),
  });

  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  let releaseResolve!: () => void;
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  let sends = 0;
  _setNotificationDeliveryForTests(async (notification) => {
    sends += 1;
    if (notification.id === 'blocked-send-a') {
      enteredResolve();
      await release;
    }
  });
  try {
    const pass = processNotificationDeliveries(assistantStub);
    await entered;
    addNotification({
      id: 'enqueued-during-send-b',
      kind: 'workflow',
      title: 'Exact terminal B',
      body: 'B arrived after the pass snapshot and must remain queued.',
      createdAt: new Date().toISOString(),
      read: false,
      metadata: exactOriginDeliveryMetadata(targetB),
    });
    releaseResolve();
    await pass;

    assert.equal(sends, 1, 'the current pass sends only snapshotted A');
    const remainingIds = listQueuedNotificationDeliveries().map((job) => job.notificationId);
    assert.equal(remainingIds.includes('blocked-send-a'), false);
    assert.equal(
      remainingIds.includes('enqueued-during-send-b'),
      true,
      'CAS settlement preserves exact terminal B appended during A provider await',
    );
  } finally {
    releaseResolve();
    _setNotificationDeliveryForTests(null);
    const targetBReceipt = exactOriginDeliveryDestinationId(targetB);
    if (targetBReceipt) {
      updateNotificationDeliveryStatus('enqueued-during-send-b', {
        deliveredAt: new Date().toISOString(),
        deliveredDestinations: [targetBReceipt],
      });
    }
    replaceQueuedNotificationDeliveries([]);
  }
});

test('exact-origin provider failure remains pending without leaking to noisy fallbacks', async () => {
  replaceQueuedNotificationDeliveries([]);
  upsertNotificationDestination({
    id: 'noisy-configured-webhook',
    name: 'Noisy configured webhook',
    type: 'generic_webhook',
    url: 'https://must-not-receive.example.test/hook',
    enabled: true,
    createdAt: new Date().toISOString(),
  });
  const notificationId = 'exact-exhausted-no-fallback-alert';
  const target = { type: 'discord_channel', channelId: 'C_EXHAUSTED' } as const;
  const receipt = exactOriginDeliveryDestinationId(target);
  assert.ok(receipt);
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Exact result that cannot deliver',
    body: 'Private exact-origin terminal body.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: exactOriginDeliveryMetadata(target),
  });
  updateNotificationDeliveryStatus(notificationId, {
    deliveryAttempts: 4,
    deliveryAttemptCountByDestination: { [receipt]: 4 },
  });
  replaceQueuedNotificationDeliveries([{
    notificationId,
    queuedAt: new Date().toISOString(),
    completedDestinationIds: [],
    failedDestinationIds: [],
    attemptCountByDestination: {},
    nextAttemptAtByDestination: {},
    lastErrorByDestination: {},
  }]);

  let providerCalls = 0;
  _setNotificationDeliveryForTests(async () => {
    providerCalls += 1;
    throw new Error('forced exact provider exhaustion');
  });
  try {
    await processNotificationDeliveries(assistantStub);
  } finally {
    _setNotificationDeliveryForTests(null);
  }

  assert.equal(providerCalls, 1);
  const alertId = `delivery-failed-${notificationId}`;
  assert.equal(getNotification(alertId), undefined, 'exact reply remains live instead of terminally failing');
  assert.equal(
    listQueuedNotificationDeliveries().some((job) => job.notificationId === notificationId),
    true,
    'exact carrier stays queued for provider recovery beyond the generic retry cap',
  );
  assert.equal(getNotification(notificationId)?.deliveryAttemptCountByDestination?.[receipt], 5);
  updateNotificationDeliveryStatus(notificationId, {
    deliveredAt: new Date().toISOString(),
    deliveredDestinations: [receipt],
  });
  removeNotificationDestination('noisy-configured-webhook');
  replaceQueuedNotificationDeliveries([]);
});

test('each successful destination receipt is durable before the next provider call completes', async () => {
  replaceQueuedNotificationDeliveries([]);
  for (const destination of listNotificationDestinations()) {
    removeNotificationDestination(destination.id);
  }
  for (const [id, name] of [['receipt-a', 'A receipt'], ['receipt-b', 'B receipt']] as const) {
    upsertNotificationDestination({
      id,
      name,
      type: 'generic_webhook',
      url: `https://${id}.example.test/hook`,
      enabled: true,
      createdAt: new Date().toISOString(),
    });
  }
  addNotification({
    id: 'multi-destination-crash-boundary',
    kind: 'workflow',
    title: 'Multi destination result',
    body: 'A must not be repeated if the process dies while B is in flight.',
    createdAt: new Date().toISOString(),
    read: false,
  });

  let enteredBResolve!: () => void;
  const enteredB = new Promise<void>((resolve) => { enteredBResolve = resolve; });
  let releaseBResolve!: () => void;
  const releaseB = new Promise<void>((resolve) => { releaseBResolve = resolve; });
  _setNotificationDeliveryForTests(async (_notification, destination) => {
    if (destination.id === 'receipt-b') {
      enteredBResolve();
      await releaseB;
    }
  });
  try {
    const pass = processNotificationDeliveries(assistantStub);
    await enteredB;
    assert.ok(
      getNotification('multi-destination-crash-boundary')?.deliveredDestinations?.includes('receipt-a'),
      'A provider receipt is fsynced before B can block or crash the pass',
    );
    releaseBResolve();
    await pass;
  } finally {
    releaseBResolve();
    _setNotificationDeliveryForTests(null);
    for (const destination of listNotificationDestinations()) {
      removeNotificationDestination(destination.id);
    }
    replaceQueuedNotificationDeliveries([]);
  }
});

test('queue corruption after destination A cannot lose bound destination B', async () => {
  replaceQueuedNotificationDeliveries([]);
  for (const destination of listNotificationDestinations()) {
    removeNotificationDestination(destination.id);
  }
  for (const [id, name] of [['rebuild-a', 'A rebuild'], ['rebuild-b', 'B rebuild']] as const) {
    upsertNotificationDestination({
      id,
      name,
      type: 'generic_webhook',
      url: `https://${id}.example.test/hook`,
      enabled: true,
      createdAt: new Date().toISOString(),
    });
  }
  const notificationId = 'multi-destination-queue-rebuild';
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Two-destination recovery',
    body: 'A is durable; B must survive a lost retry cursor.',
    createdAt: new Date().toISOString(),
    read: false,
  });

  _setNotificationDeliveryForTests(async (_notification, destination) => {
    if (destination.id === 'rebuild-b') throw new Error('B is temporarily unavailable');
  });
  try {
    await processNotificationDeliveries(assistantStub);
    assert.deepEqual(getNotification(notificationId)?.deliveryPlan?.destinationIds, [
      'rebuild-a',
      'rebuild-b',
      'derived-desktop',
    ]);
    assert.deepEqual(getNotification(notificationId)?.deliveredDestinations, [
      'rebuild-a',
      'derived-desktop',
    ]);
    assert.equal(getNotification(notificationId)?.deliveryPlanCompletedAt, undefined);

    writeFileSync(
      path.join(TMP_HOME, 'state', 'notification-delivery-queue.json'),
      '{corrupt queue generation',
    );
    updateNotificationDeliveryStatus(notificationId, {
      deliveryNextAttemptAtByDestination: { 'rebuild-b': new Date(0).toISOString() },
    });
    const replayed: string[] = [];
    _setNotificationDeliveryForTests(async (_notification, destination) => {
      replayed.push(destination.id);
    });
    await processNotificationDeliveries(assistantStub);

    assert.deepEqual(
      replayed.filter((destinationId) => destinationId.startsWith('rebuild-')),
      ['rebuild-b'],
      'recovery skips A and sends the still-bound B once',
    );
    assert.equal(
      listQueuedNotificationDeliveries().some((job) => job.notificationId === notificationId),
      false,
    );
    assert.equal(typeof getNotification(notificationId)?.deliveryPlanCompletedAt, 'string');
  } finally {
    _setNotificationDeliveryForTests(null);
    for (const destination of listNotificationDestinations()) {
      removeNotificationDestination(destination.id);
    }
    replaceQueuedNotificationDeliveries([]);
  }
});

test('queue cursors cannot manufacture success or permanent failure without carrier evidence', async () => {
  replaceQueuedNotificationDeliveries([]);
  for (const destination of listNotificationDestinations()) {
    removeNotificationDestination(destination.id);
  }
  upsertNotificationDestination({
    id: 'cursor-authority-webhook',
    name: 'Cursor authority webhook',
    type: 'generic_webhook',
    url: 'https://cursor-authority.example.test/hook',
    enabled: true,
    createdAt: new Date().toISOString(),
  });
  const notificationId = 'cursor-cannot-forge-terminal';
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Carrier owns delivery facts',
    body: 'The retry cursor cannot settle this message.',
    createdAt: new Date().toISOString(),
    read: false,
  });
  const notification = getNotification(notificationId);
  assert.ok(notification);
  const destinations = getNotificationDestinationsForRecord(notification);
  assert.ok(bindNotificationDeliveryPlan(notificationId, destinations)?.deliveryPlan);
  const destinationIds = destinations.map((destination) => destination.id);
  assert.equal(destinationIds.length, 2, 'configured webhook plus durable desktop surface');
  replaceQueuedNotificationDeliveries([{
    notificationId,
    queuedAt: new Date().toISOString(),
    completedDestinationIds: [destinationIds[0]],
    failedDestinationIds: [destinationIds[1]],
    attemptCountByDestination: Object.fromEntries(destinationIds.map((id) => [id, 5])),
    nextAttemptAtByDestination: {},
    lastErrorByDestination: {},
  }]);

  const sent: string[] = [];
  _setNotificationDeliveryForTests(async (_carrier, destination) => {
    sent.push(destination.id);
  });
  try {
    await processNotificationDeliveries(assistantStub);
    assert.deepEqual(sent, destinationIds, 'both destinations require durable carrier evidence');
    assert.deepEqual(getNotification(notificationId)?.deliveredDestinations, destinationIds);
    assert.equal(typeof getNotification(notificationId)?.deliveryPlanCompletedAt, 'string');
  } finally {
    _setNotificationDeliveryForTests(null);
    for (const destination of listNotificationDestinations()) {
      removeNotificationDestination(destination.id);
    }
    replaceQueuedNotificationDeliveries([]);
  }
});

test('manual retry atomically resets carrier-owned failure and stale-age authority', async () => {
  replaceQueuedNotificationDeliveries([]);
  for (const destination of listNotificationDestinations()) {
    removeNotificationDestination(destination.id);
  }
  const webhookId = 'manual-retry-webhook';
  upsertNotificationDestination({
    id: webhookId,
    name: 'Manual retry webhook',
    type: 'generic_webhook',
    url: 'https://manual-retry.example.test/hook',
    enabled: true,
    createdAt: new Date().toISOString(),
  });
  const notificationId = 'manual-retry-resets-carrier';
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Old failed result',
    body: 'An explicit retry must actually call the provider.',
    createdAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
    read: false,
  });
  updateNotificationDeliveryStatus(notificationId, {
    deliveredAt: new Date().toISOString(),
    deliveredDestinations: ['derived-desktop'],
    deliveryAttempts: 6,
    deliveryAttemptCountByDestination: { [webhookId]: 5, 'derived-desktop': 1 },
    deliveryNextAttemptAtByDestination: {
      [webhookId]: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
    deliveryLastErrorByDestination: { [webhookId]: 'old terminal failure' },
    deliveryPlanCompletedAt: new Date().toISOString(),
  });
  replaceQueuedNotificationDeliveries([]);

  requeueNotificationDelivery(notificationId);
  const reset = getNotification(notificationId);
  assert.deepEqual(reset?.deliveryAttemptCountByDestination, undefined);
  assert.deepEqual(reset?.deliveryNextAttemptAtByDestination, undefined);
  assert.equal(reset?.deliveryPlanCompletedAt, undefined);
  assert.match(reset?.deliveryRetryRequestedAt ?? '', /^\d{4}-/);

  const sent: string[] = [];
  _setNotificationDeliveryForTests(async (_carrier, destination) => {
    sent.push(destination.id);
  });
  try {
    await processNotificationDeliveries(assistantStub);
    assert.deepEqual(sent, [webhookId], 'successful desktop receipt is preserved; failed webhook is retried');
    assert.equal(
      listQueuedNotificationDeliveries().some((job) => job.notificationId === notificationId),
      false,
    );
  } finally {
    _setNotificationDeliveryForTests(null);
    removeNotificationDestination(webhookId);
    replaceQueuedNotificationDeliveries([]);
  }
});

test('an in-flight stale pass cannot overwrite a manual retry generation', async () => {
  replaceQueuedNotificationDeliveries([]);
  for (const destination of listNotificationDestinations()) {
    removeNotificationDestination(destination.id);
  }
  for (const id of ['retry-race-a', 'retry-race-b']) {
    upsertNotificationDestination({
      id,
      name: id,
      type: 'generic_webhook',
      url: `https://${id}.example.test/hook`,
      enabled: true,
      createdAt: new Date().toISOString(),
    });
  }
  const notificationId = 'manual-retry-wins-stale-worker';
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Retry generation race',
    body: 'The user retry must win while a prior provider call is blocked.',
    createdAt: new Date().toISOString(),
    read: false,
  });
  updateNotificationDeliveryStatus(notificationId, {
    deliveryAttempts: 5,
    deliveryAttemptCountByDestination: { 'retry-race-a': 5 },
    deliveryLastErrorByDestination: { 'retry-race-a': 'old permanent failure' },
  });

  let enteredBResolve!: () => void;
  const enteredB = new Promise<void>((resolve) => { enteredBResolve = resolve; });
  let releaseBResolve!: () => void;
  const releaseB = new Promise<void>((resolve) => { releaseBResolve = resolve; });
  _setNotificationDeliveryForTests(async (_carrier, destination) => {
    if (destination.id === 'retry-race-b') {
      enteredBResolve();
      await releaseB;
    }
  });
  try {
    const stalePass = processNotificationDeliveries(assistantStub);
    await enteredB;
    requeueNotificationDelivery(notificationId);
    releaseBResolve();
    await stalePass;

    const afterStalePass = getNotification(notificationId);
    assert.equal(afterStalePass?.deliveryAttemptCountByDestination, undefined);
    assert.equal(afterStalePass?.deliveryPlanCompletedAt, undefined);
    assert.ok(afterStalePass?.deliveredDestinations?.includes('retry-race-b'));
    assert.ok(afterStalePass?.deliveredDestinations?.includes('derived-desktop'));
    assert.equal(getNotification(`delivery-failed-${notificationId}`), undefined);

    const replayed: string[] = [];
    _setNotificationDeliveryForTests(async (_carrier, destination) => {
      replayed.push(destination.id);
    });
    await processNotificationDeliveries(assistantStub);
    assert.deepEqual(replayed, ['retry-race-a'], 'new generation retries only the still-unreceipted sibling');
  } finally {
    releaseBResolve();
    _setNotificationDeliveryForTests(null);
    for (const id of ['retry-race-a', 'retry-race-b']) removeNotificationDestination(id);
    replaceQueuedNotificationDeliveries([]);
  }
});

test('a same-id destination edit cannot redirect an admitted notification', async () => {
  replaceQueuedNotificationDeliveries([]);
  for (const destination of listNotificationDestinations()) {
    removeNotificationDestination(destination.id);
  }
  const originalDestination = {
    id: 'immutable-route-webhook',
    name: 'Immutable route webhook',
    type: 'generic_webhook' as const,
    url: 'https://original-owner.example.test/hook',
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  upsertNotificationDestination(originalDestination);
  const notificationId = 'immutable-route-carrier';
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Private admitted bytes',
    body: 'These bytes belong only to the original route authority.',
    createdAt: new Date().toISOString(),
    read: false,
  });
  const notification = getNotification(notificationId);
  assert.ok(notification);
  assert.ok(
    notification.deliveryPlan,
    'route authority is frozen in the admission generation before any worker runs',
  );
  upsertNotificationDestination({
    ...originalDestination,
    url: 'https://different-owner.example.test/hook',
  });

  const sentUrls: Array<string | undefined> = [];
  _setNotificationDeliveryForTests(async (_carrier, destination) => {
    sentUrls.push(destination.url);
  });
  try {
    await processNotificationDeliveries(assistantStub);
    assert.deepEqual(sentUrls, [undefined], 'the changed webhook receives nothing; durable desktop may settle');
    assert.match(getNotification(notificationId)?.deliveryError ?? '', /route authority changed/i);
    assert.ok(listQueuedNotificationDeliveries().some((job) => job.notificationId === notificationId));

    // Advance only the carrier-owned retry authority to the final attempt.
    // The changed route must receive neither the original bytes nor the
    // failure alert that quotes their private title.
    updateNotificationDeliveryStatus(notificationId, {
      deliveryAttempts: 4,
      deliveryAttemptCountByDestination: { [originalDestination.id]: 4 },
      deliveryNextAttemptAtByDestination: {},
      deliveryLastErrorByDestination: {
        [originalDestination.id]: 'Bound destination is unavailable or its route authority changed',
      },
    });
    await processNotificationDeliveries(assistantStub);
    assert.deepEqual(sentUrls, [undefined], 'no later send crosses the replacement route');
    assert.equal(
      listQueuedNotificationDeliveries().some((job) => job.notificationId === notificationId),
      false,
      'the generic mismatched leg reaches a durable local terminal after the retry cap',
    );
    const failureAlert = getNotification(`delivery-failed-${notificationId}`);
    assert.equal(failureAlert?.silent, true, 'authority-mismatch disclosure stays local-only');
    assert.equal(failureAlert?.metadata?.routeAuthorityFailure, true);
    assert.throws(
      () => requeueNotificationDelivery(`delivery-failed-${notificationId}`),
      /local-only/i,
      'a retry action cannot widen a local failure diagnostic into external delivery',
    );
    assert.equal(
      listQueuedNotificationDeliveries().some(
        (job) => job.notificationId === `delivery-failed-${notificationId}`,
      ),
      false,
      'the local-only alert cannot resolve against the replacement route',
    );
    replaceQueuedNotificationDeliveries([{
      notificationId: `delivery-failed-${notificationId}`,
      queuedAt: new Date().toISOString(),
      completedDestinationIds: [],
      failedDestinationIds: [],
      attemptCountByDestination: {},
      nextAttemptAtByDestination: {},
      lastErrorByDestination: {},
    }]);
    await processNotificationDeliveries(assistantStub);
    assert.deepEqual(sentUrls, [undefined], 'even a forged queue cursor cannot externalize the local alert');
    assert.equal(listQueuedNotificationDeliveries().length, 0);
  } finally {
    _setNotificationDeliveryForTests(null);
    for (const destination of listNotificationDestinations()) {
      removeNotificationDestination(destination.id);
    }
    replaceQueuedNotificationDeliveries([]);
  }
});

test('a stale generic delivery records a terminal plan and cannot resurrect on queue rebuild', async () => {
  replaceQueuedNotificationDeliveries([]);
  for (const destination of listNotificationDestinations()) {
    removeNotificationDestination(destination.id);
  }
  const notificationId = 'stale-generic-plan-terminal';
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Old generic result',
    body: 'This old result must stay in Activity without being pushed later.',
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    read: false,
  });

  let providerCalls = 0;
  _setNotificationDeliveryForTests(async () => {
    providerCalls += 1;
  });
  try {
    await processNotificationDeliveries(assistantStub);
  } finally {
    _setNotificationDeliveryForTests(null);
  }

  assert.equal(providerCalls, 0, 'the stale carrier never crosses a provider boundary');
  assert.equal(
    typeof getNotification(notificationId)?.deliveryPlanCompletedAt,
    'string',
    'the stale-drop decision is durable carrier authority',
  );
  assert.equal(
    listQueuedNotificationDeliveries().some((job) => job.notificationId === notificationId),
    false,
  );

  rmSync(path.join(TMP_HOME, 'state', 'notification-delivery-queue.json'), { force: true });
  recoverCorruptedNotificationDeliveryQueue();
  assert.equal(
    listQueuedNotificationDeliveries().some((job) => job.notificationId === notificationId),
    false,
    'a later missing-queue rebuild respects the recorded terminal plan',
  );
});

test('a malformed destination catalog records the carrier but binds and sends no fallback route', async () => {
  replaceQueuedNotificationDeliveries([]);
  for (const destination of listNotificationDestinations()) {
    removeNotificationDestination(destination.id);
  }
  const destinationsFile = path.join(TMP_HOME, 'state', 'notification-destinations.json');
  const recoveryFile = path.join(
    TMP_HOME,
    'state',
    'notification-destinations.recovery-required.json',
  );
  writeFileSync(destinationsFile, JSON.stringify({ validJson: 'wrong top-level shape' }));
  const notificationId = 'destination-corruption-defers-authority';
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Result survives route corruption',
    body: 'Do not send this through a fallback-only route.',
    createdAt: new Date().toISOString(),
    read: false,
  });

  assert.ok(getNotification(notificationId), 'carrier admission survives malformed destination state');
  assert.equal(getNotification(notificationId)?.deliveryPlan, undefined);
  assert.ok(listQueuedNotificationDeliveries().some((job) => job.notificationId === notificationId));
  assert.equal(existsSync(recoveryFile), true);

  const sentBeforeRepair: string[] = [];
  _setNotificationDeliveryForTests(async (_carrier, destination) => {
    sentBeforeRepair.push(destination.id);
  });
  await processNotificationDeliveries(assistantStub);
  assert.deepEqual(sentBeforeRepair, [], 'unknown catalog authority blocks even the desktop fallback');

  const restored = {
    id: 'restored-authority-webhook',
    name: 'Restored authority webhook',
    type: 'generic_webhook' as const,
    url: 'https://restored-authority.example.test/hook',
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(destinationsFile, JSON.stringify([restored]));
  const sentAfterRepair: string[] = [];
  _setNotificationDeliveryForTests(async (_carrier, destination) => {
    sentAfterRepair.push(destination.id);
  });
  try {
    await processNotificationDeliveries(assistantStub);
    assert.deepEqual(sentAfterRepair, [restored.id, 'derived-desktop']);
    assert.equal(existsSync(recoveryFile), false, 'valid canonical restoration clears unknown authority');
  } finally {
    _setNotificationDeliveryForTests(null);
    removeNotificationDestination(restored.id);
    replaceQueuedNotificationDeliveries([]);
  }
});

test('an old exact-origin terminal remains live after the generic age and retry caps', async () => {
  replaceQueuedNotificationDeliveries([]);
  const notificationId = 'exact-terminal-outlives-generic-caps';
  const target = { type: 'discord_channel', channelId: 'C_EXACT_LONG_LIVED' } as const;
  const receipt = exactOriginDeliveryDestinationId(target);
  assert.ok(receipt);
  const oldAt = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  addNotification({
    id: notificationId,
    kind: 'workflow',
    title: 'Long-lived exact terminal',
    body: 'Provider recovery must still deliver this exact result.',
    createdAt: oldAt,
    read: false,
    metadata: exactOriginDeliveryMetadata(target),
  });
  updateNotificationDeliveryStatus(notificationId, {
    deliveryAttempts: 5,
    deliveryAttemptCountByDestination: { [receipt]: 5 },
    deliveryNextAttemptAtByDestination: { [receipt]: oldAt },
    deliveryLastErrorByDestination: { [receipt]: 'provider was unavailable' },
  });

  let sends = 0;
  _setNotificationDeliveryForTests(async () => { sends += 1; });
  try {
    await processNotificationDeliveries(assistantStub);
    assert.equal(sends, 1, 'exact terminal retries after provider recovery instead of aging out');
    assert.ok(getNotification(notificationId)?.deliveredDestinations?.includes(receipt));
    assert.equal(
      listQueuedNotificationDeliveries().some((job) => job.notificationId === notificationId),
      false,
    );
  } finally {
    _setNotificationDeliveryForTests(null);
    replaceQueuedNotificationDeliveries([]);
  }
});

test('a corrupt notification carrier cannot CAS-delete its healthy queued delivery job', async () => {
  replaceQueuedNotificationDeliveries([]);
  addNotification({
    id: 'carrier-corruption-preserves-job',
    kind: 'workflow',
    title: 'Carrier survives by queue identity',
    body: 'Stable producer retry can restore this body.',
    createdAt: new Date().toISOString(),
    read: false,
  });
  writeFileSync(path.join(TMP_HOME, 'state', 'notifications.json'), '{corrupt notification generation');

  await processNotificationDeliveries(assistantStub);
  assert.ok(
    listQueuedNotificationDeliveries().some(
      (job) => job.notificationId === 'carrier-corruption-preserves-job',
    ),
    'missing carrier is retained for recovery rather than falsely settled',
  );

  // Leave the shared fixture healthy for any later tests in this file.
  writeFileSync(path.join(TMP_HOME, 'state', 'notifications.json'), '[]');
  replaceQueuedNotificationDeliveries([]);
});
