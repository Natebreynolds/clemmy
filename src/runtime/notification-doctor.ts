import type { NotificationDestination, NotificationRecord } from './notifications.js';

export type DeliverySurfaceId = 'slack' | 'discord';

export interface RuntimeSurfaceStatus {
  enabled?: boolean;
  connected?: boolean;
  listening?: boolean;
  guildCount?: number;
  clientId?: string;
  installUrl?: string;
  botUserId?: string;
  teamName?: string;
  startedAt?: string;
}

export interface NotificationDoctorConfig {
  discordAllowedUsers?: string[];
  discordAllowedChannels?: string[];
  slackAllowedUsers?: string[];
  slackAllowedChannels?: string[];
  slackProactiveChannel?: string;
}

export interface DeliverySurfaceHealth {
  id: DeliverySurfaceId;
  label: string;
  enabled: boolean;
  connected: boolean;
  configured: boolean;
  canDm: boolean;
  canPostChannel: boolean;
  canEdit: boolean;
  destinationCount: number;
  enabledDestinationCount: number;
  allowedUserCount: number;
  allowedChannelCount: number;
  details: Record<string, string | number | boolean | undefined>;
  lastDeliveryAt?: string;
  lastDeliveryStatus?: DeliveryReceipt['status'];
  lastDeliveryTitle?: string;
  lastFailureAt?: string;
  lastFailureTitle?: string;
  recentFailureCount: number;
  issues: string[];
}

export interface DeliveryReceipt {
  id: string;
  title: string;
  kind: NotificationRecord['kind'];
  createdAt: string;
  deliveredAt?: string;
  deliveryAttempts: number;
  deliveryError?: string;
  deliveredDestinations: string[];
  targetSummary: string;
  status: 'delivered' | 'failed' | 'partial' | 'pending';
}

export interface NotificationDoctor {
  generatedAt: string;
  surfaces: DeliverySurfaceHealth[];
  destinations: {
    total: number;
    enabled: number;
    byType: Record<string, number>;
  };
  recentReceipts: DeliveryReceipt[];
}

function destinationTypeCount(destinations: NotificationDestination[], prefix: DeliverySurfaceId): number {
  return destinations.filter((destination) => destination.type.startsWith(`${prefix}_`)).length;
}

function enabledDestinationTypeCount(destinations: NotificationDestination[], prefix: DeliverySurfaceId): number {
  return destinations.filter((destination) => destination.enabled && destination.type.startsWith(`${prefix}_`)).length;
}

function hasEnabledDestination(destinations: NotificationDestination[], type: NotificationDestination['type']): boolean {
  return destinations.some((destination) => destination.enabled && destination.type === type);
}

function targetSummary(notification: NotificationRecord): string {
  const metadata = notification.metadata ?? {};
  const reportType = typeof metadata.reportBackTargetType === 'string' ? metadata.reportBackTargetType : '';
  const reportId = typeof metadata.reportBackTargetId === 'string' ? metadata.reportBackTargetId : '';
  if (reportType && reportId) return `${reportType}: ${reportId}`;

  for (const [label, key] of [
    ['Slack DM', 'slackUserId'],
    ['Slack channel', 'slackChannelId'],
    ['Discord DM', 'discordUserId'],
    ['Discord channel', 'discordChannelId'],
  ] as const) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return `${label}: ${value}`;
  }

  const delivered = notification.deliveredDestinations ?? [];
  if (delivered.length > 0) return delivered.join(', ');
  return 'No resolved target yet';
}

function receiptStatus(notification: NotificationRecord): DeliveryReceipt['status'] {
  const delivered = Boolean(notification.deliveredAt) || (notification.deliveredDestinations ?? []).length > 0;
  if (notification.deliveryError && delivered) return 'partial';
  if (notification.deliveryError) return 'failed';
  if (delivered) return 'delivered';
  return 'pending';
}

