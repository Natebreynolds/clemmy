import { createHash } from 'node:crypto';
import { listEventsAtSequences, getLatestRunAttemptByRunId } from '../../runtime/harness/eventlog.js';
import type { MeetingResearchBoundary, MeetingResearchReference } from './meeting-research.js';

let verify: ((reference: MeetingResearchReference, sourceData: Record<string, unknown>) => MeetingResearchBoundary) | null = null;
/** Installed by the meeting service, never by a request or model. Missing service
 * means a retained research task cannot regain unrestricted execution. */
export function installMeetingResearchBoundary(value: typeof verify): void { verify = value; }

export function meetingResearchSource(sessionId: string, sourceUserSeq?: number) {
  if (!Number.isSafeInteger(sourceUserSeq) || !sourceUserSeq) return null;
  const source = listEventsAtSequences(sessionId, [sourceUserSeq])[0];
  if (!source || source.type !== 'user_input_received') return null;
  return source.data.source === 'meeting_research' ? source : null;
}

/** Reopen consent, capture, selected document revisions and question evidence at
 * every author call. All task text remains in the immutable accepted source. */
export function assertMeetingResearchModelAllowed(sessionId: string, sourceUserSeq?: number): void {
  const source = meetingResearchSource(sessionId, sourceUserSeq);
  if (!source) return;
  if (!verify) throw new Error('Meeting research permission is unavailable.');
  const boundary = verify(source.data.meetingResearchReference as MeetingResearchReference, source.data);
  const text = source.data.text;
  if (boundary.job.privateOriginSessionId !== sessionId
    || source.data.clientRequestId !== boundary.job.clientRequestId
    || !boundary.job.task || boundary.job.task.sourceUserSeq !== sourceUserSeq
    || boundary.job.task.attemptId !== source.data.attemptId || boundary.job.task.runId !== source.data.runId
    || typeof text !== 'string'
    || source.data.meetingResearchInputDigest !== createHash('sha256').update(text).digest('hex')) {
    throw new Error('Meeting research does not match its accepted task.');
  }
  const attempt = getLatestRunAttemptByRunId(sessionId, boundary.job.task.runId);
  const expiresAt = attempt?.leaseExpiresAt ? Date.parse(attempt.leaseExpiresAt) : NaN;
  if (boundary.job.dispatchOwnerPid !== process.pid || !attempt || attempt.attemptId !== boundary.job.task.attemptId
    || attempt.sourceUserSeq !== sourceUserSeq || attempt.finishedAt || attempt.status !== 'active'
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('This private lookup no longer owns its active attempt.');
  }
}

/** First automatic slice is evidence-fed and tool-free. Even a repaired or
 * recovered agent cannot acquire a carrier, connector, shell, write or send. */
export function meetingResearchToolRefusal(sessionId: string, sourceUserSeq?: number): string | undefined {
  return meetingResearchSource(sessionId, sourceUserSeq)
    ? 'This private meeting lookup can answer only from its selected, supplied evidence. Tool execution is not authorized.'
    : undefined;
}
