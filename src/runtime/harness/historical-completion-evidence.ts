/** Historical observations are a separate evidence namespace, never current
 * execution receipts. Only a host-redeemed, still-current packet can settle. */
import { createHash } from 'node:crypto';

export const HISTORICAL_COMPLETION_MAX_CHARS = 6_000;
export interface HistoricalReadConsumer {
  sessionId: string;
  sourceUserSeq: number;
  runAttemptId: string;
  sourceEventId: string;
  sourceEventDigest: string;
  objectiveDigest: string;
  replyDigest: string;
}
export interface HistoricalReadObservation {
  ref: string;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  resultHandleId: string;
  toolName: string;
  argumentDigest: string;
  contentDigest: string;
  rawByteCount: number;
  recordedAt: string;
  contentComplete: true;
  sourceExhausted: true;
  request: unknown;
  content: string;
}
export interface HistoricalReadGroup {
  ref: string;
  source: { sessionId: string; sourceUserSeq: number; eventId: string; eventDigest: string; settlementDigest: string; recordedAt: string; request: string };
  observations: HistoricalReadObservation[];
  /** Original outcomes, not new effect claims. A later read cannot turn an
   * unknown write into success or establish why a directory existed. */
  warnings: Array<{ logicalToolCallId: string; toolName: string; outcome: string; mutating: boolean }>;
}
export interface HistoricalReadPacket {
  version: 1;
  kind: 'historical_observations';
  consumer: HistoricalReadConsumer;
  groups: HistoricalReadGroup[];
}
export interface HistoricalReadClosure {
  version: 1;
  evidenceMode: 'historical_only';
  packetDigest: string;
  consumer: HistoricalReadConsumer;
  groupRef: string;
  source: Omit<HistoricalReadGroup['source'], 'request'>;
  observations: Array<Omit<HistoricalReadObservation, 'request' | 'content'>>;
  warnings: HistoricalReadGroup['warnings'];
}

const admitted = new WeakMap<HistoricalReadPacket, { bytes: string; stillCurrent: () => boolean }>();
export const historicalEvidenceDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The caller redeems all observations first. This private sidecar prevents
 * model JSON, structural clones and subsequently altered packets qualifying. */
export function admitHistoricalReadPacket(packet: HistoricalReadPacket, stillCurrent: () => boolean): HistoricalReadPacket | undefined {
  const bytes = JSON.stringify(packet);
  if (packet.groups.length === 0 || packet.groups.length > 2 || bytes.length > HISTORICAL_COMPLETION_MAX_CHARS) return undefined;
  admitted.set(packet, { bytes, stillCurrent });
  return packet;
}
export function historicalReadPacketIsCurrent(packet: HistoricalReadPacket | undefined, input: {
  sessionId?: string; objective: string; reply: string;
}): packet is HistoricalReadPacket {
  if (!packet) return false;
  try {
    const proof = admitted.get(packet);
    return Boolean(proof && proof.bytes === JSON.stringify(packet)
      && input.sessionId === packet.consumer.sessionId
      && historicalEvidenceDigest(input.objective) === packet.consumer.objectiveDigest
      && historicalEvidenceDigest(input.reply) === packet.consumer.replyDigest
      && proof.stillCurrent());
  } catch { return false; }
}
export function closeHistoricalReadSelection(packet: HistoricalReadPacket, groupRef: string, input: {
  sessionId?: string; objective: string; reply: string;
}): HistoricalReadClosure | undefined {
  if (!historicalReadPacketIsCurrent(packet, input)) return undefined;
  const group = packet.groups.find(candidate => candidate.ref === groupRef);
  if (!group || group.observations.length === 0) return undefined;
  const { request: _request, ...source } = group.source;
  return {
    version: 1, evidenceMode: 'historical_only', packetDigest: historicalEvidenceDigest(JSON.stringify(packet)),
    consumer: { ...packet.consumer }, groupRef, source,
    observations: group.observations.map(({ request: _args, content: _content, ...observation }) => ({ ...observation })),
    warnings: group.warnings.map(warning => ({ ...warning })),
  };
}
export function historicalReadClosureIsCurrent(closure: HistoricalReadClosure | undefined,
  packet: HistoricalReadPacket | undefined, input: { sessionId?: string; objective: string; reply: string }): boolean {
  if (!closure || !packet) return false;
  const current = closeHistoricalReadSelection(packet, closure.groupRef, input);
  return Boolean(current && JSON.stringify(current) === JSON.stringify(closure));
}

/** Durable metadata is closed and versioned. No model-authored fields may be
 * interpreted as host-selected historical proof after reopening. */
export function historicalReadClosureHasShape(value: unknown): value is HistoricalReadClosure {
  const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => Boolean(v && typeof v === 'object'
    && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
    && Object.keys(v).sort().join('\0') === [...keys].sort().join('\0'));
  const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 512 && v.trim() === v;
  const sha = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const seq = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  if (!exact(value, ['version', 'evidenceMode', 'packetDigest', 'consumer', 'groupRef', 'source', 'observations', 'warnings'])
    || value.version !== 1 || value.evidenceMode !== 'historical_only' || !sha(value.packetDigest) || !id(value.groupRef)
    || !exact(value.consumer, ['sessionId', 'sourceUserSeq', 'runAttemptId', 'sourceEventId', 'sourceEventDigest', 'objectiveDigest', 'replyDigest'])
    || !id(value.consumer.sessionId) || !seq(value.consumer.sourceUserSeq) || !id(value.consumer.runAttemptId)
    || !id(value.consumer.sourceEventId) || !sha(value.consumer.sourceEventDigest)
    || !sha(value.consumer.objectiveDigest) || !sha(value.consumer.replyDigest)
    || !exact(value.source, ['sessionId', 'sourceUserSeq', 'eventId', 'eventDigest', 'settlementDigest', 'recordedAt'])
    || !id(value.source.sessionId) || !seq(value.source.sourceUserSeq) || !id(value.source.eventId)
    || !sha(value.source.eventDigest) || !sha(value.source.settlementDigest) || !id(value.source.recordedAt)
    || !Array.isArray(value.observations) || value.observations.length === 0 || !Array.isArray(value.warnings)) return false;
  return value.observations.every(row => exact(row, ['ref', 'acceptedTaskId', 'logicalToolCallId', 'physicalDispatchId',
    'resultHandleId', 'toolName', 'argumentDigest', 'contentDigest', 'rawByteCount', 'recordedAt', 'contentComplete', 'sourceExhausted'])
    && ['ref', 'acceptedTaskId', 'logicalToolCallId', 'physicalDispatchId', 'resultHandleId', 'toolName', 'recordedAt'].every(key => id(row[key]))
    && sha(row.argumentDigest) && sha(row.contentDigest) && seq(row.rawByteCount)
    && row.contentComplete === true && row.sourceExhausted === true)
    && value.warnings.every(row => exact(row, ['logicalToolCallId', 'toolName', 'outcome', 'mutating'])
      && id(row.logicalToolCallId) && id(row.toolName) && id(row.outcome) && typeof row.mutating === 'boolean');
}
