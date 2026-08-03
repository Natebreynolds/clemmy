/**
 * Run: npx tsx --test src/runtime/notifications-durability.test.ts
 *
 * Cross-process and retention regressions for the notification state lease.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-notification-durability-'));
const STATE_DIR = path.join(TMP_HOME, 'state');
const NOTIFICATIONS_FILE = path.join(STATE_DIR, 'notifications.json');
const DELIVERY_QUEUE_FILE = path.join(STATE_DIR, 'notification-delivery-queue.json');
const NOTIFICATIONS_RECOVERY_FILE = path.join(STATE_DIR, 'notifications.recovery-required.json');
const DELIVERY_QUEUE_RECOVERY_FILE = path.join(
  STATE_DIR,
  'notification-delivery-queue.recovery-required.json',
);
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(STATE_DIR, { recursive: true });

const notificationsModuleUrl = pathToFileURL(
  path.resolve('src/runtime/notifications.ts'),
).href;
const {
  _failNextNotificationDeliveryQueueWriteForTest,
  addNotification,
  exactOriginDeliveryDestinationId,
  exactOriginDeliveryMetadata,
  finalizeExactNotificationDeliveryReceiptSettlement,
  getNotification,
  listNotifications,
  listQueuedNotificationDeliveries,
  observeExactNotificationDeliveryReceipt,
  recoverCorruptedNotificationDeliveryQueue,
  settleQueuedNotificationDeliveryPass,
} = await import('./notifications.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!existsSync(filePath)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function spawnAdder(input: {
  id: string;
  attemptMarker: string;
  afterLoadMarker: string;
  releaseMarker?: string;
}): ChildProcess {
  const code = `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(input.attemptMarker)}, String(process.pid));
    const { addNotification } = await import(${JSON.stringify(notificationsModuleUrl)});
    addNotification({
      id: ${JSON.stringify(input.id)},
      kind: 'workflow',
      title: ${JSON.stringify(input.id)},
      body: ${JSON.stringify(`body:${input.id}`)},
      createdAt: new Date().toISOString(),
      read: false,
    });
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEMENTINE_TEST_NOTIFICATION_AFTER_LOAD_MARKER: input.afterLoadMarker,
      ...(input.releaseMarker
        ? { CLEMENTINE_TEST_NOTIFICATION_AFTER_LOAD_RELEASE: input.releaseMarker }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function childResult(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  if (child.exitCode !== null) return { code: child.exitCode, stderr };
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { code, stderr };
}

test('two processes cannot enter the same stale notification generation or lose either queued record', async () => {
  const firstAttempt = path.join(TMP_HOME, 'first-attempt');
  const firstAfterLoad = path.join(TMP_HOME, 'first-after-load');
  const firstRelease = path.join(TMP_HOME, 'first-release');
  const secondAttempt = path.join(TMP_HOME, 'second-attempt');
  const secondAfterLoad = path.join(TMP_HOME, 'second-after-load');

  const first = spawnAdder({
    id: 'cross-process-first',
    attemptMarker: firstAttempt,
    afterLoadMarker: firstAfterLoad,
    releaseMarker: firstRelease,
  });
  let second: ChildProcess | undefined;
  try {
    await waitForFile(firstAttempt);
    await waitForFile(firstAfterLoad);

    second = spawnAdder({
      id: 'cross-process-second',
      attemptMarker: secondAttempt,
      afterLoadMarker: secondAfterLoad,
    });
    await waitForFile(secondAttempt);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    assert.equal(
      existsSync(secondAfterLoad),
      false,
      'the peer must not read notifications.json while the first generation is paused',
    );
  } finally {
    writeFileSync(firstRelease, 'release', 'utf-8');
  }

  const [firstExit, secondExit] = await Promise.all([
    childResult(first),
    childResult(second!),
  ]);
  assert.equal(firstExit.code, 0, firstExit.stderr);
  assert.equal(secondExit.code, 0, secondExit.stderr);
  assert.ok(existsSync(secondAfterLoad), 'the peer enters only after the first lease releases');

  const notificationIds = new Set(listNotifications(10).map((item) => item.id));
  const queuedIds = new Set(listQueuedNotificationDeliveries().map((job) => job.notificationId));
  for (const id of ['cross-process-first', 'cross-process-second']) {
    assert.ok(notificationIds.has(id), `${id} notification survives`);
    assert.ok(queuedIds.has(id), `${id} delivery job survives`);
  }
});

test('count pruning retains every queued record and an unobserved exact receipt, then returns to the cap after settlement', () => {
  const now = Date.now();
  const exactId = 'retention-exact-unobserved';
  const exactTarget = { type: 'discord_channel', channelId: 'C_RETENTION_EXACT' } as const;
  const exactReceipt = exactOriginDeliveryDestinationId(exactTarget);
  assert.ok(exactReceipt);

  const exact = {
    id: exactId,
    kind: 'workflow' as const,
    title: 'Exact terminal receipt',
    body: 'The exact terminal was accepted by its provider.',
    createdAt: new Date(now - 60_000).toISOString(),
    read: false,
    deliveredAt: new Date(now - 59_000).toISOString(),
    deliveredDestinations: [exactReceipt],
    metadata: exactOriginDeliveryMetadata(exactTarget),
  };
  const pending = Array.from({ length: 1_000 }, (_, index) => ({
    id: `retention-pending-${String(index).padStart(4, '0')}`,
    kind: 'workflow' as const,
    title: `Pending ${index}`,
    body: `Pending body ${index}`,
    createdAt: new Date(now + index).toISOString(),
    read: false,
  }));
  const ordinary = Array.from({ length: 10 }, (_, index) => ({
    id: `retention-ordinary-${index}`,
    kind: 'system' as const,
    title: `Ordinary ${index}`,
    body: `Ordinary body ${index}`,
    createdAt: new Date(now + 10_000 + index).toISOString(),
    read: false,
  }));
  const queue = pending.map((item) => ({
    notificationId: item.id,
    queuedAt: new Date(now).toISOString(),
    completedDestinationIds: [],
    failedDestinationIds: [],
    attemptCountByDestination: {},
    nextAttemptAtByDestination: {},
    lastErrorByDestination: {},
  }));
  writeFileSync(NOTIFICATIONS_FILE, JSON.stringify([exact, ...pending, ...ordinary], null, 2));
  writeFileSync(DELIVERY_QUEUE_FILE, JSON.stringify(queue, null, 2));

  const retained = listNotifications(2_000);
  assert.equal(retained.length, 1_001, 'lossless evidence may temporarily exceed the normal cap');
  assert.ok(retained.some((item) => item.id === exactId), 'unobserved exact receipt survives');
  assert.equal(
    pending.every((pendingItem) => retained.some((item) => item.id === pendingItem.id)),
    true,
    'all 1,000 queued records survive count pruning',
  );
  assert.equal(
    ordinary.some((ordinaryItem) => retained.some((item) => item.id === ordinaryItem.id)),
    false,
    'ordinary records yield their count budget to settlement evidence',
  );

  const ordinaryRead = getNotification(exactId);
  assert.equal(
    ordinaryRead?.exactDeliveryReceiptObservedAt,
    undefined,
    'ordinary reads do not release exact delivery evidence',
  );
  assert.equal(
    observeExactNotificationDeliveryReceipt(exactId, `${exactReceipt}-wrong`),
    undefined,
    'a mismatched receipt cannot release exact delivery evidence',
  );
  const observed = observeExactNotificationDeliveryReceipt(exactId, exactReceipt);
  assert.ok(observed?.exactDeliveryReceiptObservedAt, 'precise settlement observation is durable');
  assert.ok(observed?.exactDeliveryReceiptSettlementPendingAt, 'observation remains pending settlement');
  const settlementDigest = 'a'.repeat(64);
  const finalized = finalizeExactNotificationDeliveryReceiptSettlement(
    exactId,
    exactReceipt,
    settlementDigest,
  );
  assert.equal(finalized?.exactDeliveryReceiptSettlementDigest, settlementDigest);
  assert.equal(finalized?.exactDeliveryReceiptSettlementPendingAt, undefined);

  const observedQueue = listQueuedNotificationDeliveries();
  settleQueuedNotificationDeliveryPass(observedQueue, []);
  const settled = listNotifications(2_000);
  assert.equal(settled.length, 1_000, 'settled evidence compacts back to the normal bound');
  assert.equal(settled.some((item) => item.id === exactId), false, 'expired observed receipt becomes prunable');
  assert.deepEqual(listQueuedNotificationDeliveries(), []);
});

test('the notification half of a failed queue write is protected even when its old timestamp crosses the count cap', () => {
  const now = Date.now();
  const ordinary = Array.from({ length: 1_000 }, (_, index) => ({
    id: `partial-boundary-ordinary-${index}`,
    kind: 'system' as const,
    title: `Ordinary ${index}`,
    body: `Ordinary ${index}`,
    createdAt: new Date(now + index).toISOString(),
    read: false,
  }));
  writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(ordinary, null, 2));
  writeFileSync(DELIVERY_QUEUE_FILE, '[]');

  const partial = {
    id: 'partial-boundary-protected',
    kind: 'workflow' as const,
    title: 'Old but newly admitted delivery',
    body: 'This record must survive until its queue half can be repaired.',
    createdAt: new Date(now - 24 * 60 * 60 * 1_000).toISOString(),
    read: false,
  };
  _failNextNotificationDeliveryQueueWriteForTest();
  assert.throws(() => addNotification(partial), /forced notification delivery queue write failure/);

  const afterFailure = JSON.parse(readFileSync(NOTIFICATIONS_FILE, 'utf-8')) as typeof ordinary;
  assert.equal(afterFailure.length, 1_000);
  assert.ok(
    afterFailure.some((item) => item.id === partial.id),
    'the just-admitted record wins a protected slot before its queue write',
  );

  addNotification({
    id: 'partial-boundary-intervening',
    kind: 'system',
    title: 'Unrelated mutation before recovery',
    body: 'This must not prune the stranded terminal carrier.',
    createdAt: new Date(now + 20_000).toISOString(),
    read: false,
  });
  const afterInterveningMutation = JSON.parse(
    readFileSync(NOTIFICATIONS_FILE, 'utf-8'),
  ) as typeof ordinary;
  assert.ok(
    afterInterveningMutation.some((item) => item.id === partial.id),
    'the durable admission marker protects the carrier across unrelated mutations',
  );

  assert.ok(
    listQueuedNotificationDeliveries().some((job) => job.notificationId === partial.id),
    'the next worker snapshot repairs the missing queue half without a caller retry',
  );
  assert.equal(
    (JSON.parse(readFileSync(NOTIFICATIONS_FILE, 'utf-8')) as Array<Record<string, unknown>>)
      .find((item) => item.id === partial.id)?.deliveryAdmissionPendingAt,
    undefined,
    'admission marker clears only after queue durability',
  );
});

test('a corrupt queue remains fail-closed across repeated reads and stale settlement until explicit rebuild', () => {
  const now = Date.now();
  const records = Array.from({ length: 1_001 }, (_, index) => ({
    id: `corrupt-queue-retained-${index}`,
    kind: 'system' as const,
    title: `Retained ${index}`,
    body: `Retained body ${index}`,
    createdAt: new Date(now + index).toISOString(),
    read: false,
    silent: true,
  }));
  writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(records, null, 2));
  writeFileSync(DELIVERY_QUEUE_FILE, '{corrupt queue generation');

  assert.equal(listNotifications(2_000).length, 1_001);
  assert.equal(
    listNotifications(2_000).length,
    1_001,
    'quarantine authority survives the now-missing queue file',
  );
  settleQueuedNotificationDeliveryPass([], []);
  assert.equal(
    listNotifications(2_000).length,
    1_001,
    'settling an obsolete snapshot cannot clear corruption authority or prune',
  );

  assert.deepEqual(recoverCorruptedNotificationDeliveryQueue(), {
    recovered: true,
    queued: 0,
  });
  assert.equal(
    listNotifications(2_000).length,
    1_000,
    'explicit durable rebuild restores normal bounded compaction',
  );
});

test('boot recovery rebuilds an undelivered legacy carrier when the old queue file is missing', () => {
  const createdAt = new Date(Date.now() - 14 * 24 * 60 * 60_000).toISOString();
  const legacy = {
    id: 'legacy-no-admission-marker',
    kind: 'workflow' as const,
    title: 'Legacy terminal carrier',
    body: 'A pre-journal crash must not strand this result.',
    createdAt,
    read: false,
  };
  writeFileSync(NOTIFICATIONS_FILE, JSON.stringify([legacy], null, 2));
  try { unlinkSync(DELIVERY_QUEUE_FILE); } catch { /* already absent */ }

  assert.deepEqual(recoverCorruptedNotificationDeliveryQueue(), {
    recovered: true,
    queued: 1,
  });
  assert.equal(listQueuedNotificationDeliveries()[0]?.notificationId, legacy.id);
  assert.equal(
    listQueuedNotificationDeliveries()[0]?.queuedAt,
    createdAt,
    'reconstruction preserves backlog age instead of making old work fresh',
  );
});

