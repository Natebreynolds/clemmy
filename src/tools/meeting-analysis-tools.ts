import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from './shared.js';
import { MEETINGS_DIR } from '../memory/vault.js';
import {
  fileMeetingFromAnalysis,
  loadRecallMeetingAnalysis,
  loadRecallMeetingById,
  patchMeetingRecord,
  saveRecallMeetingAnalysis,
  type RecallMeetingAnalysis,
  type RecallMeetingRecord,
} from '../integrations/recall/meeting-capture.js';
import {
  MEETING_ANALYSIS_CONTENT,
  meetingAnalysisContentDigest,
  meetingAnalysisRequirementSchema,
  meetingAnalysisTranscriptDigest,
  verifyMeetingAnalysisRequirementTranscript,
} from '../integrations/recall/meeting-analysis-contract.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { currentHostCallAttestation } from '../runtime/harness/accepted-turn-call-authority.js';
import { acceptedTaskIdFor, currentLogicalCall } from '../runtime/harness/attempt-identity.js';
import { durableLogicalCallContract } from '../runtime/harness/logical-call-contract.js';
import { getUserInputEventAtSequence, openEventLog } from '../runtime/harness/eventlog.js';
import { hostCallCapabilityBindingMatchesAttestation, loadHostCallCapabilityBinding } from '../runtime/harness/host-call-capability-binding.js';
import { assertDispatchLeaseCurrent, currentDispatchLease } from '../runtime/harness/dispatch-lease.js';

export const MEETING_ANALYSIS_INPUT = z.object({
  meeting_id: z.string().min(1),
  analysis: MEETING_ANALYSIS_CONTENT,
}).strict();

/** Only the host chooses the destination. General file writes must continue
 * to refuse the protected state directory, including meeting analysis. */
export function persistMeetingAnalysis(
  input: unknown,
  completionEvidence?: RecallMeetingAnalysis['completionEvidence'],
): { meetingId: string; meetingNotePath: string; meetingsDirectory: string; noteUpdated: boolean } {
  const { meeting_id: meetingId, analysis } = MEETING_ANALYSIS_INPUT.parse(input);
  const record = loadRecallMeetingById(meetingId);
  if (!record) throw new Error('Meeting not found. No analysis was saved.');
  if (record.status !== 'completed' || !record.artifactPath) {
    throw new Error('Meeting transcript is not finalized. No analysis was saved.');
  }
  const normalized = {
    ...analysis,
    actionItems: analysis.actionItems.map(({ text, owner, dueDate }) => ({
      text,
      ...(owner ? { owner } : {}),
      ...(dueDate ? { dueDate } : {}),
    })),
  };
  const existing = loadRecallMeetingAnalysis(meetingId);
  const { generatedAt: previousGeneratedAt, source: _previousSource,
    completionEvidence: previousEvidence, ...previousContent } = existing ?? {};
  const unchanged = JSON.stringify(previousContent) === JSON.stringify(normalized);
  saveRecallMeetingAnalysis(meetingId, {
    ...normalized,
    generatedAt: unchanged && previousGeneratedAt ? previousGeneratedAt : new Date().toISOString(),
    source: 'agent',
    ...((completionEvidence ?? (unchanged ? previousEvidence : undefined))
      ? { completionEvidence: completionEvidence ?? previousEvidence } : {}),
  });
  // Keep filing recoverable: a retry can re-file already persisted analysis.
  const filed = fileMeetingFromAnalysis(meetingId);
  patchMeetingRecord(meetingId, { analysisError: undefined, analysisUpdatedAt: new Date().toISOString() });
  return { meetingId, meetingNotePath: record.artifactPath, meetingsDirectory: MEETINGS_DIR, noteUpdated: filed };
}

/** This is a receipt check, not a consent bypass. The genuine local work_call
 * envelope still owns schema, argument and effect admission before this body.
 * Background analyzers additionally own one retained meeting/transcript target;
 * another completed meeting or a newer capture cannot satisfy that task. */