function buildReceipt(notification: NotificationRecord): DeliveryReceipt {
  return {
    id: notification.id,
    title: notification.title,
    kind: notification.kind,
    createdAt: notification.createdAt,
    deliveredAt: notification.deliveredAt,
    deliveryAttempts: notification.deliveryAttempts ?? 0,
    deliveryError: notification.deliveryError,
    deliveredDestinations: notification.deliveredDestinations ?? [],
    targetSummary: targetSummary(notification),
    status: receiptStatus(notification),
  };
}

function notificationSurfaceIds(notification: NotificationRecord): DeliverySurfaceId[] {
  const metadata = notification.metadata ?? {};
  const surfaces = new Set<DeliverySurfaceId>();
  const reportType = typeof metadata.reportBackTargetType === 'string' ? metadata.reportBackTargetType : '';
  if (reportType.startsWith('slack_')) surfaces.add('slack');
  if (reportType.startsWith('discord_')) surfaces.add('discord');
  if (typeof metadata.slackUserId === 'string' || typeof metadata.slackChannelId === 'string') surfaces.add('slack');
  if (typeof metadata.discordUserId === 'string' || typeof metadata.discordChannelId === 'string') surfaces.add('discord');
  for (const destination of notification.deliveredDestinations ?? []) {
    const lower = destination.toLowerCase();
    if (lower.includes('slack')) surfaces.add('slack');
    if (lower.includes('discord')) surfaces.add('discord');
  }
  const error = notification.deliveryError?.toLowerCase() ?? '';
  if (error.includes('slack')) surfaces.add('slack');
  if (error.includes('discord')) surfaces.add('discord');
  return [...surfaces];
}

function surfaceDeliveryStats(notifications: NotificationRecord[], surface: DeliverySurfaceId): {
  lastDeliveryAt?: string;
  lastDeliveryStatus?: DeliveryReceipt['status'];
  lastDeliveryTitle?: string;
  lastFailureAt?: string;
  lastFailureTitle?: string;
  recentFailureCount: number;
} {
  const receipts = notifications
    .filter((notification) => !notification.silent && notificationSurfaceIds(notification).includes(surface))
    .map(buildReceipt);
  const last = receipts[0];
  const failures = receipts.filter((receipt) => receipt.status === 'failed' || receipt.status === 'partial');
  return {
    lastDeliveryAt: last?.deliveredAt ?? last?.createdAt,
    lastDeliveryStatus: last?.status,
    lastDeliveryTitle: last?.title,
    lastFailureAt: failures[0]?.deliveredAt ?? failures[0]?.createdAt,
    lastFailureTitle: failures[0]?.title,
    recentFailureCount: failures.length,
  };
}

function surfaceIssues(input: {
  enabled: boolean;
  connected: boolean;
  configured: boolean;
  canDm: boolean;
  canPostChannel: boolean;
}): string[] {
  const issues: string[] = [];
  if (!input.enabled) issues.push('Not enabled');
  if (input.enabled && !input.connected) issues.push('Not connected');
  if (input.connected && !input.configured) issues.push('No delivery destination or fallback configured');
  if (input.connected && !input.canDm) issues.push('No DM route configured');
  if (input.connected && !input.canPostChannel) issues.push('No channel route configured');
  return issues;
}

