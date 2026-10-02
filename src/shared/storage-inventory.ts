/** Public metadata only. Storage readers never disclose local paths or data. */
export type StorageCategory = 'conversations' | 'execution' | 'learning' | 'backups' | 'software' | 'files';
export interface StorageInventory {
  measuredAt: string;
  durationMs: number;
  complete: boolean;
  stopReason: 'entry_limit' | 'time_limit' | 'unavailable' | null;
  unreadableEntries: number;
  skippedLinks: number;
  totalBytes: number;
  categories: Array<{ id: StorageCategory; bytes: number; files: number }>;
}
