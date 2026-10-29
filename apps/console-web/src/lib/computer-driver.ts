import { apiGet, apiPost, withToken } from './api';
import type { InstallJob } from './connect';

export interface ComputerDriverStatus {
  installed: boolean;
  path: string | null;
  embedded: boolean;
  version: string;
  daemon: 'running' | 'stopped' | 'unknown';
  statusText: string | null;
  permissions: 'granted' | 'missing' | 'unknown';
  permissionsText: string | null;
  connected: boolean;
  serverName: string;
  docsUrl: string;
  platformSupport: 'supported' | 'preview' | 'unsupported';
  /** Older daemons omit capabilities; no unsupported action is inferred. */
  permissionSettingsAvailable?: boolean;
  screenViewAvailable?: boolean;
}

export const getComputerDriver = () => apiGet<ComputerDriverStatus>('/api/console/computer-driver');
export const installComputerDriver = () => apiPost<{ job: InstallJob }>('/api/console/computer-driver/install', {});
export const getComputerDriverInstallJob = (id: string) => apiGet<{ job: InstallJob }>(`/api/console/computer-driver/install/${encodeURIComponent(id)}`);
export const grantComputerDriverPermissions = () => apiPost<{ output: string; status: ComputerDriverStatus }>('/api/console/computer-driver/permissions', {});
export const connectComputerDriver = () => apiPost<{ status: ComputerDriverStatus }>('/api/console/computer-driver/connect', {});

/** An installed driver alone does not mean this computer is connected. */
export function computerDriverIsConnected(status?: Pick<ComputerDriverStatus, 'installed' | 'connected'>): boolean {
  return Boolean(status?.installed && status.connected);
}

/** The one next step the card offers: turn on, connect (an older copy), then ready. */
export function computerDriverNextStep(status: ComputerDriverStatus): 'install' | 'connect' | 'ready' | 'unsupported' {
  if (status.platformSupport === 'unsupported') return 'unsupported';
  if (!status.installed) return 'install';
  if (!status.connected) return 'connect';
  return 'ready';
}

/** A fresh capture of the screen each time it is asked for. */
export function computerScreenUrl(conversationId?: string, nowMs: number = Date.now()): string {
  const query = new URLSearchParams();
  if (conversationId) query.set('session', conversationId);
  query.set('t', String(nowMs));
  return withToken(`/api/console/computer-driver/screen?${query}`);
}
