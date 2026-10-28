import { apiGet, apiPost } from './api';
import type { InstallJob } from './connect';

export interface ComputerDriverStatus {
  installed: boolean;
  path: string | null;
  daemon: 'running' | 'stopped' | 'unknown';
  statusText: string | null;
  permissions: 'granted' | 'missing' | 'unknown';
  permissionsText: string | null;
  connected: boolean;
  serverName: string;
  installCommand: string;
  docsUrl: string;
  platformSupport: 'supported' | 'preview' | 'unsupported';
}

export const getComputerDriver = () => apiGet<ComputerDriverStatus>('/api/console/computer-driver');
export const installComputerDriver = () => apiPost<{ job: InstallJob }>('/api/console/computer-driver/install', {});
export const getComputerDriverInstallJob = (id: string) => apiGet<{ job: InstallJob }>(`/api/console/computer-driver/install/${encodeURIComponent(id)}`);
export const grantComputerDriverPermissions = () => apiPost<{ output: string; status: ComputerDriverStatus }>('/api/console/computer-driver/permissions', {});
export const connectComputerDriver = () => apiPost<{ status: ComputerDriverStatus }>('/api/console/computer-driver/connect', {});

/** The one next step the card offers, in order: install, permissions, connect, done. */
export function computerDriverNextStep(status: ComputerDriverStatus): 'install' | 'permissions' | 'connect' | 'ready' | 'unsupported' {
  if (status.platformSupport === 'unsupported') return 'unsupported';
  if (!status.installed) return 'install';
  if (status.permissions === 'missing') return 'permissions';
  if (!status.connected) return 'connect';
  return 'ready';
}
