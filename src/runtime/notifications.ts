import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
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
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
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
function loadJsonResilient<T>(filePath: string, fallback: T): { value: T; corrupted: boolean } {
  if (!existsSync(filePath)) return { value: fallback, corrupted: false };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return { value: parsed as T, corrupted: false };
  } catch {
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
      title: 'Notification store was corrupted and reset',
      body: `Found unparsable JSON in ${path.basename(filePath)}. Quarantined the bad file with a .corrupt-<timestamp> suffix and started fresh. Some pending notifications or delivery state may have been lost.`,
      createdAt: now,
      read: false,
      metadata: { filePath, recoveredAt: now },
    },
  });
}

const NOTIFICATIONS_FILE = path.join(BASE_DIR, 'state', 'notifications.json');
const DESTINATIONS_FILE = path.join(BASE_DIR, 'state', 'notification-destinations.json');
const DELIVERY_QUEUE_FILE = path.join(BASE_DIR, 'state', 'notification-delivery-queue.json');
const MAX_STORED_NOTIFICATIONS = 1000;
const PROACTIVE_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

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
  type: 'generic_webhook' | 'discord_webhook' | 'discord_channel' | 'discord_user' | 'slack_webhook' | 'slack_channel' | 'slack_user' | 'web_push';
  url?: string;
  channelId?: string;
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

export function loadNotifications(): NotificationRecord[] {
  const result = loadJsonResilient<NotificationRecord[]>(NOTIFICATIONS_FILE, []);
  if (result.corrupted) surfaceCorruption(NOTIFICATIONS_FILE);
  return result.value;
}

function saveNotifications(items: NotificationRecord[]): void {
  const pruned = pruneNotifications(items);
  atomicWriteJson(NOTIFICATIONS_FILE, pruned);
}

function loadDestinations(): NotificationDestination[] {
  const result = loadJsonResilient<NotificationDestination[]>(DESTINATIONS_FILE, []);
  if (result.corrupted) surfaceCorruption(DESTINATIONS_FILE);
  return result.value;
}

function saveDestinations(items: NotificationDestination[]): void {
  atomicWriteJson(DESTINATIONS_FILE, items);
}

function loadDeliveryQueue(): NotificationDeliveryJob[] {
  const result = loadJsonResilient<NotificationDeliveryJob[]>(DELIVERY_QUEUE_FILE, []);
  if (result.corrupted) surfaceCorruption(DELIVERY_QUEUE_FILE);
  return result.value.map((item) => ({
    notificationId: item.notificationId,
    queuedAt: item.queuedAt,
    completedDestinationIds: Array.isArray(item.completedDestinationIds) ? item.completedDestinationIds : [],
    failedDestinationIds: Array.isArray(item.failedDestinationIds) ? item.failedDestinationIds : [],
    attemptCountByDestination: item.attemptCountByDestination ?? {},
    nextAttemptAtByDestination: item.nextAttemptAtByDestination ?? {},
    lastErrorByDestination: item.lastErrorByDestination ?? {},
  }));
}

function saveDeliveryQueue(items: NotificationDeliveryJob[]): void {
  atomicWriteJson(DELIVERY_QUEUE_FILE, items);
}

function pruneNotifications(items: NotificationRecord[]): NotificationRecord[] {
  if (items.length <= MAX_STORED_NOTIFICATIONS) return items;
  return [...items]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_STORED_NOTIFICATIONS)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

