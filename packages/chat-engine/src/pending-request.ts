import type { ChatMessage } from './types.js';
import { readTaskMode } from './task-mode.js';

export interface PendingMessageStore {
  load(): ChatMessage[];
  save(messages: ChatMessage[]): void;
}

/** Only unacknowledged request bytes live here. Reopening never invents a new
 * request id or changes the mode of an uncertain request. */
export function createPendingMessageStore(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }, key: string): PendingMessageStore {
  return {
    load() {
      try {
        const rows = JSON.parse(storage.getItem(key) ?? '[]') as unknown;
        if (!Array.isArray(rows)) return [];
        return rows.flatMap(value => {
          if (!value || typeof value !== 'object') return [];
          const row = value as ChatMessage;
          const mode = readTaskMode(row.taskMode);
          if (row.role !== 'user' || typeof row.id !== 'string' || typeof row.text !== 'string'
            || typeof row.idempotencyKey !== 'string' || !row.idempotencyKey
            || (row.requestSessionId !== null && typeof row.requestSessionId !== 'string')
            || (row.taskMode !== undefined && !mode)) return [];
          return [{ ...row, taskMode: mode, pending: 'failed' as const,
            pendingError: 'Delivery was not confirmed. Retry sends the exact same request.' }];
        });
      } catch { return []; }
    },
    save(messages) {
      try {
        const pending = messages.filter(message => message.role === 'user' && message.pending && message.idempotencyKey);
        if (pending.length) storage.setItem(key, JSON.stringify(pending));
        else storage.removeItem(key);
      } catch { /* in-memory request identity still survives this page */ }
    },
  };
}
