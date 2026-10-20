/** Pure retained consent identity codec; decoding never mints consent. */
import { createHash } from 'node:crypto';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';

export interface HostInteractiveConsentSubjectV1 {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  decisionSubjectDigest: string;
  callDigest: string;
  coverageDigest: string;
  riskDigest: string;
}

const CONSENT_SUBJECT_KEYS = new Set([
  'version', 'sessionId', 'sourceUserSeq', 'acceptedTaskId', 'logicalToolCallId',
  'decisionSubjectDigest', 'callDigest', 'coverageDigest', 'riskDigest',
]);

export function parseHostInteractiveConsentSubjectV1(
  value: unknown,
): HostInteractiveConsentSubjectV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const subject = value as Record<string, unknown>;
  const keys = Object.keys(subject);
  if (keys.length !== CONSENT_SUBJECT_KEYS.size || keys.some((key) => !CONSENT_SUBJECT_KEYS.has(key))) {
    return null;
  }
  const digestFields = [
    subject.decisionSubjectDigest,
    subject.callDigest,
    subject.coverageDigest,
    subject.riskDigest,
  ];
  if (
    subject.version !== 1
    || typeof subject.sessionId !== 'string'
    || !subject.sessionId.trim()
    || typeof subject.sourceUserSeq !== 'number'
    || !Number.isSafeInteger(subject.sourceUserSeq)
    || subject.sourceUserSeq <= 0
    || typeof subject.acceptedTaskId !== 'string'
    || !subject.acceptedTaskId.trim()
    || typeof subject.logicalToolCallId !== 'string'
    || !subject.logicalToolCallId.trim()
    || !digestFields.every((entry) => typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry))
  ) return null;
  return subject as unknown as HostInteractiveConsentSubjectV1;
}

export function hostInteractiveConsentApprovalResumeKey(
  value: HostInteractiveConsentSubjectV1,
): string | null {
  const subject = parseHostInteractiveConsentSubjectV1(value);
  return subject ? `host-consent:v1:${createHash('sha256').update(closedCanonicalJson(subject), 'utf8').digest('hex')}` : null;
}
