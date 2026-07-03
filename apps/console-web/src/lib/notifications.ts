import { apiGet, apiPost, api } from './api';

export type DestinationType =
  | 'discord_webhook'
  | 'discord_channel'
  | 'discord_user'
  | 'slack_webhook'
  | 'slack_channel'
  | 'slack_user';

export interface NotificationDestination {
  id: string;
  name: string;
  type: DestinationType;
  url?: string;
  enabled?: boolean;
  channelId?: string;
  channel_id?: string;
  guild_id?: string;
  userId?: string;
  user_id?: string;
}

export interface DeliverySurfaceHealth {
  id: 'slack' | 'discord';
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
  details?: Record<string, string | number | boolean | undefined>;
  issues: string[];
}

export interface DeliveryReceipt {
  id: string;
  title: string;
  kind: string;
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
  destinations: { total: number; enabled: number; byType: Record<string, number> };
  recentReceipts: DeliveryReceipt[];
}

export const listDestinations = () =>
  apiGet<{ destinations: NotificationDestination[] }>('/api/notifications/destinations');

export const getNotificationDoctor = () =>
  apiGet<NotificationDoctor>('/api/notifications/doctor');

export const addDestination = (body: Partial<NotificationDestination>) =>
  apiPost('/api/notifications/destinations', body);

export const testDestination = (id: string) =>
  apiPost(`/api/notifications/destinations/${encodeURIComponent(id)}/test`);

// JSON routes that SET enabled (idempotent) + delete — not the legacy
// /dashboard/actions/* redirect endpoints that return HTML and ignore the body.
export const toggleDestination = (id: string, enabled: boolean) =>
  api(`/api/notifications/destinations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });

export const deleteDestination = (id: string) =>
  api(`/api/notifications/destinations/${encodeURIComponent(id)}`, { method: 'DELETE' });
