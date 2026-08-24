/** Dependency-neutral adapter over the existing durable read-receipt events. */
import type { DurableReceiptRecord, ReceiptResolver } from '../../memory/procedure-receipts.js';
import { listEvents } from '../harness/eventlog.js';
import { canonicalVerifiedReadReceipt } from './verified-read-origin-authority.js';

function canonicalLearningReceipt(record: DurableReceiptRecord): DurableReceiptRecord | undefined {
  if (!/^rr_[a-f0-9]{32}$/.test(record.receiptId)) return record;
  const evidenceDigest = /^evt:([a-f0-9]{24})$/.exec(record.readEvidenceRef ?? '')?.[1];
  const source = record.source;
  if (!evidenceDigest || !source) return undefined;
  return canonicalVerifiedReadReceipt({
    origin: {
      version: 1,
      sessionId: source.sessionId,
      sourceUserSeq: source.sourceUserSeq,
      receiptId: record.receiptId,
      evidenceDigest,
    },
    identifier: record.identifier,
    accountIdentity: record.scope?.accountIdentity ?? '',
    schemaFingerprint: record.schemaFingerprint,
  }) ?? undefined;
}

export function eventLogReceiptResolver(sessionId: string): ReceiptResolver {
  return {
    resolve(receiptId: string): DurableReceiptRecord | undefined {
      try {
        for (const event of listEvents(sessionId)) {
          if (event.type !== 'read_receipt') continue;
          const data = event.data as { record?: DurableReceiptRecord } | undefined;
          if (data?.record?.receiptId === receiptId) return canonicalLearningReceipt(data.record);
        }
      } catch { /* fail closed */ }
      return undefined;
    },
  };
}
