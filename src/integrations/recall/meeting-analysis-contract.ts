import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  analysisPathFor,
  loadRecallMeetingAnalysis,
  loadRecallMeetingById,
  meetingArtifactMatchesAnalysis,
  type RecallMeetingRecord,
} from './meeting-capture.js';

export const MEETING_ANALYSIS_CONTENT = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  decisions: z.array(z.string()),
  actionItems: z.array(z.object({
    text: z.string().min(1),
    owner: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
  }).strict()),
  topics: z.array(z.string()),
  participants: z.array(z.string()),
}).strict();

export const meetingAnalysisRequirementSchema = z.object({
  version: z.literal(1),
  kind: z.literal('meeting_analysis'),
  meetingId: z.string().min(1),
  transcriptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  transcriptCompleteness: z.enum(['complete', 'partial']),
}).strict();

/** Host-owned expected output. The model cannot change a job's destination or
 * substitute a separate note for the exact canonical meeting record. */
export type MeetingAnalysisRequirement = z.infer<typeof meetingAnalysisRequirementSchema>;

export function meetingAnalysisTranscriptDigest(record: RecallMeetingRecord): string {
  // Filing analysis rewrites the Markdown note and may refine its title. Hash
  // the capture's retained source instead, including its completeness and notes.
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    id: record.id,
    windowId: record.windowId,
    provider: record.provider ?? 'recall',
    sdkUploadId: record.sdkUploadId ?? null,
    recordingId: record.recordingId ?? null,
    startedAt: record.startedAt,
    recordingStartedAt: record.recordingStartedAt ?? null,
    endedAt: record.endedAt ?? null,
    status: record.status,
    canonicalStatus: record.canonicalStatus ?? null,
    transcriptionStatus: record.transcriptionStatus ?? null,
    liveTranscriptDelivery: record.liveTranscriptDelivery ?? null,
    segments: record.segments,
    notes: record.notes ?? [],
  })).digest('hex');
}

export function captureMeetingAnalysisRequirement(record: RecallMeetingRecord): MeetingAnalysisRequirement {
  if (record.status !== 'completed' || !record.artifactPath) {
    throw new Error('Meeting transcript is not finalized. Summary preparation was not queued.');
  }
  const complete = record.provider === 'local'
    ? record.transcriptionStatus === 'ready'
    : record.canonicalStatus === 'ready'
      || (record.recallRetentionMode === 'zero'
        && !record.liveTranscriptDelivery && record.segments.length > 0);
  return {
    version: 1,
    kind: 'meeting_analysis',
    meetingId: record.id,
    transcriptDigest: meetingAnalysisTranscriptDigest(record),
    transcriptCompleteness: complete ? 'complete' : 'partial',
  };
}

export function verifyMeetingAnalysisRequirementTranscript(
  requirement: MeetingAnalysisRequirement,
  record: RecallMeetingRecord,
): boolean {
  return record.status === 'completed' && Boolean(record.artifactPath)
    && record.id === requirement.meetingId
    && meetingAnalysisTranscriptDigest(record) === requirement.transcriptDigest;
}

export function meetingAnalysisContentDigest(input: unknown): string {
  const analysis = MEETING_ANALYSIS_CONTENT.parse(input);
  // The typed save normalizes absent/null owner and dueDate identically.
  const normalized = { ...analysis, actionItems: analysis.actionItems.map(({ text, owner, dueDate }) => ({
    text, ...(owner ? { owner } : {}), ...(dueDate ? { dueDate } : {}),
  })) };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export type MeetingAnalysisOutputProof =
  | { ok: true; transcriptCompleteness: 'complete' | 'partial' }
  | { ok: false; reason: string };

/** Deterministic completion floor. A successful model response, another file,
 * or an old summary never redeems this host-owned required output. */
export function verifyMeetingAnalysisOutput(input: {
  requiredOutput: unknown;
  runSessionId: string;
  sourceExists: (sessionId: string, sourceUserSeq: number) => boolean;
}): MeetingAnalysisOutputProof {
  const parsed = meetingAnalysisRequirementSchema.safeParse(input.requiredOutput);
  if (!parsed.success) return { ok: false, reason: 'The meeting summary requirement could not be read. No completed summary was confirmed.' };
  const requirement = parsed.data;
  try {
    const record = loadRecallMeetingById(requirement.meetingId);
    if (!record || !verifyMeetingAnalysisRequirementTranscript(requirement, record)) {
      return { ok: false, reason: 'The meeting transcript changed or is unavailable. Prepare a fresh summary from this meeting’s current transcript.' };
    }
    if (!record.analysisPath || path.resolve(record.analysisPath) !== path.resolve(analysisPathFor(record.id))) {
      return { ok: false, reason: 'The summary has not been saved back to this meeting. Partial work is kept; summary preparation can be retried.' };
    }
    const saved = loadRecallMeetingAnalysis(record.id);
    if (!saved) return { ok: false, reason: 'The saved meeting summary could not be read. Partial work is kept.' };
    const { generatedAt, source, completionEvidence, ...content } = saved;
    if (!MEETING_ANALYSIS_CONTENT.safeParse(content).success || !generatedAt || source !== 'agent') {
      return { ok: false, reason: 'The saved meeting summary is incomplete. Partial work is kept; summary preparation can be retried.' };
    }
    if (!completionEvidence || completionEvidence.version !== 1
      || completionEvidence.meetingId !== requirement.meetingId
      || completionEvidence.transcriptDigest !== requirement.transcriptDigest
      || completionEvidence.contentDigest !== meetingAnalysisContentDigest(content)
      || completionEvidence.sessionId !== input.runSessionId
      || !Number.isSafeInteger(completionEvidence.sourceUserSeq) || completionEvidence.sourceUserSeq <= 0
      || !input.sourceExists(completionEvidence.sessionId, completionEvidence.sourceUserSeq)) {
      return { ok: false, reason: 'This task has not confirmed a saved summary for the exact meeting transcript. Partial work is kept; summary preparation can be retried.' };
    }
    if (!meetingArtifactMatchesAnalysis(record, saved)) {
      return { ok: false, reason: 'The summary was saved, but its meeting note has not been updated and verified. Partial work is kept.' };
    }
    return { ok: true, transcriptCompleteness: requirement.transcriptCompleteness };
  } catch {
    return { ok: false, reason: 'The saved meeting summary could not be verified. Partial work is kept; summary preparation can be retried.' };
  }
}