async function completionEvidenceForSave(
  input: z.infer<typeof MEETING_ANALYSIS_INPUT>,
  record: RecallMeetingRecord,
): Promise<RecallMeetingAnalysis['completionEvidence']> {
  const context = harnessRunContextStorage.getStore();
  const backgroundSession = context?.sessionId.startsWith('background:') === true;
  let backgroundRequirement: import('../integrations/recall/meeting-analysis-contract.js').MeetingAnalysisRequirement | undefined;
  if (backgroundSession) {
    const taskId = context!.sessionId.slice('background:'.length);
    if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) throw new Error('Meeting analysis task binding is missing. No analysis was saved.');
    const { getBackgroundTask } = await import('../execution/background-tasks.js');
    const task = getBackgroundTask(taskId);
    if (!task || task.runSessionId !== context!.sessionId) {
      throw new Error('Meeting analysis task binding is missing. No analysis was saved.');
    }
    if (task.requiredOutput !== undefined) {
      const parsed = meetingAnalysisRequirementSchema.safeParse(task.requiredOutput);
      if (!parsed.success) throw new Error('Meeting analysis task binding is unreadable. No analysis was saved.');
      backgroundRequirement = parsed.data;
      // The lazy task import can yield. Reopen the transcript after it so an
      // upload/stop transition during that await cannot authorize stale bytes.
      const currentRecord = loadRecallMeetingById(input.meeting_id);
      if (!currentRecord) throw new Error('Meeting not found. No analysis was saved.');
      record = currentRecord;
      if (backgroundRequirement.meetingId !== input.meeting_id
        || !verifyMeetingAnalysisRequirementTranscript(backgroundRequirement, record)) {
        throw new Error('Meeting analysis does not match this task’s finalized transcript. No analysis was saved.');
      }
    }
    if (task.status !== 'running') throw new Error('Meeting analysis task is no longer running. No analysis was saved.');
  }
  const sourceUserSeq = context?.sourceUserSeq;
  const attestation = currentHostCallAttestation();
  const logical = currentLogicalCall();
  const exactSource = context && Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
    ? getUserInputEventAtSequence(context.sessionId, sourceUserSeq!) : undefined;
  const acceptedTaskId = context && sourceUserSeq ? acceptedTaskIdFor(context.sessionId, sourceUserSeq) : undefined;
  const contract = acceptedTaskId ? durableLogicalCallContract(acceptedTaskId, 'meeting_analysis_save', input) : null;
  const durable = context && sourceUserSeq && logical ? loadHostCallCapabilityBinding({ db: openEventLog(),
    sessionId: context.sessionId, sourceUserSeq, logicalToolCallId: logical.logicalToolCallId }) : null;
  const exactHostCall = exactSource && attestation && logical && contract
    && attestation.sessionId === context!.sessionId
    && attestation.sourceUserSeq === sourceUserSeq
    && attestation.sourceEventId === exactSource.id
    && attestation.acceptedTaskId === acceptedTaskId
    && logical.acceptedTaskId === acceptedTaskId
    && attestation.logicalToolCallId === logical.logicalToolCallId
    && attestation.toolName === 'meeting_analysis_save'
    && durable?.status === 'ok'
    && hostCallCapabilityBindingMatchesAttestation(durable.binding, attestation)
    && durable.binding.effectiveArgumentDigest === contract.argumentDigest
    && attestation.effect === 'local_write'
    && attestation.bindingKind === 'local_envelope'
    && Boolean(attestation.schemaFingerprint)
    && Boolean(attestation.bindingDigest);
  if (!exactHostCall) {
    if (backgroundSession) throw new Error('Meeting analysis requires its exact accepted save call. No analysis was saved.');
    // Existing direct/manual callers can save, but cannot mint a completion
    // receipt for an independently owned background task.
    return undefined;
  }
  // Pre-contract jobs retain their save behavior; they cannot attest to a
  // transcript target the host never froze when the job was created.
  if (backgroundSession && !backgroundRequirement) return undefined;
  return {
    version: 1,
    meetingId: record.id,
    transcriptDigest: backgroundRequirement?.transcriptDigest ?? meetingAnalysisTranscriptDigest(record),
    contentDigest: meetingAnalysisContentDigest(input.analysis),
    sessionId: context!.sessionId,
    sourceUserSeq: sourceUserSeq!,
    logicalCallId: logical!.logicalToolCallId,
  };
}

export function registerMeetingAnalysisTools(server: McpServer): void {
  server.tool(
    'meeting_analysis_save',
    'Save structured analysis for an existing finalized meeting and update its meeting note. '
      + 'Use the meeting id and analysis object; the host owns the internal destination. '
      + `Returns the meeting note path in ${MEETINGS_DIR}. Supporting notes and follow-up drafts can be written in that folder with write_file. `
      + 'Use this tool for structured analysis shown in Meetings; it does not schedule work or execute action items.',
    MEETING_ANALYSIS_INPUT.shape,
    async (input) => {
      const parsed = MEETING_ANALYSIS_INPUT.parse(input);
      const record = loadRecallMeetingById(parsed.meeting_id);
      if (!record) throw new Error('Meeting not found. No analysis was saved.');
      const evidence = await completionEvidenceForSave(parsed, record);
      // Completion receipts never revive a dispatch generation cancelled while
      // resolving task ownership. The remaining write is synchronous.
      assertDispatchLeaseCurrent(currentDispatchLease());
      const result = persistMeetingAnalysis(parsed, evidence);
      return textResult(JSON.stringify({ ok: true, ...result }));
    },
  );
}