export function buildNotificationDoctor(input: {
  destinations: NotificationDestination[];
  notifications: NotificationRecord[];
  discord?: RuntimeSurfaceStatus;
  slack?: RuntimeSurfaceStatus;
  config?: NotificationDoctorConfig;
  now?: string;
}): NotificationDoctor {
  const destinations = input.destinations;
  const config = input.config ?? {};
  const discordDestinationCount = destinationTypeCount(destinations, 'discord');
  const slackDestinationCount = destinationTypeCount(destinations, 'slack');
  const enabledDiscordDestinationCount = enabledDestinationTypeCount(destinations, 'discord');
  const enabledSlackDestinationCount = enabledDestinationTypeCount(destinations, 'slack');
  const discordAllowedUsers = config.discordAllowedUsers ?? [];
  const discordAllowedChannels = config.discordAllowedChannels ?? [];
  const slackAllowedUsers = config.slackAllowedUsers ?? [];
  const slackAllowedChannels = config.slackAllowedChannels ?? [];

  const discordEnabled = input.discord?.enabled === true;
  const discordConnected = input.discord?.connected === true;
  const discordCanDm = discordConnected && (discordAllowedUsers.length > 0 || hasEnabledDestination(destinations, 'discord_user'));
  const discordCanPostChannel = discordConnected && (
    discordAllowedChannels.length > 0
    || hasEnabledDestination(destinations, 'discord_channel')
    || hasEnabledDestination(destinations, 'discord_webhook')
  );
  const discordConfigured = enabledDiscordDestinationCount > 0 || discordAllowedUsers.length > 0 || discordAllowedChannels.length > 0;
  const discordDeliveryStats = surfaceDeliveryStats(input.notifications, 'discord');

  const slackEnabled = input.slack?.enabled === true;
  const slackConnected = input.slack?.connected === true || input.slack?.listening === true;
  const slackCanDm = slackConnected && (slackAllowedUsers.length > 0 || hasEnabledDestination(destinations, 'slack_user'));
  const slackCanPostChannel = slackConnected && (
    slackAllowedChannels.length > 0
    || Boolean(config.slackProactiveChannel)
    || hasEnabledDestination(destinations, 'slack_channel')
    || hasEnabledDestination(destinations, 'slack_webhook')
  );
  const slackConfigured = enabledSlackDestinationCount > 0
    || slackAllowedUsers.length > 0
    || slackAllowedChannels.length > 0
    || Boolean(config.slackProactiveChannel);
  const slackDeliveryStats = surfaceDeliveryStats(input.notifications, 'slack');

  const surfaces: DeliverySurfaceHealth[] = [
    {
      id: 'slack',
      label: 'Slack',
      enabled: slackEnabled,
      connected: slackConnected,
      configured: slackConfigured,
      canDm: slackCanDm,
      canPostChannel: slackCanPostChannel,
      canEdit: false,
      destinationCount: slackDestinationCount,
      enabledDestinationCount: enabledSlackDestinationCount,
      allowedUserCount: slackAllowedUsers.length,
      allowedChannelCount: slackAllowedChannels.length,
      details: {
        botUserId: input.slack?.botUserId,
        teamName: input.slack?.teamName,
        startedAt: input.slack?.startedAt,
        proactiveChannel: config.slackProactiveChannel,
      },
      ...slackDeliveryStats,
      issues: surfaceIssues({
        enabled: slackEnabled,
        connected: slackConnected,
        configured: slackConfigured,
        canDm: slackCanDm,
        canPostChannel: slackCanPostChannel,
      }),
    },
    {
      id: 'discord',
      label: 'Discord',
      enabled: discordEnabled,
      connected: discordConnected,
      configured: discordConfigured,
      canDm: discordCanDm,
      canPostChannel: discordCanPostChannel,
      canEdit: discordConnected,
      destinationCount: discordDestinationCount,
      enabledDestinationCount: enabledDiscordDestinationCount,
      allowedUserCount: discordAllowedUsers.length,
      allowedChannelCount: discordAllowedChannels.length,
      details: {
        clientId: input.discord?.clientId,
        guildCount: input.discord?.guildCount,
        installUrl: input.discord?.installUrl,
        startedAt: input.discord?.startedAt,
      },
      ...discordDeliveryStats,
      issues: surfaceIssues({
        enabled: discordEnabled,
        connected: discordConnected,
        configured: discordConfigured,
        canDm: discordCanDm,
        canPostChannel: discordCanPostChannel,
      }),
    },
  ];

  const byType: Record<string, number> = {};
  for (const destination of destinations) {
    byType[destination.type] = (byType[destination.type] ?? 0) + 1;
  }

  const recentReceipts = input.notifications
    .filter((notification) => !notification.silent)
    .slice(0, 12)
    .map(buildReceipt);

  return {
    generatedAt: input.now ?? new Date().toISOString(),
    surfaces,
    destinations: {
      total: destinations.length,
      enabled: destinations.filter((destination) => destination.enabled).length,
      byType,
    },
    recentReceipts,
  };
}
