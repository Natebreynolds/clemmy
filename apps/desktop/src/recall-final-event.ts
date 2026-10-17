import { createHash, randomUUID } from 'node:crypto';

export interface RecallFinalMetadata {
  participantId?: string;
  sourceStartSeconds?: number;
  sourceEndSeconds?: number;
  sourceEventId?: string;
}

function scalar(value: unknown): string | undefined {
  return (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))
    ? String(value) : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Extract identity facts, never content hashes: repeated words are legitimate
 * utterances unless the SDK also identifies the same utterance or time span. */
export function recallFinalMetadata(data: unknown, eventId?: string): RecallFinalMetadata {
  const root = object(data);
  const body = Object.keys(object(root.data)).length ? object(root.data) : root;
  const participantId = scalar(object(body.participant).id) ?? scalar(object(body.speaker).id);
  const words = Array.isArray(body.words) ? body.words : [];
  const first = object(words[0]);
  const last = object(words[words.length - 1]);
  const start = object(first.start_timestamp).relative;
  const end = object(last.end_timestamp).relative;
  const validSpan = typeof start === 'number' && Number.isFinite(start) && start >= 0
    && typeof end === 'number' && Number.isFinite(end) && end >= start;
  return {
    participantId,
    sourceEventId: eventId ?? scalar(body.event_id) ?? scalar(body.utterance_id),
    ...(validSpan ? { sourceStartSeconds: start, sourceEndSeconds: end } : {}),
  };
}

export function recallFinalEventIdentity(captureId: string, metadata: RecallFinalMetadata): {
  eventId: string;
  eventIdentity: 'sdk' | 'delivery';
} {
  const sdkIdentity = metadata.sourceEventId
    ? ['event', metadata.sourceEventId]
    : metadata.participantId !== undefined && metadata.sourceStartSeconds !== undefined && metadata.sourceEndSeconds !== undefined
      ? ['words', metadata.participantId, metadata.sourceStartSeconds, metadata.sourceEndSeconds]
      : null;
  return {
    eventId: `recall-final-${createHash('sha256').update(JSON.stringify([captureId, sdkIdentity ?? ['delivery', randomUUID()]])).digest('hex')}`,
    eventIdentity: sdkIdentity ? 'sdk' : 'delivery',
  };
}
