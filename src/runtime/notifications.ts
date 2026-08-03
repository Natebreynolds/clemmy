import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BASE_DIR,
  DISCORD_BOT_TOKEN,
  DISCORD_DM_ALLOWED_USERS,
  DISCORD_ENABLED,
  SLACK_ALLOWED_USERS,
  SLACK_BOT_TOKEN,
  SLACK_ENABLED,
  SLACK_PROACTIVE_CHANNEL,
} from '../config.js';
import { actionBus } from './action-bus.js';
import { withFileLockSyncStrict } from './atomic-json.js';
import {
  exactOriginDeliveryTarget,
  expectedExactOriginDeliveryReceipt,
  hasExactOriginDeliveryMode,
  hasExpectedExactOriginDeliveryReceipt,
} from './exact-origin-delivery.js';
export {
  exactOriginDeliveryDestinationId,
  exactOriginDeliveryMetadata,
  exactOriginDeliveryReceiptForTarget,
  expectedExactOriginDeliveryReceipt,
  hasExactOriginDeliveryReceipt,
  hasExpectedExactOriginDeliveryReceipt,
} from './exact-origin-delivery.js';
export type {
  ExactOriginDeliveryEnvelope,
  ExactOriginDeliveryMetadata,
  ExactOriginDeliveryTarget,
} from './exact-origin-delivery.js';

/**
 * Atomic JSON write: stages bytes into a sibling .tmp file, fsync to
 * flush to disk, then atomically rename onto the canonical path. A
 * crash (kill -9, power loss) leaves either the previous good file
 * OR the .tmp file but never a half-written canonical file — readers
 * always see a consistent snapshot.
 *
 * Why we need this: the previous non-atomic write was the silent loss
 * mode for the notification store. A SIGKILL during the JSON write
 * left a truncated file; the load path caught JSON.parse and silently
 * returned [], wiping every pending notification + delivery job.
 */
function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  const payload = JSON.stringify(value, null, 2);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, payload, 'utf-8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
    // fsyncing the file does not make the directory entry created by rename
    // durable on POSIX. Flush the parent too so a power loss cannot resurrect
    // the previous generation after the provider receipt was acknowledged.
    if (process.platform !== 'win32') {
      const directoryFd = openSync(path.dirname(filePath), 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
  } catch (err) {
    // A write/rename failure (disk full, perms, race) must not leave the
    // half-written tmp behind — those accumulated as orphaned `.tmp.*`
    // files. Clean it up, then rethrow so the caller still sees the error.
    // (A hard SIGKILL between create and rename can still orphan a tmp;
    // that residue is swept separately, not here.)
    try { unlinkSync(tmp); } catch { /* tmp may not exist — ignore */ }
    throw err;
  }
}

/**
 * Tolerant JSON read: if the file is missing OR unparsable, returns
 * `fallback`. On a parse failure we ALSO rename the corrupted file to
 * `<path>.corrupt-<timestamp>` so it survives for inspection, and emit
 * an action-bus + notification signal so the user finds out — instead
 * of the previous silent `return []` which made corruptions invisible.
 *
 * NOTE: we deliberately do NOT call addNotification() from inside here
 * (that would recurse if the notifications file itself was corrupted).
 * Callers responsible for surfacing the recovery — see surfaceCorruption.
 */
function loadJsonResilient<T>(
  filePath: string,
  fallback: T,
  options: {
    /** Must become durable before the canonical corrupt file is moved. */
    beforeQuarantine?: () => void;
    validate?: (value: unknown) => value is T;
  } = {},
): { value: T; corrupted: boolean } {
  if (!existsSync(filePath)) return { value: fallback, corrupted: false };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (options.validate && !options.validate(parsed)) {
      throw new Error('JSON state has an invalid structural shape.');
    }
    return { value: parsed as T, corrupted: false };
  } catch {
    // Some multi-file stores need a durable fail-closed marker before this
    // pathname is moved. Otherwise a crash between quarantine and marker write
    // could make the next process mistake a missing file for healthy empty state.
    options.beforeQuarantine?.();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantined = `${filePath}.corrupt-${stamp}`;
    try {
      renameSync(filePath, quarantined);
    } catch {
      // If we can't even quarantine, fall through — at least the fallback
      // is returned. Loss of the original is unavoidable in that case.
    }
    return { value: fallback, corrupted: true };
  }
}

// Corruption callbacks must not run under the notification-state lock: an
// action-bus subscriber can synchronously call back into this module. Record the
// paths while locked and surface them after the outermost critical section has
// released its cross-process lease.
const pendingCorruptionSignals = new Set<string>();