export function listNotifications(limit = 20): NotificationRecord[] {
  const items = loadNotifications();
  const compacted = pruneNotifications(items);
  if (compacted.length !== items.length) {
    saveNotifications(compacted);
  }
  return compacted
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function addNotification(item: NotificationRecord): void {
  const items = loadNotifications();
  // ID dedup added 2026-05-24: callers (cron heartbeat, daemon-offline
  // check, etc.) pass a STABLE id when they want at-most-once delivery.
  // Without this, three daemon restarts within a minute emitted three
  // "offline X min" notifications with the SAME id-key seed but
  // recomputed gap values — confusing duplicate reports of the same
  // outage. Content-dedup (proactive briefs, approvals) stays as a
  // secondary safety net for kinds that don't bother setting a stable id.
  if (item.id && items.some((existing) => existing.id === item.id)) {
    return;
  }
  if (items.some((existing) =>
    isRecentDuplicateProactiveBrief(existing, item) ||
    isDuplicateApprovalNotification(existing, item)
  )) {
    return;
  }
  items.push(item);
  saveNotifications(items);

  // Silent notifications are dashboard-only: skip the delivery queue so
  // we don't fan out lifecycle pings (queued / started / heartbeat /
  // tool-progress) to Discord and other external destinations. They
  // still land in notifications.json so the Activity panel sees them,
  // and the actionBus emit below still fires for live dashboard updates.
  if (!item.silent) {
    const queue = loadDeliveryQueue();
    queue.push({
      notificationId: item.id,
      queuedAt: new Date().toISOString(),
      completedDestinationIds: [],
      failedDestinationIds: [],
      attemptCountByDestination: {},
      nextAttemptAtByDestination: {},
      lastErrorByDestination: {},
    });
    saveDeliveryQueue(queue);
  }

  actionBus.emit({ kind: 'notification.created', notification: item });
}

export function markNotificationRead(id: string): NotificationRecord | undefined {
  const items = loadNotifications();
  const item = items.find((entry) => entry.id === id);
  if (!item) return undefined;
  item.read = true;
  saveNotifications(items);
  return item;
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
  const items = loadNotifications();
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
  if (changed.length > 0) saveNotifications(items);
  return changed;
}

export function markNotificationsReadByApprovalId(
  approvalId: string,
  metadataPatch: Record<string, unknown> = {},
): NotificationRecord[] {
  const items = loadNotifications();
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
  if (changed.length > 0) saveNotifications(items);
  return changed;
}

export function markStaleApprovalNotificationsRead(
  activeApprovalIds: Iterable<string>,
  metadataPatch: Record<string, unknown> = {},
): NotificationRecord[] {
  const active = new Set(activeApprovalIds);
  const items = loadNotifications();
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
  if (changed.length > 0) saveNotifications(items);
  return changed;
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
  const items = loadNotifications();
  const kept: NotificationRecord[] = [];
  let markedRead = 0;
  let purged = 0;
  for (const item of items) {
    const at = Date.parse(item.createdAt);
    const age = Number.isFinite(at) ? nowMs - at : 0;
    if (age > NOTIFICATION_MAX_AGE_MS) {
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
  if (markedRead > 0 || purged > 0) saveNotifications(kept);
  return { markedRead, purged };
}

export function getNotification(id: string): NotificationRecord | undefined {
  return loadNotifications().find((entry) => entry.id === id);
}

export function updateNotificationDeliveryStatus(
  id: string,
  patch: Partial<Pick<NotificationRecord, 'deliveredAt' | 'deliveryAttempts' | 'deliveryError' | 'deliveredDestinations'>>,
): NotificationRecord | undefined {
  const items = loadNotifications();
  const item = items.find((entry) => entry.id === id);
  if (!item) return undefined;
  if (patch.deliveredDestinations) {
    item.deliveredDestinations = uniqueStrings([
      ...(item.deliveredDestinations ?? []),
      ...patch.deliveredDestinations,
    ]);
  }
  Object.assign(item, {
    ...patch,
    deliveredDestinations: item.deliveredDestinations,
  });
  saveNotifications(items);
  return item;
}

export function listNotificationDestinations(): NotificationDestination[] {
  return loadDestinations().sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertNotificationDestination(destination: NotificationDestination): void {
  const items = loadDestinations();
  const index = items.findIndex((entry) => entry.id === destination.id);
  if (index >= 0) {
    items[index] = destination;
  } else {
    items.push(destination);
  }
  saveDestinations(items);
}

export function removeNotificationDestination(id: string): boolean {
  const items = loadDestinations();
  const next = items.filter((entry) => entry.id !== id);
  if (next.length === items.length) return false;
  saveDestinations(next);
  return true;
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
  const items = loadDestinations();
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
  saveDestinations(items);
  return destination;
}

export function removeWebPushDestinationByEndpoint(endpoint: string): boolean {
  const items = loadDestinations();
  const next = items.filter(
    (entry) => !(entry.type === 'web_push' && entry.pushEndpoint === endpoint),
  );
  if (next.length === items.length) return false;
  saveDestinations(next);
  return true;
}

export function removeWebPushDestinationsByDeviceId(deviceId: string): number {
  const items = loadDestinations();
  const next = items.filter(
    (entry) => !(entry.type === 'web_push' && entry.deviceId === deviceId),
  );
  const removed = items.length - next.length;
  if (removed > 0) saveDestinations(next);
  return removed;
}

export function listQueuedNotificationDeliveries(): NotificationDeliveryJob[] {
  return loadDeliveryQueue();
}

export function replaceQueuedNotificationDeliveries(items: NotificationDeliveryJob[]): void {
  saveDeliveryQueue(items);
}

export function requeueNotificationDelivery(notificationId: string): void {
  const queue = loadDeliveryQueue();
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
  saveDeliveryQueue(queue);
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
  const configured = listNotificationDestinations().filter((entry) => entry.enabled);
  const metadata = notification.metadata ?? {};
  const explicitDiscordUserId = typeof metadata.discordUserId === 'string' ? metadata.discordUserId : '';
  const explicitDiscordChannelId = typeof metadata.discordChannelId === 'string' ? metadata.discordChannelId : '';
  const explicitSlackUserId = typeof metadata.slackUserId === 'string' ? metadata.slackUserId : '';
  const explicitSlackChannelId = typeof metadata.slackChannelId === 'string' ? metadata.slackChannelId : '';

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
      id: `derived-slack-channel:${explicitSlackChannelId}`,
      name: `Slack Channel ${explicitSlackChannelId}`,
      type: 'slack_channel',
      channelId: explicitSlackChannelId,
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
  if (combined.length === 0
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
  if (combined.length === 0
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

  return combined.filter((destination, index) =>
    combined.findIndex((entry) => entry.id === destination.id) === index,
  );
}
