/** Dependency-neutral adapter over the existing durable read-receipt events. */
import type { DurableReceiptRecord, ReceiptResolver } from '../../memory/procedure-receipts.js';
import { listEvents } from '../harness/eventlog.js';

export function eventLogReceiptResolver(sessionId: string): ReceiptResolver {
  return {
    resolve(receiptId: string): DurableReceiptRecord | undefined {
      try {
        for (const event of listEvents(sessionId)) {
          if (event.type !== 'read_receipt') continue;
          const data = event.data as { record?: DurableReceiptRecord } | undefined;
          if (data?.record?.receiptId === receiptId) return data.record;
        }
      } catch { /* fail closed */ }
      return undefined;
    },
  };
}