function surfaceCorruption(filePath: string): void {
  // Emit through actionBus directly (not addNotification) because the
  // notifications file itself may be the one that was corrupted, and
  // re-entering addNotification on a half-loaded queue is unsafe.
  const id = `${Date.now()}-notif-store-corrupt-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  actionBus.emit({
    kind: 'notification.created',
    notification: {
      id,
      kind: 'system',
      title: 'Notification state needs recovery',
      body: `Found invalid JSON state in ${path.basename(filePath)}. The bytes were quarantined with a .corrupt-<timestamp> suffix, and a durable recovery marker prevents the missing generation from being treated as authoritative empty state.`,
      createdAt: now,
      read: false,
      metadata: { filePath, recoveredAt: now },
    },
  });
}

const NOTIFICATION_STATE_DIR = path.join(BASE_DIR, 'state');
const NOTIFICATION_STATE_LOCK_FILE = path.join(NOTIFICATION_STATE_DIR, 'notification-state');
const NOTIFICATIONS_FILE = path.join(NOTIFICATION_STATE_DIR, 'notifications.json');
const DESTINATIONS_FILE = path.join(NOTIFICATION_STATE_DIR, 'notification-destinations.json');
const DELIVERY_QUEUE_FILE = path.join(NOTIFICATION_STATE_DIR, 'notification-delivery-queue.json');
const DELIVERY_QUEUE_RECOVERY_FILE = path.join(
  NOTIFICATION_STATE_DIR,
  'notification-delivery-queue.recovery-required.json',
);
const NOTIFICATIONS_RECOVERY_FILE = path.join(
  NOTIFICATION_STATE_DIR,
  'notifications.recovery-required.json',
);
const MAX_STORED_NOTIFICATIONS = 1000;
const PROACTIVE_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
const EXACT_RECEIPT_OBSERVATION_GRACE_MS = 24 * 60 * 60 * 1000;

let notificationStateLockDepth = 0;

function flushPendingCorruptionSignals(): void {
  const paths = [...pendingCorruptionSignals];
  pendingCorruptionSignals.clear();
  for (const filePath of paths) {
    try { surfaceCorruption(filePath); } catch { /* diagnostic callback only */ }
  }
}

/**
 * One strict, process-shared lease owns all notification store generations.
 * A single lock key is intentional: addNotification crosses notifications.json
 * and the delivery queue, and pruning needs an authoritative queue snapshot.
 * The work is synchronous and must never include provider I/O or callbacks.
 */
function withNotificationStateLock<T>(work: () => T): T {
  if (notificationStateLockDepth > 0) return work();
  mkdirSync(NOTIFICATION_STATE_DIR, { recursive: true });
  try {
    return withFileLockSyncStrict(NOTIFICATION_STATE_LOCK_FILE, () => {
      notificationStateLockDepth += 1;
      try {
        return work();
      } finally {
        notificationStateLockDepth -= 1;
      }
    });
  } finally {
    flushPendingCorruptionSignals();
  }
}

/** Deterministic cross-process race seam used only by focused tests. */
function waitAfterNotificationLoadForTest(): void {
  const marker = process.env.CLEMENTINE_TEST_NOTIFICATION_AFTER_LOAD_MARKER;
  if (!marker) return;
  writeFileSync(marker, `${process.pid}\n`, 'utf-8');
  const release = process.env.CLEMENTINE_TEST_NOTIFICATION_AFTER_LOAD_RELEASE;
  if (!release) return;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 10);
}

// The daemon owns the assistant/provider clients, so the persistence layer
// cannot deliver a newly queued notification itself. It can, however, signal
// the daemon immediately after the queue write is durable. The independent
// timer remains the restart/crash backstop; this kick only removes the normal
// foreground wait (previously as much as 15 seconds).
let notificationDeliveryKick: (() => void) | null = null;

export function registerNotificationDeliveryKick(kick: () => void): void {
  notificationDeliveryKick = kick;
}

function requestNotificationDeliveryKick(): void {
  const kick = notificationDeliveryKick;
  if (!kick) return;
  try {
    kick();
  } catch {
    // Best-effort signal only. Durable queue + periodic worker own recovery.
  }
}

export interface NotificationRecord {
  id: string;
  kind: 'cron' | 'workflow' | 'system' | 'approval' | 'execution';
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  metadata?: Record<string, unknown>;
  deliveredAt?: string;
  deliveryAttempts?: number;
  deliveryError?: string;
  deliveredDestinations?: string[];
  /** First durable observation of an exact provider receipt. Observation is
   * not settlement; the pending marker below owns that crash window. */
  exactDeliveryReceiptObservedAt?: string;
  /** Observation is not final authority. This durable journal bit remains
   * retention-protected until the immutable workflow-group settlement wins. */
  exactDeliveryReceiptSettlementPendingAt?: string;
  /** Immutable settlement generation that consumed the provider receipt. */
  exactDeliveryReceiptSettlementDigest?: string;
  /**
   * Durable notification -> delivery-queue admission journal. It is written in
   * the notification generation before the queue generation and removed only
   * after that queue row is durable. While present, count/age pruning must keep
   * the carrier even across a restart or an unrelated notification mutation.
   */
  deliveryAdmissionPendingAt?: string;
  /**
   * When true, the notification is recorded for the dashboard but NOT
   * pushed to external destinations (Discord, webhooks, email). Use
   * this for high-volume lifecycle events — "Background task queued",
   * "task heartbeat", "tool call observed" — that fill the dashboard's
   * Activity panel with useful signal but spam channels like Discord
   * with no substance. The "completed" notification (which carries
   * the actual result) is the one that should hit external channels.
   */
  silent?: boolean;
}

export interface NotificationDestination {
  id: string;
  name: string;
  type: 'generic_webhook' | 'discord_webhook' | 'discord_channel' | 'discord_user' | 'slack_webhook' | 'slack_channel' | 'slack_user' | 'web_push' | 'apns' | 'desktop';
  url?: string;
  channelId?: string;
  threadTs?: string;
  guildId?: string;
  userId?: string;
  /** Web Push subscription endpoint (push service URL). */
  pushEndpoint?: string;
  /** Web Push subscription P-256 public key (base64url). */
  pushP256dh?: string;
  /** Web Push subscription auth secret (base64url). */
  pushAuth?: string;
  /** Mobile session/device that owns this push subscription. */
  deviceId?: string;
  /** Expiration hint reported by the browser (Unix ms), if any. */
  pushExpirationTime?: number | null;
  /** APNs device token (hex) for native iOS pushes. */
  apnsDeviceToken?: string;
  enabled: boolean;
  createdAt: string;
}

export interface NotificationDeliveryJob {
  notificationId: string;
  queuedAt: string;
  completedDestinationIds?: string[];
  failedDestinationIds?: string[];
  attemptCountByDestination?: Record<string, number>;
  nextAttemptAtByDestination?: Record<string, string>;
  lastErrorByDestination?: Record<string, string>;
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/**
 * A delivery job is "stale" once it has sat undelivered longer than
 * maxAgeMs. Jobs defer in the queue while no destination is configured
 * (intended) — but without an age cap they accumulate forever and then
 * flush ALL AT ONCE the moment a destination is finally added. That is
 * exactly the 2026-06-05 incident: connecting Discord for a new user
 * dumped 395 two-week-old notifications in one burst. The drain drops
 * stale jobs instead of delivering them; the underlying notification
 * stays in Activity, it just won't be pushed out. Unparseable timestamps
 * are treated as NOT stale (keep — safer than silently dropping).
 */
export function isDeliveryJobStale(queuedAt: string, nowMs: number, maxAgeMs: number): boolean {
  const queuedMs = new Date(queuedAt).getTime();
  if (!Number.isFinite(queuedMs)) return false;
  return nowMs - queuedMs > maxAgeMs;
}

function validNotificationRecord(value: unknown): value is NotificationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== 'string'
    || item.id.trim().length === 0
    || (item.kind !== 'cron'
      && item.kind !== 'workflow'
      && item.kind !== 'system'
      && item.kind !== 'approval'
      && item.kind !== 'execution')
    || typeof item.title !== 'string'
    || typeof item.body !== 'string'
    || typeof item.createdAt !== 'string'
    || typeof item.read !== 'boolean'
  ) return false;
  if (
    item.metadata !== undefined
    && (!item.metadata || typeof item.metadata !== 'object' || Array.isArray(item.metadata))
  ) return false;
  if (
    item.deliveredDestinations !== undefined
    && (!Array.isArray(item.deliveredDestinations)
      || item.deliveredDestinations.some((destination) => typeof destination !== 'string'))
  ) return false;
  for (const key of [
    'deliveredAt',
    'deliveryError',
    'exactDeliveryReceiptObservedAt',
    'exactDeliveryReceiptSettlementPendingAt',
    'exactDeliveryReceiptSettlementDigest',
    'deliveryAdmissionPendingAt',
  ] as const) {
    if (item[key] !== undefined && typeof item[key] !== 'string') return false;
  }
  if (
    item.exactDeliveryReceiptSettlementDigest !== undefined
    && !/^[a-f0-9]{64}$/.test(item.exactDeliveryReceiptSettlementDigest as string)
  ) return false;
  for (const key of [
    'exactDeliveryReceiptObservedAt',
    'exactDeliveryReceiptSettlementPendingAt',
    'deliveryAdmissionPendingAt',
  ] as const) {
    if (item[key] !== undefined && !Number.isFinite(Date.parse(item[key] as string))) return false;
  }
  return (item.deliveryAttempts === undefined
      || (typeof item.deliveryAttempts === 'number' && Number.isFinite(item.deliveryAttempts)))
    && (item.silent === undefined || typeof item.silent === 'boolean');
}

function ensureNotificationsRecoveryMarker(): void {
  if (!existsSync(NOTIFICATIONS_RECOVERY_FILE)) {
    atomicWriteJson(NOTIFICATIONS_RECOVERY_FILE, {
      version: 1,
      detectedAt: new Date().toISOString(),
      carrierFile: path.basename(NOTIFICATIONS_FILE),
    });
  }
}

function notificationsRequireRecovery(): boolean {
  return existsSync(NOTIFICATIONS_RECOVERY_FILE);
}

function loadNotificationsUnlocked(): NotificationRecord[] {
  const result = loadJsonResilient<NotificationRecord[]>(NOTIFICATIONS_FILE, [], {
    beforeQuarantine: ensureNotificationsRecoveryMarker,
    validate: (value): value is NotificationRecord[] => Array.isArray(value)
      && value.every(validNotificationRecord),
  });
  if (result.corrupted) {
    pendingCorruptionSignals.add(NOTIFICATIONS_FILE);
    ensureNotificationsRecoveryMarker();
  }
  return result.value;
}

export function loadNotifications(): NotificationRecord[] {
  return withNotificationStateLock(() => loadNotificationsUnlocked());
}

function loadDestinationsUnlocked(): NotificationDestination[] {
  const result = loadJsonResilient<NotificationDestination[]>(DESTINATIONS_FILE, []);
  if (result.corrupted) pendingCorruptionSignals.add(DESTINATIONS_FILE);
  return result.value;
}

function saveDestinationsUnlocked(items: NotificationDestination[]): void {
  atomicWriteJson(DESTINATIONS_FILE, items);
}

function loadDeliveryQueueUnlocked(): { items: NotificationDeliveryJob[]; corrupted: boolean } {
  const ensureRecoveryMarker = (): void => {
    if (!existsSync(DELIVERY_QUEUE_RECOVERY_FILE)) {
      atomicWriteJson(DELIVERY_QUEUE_RECOVERY_FILE, {
        version: 1,
        detectedAt: new Date().toISOString(),
        queueFile: path.basename(DELIVERY_QUEUE_FILE),
      });
    }
  };
  const result = loadJsonResilient<NotificationDeliveryJob[]>(DELIVERY_QUEUE_FILE, [], {
    beforeQuarantine: ensureRecoveryMarker,
    validate: (value): value is NotificationDeliveryJob[] => Array.isArray(value)
      && value.every((item) => Boolean(
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && typeof (item as NotificationDeliveryJob).notificationId === 'string'
        && (item as NotificationDeliveryJob).notificationId.trim()
        && typeof (item as NotificationDeliveryJob).queuedAt === 'string',
      )),
  });
  if (result.corrupted) {
    pendingCorruptionSignals.add(DELIVERY_QUEUE_FILE);
    ensureRecoveryMarker();
  }
  return {
    // The marker survives quarantine of the bad queue. A later missing queue
    // file is not a healthy empty generation until an explicit rebuild clears
    // this authority.
    corrupted: result.corrupted || existsSync(DELIVERY_QUEUE_RECOVERY_FILE),
    items: result.value.map((item) => ({
      notificationId: item.notificationId,
      queuedAt: item.queuedAt,
      completedDestinationIds: Array.isArray(item.completedDestinationIds) ? item.completedDestinationIds : [],
      failedDestinationIds: Array.isArray(item.failedDestinationIds) ? item.failedDestinationIds : [],
      attemptCountByDestination: item.attemptCountByDestination ?? {},
      nextAttemptAtByDestination: item.nextAttemptAtByDestination ?? {},
      lastErrorByDestination: item.lastErrorByDestination ?? {},
    })),
  };
}

let failNextDeliveryQueueWriteForTest: Error | null = null;

/** Test-only fault injection for the notifications.json → delivery-queue
 * partial-write boundary. Never called by production code. */
export function _failNextNotificationDeliveryQueueWriteForTest(
  error: Error = new Error('forced notification delivery queue write failure'),
): void {
  failNextDeliveryQueueWriteForTest = error;
}

function saveDeliveryQueueUnlocked(items: NotificationDeliveryJob[]): void {
  if (failNextDeliveryQueueWriteForTest) {
    const error = failNextDeliveryQueueWriteForTest;
    failNextDeliveryQueueWriteForTest = null;
    throw error;
  }
  atomicWriteJson(DELIVERY_QUEUE_FILE, items);
}

function clearDeliveryQueueRecoveryMarkerDurably(): void {
  if (!existsSync(DELIVERY_QUEUE_RECOVERY_FILE)) return;
  unlinkSync(DELIVERY_QUEUE_RECOVERY_FILE);
  if (process.platform !== 'win32') {
    const directoryFd = openSync(NOTIFICATION_STATE_DIR, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
}

function freshDeliveryJob(notificationId: string, queuedAt = new Date().toISOString()): NotificationDeliveryJob {
  return {
    notificationId,
    queuedAt,
    completedDestinationIds: [],
    failedDestinationIds: [],
    attemptCountByDestination: {},
    nextAttemptAtByDestination: {},
    lastErrorByDestination: {},
  };
}

function notificationDeliveryQueuedAt(item: NotificationRecord): string {
  for (const candidate of [item.deliveryAdmissionPendingAt, item.createdAt]) {
    if (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate))) return candidate;
  }
  // Invalid legacy timestamps remain non-stale rather than being silently
  // discarded. Preserve the original bytes when possible for diagnosis.
  return typeof item.createdAt === 'string' ? item.createdAt : '';
}

function exactReceiptNeedsRetention(item: NotificationRecord, nowMs: number): boolean {
  if (!hasExpectedExactOriginDeliveryReceipt(item)) return false;
  if (
    typeof item.exactDeliveryReceiptSettlementPendingAt === 'string'
    && item.exactDeliveryReceiptSettlementPendingAt.trim().length > 0
  ) return true;
  if (/^[a-f0-9]{64}$/.test(item.exactDeliveryReceiptSettlementDigest ?? '')) return false;
  const observedAt = Date.parse(item.exactDeliveryReceiptObservedAt ?? '');
  if (!Number.isFinite(observedAt)) return true;
  return observedAt > nowMs || nowMs - observedAt < EXACT_RECEIPT_OBSERVATION_GRACE_MS;
}

function deliveryAdmissionNeedsRetention(item: NotificationRecord): boolean {
  return typeof item.deliveryAdmissionPendingAt === 'string'
    && item.deliveryAdmissionPendingAt.trim().length > 0;
}

function pruneNotifications(
  items: NotificationRecord[],
  queue: NotificationDeliveryJob[],
  options: { nowMs?: number; extraProtectedIds?: Iterable<string> } = {},
): NotificationRecord[] {
  if (items.length <= MAX_STORED_NOTIFICATIONS) return items;
  const nowMs = options.nowMs ?? Date.now();
  const protectedIds = new Set(queue.map((job) => job.notificationId));
  for (const id of options.extraProtectedIds ?? []) protectedIds.add(id);

  const protectedItems: NotificationRecord[] = [];
  const ordinaryItems: NotificationRecord[] = [];
  for (const item of items) {
    if (
      protectedIds.has(item.id)
      || exactReceiptNeedsRetention(item, nowMs)
      || deliveryAdmissionNeedsRetention(item)
    ) {
      protectedItems.push(item);
    } else {
      ordinaryItems.push(item);
    }
  }

  // Lossless pending evidence may temporarily lift the count above the normal
  // cap. Once jobs settle and exact receipts are observed, the next mutation or
  // settlement compacts back to MAX_STORED_NOTIFICATIONS.
  const ordinaryBudget = Math.max(0, MAX_STORED_NOTIFICATIONS - protectedItems.length);
  const newestOrdinary = ordinaryItems
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, ordinaryBudget);
  return [...protectedItems, ...newestOrdinary]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function saveNotificationsUnlocked(
  items: NotificationRecord[],
  options: {
    queue?: NotificationDeliveryJob[];
    extraProtectedIds?: Iterable<string>;
    nowMs?: number;
    skipPrune?: boolean;
  } = {},
): void {
  const queueSnapshot = options.queue === undefined
    ? loadDeliveryQueueUnlocked()
    : { items: options.queue, corrupted: false };
  // If the queue was corrupt, its missing references are unknowable. Preserve
  // every notification until a later healthy generation can prune safely.
  const pruned = options.skipPrune || queueSnapshot.corrupted || notificationsRequireRecovery()
    ? items
    : pruneNotifications(items, queueSnapshot.items, options);
  atomicWriteJson(NOTIFICATIONS_FILE, pruned);
}

function compactNotificationsUnlocked(queue: NotificationDeliveryJob[]): void {
  if (notificationsRequireRecovery()) return;
  const items = loadNotificationsUnlocked();
  if (items.length <= MAX_STORED_NOTIFICATIONS) return;
  const compacted = pruneNotifications(items, queue);
  if (compacted.length !== items.length) atomicWriteJson(NOTIFICATIONS_FILE, compacted);
}

function isRecentDuplicateProactiveBrief(existing: NotificationRecord, next: NotificationRecord): boolean {
  if (!existing.metadata?.proactiveBrief || !next.metadata?.proactiveBrief) return false;
  if (existing.title !== next.title || existing.body !== next.body) return false;
  const previousAt = Date.parse(existing.createdAt);
  const nextAt = Date.parse(next.createdAt);
  return Number.isFinite(previousAt) &&
    Number.isFinite(nextAt) &&
    nextAt - previousAt >= 0 &&
    nextAt - previousAt < PROACTIVE_DEDUPE_WINDOW_MS;
}

function isDuplicateApprovalNotification(existing: NotificationRecord, next: NotificationRecord): boolean {
  if (existing.kind !== 'approval' || next.kind !== 'approval') return false;
  const existingApprovalId = existing.metadata?.approvalId;
  const nextApprovalId = next.metadata?.approvalId;
  return typeof existingApprovalId === 'string' &&
    existingApprovalId.length > 0 &&
    existingApprovalId === nextApprovalId &&
    existing.title === next.title &&
    existing.body === next.body;
}

function isTerminalOriginChatPushEligible(item: NotificationRecord): boolean {
  return item.metadata?.reportBackTargetType === 'origin_chat'
    && item.metadata?.terminalReportBack === true
    && (process.env.CLEMMY_REPORTBACK_PUSH ?? 'on').toLowerCase() !== 'off'
    && loadDestinationsUnlocked().some((entry) => entry.enabled && entry.type === 'web_push');
}

function shouldQueueNotificationDelivery(item: NotificationRecord): boolean {
  if (item.silent) return false;
  if (hasExactOriginDeliveryMode(item)) {
    // A malformed exact-origin envelope deliberately remains queueable: the
    // resolver returns zero destinations and the worker records a durable
    // undelivered/deferred state. It must never fall through to defaults.
    return exactOriginDeliveryTarget(item)?.type !== 'origin_chat';
  }
  const isOriginChatReport = item.metadata?.reportBackTargetType === 'origin_chat';
  return !isOriginChatReport || isTerminalOriginChatPushEligible(item);
}

function notificationNeedsDeliveryQueue(item: NotificationRecord): boolean {
  if (!shouldQueueNotificationDelivery(item)) return false;
  if (hasExactOriginDeliveryMode(item)) {
    return !hasExpectedExactOriginDeliveryReceipt(item);
  }
  const isOriginChatReport = item.metadata?.reportBackTargetType === 'origin_chat';
  if (item.deliveredAt && !isOriginChatReport) return false;
  if (
    isOriginChatReport
    && item.deliveredDestinations?.some((destination) => destination !== 'origin-chat')
  ) return false;
  return true;
}

/**
 * Reconcile the second half of notification persistence. A crash or disk
 * failure can land notifications.json before its delivery-queue write; a
 * stable-ID retry must repair that missing job instead of treating the
 * notification record alone as proof that outbound delivery was queued.
 */
function ensureNotificationDeliveryQueuedUnlocked(item: NotificationRecord): void {
  if (!notificationNeedsDeliveryQueue(item)) return;

  const queue = loadDeliveryQueueUnlocked().items;
  if (queue.some((job) => job.notificationId === item.id)) return;
  queue.push(freshDeliveryJob(item.id, notificationDeliveryQueuedAt(item)));
  saveDeliveryQueueUnlocked(queue);
}

/** Finish notification -> queue admissions left between the two durable file
 * generations. Queue persistence wins first; only then is the carrier's
 * journal marker cleared. Repeating after any crash is idempotent. */
function recoverNotificationDeliveryAdmissionsUnlocked(): NotificationDeliveryJob[] {
  const initialQueue = loadDeliveryQueueUnlocked();
  if (initialQueue.corrupted) return initialQueue.items;
  const items = loadNotificationsUnlocked();
  const pending = items.filter(deliveryAdmissionNeedsRetention);
  if (pending.length === 0) return initialQueue.items;
  for (const item of pending) ensureNotificationDeliveryQueuedUnlocked(item);
  const durableQueue = loadDeliveryQueueUnlocked();
  if (durableQueue.corrupted) return durableQueue.items;
  for (const item of pending) delete item.deliveryAdmissionPendingAt;
  saveNotificationsUnlocked(items, { queue: durableQueue.items });
  return durableQueue.items;
}

export function listNotifications(limit = 20): NotificationRecord[] {
  return withNotificationStateLock(() => {
    const items = loadNotificationsUnlocked();
    const queueSnapshot = loadDeliveryQueueUnlocked();
    const compacted = queueSnapshot.corrupted || notificationsRequireRecovery()
      ? items
      : pruneNotifications(items, queueSnapshot.items);
    if (compacted.length !== items.length) {
      atomicWriteJson(NOTIFICATIONS_FILE, compacted);
    }
    return compacted
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  });
}

export function addNotification(item: NotificationRecord): void {
  const result = withNotificationStateLock((): { emit: boolean; kick: boolean } => {
    const items = loadNotificationsUnlocked();
    waitAfterNotificationLoadForTest();
    // ID dedup added 2026-05-24: callers (cron heartbeat, daemon-offline
    // check, etc.) pass a STABLE id when they want at-most-once delivery.
    // Without this, three daemon restarts within a minute emitted three
    // "offline X min" notifications with the SAME id-key seed but
    // recomputed gap values — confusing duplicate reports of the same
    // outage. Content-dedup (proactive briefs, approvals) stays as a
    // secondary safety net for kinds that don't bother setting a stable id.
    const existingWithId = item.id
      ? items.find((existing) => existing.id === item.id)
      : undefined;
    if (existingWithId) {
      // Repair a partially persisted exact origin-chat acknowledgement on a
      // stable-ID retry. External exact targets are repaired by re-queuing until
      // their precise receipt exists; origin_chat has no outbound worker leg.
      const existingExactTarget = exactOriginDeliveryTarget(existingWithId);
      if (existingExactTarget?.type === 'origin_chat') {
        const receipt = expectedExactOriginDeliveryReceipt(existingWithId);
        if (receipt && !hasExpectedExactOriginDeliveryReceipt(existingWithId)) {
          existingWithId.deliveredAt = existingWithId.deliveredAt ?? existingWithId.createdAt;
          existingWithId.deliveredDestinations = [receipt];
          saveNotificationsUnlocked(items);
        }
      }
      const needsQueue = notificationNeedsDeliveryQueue(existingWithId);
      ensureNotificationDeliveryQueuedUnlocked(existingWithId);
      if (deliveryAdmissionNeedsRetention(existingWithId)) {
        delete existingWithId.deliveryAdmissionPendingAt;
        saveNotificationsUnlocked(items);
      }
      return { emit: false, kick: needsQueue };
    }
    if (items.some((existing) =>
      isRecentDuplicateProactiveBrief(existing, item) ||
      isDuplicateApprovalNotification(existing, item)
    )) {
      return { emit: false, kick: false };
    }

    // Origin-chat report-back has NO external destination — the outcome is
    // delivered into the originating session's transcript, not pushed anywhere.
    // Record it as terminally delivered ("sent to origin chat") and skip the
    // external delivery queue, so it never sits "queued" forever waiting for a
    // destination that will never come, and never leaks to a Discord/Slack DM
    // fallback (the 2026-07-08 desktop-task defect).
    if (hasExactOriginDeliveryMode(item)) {
      const target = exactOriginDeliveryTarget(item);
      const receipt = expectedExactOriginDeliveryReceipt(item);
      if (target?.type === 'origin_chat' && receipt) {
        item.deliveredAt = item.deliveredAt ?? item.createdAt;
        item.deliveredDestinations = [receipt];
      }
    } else {
      const isOriginChatReport = item.metadata?.reportBackTargetType === 'origin_chat';
      if (isOriginChatReport && !item.deliveredAt) {
        item.deliveredAt = item.createdAt;
        item.deliveredDestinations = ['origin-chat'];
      }
    }

    const shouldQueue = notificationNeedsDeliveryQueue(item);
    if (shouldQueue) item.deliveryAdmissionPendingAt = new Date().toISOString();
    items.push(item);
    saveNotificationsUnlocked(items, {
      extraProtectedIds: shouldQueue ? [item.id] : [],
    });

    // Wave 3 Move B: a TERMINAL origin_chat report-back is ALSO enqueued so the
    // delivery worker resolves + pushes it to the user's OWN registered web-push
    // devices (getNotificationDestinationsForRecord returns web_push ONLY for this
    // case — never a Discord/Slack channel). Without this the worker — the sole
    // caller of the resolver — never ran for origin_chat notifications, so the
    // web_push branch was dead code and the away-user ping never fired (caught by
    // the Wave-3 adversarial review). We KEEP the 'origin-chat' delivered stamp
    // above so the terminal-undelivered watchdog still sees it reported-back and
    // never double-fires a replay push; the worker overwrites deliveredDestinations
    // with the web_push device on success. Only enqueue when push is enabled AND a
    // web_push device actually exists, so a no-device task stays transcript-only
    // (no perpetually-deferred "no destinations" job). Kill-switch CLEMMY_REPORTBACK_PUSH.
    // Silent notifications are dashboard-only: skip the delivery queue so
    // we don't fan out lifecycle pings (queued / started / heartbeat /
    // tool-progress) to Discord and other external destinations. They
    // still land in notifications.json so the Activity panel sees them,
    // and the actionBus emit below still fires for live dashboard updates.
    ensureNotificationDeliveryQueuedUnlocked(item);
    if (deliveryAdmissionNeedsRetention(item)) {
      delete item.deliveryAdmissionPendingAt;
      // Queue durability precedes removal of the admission marker. A crash
      // before this write merely causes the next worker pass to reconcile the
      // same stable notification id again.
      saveNotificationsUnlocked(items);
    }
    return { emit: true, kick: shouldQueue };
  });

  if (result.kick) requestNotificationDeliveryKick();
  if (result.emit) actionBus.emit({ kind: 'notification.created', notification: item });
}

export function markNotificationRead(id: string): NotificationRecord | undefined {
  return withNotificationStateLock(() => {
    const items = loadNotificationsUnlocked();
    const item = items.find((entry) => entry.id === id);
    if (!item) return undefined;
    item.read = true;
    saveNotificationsUnlocked(items);
    return item;
  });
}

/**
 * A notification that asks for the user's intervention (vs. a report of
 * completed work). Shared by the command-center "Needs you" feed and the
 * group-dismiss below so both sides agree on what a "needs attention"
 * notification is.
 */
export function isNeedsAttentionNotification(
  notification: Pick<NotificationRecord, 'title' | 'metadata'>,
): boolean {
  return notification.metadata?.needsAttention === true ||
    Boolean(notification.metadata?.proposedFixId) ||
    /\bblocked\b|needs attention|needs input|couldn['’]t finish|action required/i.test(notification.title || '');
}

/**
 * Mark a notification read together with its dedupe twins: every other
 * unread notification with the same title (case-insensitive), plus
 * same-workflow notifications that are themselves needs-attention. The
 * command-center "Needs you" feed collapses duplicates by title/workflow,
 * so dismissing only the surfaced one just resurrects the next-oldest twin
 * behind it (whack-a-mole; observed 2026-06-11 with 179 unread
 * outlook-triage-hourly duplicates behind one card).
 *
 * The workflow branch deliberately requires the twin to be needs-attention:
 * a workflow's unrelated unread SUCCESS report must not be silently marked
 * read by dismissing that workflow's failure card.
 */
export function markNotificationGroupRead(id: string): NotificationRecord[] {
  return withNotificationStateLock(() => {
    const items = loadNotificationsUnlocked();
    const anchor = items.find((entry) => entry.id === id);
    if (!anchor) return [];
    const titleKey = (anchor.title || '').toLowerCase().trim();
    const workflowKey = typeof anchor.metadata?.workflow === 'string' ? anchor.metadata.workflow.toLowerCase() : '';
    const changed: NotificationRecord[] = [];
    for (const item of items) {
      if (item.read) continue;
      const itemWorkflow = typeof item.metadata?.workflow === 'string' ? item.metadata.workflow.toLowerCase() : '';
      const sameTitle = Boolean(titleKey) && (item.title || '').toLowerCase().trim() === titleKey;
      const sameWorkflow = Boolean(workflowKey) && itemWorkflow === workflowKey && isNeedsAttentionNotification(item);
      if (item.id !== id && !sameTitle && !sameWorkflow) continue;
      item.read = true;
      changed.push(item);
    }
    if (changed.length > 0) saveNotificationsUnlocked(items);
    return changed;
  });
}

export function markNotificationsReadByApprovalId(
  approvalId: string,
  metadataPatch: Record<string, unknown> = {},
): NotificationRecord[] {
  return withNotificationStateLock(() => {
    const items = loadNotificationsUnlocked();
    const changed: NotificationRecord[] = [];
    const resolvedAt = new Date().toISOString();
    for (const item of items) {
      const matchesStableId = item.id === `approval-${approvalId}`;
      const matchesMetadata = item.metadata?.approvalId === approvalId;
      if (item.kind !== 'approval' && !matchesStableId && !matchesMetadata) continue;
      if (!matchesStableId && !matchesMetadata) continue;
      const nextMetadata = {
        ...(item.metadata ?? {}),
        resolvedAt,
        ...metadataPatch,
      };
      let didChange = false;
      if (!item.read) {
        item.read = true;
        didChange = true;
      }
      if (JSON.stringify(item.metadata ?? {}) !== JSON.stringify(nextMetadata)) {
        item.metadata = nextMetadata;
        didChange = true;
      }
      if (didChange) changed.push(item);
    }
    if (changed.length > 0) saveNotificationsUnlocked(items);
    return changed;
  });
}

/** Resolve the durable "background task needs your input" card once its
 * freeform question has been answered or the task leaves that parked state.
 * Approval notifications already had this lifecycle cleanup; question-backed
 * cards did not, so Home could remain stuck on "needs you" after the task had
 * resumed and the Tasks board had moved on. */
export function markNotificationsReadByQuestionId(
  questionId: string,
  metadataPatch: Record<string, unknown> = {},
): NotificationRecord[] {
  if (!questionId) return [];
  return withNotificationStateLock(() => {
    const items = loadNotificationsUnlocked();
    const changed: NotificationRecord[] = [];
    const resolvedAt = new Date().toISOString();
    for (const item of items) {
      if (item.metadata?.questionId !== questionId) continue;
      const nextMetadata = {
        ...(item.metadata ?? {}),
        questionResolvedAt: resolvedAt,
        ...metadataPatch,
      };
      let didChange = false;
      if (!item.read) {
        item.read = true;
        didChange = true;
      }
      if (JSON.stringify(item.metadata ?? {}) !== JSON.stringify(nextMetadata)) {
        item.metadata = nextMetadata;
        didChange = true;
      }
      if (didChange) changed.push(item);
    }
    if (changed.length > 0) saveNotificationsUnlocked(items);
    return changed;
  });
}

export function markStaleApprovalNotificationsRead(
  activeApprovalIds: Iterable<string>,
  metadataPatch: Record<string, unknown> = {},
): NotificationRecord[] {
  const active = new Set(activeApprovalIds);
  return withNotificationStateLock(() => {
    const items = loadNotificationsUnlocked();
    const changed: NotificationRecord[] = [];
    const reconciledAt = new Date().toISOString();
    for (const item of items) {
      if (item.kind !== 'approval') continue;
      const approvalId = item.metadata?.approvalId;
      if (typeof approvalId !== 'string' || approvalId.length === 0) continue;
      if (active.has(approvalId)) continue;
      const nextMetadata = {
        ...(item.metadata ?? {}),
        reconciledAt,
        ...metadataPatch,
      };
      let didChange = false;
      if (!item.read) {
        item.read = true;
        didChange = true;
      }
      if (JSON.stringify(item.metadata ?? {}) !== JSON.stringify(nextMetadata)) {
        item.metadata = nextMetadata;
        didChange = true;
      }
      if (didChange) changed.push(item);
    }
    if (changed.length > 0) saveNotificationsUnlocked(items);
    return changed;
  });
}

/** Unread approval/execution notifications older than this are dead — their
 *  runs/approvals are long gone and the "Needs you" card goes nowhere. */
const STALE_ACTION_NOTIFICATION_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard age cap: anything older than this is purged outright (the count cap
 *  in pruneNotifications never fires when volume is low but age is high). */
const NOTIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Notification hygiene (run at daemon boot + nightly): marks stale unread
 * approval/execution notifications read (their underlying runs are dead, so
 * the inbox card is unactionable — observed live: 873 unread dating back
 * weeks, burying anything real) and purges records past the hard age cap.
 * Audit trail: reaped items get metadata.reapedAt/reapReason.
 */
export function reapStaleNotifications(nowMs: number = Date.now()): { markedRead: number; purged: number } {
  return withNotificationStateLock(() => {
    const items = loadNotificationsUnlocked();
    if (notificationsRequireRecovery()) return { markedRead: 0, purged: 0 };
    const queueSnapshot = loadDeliveryQueueUnlocked();
    const queuedIds = new Set(queueSnapshot.items.map((job) => job.notificationId));
    const kept: NotificationRecord[] = [];
    let markedRead = 0;
    let purged = 0;
    for (const item of items) {
      const at = Date.parse(item.createdAt);
      const age = Number.isFinite(at) ? nowMs - at : 0;
      const retentionEvidence = queueSnapshot.corrupted
        || queuedIds.has(item.id)
        || exactReceiptNeedsRetention(item, nowMs)
        || deliveryAdmissionNeedsRetention(item);
      if (age > NOTIFICATION_MAX_AGE_MS && !retentionEvidence) {
        purged += 1;
        continue;
      }
      if (
        !item.read &&
        age > STALE_ACTION_NOTIFICATION_MS &&
        (item.kind === 'approval' || item.kind === 'execution')
      ) {
        item.read = true;
        item.metadata = {
          ...(item.metadata ?? {}),
          reapedAt: new Date(nowMs).toISOString(),
          reapReason: 'stale_action_notification',
        };
        markedRead += 1;
      }
      kept.push(item);
    }
    if (markedRead > 0 || purged > 0) {
      saveNotificationsUnlocked(kept, {
        queue: queueSnapshot.items,
        nowMs,
        skipPrune: queueSnapshot.corrupted,
      });
    }
    return { markedRead, purged };
  });
}

export function getNotification(id: string): NotificationRecord | undefined {
  return withNotificationStateLock(() => loadNotificationsUnlocked().find((entry) => entry.id === id));
}

/**
 * Durably mark one precise provider receipt as consumed by graph settlement.
 * Generic reads (UI rendering, delivery workers, action handlers) are not
 * authority to release retained delivery evidence. The caller must present the
 * exact receipt it verified from the admitted origin target.
 */
export function observeExactNotificationDeliveryReceipt(
  id: string,
  expectedReceipt: string,
): NotificationRecord | undefined {
  return withNotificationStateLock(() => {
    const items = loadNotificationsUnlocked();
    const item = items.find((entry) => entry.id === id);
    if (!item) return undefined;
    const embeddedReceipt = expectedExactOriginDeliveryReceipt(item);
    if (
      !embeddedReceipt
      || embeddedReceipt !== expectedReceipt
      || !Array.isArray(item.deliveredDestinations)
      || !item.deliveredDestinations.includes(expectedReceipt)
    ) {
      return undefined;
    }
    let changed = false;
    if (!Number.isFinite(Date.parse(item.exactDeliveryReceiptObservedAt ?? ''))) {
      item.exactDeliveryReceiptObservedAt = new Date().toISOString();
      changed = true;
    }
    if (
      !/^[a-f0-9]{64}$/.test(item.exactDeliveryReceiptSettlementDigest ?? '')
      && !Number.isFinite(Date.parse(item.exactDeliveryReceiptSettlementPendingAt ?? ''))
    ) {
      item.exactDeliveryReceiptSettlementPendingAt = item.exactDeliveryReceiptObservedAt;
      changed = true;
    }
    if (changed) saveNotificationsUnlocked(items);
    return item;
  });
}

/** Release an observed provider receipt only after the immutable workflow
 * group settlement exists. Replays are idempotent; a conflicting settlement
 * generation fails closed and leaves the carrier retained. */
export function finalizeExactNotificationDeliveryReceiptSettlement(
  id: string,
  expectedReceipt: string,
  settlementDigest: string,
): NotificationRecord | undefined {
  if (!/^[a-f0-9]{64}$/.test(settlementDigest)) return undefined;
  return withNotificationStateLock(() => {
    const items = loadNotificationsUnlocked();
    const item = items.find((entry) => entry.id === id);
    if (!item) return undefined;
    const embeddedReceipt = expectedExactOriginDeliveryReceipt(item);
    if (
      !embeddedReceipt
      || embeddedReceipt !== expectedReceipt
      || !Array.isArray(item.deliveredDestinations)
      || !item.deliveredDestinations.includes(expectedReceipt)
      || !Number.isFinite(Date.parse(item.exactDeliveryReceiptObservedAt ?? ''))
    ) return undefined;
    if (
      item.exactDeliveryReceiptSettlementDigest !== undefined
      && item.exactDeliveryReceiptSettlementDigest !== settlementDigest
    ) return undefined;
    if (
      item.exactDeliveryReceiptSettlementDigest !== settlementDigest
      || item.exactDeliveryReceiptSettlementPendingAt !== undefined
    ) {
      item.exactDeliveryReceiptSettlementDigest = settlementDigest;
      delete item.exactDeliveryReceiptSettlementPendingAt;
      saveNotificationsUnlocked(items);
    }
    return item;
  });
}

export function updateNotificationDeliveryStatus(
  id: string,
  patch: Partial<Pick<NotificationRecord, 'deliveredAt' | 'deliveryAttempts' | 'deliveryError' | 'deliveredDestinations'>>,
): NotificationRecord | undefined {
  return withNotificationStateLock(() => {
    const items = loadNotificationsUnlocked();
    const item = items.find((entry) => entry.id === id);
    if (!item) return undefined;
    if (patch.deliveredDestinations) {
      item.deliveredDestinations = uniqueStrings([
        ...(Array.isArray(item.deliveredDestinations) ? item.deliveredDestinations : []),
        ...patch.deliveredDestinations,
      ]);
    }
    Object.assign(item, {
      ...patch,
      deliveredDestinations: item.deliveredDestinations,
    });
    saveNotificationsUnlocked(items);
    return item;
  });
}

export function listNotificationDestinations(): NotificationDestination[] {
  return withNotificationStateLock(() =>
    loadDestinationsUnlocked().sort((a, b) => a.name.localeCompare(b.name)));
}

export function upsertNotificationDestination(destination: NotificationDestination): void {
  withNotificationStateLock(() => {
    const items = loadDestinationsUnlocked();
    const index = items.findIndex((entry) => entry.id === destination.id);
    if (index >= 0) {
      items[index] = destination;
    } else {
      items.push(destination);
    }
    saveDestinationsUnlocked(items);
  });
}

export function removeNotificationDestination(id: string): boolean {
  return withNotificationStateLock(() => {
    const items = loadDestinationsUnlocked();
    const next = items.filter((entry) => entry.id !== id);
    if (next.length === items.length) return false;
    saveDestinationsUnlocked(next);
    return true;
  });
}

/**
 * Idempotent upsert for Web Push subscriptions, keyed by endpoint URL.
 * Re-subscribing the same browser produces the same endpoint and updates
 * the existing row in place rather than creating a duplicate.
 */
export function upsertWebPushDestination(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceId: string;
  deviceLabel?: string;
  expirationTime?: number | null;
}): NotificationDestination {
  return withNotificationStateLock(() => {
    const items = loadDestinationsUnlocked();
    const existing = items.find(
      (entry) => entry.type === 'web_push' && entry.pushEndpoint === input.endpoint,
    );
    const id = existing?.id ?? `web-push-${input.deviceId}-${Date.now().toString(36)}`;
    const destination: NotificationDestination = {
      id,
      name: input.deviceLabel?.trim() || `Mobile device ${input.deviceId}`,
      type: 'web_push',
      pushEndpoint: input.endpoint,
      pushP256dh: input.p256dh,
      pushAuth: input.auth,
      deviceId: input.deviceId,
      pushExpirationTime: input.expirationTime ?? null,
      enabled: true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    if (existing) {
      items[items.indexOf(existing)] = destination;
    } else {
      items.push(destination);
    }
    saveDestinationsUnlocked(items);
    return destination;
  });
}

export function removeWebPushDestinationByEndpoint(endpoint: string): boolean {
  return withNotificationStateLock(() => {
    const items = loadDestinationsUnlocked();
    const next = items.filter(
      (entry) => !(entry.type === 'web_push' && entry.pushEndpoint === endpoint),
    );
    if (next.length === items.length) return false;
    saveDestinationsUnlocked(next);
    return true;
  });
}

export function removeWebPushDestinationsByDeviceId(deviceId: string): number {
  return withNotificationStateLock(() => {
    const items = loadDestinationsUnlocked();
    const next = items.filter(
      (entry) => !((entry.type === 'web_push' || entry.type === 'apns') && entry.deviceId === deviceId),
    );
    const removed = items.length - next.length;
    if (removed > 0) saveDestinationsUnlocked(next);
    return removed;
  });
}

/**
 * Native iOS push registration. One destination per device token; a device
 * that re-registers (fresh install, token rotation) updates in place keyed by
 * deviceId so the destination list never accumulates ghost phones.
 */
export function upsertApnsDestination(input: {
  deviceToken: string;
  deviceId: string;
  deviceLabel?: string;
}): NotificationDestination {
  return withNotificationStateLock(() => {
    const items = loadDestinationsUnlocked();
    const existing = items.find(
      (entry) => entry.type === 'apns'
        && (entry.deviceId === input.deviceId || entry.apnsDeviceToken === input.deviceToken),
    );
    const id = existing?.id ?? `apns-${input.deviceId}-${Date.now().toString(36)}`;
    const destination: NotificationDestination = {
      id,
      name: input.deviceLabel?.trim() || `iPhone ${input.deviceId}`,
      type: 'apns',
      apnsDeviceToken: input.deviceToken,
      deviceId: input.deviceId,
      enabled: true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    if (existing) {
      items[items.indexOf(existing)] = destination;
    } else {
      items.push(destination);
    }
    saveDestinationsUnlocked(items);
    return destination;
  });
}

/** Reap a dead token (APNs said Unregistered/BadDeviceToken/410). */
export function removeApnsDestinationByToken(deviceToken: string): boolean {
  return withNotificationStateLock(() => {
    const items = loadDestinationsUnlocked();
    const next = items.filter(
      (entry) => !(entry.type === 'apns' && entry.apnsDeviceToken === deviceToken),
    );
    if (next.length === items.length) return false;
    saveDestinationsUnlocked(next);
    return true;
  });
}

export function listQueuedNotificationDeliveries(): NotificationDeliveryJob[] {
  return withNotificationStateLock(() => recoverNotificationDeliveryAdmissionsUnlocked());
}

/**
 * Explicitly replace a quarantined/corrupt queue generation from the durable
 * notification carriers. Ordinary reads and queue settlement deliberately do
 * not clear the recovery marker: until this transaction succeeds, every
 * notification remains protected from count and age pruning.
 */
export function recoverCorruptedNotificationDeliveryQueue(): {
  recovered: boolean;
  queued: number;
} {
  return withNotificationStateLock(() => {
    const queueWasMissing = !existsSync(DELIVERY_QUEUE_FILE);
    const snapshot = loadDeliveryQueueUnlocked();
    if (!snapshot.corrupted && !queueWasMissing) {
      return { recovered: false, queued: recoverNotificationDeliveryAdmissionsUnlocked().length };
    }

    const notifications = loadNotificationsUnlocked();
    if (notificationsRequireRecovery()) {
      // The queue cannot be reconstructed from an unknown carrier generation.
      // Keep both recovery authorities in place and perform no writes.
      return { recovered: false, queued: snapshot.items.length };
    }
    const rebuilt = new Map(snapshot.items.map((job) => [job.notificationId, job]));
    for (const notification of notifications) {
      if (notificationNeedsDeliveryQueue(notification) && !rebuilt.has(notification.id)) {
        rebuilt.set(notification.id, freshDeliveryJob(
          notification.id,
          notificationDeliveryQueuedAt(notification),
        ));
      }
    }
    const queue = [...rebuilt.values()];
    // The rebuilt generation is durable before the corruption authority is
    // cleared. Crashing on either side replays this exact reconstruction.
    saveDeliveryQueueUnlocked(queue);
    if (snapshot.corrupted) clearDeliveryQueueRecoveryMarkerDurably();
    for (const notification of notifications) {
      if (deliveryAdmissionNeedsRetention(notification)) {
        delete notification.deliveryAdmissionPendingAt;
      }
    }
    saveNotificationsUnlocked(notifications, { queue });
    return { recovered: true, queued: queue.length };
  });
}

export function replaceQueuedNotificationDeliveries(items: NotificationDeliveryJob[]): void {
  withNotificationStateLock(() => {
    if (loadDeliveryQueueUnlocked().corrupted) {
      throw new Error('Notification delivery queue requires explicit corruption recovery.');
    }
    saveDeliveryQueueUnlocked(items);
    compactNotificationsUnlocked(items);
  });
}

function sameNotificationDeliveryJob(
  left: NotificationDeliveryJob,
  right: NotificationDeliveryJob,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Settle one asynchronously processed queue snapshot without replacing work
 * that arrived while provider sends were awaiting. Each observed job is an
 * optimistic-CAS generation: it is replaced/removed only when its current
 * persisted bytes still match the bytes the worker originally observed.
 * Jobs absent from the snapshot, and same-id jobs requeued or otherwise
 * mutated during the pass, survive untouched.
 */
export function settleQueuedNotificationDeliveryPass(
  observedJobs: NotificationDeliveryJob[],
  replacementJobs: NotificationDeliveryJob[],
): void {
  withNotificationStateLock(() => {
    const observedById = new Map(observedJobs.map((job) => [job.notificationId, job]));
    const replacementById = new Map(replacementJobs.map((job) => [job.notificationId, job]));
    const currentSnapshot = loadDeliveryQueueUnlocked();
    // Never turn a quarantined/missing generation into authoritative empty
    // state merely because a worker happened to settle an old snapshot.
    if (currentSnapshot.corrupted) return;
    const current = currentSnapshot.items;
    const settled: NotificationDeliveryJob[] = [];

    for (const currentJob of current) {
      const observed = observedById.get(currentJob.notificationId);
      if (!observed || !sameNotificationDeliveryJob(currentJob, observed)) {
        settled.push(currentJob);
        continue;
      }
      const replacement = replacementById.get(currentJob.notificationId);
      if (replacement) settled.push(replacement);
    }

    saveDeliveryQueueUnlocked(settled);
    compactNotificationsUnlocked(settled);
  });
}

export function requeueNotificationDelivery(notificationId: string): void {
  withNotificationStateLock(() => {
    const queue = loadDeliveryQueueUnlocked().items;
    const existing = queue.find((item) => item.notificationId === notificationId);
    if (existing) {
      existing.queuedAt = new Date().toISOString();
      existing.completedDestinationIds = [];
      existing.failedDestinationIds = [];
      existing.attemptCountByDestination = {};
      existing.nextAttemptAtByDestination = {};
      existing.lastErrorByDestination = {};
    } else {
      queue.push({
        notificationId,
        queuedAt: new Date().toISOString(),
        completedDestinationIds: [],
        failedDestinationIds: [],
        attemptCountByDestination: {},
        nextAttemptAtByDestination: {},
        lastErrorByDestination: {},
      });
    }
    saveDeliveryQueueUnlocked(queue);
    compactNotificationsUnlocked(queue);
  });
}

/**
 * Resolve where a notification should be delivered.
 *
 * Order of precedence:
 *   1. Configured destinations (`notification-destinations.json`, enabled only).
 *   2. Explicit destinations in the notification metadata
 *      (`discordUserId`, `discordChannelId`).
 *   3. **Fallback to the primary Discord DM allowlist** so cron + workflow
 *      notifications still reach the user when nothing has been wired up.
 *      Previously the delivery loop silently dropped these — the user
 *      could trigger hours of work and never hear a peep.
 */
export function getNotificationDestinationsForRecord(notification: NotificationRecord): NotificationDestination[] {
  const metadata = notification.metadata ?? {};
  if (hasExactOriginDeliveryMode(notification)) {
    const target = exactOriginDeliveryTarget(notification);
    const receipt = expectedExactOriginDeliveryReceipt(notification);
    // Presence of the marker owns routing. A corrupt/unsupported target and
    // origin_chat both resolve to zero outbound destinations; neither may
    // inherit a configured, derived, fallback, proactive, push, or desktop leg.
    if (!target || !receipt || target.type === 'origin_chat') return [];

    if (target.type === 'discord_channel') {
      return [{
        id: receipt,
        name: receipt,
        type: 'discord_channel',
        channelId: target.channelId,
        enabled: true,
        createdAt: notification.createdAt,
      }];
    }
    if (target.type === 'slack_user') {
      return [{
        id: receipt,
        name: receipt,
        type: 'slack_user',
        userId: target.userId,
        enabled: true,
        createdAt: notification.createdAt,
      }];
    }
    return [{
      id: receipt,
      name: receipt,
      type: 'slack_channel',
      channelId: target.channelId,
      threadTs: target.threadTs,
      enabled: true,
      createdAt: notification.createdAt,
    }];
  }
  // Origin-chat report-back is delivered into the chat transcript, not pushed to
  // any external surface — resolve ZERO destinations so it never falls through to
  // the Discord/Slack DM fallback below.
  if (metadata.reportBackTargetType === 'origin_chat') {
    // Wave 3 Move B: a TERMINAL report-back (done/blocked/failed) still pings the
    // user's OWN registered devices (web-push) so an away user learns their task
    // finished, instead of the completion sitting unseen in the transcript until
    // the watchdog replay (3min–12h later). Web-push targets the user's own
    // devices only (never a Discord/Slack channel they didn't choose), and only
    // for terminal report-backs (heartbeats/progress stay silent).
    // Kill-switch CLEMMY_REPORTBACK_PUSH=off.
    if (metadata.terminalReportBack === true
      && (process.env.CLEMMY_REPORTBACK_PUSH ?? 'on').toLowerCase() !== 'off') {
      return listNotificationDestinations().filter((e) => e.enabled && e.type === 'web_push');
    }
    return [];
  }
  // U5 (v2.3.0): the DESKTOP is always a valid loud surface — the durable
  // notification store lives on this machine, and the app shell toasts it.
  // With no other destination configured, loud notifications previously
  // resolved to [] and deferred forever ("No notification destinations
  // resolved", 9 stuck jobs live 2026-07-22 on two machines).
  const desktopDestination: NotificationDestination[] = notification.silent
    ? []
    : [{
        id: 'derived-desktop',
        name: 'Desktop app',
        type: 'desktop',
        enabled: true,
        createdAt: notification.createdAt,
      }];
  const configured = listNotificationDestinations().filter((entry) => entry.enabled);
  const explicitDiscordUserId = typeof metadata.discordUserId === 'string' ? metadata.discordUserId : '';
  const explicitDiscordChannelId = typeof metadata.discordChannelId === 'string' ? metadata.discordChannelId : '';
  const explicitSlackUserId = typeof metadata.slackUserId === 'string' ? metadata.slackUserId : '';
  const explicitSlackChannelId = typeof metadata.slackChannelId === 'string' ? metadata.slackChannelId : '';
  const explicitSlackThreadTs = typeof metadata.slackThreadTs === 'string' ? metadata.slackThreadTs : '';

  const derived: NotificationDestination[] = [];
  if (explicitDiscordUserId) {
    derived.push({
      id: `derived-discord-user:${explicitDiscordUserId}`,
      name: `Discord User ${explicitDiscordUserId}`,
      type: 'discord_user',
      userId: explicitDiscordUserId,
      enabled: true,
      createdAt: notification.createdAt,
    });
  }
  if (explicitDiscordChannelId) {
    derived.push({
      id: `derived-discord-channel:${explicitDiscordChannelId}`,
      name: `Discord Channel ${explicitDiscordChannelId}`,
      type: 'discord_channel',
      channelId: explicitDiscordChannelId,
      enabled: true,
      createdAt: notification.createdAt,
    });
  }
  if (explicitSlackUserId) {
    derived.push({
      id: `derived-slack-user:${explicitSlackUserId}`,
      name: `Slack User ${explicitSlackUserId}`,
      type: 'slack_user',
      userId: explicitSlackUserId,
      enabled: true,
      createdAt: notification.createdAt,
    });
  }
  if (explicitSlackChannelId) {
    derived.push({
      id: explicitSlackThreadTs
        ? `derived-slack-channel:${explicitSlackChannelId}:${explicitSlackThreadTs}`
        : `derived-slack-channel:${explicitSlackChannelId}`,
      name: explicitSlackThreadTs
        ? `Slack Channel ${explicitSlackChannelId} Thread ${explicitSlackThreadTs}`
        : `Slack Channel ${explicitSlackChannelId}`,
      type: 'slack_channel',
      channelId: explicitSlackChannelId,
      threadTs: explicitSlackThreadTs || undefined,
      enabled: true,
      createdAt: notification.createdAt,
    });
  }
  // Proactive posts: when a default Slack channel is configured, mirror
  // non-silent notifications into it (the "both: chat + proactive posts"
  // surface). Approval/check-in cards still route to the originating user/
  // channel above; this is the broadcast lane for briefs + surfaced items.
  if (SLACK_ENABLED && SLACK_BOT_TOKEN && SLACK_PROACTIVE_CHANNEL && !notification.silent) {
    derived.push({
      id: `derived-slack-proactive:${SLACK_PROACTIVE_CHANNEL}`,
      name: `Slack proactive channel`,
      type: 'slack_channel',
      channelId: SLACK_PROACTIVE_CHANNEL,
      enabled: true,
      createdAt: notification.createdAt,
    });
  }

  // Fallback: if nothing else routes this notification, ship it to the
  // primary allowlisted Discord DM user. Only fires when Discord is
  // enabled AND we have at least one allowed-DM user AND no other
  // destination was found — this is the "you set the cron from Discord,
  // you'd expect the cron's output to show up in Discord" path.
  const combined = [...configured, ...derived];
  // Per-surface DM fallback, fired when NO explicit/derived destination routed
  // this notification. Evaluate Discord and Slack INDEPENDENTLY against the
  // pre-fallback set: previously both gated on `combined.length === 0`, and since
  // Discord is pushed first it made `combined` non-empty and SHADOWED the Slack
  // fallback — so a scheduled workflow with no origin channel (run.channel null,
  // no routing metadata) only ever reached Discord. With both surfaces configured
  // the user expects parity (the 2026-06-29 "Discord but not Slack" incident).
  const hasRoutedDestination = combined.length > 0;
  if (!hasRoutedDestination
      && DISCORD_ENABLED
      && DISCORD_BOT_TOKEN
      && DISCORD_DM_ALLOWED_USERS.length > 0) {
    combined.push({
      id: `fallback-discord-user:${DISCORD_DM_ALLOWED_USERS[0]}`,
      name: `Discord DM (allowlist primary)`,
      type: 'discord_user',
      userId: DISCORD_DM_ALLOWED_USERS[0],
      enabled: true,
      createdAt: notification.createdAt,
    });
  }

  // Same fallback for Slack: when nothing else routes this AND Slack is the
  // configured chat surface, DM the primary allowlisted Slack user so cron /
  // background output set up from Slack reports back into Slack.
  if (!hasRoutedDestination
      && SLACK_ENABLED
      && SLACK_BOT_TOKEN
      && SLACK_ALLOWED_USERS.length > 0) {
    combined.push({
      id: `fallback-slack-user:${SLACK_ALLOWED_USERS[0]}`,
      name: `Slack DM (allowlist primary)`,
      type: 'slack_user',
      userId: SLACK_ALLOWED_USERS[0],
      enabled: true,
      createdAt: notification.createdAt,
    });
  }
  // The desktop leg rides ALONGSIDE whatever else routed (parity: the same
  // report that pings Slack/Discord also toasts the desktop) — and when
  // nothing else is configured it is the guaranteed non-empty destination.
  combined.push(...desktopDestination);

  return combined.filter((destination, index) =>
    combined.findIndex((entry) => entry.id === destination.id) === index,
  );
}