test('the exported observation API cannot accept a string as a delivered receipt array', () => {
  const target = { type: 'discord_channel', channelId: 'C_FALSE_STRING' } as const;
  const receipt = exactOriginDeliveryDestinationId(target);
  assert.ok(receipt);
  writeFileSync(NOTIFICATIONS_FILE, JSON.stringify([{
    id: 'false-string-receipt',
    kind: 'workflow',
    title: 'Malformed carrier',
    body: 'A string must not impersonate an exact receipt array.',
    createdAt: new Date().toISOString(),
    read: false,
    deliveredDestinations: receipt,
    metadata: exactOriginDeliveryMetadata(target),
  }]));
  writeFileSync(DELIVERY_QUEUE_FILE, '[]');

  assert.equal(observeExactNotificationDeliveryReceipt('false-string-receipt', receipt), undefined);
  assert.ok(existsSync(NOTIFICATIONS_RECOVERY_FILE), 'malformed valid JSON is quarantined fail-closed');

  // Isolate the final corruption-recovery test from this deliberate fixture.
  unlinkSync(NOTIFICATIONS_RECOVERY_FILE);
  writeFileSync(NOTIFICATIONS_FILE, '[]');
});

test('queue recovery never manufactures empty authority from a corrupt carrier generation', () => {
  writeFileSync(NOTIFICATIONS_FILE, JSON.stringify({ validJson: 'wrong top-level shape' }));
  writeFileSync(DELIVERY_QUEUE_FILE, '{corrupt queue generation');

  assert.deepEqual(recoverCorruptedNotificationDeliveryQueue(), {
    recovered: false,
    queued: 0,
  });
  assert.ok(existsSync(NOTIFICATIONS_RECOVERY_FILE));
  assert.ok(existsSync(DELIVERY_QUEUE_RECOVERY_FILE));
  assert.equal(existsSync(NOTIFICATIONS_FILE), false, 'unknown carrier bytes were quarantined');
  assert.equal(existsSync(DELIVERY_QUEUE_FILE), false, 'unknown queue bytes were quarantined');

  assert.deepEqual(
    recoverCorruptedNotificationDeliveryQueue(),
    { recovered: false, queued: 0 },
    'repeated recovery stays fail-closed while carrier authority is unknown',
  );
  assert.equal(existsSync(DELIVERY_QUEUE_RECOVERY_FILE), true);
});
