/** Public metadata only. Storage readers never disclose local paths or data. */
export type StorageCategory = 'conversations' | 'execution' | 'learning' | 'backups' | 'software' | 'files';
export type StorageDatabaseStatus = { state: 'unavailable' } | { state: 'not_created' } | {
  state: 'measured';
  allocatedBytes: number;
  reusableBytes: number;
  historyConversion: null | {
    state: 'not_started' | 'partial' | 'caught_up' | 'blocked';
    scannedRows: number;
    convertedHistories: number;
    netLogicalPayloadBytesRemoved: number;
  };
};
export interface StorageInventory {
  measuredAt: string;
  durationMs: number;
  complete: boolean;
  stopReason: 'entry_limit' | 'time_limit' | 'unavailable' | null;
  unreadableEntries: number;
  skippedLinks: number;
  totalBytes: number;
  categories: Array<{ id: StorageCategory; bytes: number; files: number }>;
  /** Separate SQLite metadata. It is not added to the file-size total twice. */
  database?: StorageDatabaseStatus;
}
