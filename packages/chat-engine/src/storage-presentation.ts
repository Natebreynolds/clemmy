/** Host storage measurements, shared by desktop and phone. No paths or
 * conversation content cross this presentation boundary. */
import type { StorageCategory, StorageDatabaseStatus } from '../../../src/shared/storage-inventory.js';
export type { StorageCategory, StorageInventory, StorageDatabaseStatus } from '../../../src/shared/storage-inventory.js';
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

/** Logical optimization is not disk reclamation; use the same copy on both
 * surfaces, including against a server that has not run conversion yet. */
export function storageDatabaseSummary(status: StorageDatabaseStatus | undefined): string[] {
  if (!status) return []; // Older daemon response remains compatible.
  if (status.state === 'unavailable') return ['Database space details are unavailable.'];
  if (status.state === 'not_created') return ['No conversation database has been created yet.'];
  const lines = [`Database allocation: ${formatStorageBytes(status.allocatedBytes)}. Of that, ${formatStorageBytes(status.reusableBytes)} is available for Clem to reuse.`,
    'Reusable space is still on disk. It lets Clem store new work without growing the database file.'];
  const conversion = status.historyConversion;
  if (conversion && conversion.convertedHistories > 0) {
    lines.push(`${conversion.convertedHistories.toLocaleString()} history entries optimized, reducing stored payload by ${formatStorageBytes(conversion.netLogicalPayloadBytesRemoved)}. Original context and recovery evidence are preserved.`);
  }
  if (conversion?.state === 'blocked') lines.push('History optimization needs attention. The affected history is preserved; Clem has not skipped it.');
  return lines;
}
