/**
 * Private, value-opaque provenance for a learned write capability.
 *
 * This pointer contains only durable authority identities. In particular it
 * can never carry invocation arguments, a destination/target, a template, or
 * an approval. Every consumer must reopen the commit receipt, exact host-call
 * binding, and terminal adjudication before treating the capability as proven.
 */
export interface VerifiedWriteCapabilityOrigin {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  receiptId: string;
  hostBindingDigest: string;
  terminalEventId: string;
}

const ORIGIN_KEYS = new Set([
  'acceptedTaskId',
  'hostBindingDigest',
  'logicalToolCallId',
  'receiptId',
  'sessionId',
  'sourceUserSeq',
  'terminalEventId',
  'version',
]);

function exactIdentity(value: unknown, max = 512): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Strict v1 parser. Unknown fields abstain rather than silently acquiring
 * replay semantics in a later release. */
export function parseVerifiedWriteCapabilityOrigin(
  value: unknown,
): VerifiedWriteCapabilityOrigin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== ORIGIN_KEYS.size || keys.some((key) => !ORIGIN_KEYS.has(key))) return null;
  if (
    record.version !== 1
    || !exactIdentity(record.sessionId)
    || !Number.isSafeInteger(record.sourceUserSeq)
    || Number(record.sourceUserSeq) <= 0
    || record.acceptedTaskId !== `task:${record.sessionId}#${record.sourceUserSeq}`
    || !exactIdentity(record.logicalToolCallId)
    || typeof record.receiptId !== 'string'
    || !/^write-evidence:v1:[a-f0-9]{64}$/u.test(record.receiptId)
    || typeof record.hostBindingDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(record.hostBindingDigest)
    || !exactIdentity(record.terminalEventId)
  ) return null;
  return {
    version: 1,
    sessionId: record.sessionId as string,
    sourceUserSeq: Number(record.sourceUserSeq),
    acceptedTaskId: record.acceptedTaskId as string,
    logicalToolCallId: record.logicalToolCallId as string,
    receiptId: record.receiptId,
    hostBindingDigest: record.hostBindingDigest,
    terminalEventId: record.terminalEventId as string,
  };
}
