import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

const NOTIFICATIONS_FILE = path.join(BASE_DIR, 'state', 'notifications.json');
const DESTINATIONS_FILE = path.join(BASE_DIR, 'state', 'notification-destinations.json');
const DELIVERY_QUEUE_FILE = path.join(BASE_DIR, 'state', 'notification-delivery-queue.json');

export interface NotificationRecord {
  id: string;
  kind: 'cron' | 'workflow' | 'system' | 'approval';
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  metadata?: Record<string, unknown>;
  deliveredAt?: string;
  deliveryAttempts?: number;
  deliveryError?: string;
  deliveredDestinations?: string[];
}

export interface NotificationDestination {
  id: string;
  name: string;
  type: 'generic_webhook' | 'discord_webhook' | 'discord_channel' | 'discord_user';
  url?: string;
  channelId?: string;
  guildId?: string;
  userId?: string;
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

function loadNotifications(): NotificationRecord[] {
  if (!existsSync(NOTIFICATIONS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(NOTIFICATIONS_FILE, 'utf-8')) as NotificationRecord[];
  } catch {
    return [];
  }
}

function saveNotifications(items: NotificationRecord[]): void {
  mkdirSync(path.dirname(NOTIFICATIONS_FILE), { recursive: true });
  writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(items, null, 2), 'utf-8');
}

function loadDestinations(): NotificationDestination[] {
  if (!existsSync(DESTINATIONS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(DESTINATIONS_FILE, 'utf-8')) as NotificationDestination[];
  } catch {
    return [];
  }
}

function saveDestinations(items: NotificationDestination[]): void {
  mkdirSync(path.dirname(DESTINATIONS_FILE), { recursive: true });
  writeFileSync(DESTINATIONS_FILE, JSON.stringify(items, null, 2), 'utf-8');
}

function loadDeliveryQueue(): NotificationDeliveryJob[] {
  if (!existsSync(DELIVERY_QUEUE_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(DELIVERY_QUEUE_FILE, 'utf-8')) as NotificationDeliveryJob[];
    return parsed.map((item) => ({
      notificationId: item.notificationId,
      queuedAt: item.queuedAt,
      completedDestinationIds: Array.isArray(item.completedDestinationIds) ? item.completedDestinationIds : [],
      failedDestinationIds: Array.isArray(item.failedDestinationIds) ? item.failedDestinationIds : [],
      attemptCountByDestination: item.attemptCountByDestination ?? {},
      nextAttemptAtByDestination: item.nextAttemptAtByDestination ?? {},
      lastErrorByDestination: item.lastErrorByDestination ?? {},
    }));
  } catch {
    return [];
  }
}

function saveDeliveryQueue(items: NotificationDeliveryJob[]): void {
  mkdirSync(path.dirname(DELIVERY_QUEUE_FILE), { recursive: true });
  writeFileSync(DELIVERY_QUEUE_FILE, JSON.stringify(items, null, 2), 'utf-8');
}

export function listNotifications(limit = 20): NotificationRecord[] {
  return loadNotifications()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function addNotification(item: NotificationRecord): void {
  const items = loadNotifications();
  items.push(item);
  saveNotifications(items);

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

export function markNotificationRead(id: string): NotificationRecord | undefined {
  const items = loadNotifications();
  const item = items.find((entry) => entry.id === id);
  if (!item) return undefined;
  item.read = true;
  saveNotifications(items);
  return item;
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

export function getNotificationDestinationsForRecord(notification: NotificationRecord): NotificationDestination[] {
  const configured = listNotificationDestinations().filter((entry) => entry.enabled);
  const metadata = notification.metadata ?? {};
  const explicitDiscordUserId = typeof metadata.discordUserId === 'string' ? metadata.discordUserId : '';
  const explicitDiscordChannelId = typeof metadata.discordChannelId === 'string' ? metadata.discordChannelId : '';

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

  const combined = [...configured, ...derived];
  return combined.filter((destination, index) =>
    combined.findIndex((entry) => entry.id === destination.id) === index,
  );
}
