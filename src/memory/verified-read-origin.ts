/**
 * Private provenance carried by a capability learned from one verified read.
 * It is a pointer only: every consumer must re-resolve the durable learning
 * receipt and exact public completion before trusting historical bytes.
 */
export interface VerifiedReadCapabilityOrigin {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  receiptId: string;
  evidenceDigest: string;
}

const ORIGIN_KEYS = new Set([
  'evidenceDigest',
  'receiptId',
  'sessionId',
  'sourceUserSeq',
  'version',
]);

/** Strictly parse the bounded v1 pointer. Unknown fields or legacy guesses
 * abstain so provenance cannot silently acquire new meaning. */
export function parseVerifiedReadCapabilityOrigin(
  value: unknown,
): VerifiedReadCapabilityOrigin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== ORIGIN_KEYS.size || keys.some((key) => !ORIGIN_KEYS.has(key))) return null;
  if (record.version !== 1
    || typeof record.sessionId !== 'string'
    || record.sessionId.trim() !== record.sessionId
    || record.sessionId.length < 1
    || record.sessionId.length > 512
    || !Number.isSafeInteger(record.sourceUserSeq)
    || Number(record.sourceUserSeq) <= 0
    || typeof record.receiptId !== 'string'
    || !/^rr_[a-f0-9]{32}$/.test(record.receiptId)
    || typeof record.evidenceDigest !== 'string'
    || !/^[a-f0-9]{24}$/.test(record.evidenceDigest)) return null;
  return {
    version: 1,
    sessionId: record.sessionId,
    sourceUserSeq: Number(record.sourceUserSeq),
    receiptId: record.receiptId,
    evidenceDigest: record.evidenceDigest,
  };
}
