/** Host storage measurements, shared by desktop and phone. No paths or
 * conversation content cross this presentation boundary. */
import type { StorageCategory } from '../../../src/shared/storage-inventory.js';
export type { StorageCategory, StorageInventory } from '../../../src/shared/storage-inventory.js';
export const STORAGE_COPY: Record<StorageCategory, { label: string; note: string }> = {
  conversations: { label: 'Conversations & run records', note: 'Chat history, approvals, receipts and recovery checkpoints.' },
  execution: { label: 'Execution snapshots', note: 'Encrypted evidence used to review work and recover context.' },
  learning: { label: 'Memory & learned tools', note: 'Facts, tool knowledge and strategies Clem has learned.' },
  backups: { label: 'Backups', note: 'Saved rollback copies kept separately from current data.' },
  software: { label: 'Runtime & tool caches', note: 'Installed runtime files and downloaded tool dependencies.' },
  files: { label: 'Attachments & other files', note: 'Meeting files, attachments, logs and other app data.' },
};
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1_000;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) { value /= 1_000; unit += 1; }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}
