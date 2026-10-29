import { apiGet, apiPost } from './api';

export type OtherAppState = 'not_installed' | 'not_connected' | 'connected' | 'needs_update' | 'unreadable';

export interface OtherApp {
  id: 'claude-desktop' | 'cursor';
  name: string;
  state: OtherAppState;
  /** What the owner does after connecting for the app to see Clementine. */
  after: string;
}

export interface OtherAppsStatus {
  available: boolean;
  connection: { command: string; args: string[]; env: Record<string, string> } | null;
  apps: OtherApp[];
}

export const getOtherApps = () => apiGet<OtherAppsStatus>('/api/console/other-apps');
export const setOtherAppConnected = (id: OtherApp['id'], connect: boolean) =>
  apiPost<{ ok: true; state: OtherAppState; after: string | null }>(`/api/console/other-apps/${id}/${connect ? 'connect' : 'disconnect'}`, {});

/** The one action a row offers, from its state; none while the app is absent or unreadable. */
export function otherAppAction(state: OtherAppState): { label: string; connect: boolean } | null {
  if (state === 'not_connected') return { label: 'Connect', connect: true };
  if (state === 'needs_update') return { label: 'Update', connect: true };
  if (state === 'connected') return { label: 'Disconnect', connect: false };
  return null;
}

export function otherAppStateWords(state: OtherAppState): string {
  switch (state) {
    case 'connected': return 'Connected';
    case 'needs_update': return 'Needs an update';
    case 'not_connected': return 'Not connected';
    case 'unreadable': return 'Its settings file could not be read';
    case 'not_installed': return 'Not on this computer';
  }
}
