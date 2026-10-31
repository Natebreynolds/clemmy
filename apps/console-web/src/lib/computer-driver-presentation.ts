import type { ComputerDriverStatus } from './computer-driver';

export interface ComputerDriverPresentation {
  label: string;
  tone: 'success' | 'warning' | 'neutral';
  detail: string;
}

/** A single summary of the recorded connection, without treating installation
 * or registration alone as proof that Clem can use the screen. */
export function computerDriverPresentation(status?: ComputerDriverStatus, unavailable = false): ComputerDriverPresentation {
  if (unavailable) return {
    label: 'Status unavailable', tone: 'warning',
    detail: 'Computer access couldn’t be checked. Refresh its status before changing setup.',
  };
  if (!status) return {
    label: 'Checking…', tone: 'neutral',
    detail: 'Checking whether Clem can work in apps on this computer.',
  };
  if (status.platformSupport === 'unsupported') return {
    label: 'Unavailable here', tone: 'neutral',
    detail: 'Computer control isn’t supported on this platform yet.',
  };
  if (!status.installed) return {
    label: 'Not set up', tone: 'neutral',
    detail: 'Let Clem work in apps on this computer when you ask. Your approval rules still apply.',
  };
  if (status.daemon === 'stopped') return {
    label: 'Stopped', tone: 'warning',
    detail: 'Clem’s computer connection is stopped. Check its connection details below.',
  };
  if (status.permissions === 'missing') return {
    label: 'Permission needed', tone: 'warning',
    detail: 'Computer access still needs your permission before Clem can see and use your screen.',
  };
  if (!status.connected) return {
    label: 'Not connected', tone: 'neutral',
    detail: 'Connect this computer so Clem can work in its apps.',
  };
  if (status.daemon !== 'running') return {
    label: 'Status unknown', tone: 'neutral',
    detail: 'The computer connection is saved, but its running state hasn’t been confirmed.',
  };
  if (status.permissions !== 'granted') return {
    label: 'Permissions unknown', tone: 'neutral',
    detail: 'The computer connection is running, but screen access hasn’t been confirmed.',
  };
  return {
    label: 'Connected', tone: 'success',
    detail: 'Ask Clem to work in an app on this computer. Your approval rules still apply.',
  };
}
