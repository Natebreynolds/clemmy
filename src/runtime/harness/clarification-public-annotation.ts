/** A bounded host display annotation, never a question answer or execution grant.
 * Durable callers separately verify the exact source, parent and reading event. */
import { createHash } from 'node:crypto';

export const MAX_CLARIFICATION_REFERENCE_CHARS = 4_000;
export const CLARIFICATION_UNAVAILABLE_NOTICE = 'Your reply is recorded. I couldn’t verify how it changes the pending question, so this task is still paused. Please add any details you haven’t supplied yet, or ask me to check the recorded question and replies.\n\nEarlier question and choices — reference only. Your latest reply may already answer or change parts of them:\n';
export const MAX_CLARIFICATION_PUBLIC_CHARS = CLARIFICATION_UNAVAILABLE_NOTICE.length + MAX_CLARIFICATION_REFERENCE_CHARS;

export interface ClarificationUnavailableAnnotationV1 {
  readonly version: 1;
  readonly kind: 'clarification_reading_unavailable';
  readonly sessionId: string;
  readonly sourceUserSeq: number;
  readonly parentPacketId: string;
  readonly readingEventId: string;
  readonly referenceSha256: string;
}
const KEYS = ['version', 'kind', 'sessionId', 'sourceUserSeq', 'parentPacketId', 'readingEventId', 'referenceSha256'];
export function clarificationReferenceDigest(question: string, options: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ question, options })).digest('hex');
}
export function renderClarificationUnavailable(question: string): string {
  if (!question.trim() || question.length > MAX_CLARIFICATION_REFERENCE_CHARS) throw new Error('Clarification reference exceeds its existing bound.');
  return CLARIFICATION_UNAVAILABLE_NOTICE + question;
}
export function validateClarificationUnavailableAnnotation(
  value: unknown,
  identity: { sessionId: string; sourceUserSeq: number; parentPacketId: string },
  question: string,
  options: readonly string[],
): ClarificationUnavailableAnnotationV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== KEYS.length || Object.keys(row).some(key => !KEYS.includes(key))
    || row.version !== 1 || row.kind !== 'clarification_reading_unavailable'
    || typeof row.sessionId !== 'string' || !row.sessionId || row.sessionId.length > 512
    || !Number.isSafeInteger(row.sourceUserSeq) || Number(row.sourceUserSeq) <= 0
    || typeof row.parentPacketId !== 'string' || !row.parentPacketId || row.parentPacketId.length > 128
    || typeof row.readingEventId !== 'string' || !row.readingEventId || row.readingEventId.length > 128
    || row.sessionId !== identity.sessionId || row.sourceUserSeq !== identity.sourceUserSeq
    || row.parentPacketId !== identity.parentPacketId
    || typeof question !== 'string' || !question.trim() || question.length > MAX_CLARIFICATION_REFERENCE_CHARS
    || !Array.isArray(options) || options.length > 8
    || options.some(option => typeof option !== 'string' || !option.trim() || option.length > 500)
    || row.referenceSha256 !== clarificationReferenceDigest(question, options)) return null;
  return Object.freeze({ ...row }) as unknown as ClarificationUnavailableAnnotationV1;
}
