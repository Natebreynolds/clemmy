import { apiGet, apiPost, api } from './api';

export type DestinationType = 'discord_webhook' | 'discord_channel' | 'discord_user';

export interface NotificationDestination {
  id: string;
  name: string;
  type: DestinationType;
  url?: string;
  enabled?: boolean;
  channel_id?: string;
  guild_id?: string;
  user_id?: string;
}

export const listDestinations = () =>
  apiGet<{ destinations: NotificationDestination[] }>('/api/notifications/destinations');

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
