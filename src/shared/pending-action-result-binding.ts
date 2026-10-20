/** Bounded metadata shape only. This is not review, execution or presentation
 * authority; readers must verify the exact action, registry and canonical B. */
export interface PendingActionResultBinding {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  pendingActionId: string;
  approvalId: string;
  payloadHash: string;
  recordUpdatedAt: string;
  recordStatus: 'executed' | 'failed' | 'executing' | 'rejected' | 'expired' | 'cancelled';
  resultSummaryDigest: string;
}
const KEYS = ['version', 'sessionId', 'sourceUserSeq', 'pendingActionId', 'approvalId', 'payloadHash', 'recordUpdatedAt', 'recordStatus', 'resultSummaryDigest'];
export function normalizePendingActionResultBinding(value: unknown): PendingActionResultBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(raw, key))
    || raw.version !== 1 || !Number.isSafeInteger(raw.sourceUserSeq) || Number(raw.sourceUserSeq) < 1
    || typeof raw.sessionId !== 'string' || !/^[A-Za-z0-9:._-]{1,256}$/.test(raw.sessionId)
    || typeof raw.pendingActionId !== 'string' || !/^pa-[A-Za-z0-9_-]{1,128}$/.test(raw.pendingActionId)
    || typeof raw.approvalId !== 'string' || !/^apr-[a-z0-9]{4}$/i.test(raw.approvalId)
    || typeof raw.payloadHash !== 'string' || !/^[a-f0-9]{16}$/.test(raw.payloadHash)
    || typeof raw.resultSummaryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.resultSummaryDigest)
    || typeof raw.recordUpdatedAt !== 'string' || !Number.isFinite(Date.parse(raw.recordUpdatedAt))
    || new Date(raw.recordUpdatedAt).toISOString() !== raw.recordUpdatedAt
    || typeof raw.recordStatus !== 'string'
    || !['executed', 'failed', 'executing', 'rejected', 'expired', 'cancelled'].includes(raw.recordStatus)) return null;
  return { ...raw } as unknown as PendingActionResultBinding;
}
