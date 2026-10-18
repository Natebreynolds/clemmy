import { api, apiGet } from './api';

export const MEETING_DOCUMENT_TEXT_LIMIT = 32_000;
export const MEETING_DOCUMENT_TITLE_LIMIT = 200;
export const MEETING_DOCUMENT_COUNT_LIMIT = 8;

export interface MeetingResearchDocument {
  id: string;
  revision: number;
  digest: string;
  title: string;
  charCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface MeetingResearchDocuments {
  meetingId: string;
  captureDigest: string;
  snapshotVersion: number;
  documents: MeetingResearchDocument[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
const refreshError = () => new Error('Meeting research couldn’t refresh. Reopen this meeting and try again.');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Missing or unfamiliar state is unavailable, never implicit permission. */
export function parseMeetingResearchDocuments(value: unknown, meetingId: string): MeetingResearchDocuments {
  const raw = record(value);
  if (!raw || raw.meetingId !== meetingId || !digest(raw.captureDigest)
    || !nonnegativeInteger(raw.snapshotVersion) || !Array.isArray(raw.documents)
    || raw.documents.length > MEETING_DOCUMENT_COUNT_LIMIT) throw refreshError();
  const ids = new Set<string>();
  const documents = raw.documents.map(value => {
    const doc = record(value);
    if (!doc || !boundedText(doc.id, 200) || ids.has(doc.id) || !nonnegativeInteger(doc.revision)
      || doc.revision < 1 || !digest(doc.digest) || !boundedText(doc.title, MEETING_DOCUMENT_TITLE_LIMIT)
      || !nonnegativeInteger(doc.charCount) || doc.charCount > MEETING_DOCUMENT_TEXT_LIMIT
      || !timestamp(doc.createdAt) || !timestamp(doc.updatedAt)) throw refreshError();
    ids.add(doc.id);
    return { id: doc.id, revision: doc.revision, digest: doc.digest, title: doc.title,
      charCount: doc.charCount, createdAt: doc.createdAt, updatedAt: doc.updatedAt };
  });
  return { meetingId, captureDigest: raw.captureDigest, snapshotVersion: raw.snapshotVersion, documents };
}

export interface MeetingResearchDocumentRef { id: string; revision: number; digest: string }
export interface MeetingResearchJob {
  id: string;
  question: string;
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'cancelled';
  task?: { sessionId: string; sourceUserSeq: number; attemptId: string; runId: string; clientRequestId: string };
  reason?: string;
  outcomeUnknown?: boolean;
  reviewState?: 'reviewed' | 'disabled_by_owner' | 'not_required' | 'unverified';
  answer?: { text: string; sessionId: string; sourceUserSeq: number };
}
export interface MeetingResearchState {
  meetingId: string;
  version: number;
  enabled: boolean;
  useMemory: boolean;
  maxLookups: number;
  usedLookups: number;
  status: 'disabled' | 'ready' | 'running' | 'exhausted' | 'unavailable';
  reason?: string;
  documentRefs: MeetingResearchDocumentRef[];
  expiresAt?: number;
  jobs: MeetingResearchJob[];
}
export type MeetingResearchSettings = Pick<MeetingResearchState, 'enabled' | 'useMemory' | 'maxLookups' | 'documentRefs'> & { expectedVersion: number };

function parseReference(value: unknown): MeetingResearchDocumentRef {
  const ref = record(value);
  if (!ref || !boundedText(ref.id, 200) || !nonnegativeInteger(ref.revision) || ref.revision < 1 || !digest(ref.digest)) throw refreshError();
  return { id: ref.id, revision: ref.revision, digest: ref.digest };
}
export function parseMeetingResearchState(value: unknown, meetingId: string): MeetingResearchState {
  const raw = record(value);
  const statuses = ['disabled', 'ready', 'running', 'exhausted', 'unavailable'];
  if (!raw || raw.meetingId !== meetingId || !nonnegativeInteger(raw.version) || typeof raw.enabled !== 'boolean'
    || typeof raw.useMemory !== 'boolean' || !nonnegativeInteger(raw.maxLookups) || raw.maxLookups < 1 || raw.maxLookups > 8
    || !nonnegativeInteger(raw.usedLookups) || !statuses.includes(String(raw.status))
    || !Array.isArray(raw.documentRefs) || raw.documentRefs.length > MEETING_DOCUMENT_COUNT_LIMIT
    || !Array.isArray(raw.jobs) || raw.jobs.length > 128
    || (raw.expiresAt !== undefined && !nonnegativeInteger(raw.expiresAt))
    || (raw.reason !== undefined && !boundedText(raw.reason, 200))) throw refreshError();
  const refs = raw.documentRefs.map(parseReference);
  if (new Set(refs.map(ref => ref.id)).size !== refs.length) throw refreshError();
  const ids = new Set<string>();
  const jobs = raw.jobs.map(value => {
    const job = record(value);
    if (!job || !boundedText(job.id, 200) || ids.has(job.id) || !boundedText(job.question, 500)
      || !['queued', 'running', 'completed', 'blocked', 'cancelled'].includes(String(job.status))
      || (job.reason !== undefined && !boundedText(job.reason, 200))
      || (job.outcomeUnknown !== undefined && typeof job.outcomeUnknown !== 'boolean')) throw refreshError();
    ids.add(job.id);
    let task: MeetingResearchJob['task'];
    if (job.task !== undefined) {
      const accepted = record(job.task);
      if (!accepted || !boundedText(accepted.sessionId, 200) || !nonnegativeInteger(accepted.sourceUserSeq) || accepted.sourceUserSeq < 1
        || !boundedText(accepted.attemptId, 200) || !boundedText(accepted.runId, 200) || !boundedText(accepted.clientRequestId, 200)) throw refreshError();
      task = { sessionId: accepted.sessionId, sourceUserSeq: accepted.sourceUserSeq, attemptId: accepted.attemptId,
        runId: accepted.runId, clientRequestId: accepted.clientRequestId };
    }
    let answer: MeetingResearchJob['answer'];
    if (job.answer !== undefined) {
      const saved = record(job.answer);
      if (!saved || !task || job.status !== 'completed' || !boundedText(saved.text, 64_000)
        || saved.sessionId !== task.sessionId || saved.sourceUserSeq !== task.sourceUserSeq) throw refreshError();
      answer = { text: saved.text, sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq };
    }
    return { id: job.id, question: job.question, status: job.status as MeetingResearchJob['status'],
      ...(task ? { task } : {}), ...(job.reason ? { reason: job.reason as string } : {}),
      ...(answer ? { answer } : {}),
      ...(job.outcomeUnknown !== undefined ? { outcomeUnknown: job.outcomeUnknown as boolean } : {}),
      ...(job.reviewState !== undefined ? { reviewState: ['reviewed', 'disabled_by_owner', 'not_required'].includes(String(job.reviewState))
        ? job.reviewState as MeetingResearchJob['reviewState'] : 'unverified' as const } : {}) };
  });
  return { meetingId, version: raw.version, enabled: raw.enabled, useMemory: raw.useMemory,
    maxLookups: raw.maxLookups, usedLookups: raw.usedLookups, status: raw.status as MeetingResearchState['status'], documentRefs: refs, jobs,
    ...(raw.reason ? { reason: raw.reason as string } : {}), ...(raw.expiresAt !== undefined ? { expiresAt: raw.expiresAt as number } : {}) };
}

export function meetingResearchNotice(state: Pick<MeetingResearchState, 'status' | 'reason'>): string {
  if (state.reason === 'meeting_not_recording') return 'This meeting has ended. Your private lookups are kept below.';
  if (state.reason === 'documents_changed' || state.reason === 'document_selection_changed') return 'Meeting context changed. Choose the current notes and save permission again.';
  if (state.reason === 'permission_expired') return 'Research permission expired. Save it again to continue during this meeting.';
  switch (state.status) {
    case 'disabled': return 'Automatic research is off. You can still choose individual lookups above.';
    case 'ready': return 'Clem can research useful questions privately as they come up.';
    case 'running': return 'Researching a meeting question privately…';
    case 'exhausted': return 'This meeting’s research limit is reached. Your lookups are kept below.';
    case 'unavailable': return 'Research is paused. Refresh to check its permission and sources.';
  }
}
export function meetingResearchJobLabel(job: Pick<MeetingResearchJob, 'status' | 'outcomeUnknown'>): string {
  if (job.outcomeUnknown) return 'Needs checking';
  switch (job.status) {
    case 'queued': return 'Queued';
    case 'running': return 'Researching';
    case 'completed': return 'Answer ready';
    case 'blocked': return 'Needs attention';
    case 'cancelled': return 'Stopped';
  }
}
export function meetingResearchReviewNotice(job: Pick<MeetingResearchJob, 'status' | 'task' | 'reviewState'>): string | undefined {
  if (job.status !== 'completed' || !job.task) return undefined;
  switch (job.reviewState) {
    case 'reviewed': return 'Reviewed';
    case 'disabled_by_owner': return 'Review was off for this answer.';
    case 'not_required': return 'Separate review wasn’t required for this answer.';
    default: return 'The answer is available, but review couldn’t confirm it.';
  }
}
export function meetingResearchRefsCurrent(refs: readonly MeetingResearchDocumentRef[], documents: readonly MeetingResearchDocument[]): boolean {
  return refs.every(ref => documents.some(doc => doc.id === ref.id && doc.revision === ref.revision && doc.digest === ref.digest));
}

const endpoint = (id: string) => `/api/console/meetings/${encodeURIComponent(id)}`;
export async function getMeetingResearch(meetingId: string): Promise<MeetingResearchState> {
  return parseMeetingResearchState(await apiGet<unknown>(`${endpoint(meetingId)}/research`), meetingId);
}
export async function setMeetingResearch(meetingId: string, settings: MeetingResearchSettings): Promise<MeetingResearchState> {
  return parseMeetingResearchState(await api<unknown>(`${endpoint(meetingId)}/research`, {
    method: 'PATCH', body: JSON.stringify(settings),
  }), meetingId);
}
/** Stop has no view-version dependency: a concurrent reservation must never
 * prevent the owner from withdrawing this meeting's research permission. */
export async function stopMeetingResearch(meetingId: string): Promise<MeetingResearchState> {
  return parseMeetingResearchState(await api<unknown>(`${endpoint(meetingId)}/research/stop`, {
    method: 'POST', body: '{}',
  }), meetingId);
}
export async function getMeetingResearchDocuments(meetingId: string): Promise<MeetingResearchDocuments> {
  return parseMeetingResearchDocuments(await apiGet<unknown>(`${endpoint(meetingId)}/documents`), meetingId);
}
export async function addMeetingResearchDocument(meetingId: string, snapshot: MeetingResearchDocuments, title: string, text: string): Promise<MeetingResearchDocuments> {
  return parseMeetingResearchDocuments(await api<unknown>(`${endpoint(meetingId)}/documents`, {
    method: 'POST', body: JSON.stringify({ expectedVersion: snapshot.snapshotVersion,
      captureDigest: snapshot.captureDigest, title, text }),
  }), meetingId);
}
export async function removeMeetingResearchDocument(meetingId: string, snapshot: MeetingResearchDocuments, document: MeetingResearchDocument): Promise<MeetingResearchDocuments> {
  return parseMeetingResearchDocuments(await api<unknown>(`${endpoint(meetingId)}/documents/${encodeURIComponent(document.id)}`, {
    method: 'DELETE', body: JSON.stringify({ expectedVersion: snapshot.snapshotVersion,
      captureDigest: snapshot.captureDigest, revision: document.revision }),
  }), meetingId);
}
