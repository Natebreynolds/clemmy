import { createHash } from 'node:crypto';
import path from 'node:path';
import { createBackgroundTask, getBackgroundTask } from '../../execution/background-tasks.js';
import { getUserInputEventAtSequence } from '../../runtime/harness/eventlog.js';
import { captureMeetingAnalysisRequirement, MEETING_ANALYSIS_CONTENT, meetingAnalysisRequirementSchema, verifyMeetingAnalysisOutput } from './meeting-analysis-contract.js';
import { analysisPathFor, buildAnalyzerPrompt, loadRecallMeetingAnalysis, loadRecallMeetingById, meetingArtifactMatchesAnalysis, patchMeetingRecord, type RecallMeetingRecord } from './meeting-capture.js';

export interface MeetingAnalysisState {
  status: 'off' | 'queued' | 'running' | 'complete' | 'failed' | 'incomplete' | 'unavailable';
  taskId?: string;
  partialTranscript?: boolean;
}

/** Passive projection: a task terminal never substitutes for meeting output. */
export function projectMeetingAnalysisState(record: RecallMeetingRecord, enabled: boolean): MeetingAnalysisState {
  const identity = record.analysisTaskId ? { taskId: record.analysisTaskId } : {};
  try {
    const task = record.analysisTaskId ? getBackgroundTask(record.analysisTaskId) : null;
    if (record.analysisTaskId && !task) return { status: 'unavailable', ...identity };
    if (task && task.runSessionId !== `background:${record.analysisTaskId}`) return { status: 'unavailable', ...identity };
    if (task && Object.prototype.hasOwnProperty.call(task, 'requiredOutput')) {
      const requirement = meetingAnalysisRequirementSchema.safeParse(task.requiredOutput);
      if (!requirement.success || requirement.data.meetingId !== record.id) return { status: 'unavailable', ...identity };
      const proof = verifyMeetingAnalysisOutput({
        requiredOutput: task.requiredOutput,
        runSessionId: task.runSessionId,
        sourceExists: (sessionId, seq) => Boolean(getUserInputEventAtSequence(sessionId, seq)),
      });
      if (proof.ok) return { status: 'complete', ...identity, ...(proof.transcriptCompleteness === 'partial' ? { partialTranscript: true } : {}) };
    } else {
      const saved = loadRecallMeetingAnalysis(record.id);
      if (saved) {
        const { generatedAt: _generatedAt, source: _source, completionEvidence: _evidence, ...content } = saved;
        if (MEETING_ANALYSIS_CONTENT.safeParse(content).success && record.analysisPath
          && path.resolve(record.analysisPath) === path.resolve(analysisPathFor(record.id))
          && meetingArtifactMatchesAnalysis(record, saved)) return { status: 'complete', ...identity };
      }
    }
    if (task?.status === 'pending') return { status: 'queued', ...identity };
    if (task?.status === 'running' || task?.status === 'cancelling') return { status: 'running', ...identity };
    if (task?.status === 'failed' || task?.status === 'aborted' || record.analysisError) return { status: 'failed', ...identity };
    if (task) return { status: 'incomplete', ...identity };
    if (record.analysisTaskId) return { status: 'unavailable', ...identity };
    return { status: enabled && record.status === 'completed' && Boolean(record.artifactPath) ? 'unavailable' : 'off' };
  } catch { return { status: 'unavailable', ...identity }; }
}

/** Explicit owner retry only. Replays rejoin one prepared task; an active or
 * parked worker retains its ownership instead of gaining a duplicate. */
export function requestMeetingAnalysisRetry(meetingId: string, expectedTaskId: string | null): { taskId: string } {
  const record = loadRecallMeetingById(meetingId);
  if (!record || (record.analysisTaskId ?? null) !== expectedTaskId) {
    throw new Error('This meeting changed. Refresh it before preparing the summary again.');
  }
  const prior = record.analysisTaskId ? getBackgroundTask(record.analysisTaskId) : null;
  if (record.analysisTaskId && !prior) throw new Error('The previous summary task could not be read. Refresh its status before trying again.');
  if (prior && (prior.id !== record.analysisTaskId || prior.runSessionId !== `background:${prior.id}`)) {
    throw new Error('The summary task does not belong to this meeting. Refresh its status before trying again.');
  }
  if (prior && Object.prototype.hasOwnProperty.call(prior, 'requiredOutput')) {
    const bound = meetingAnalysisRequirementSchema.safeParse(prior.requiredOutput);
    if (!bound.success || bound.data.meetingId !== meetingId) {
      throw new Error('The summary task does not belong to this meeting. Refresh its status before trying again.');
    }
  }
  if (prior && !['done', 'failed', 'blocked', 'aborted'].includes(prior.status)) return { taskId: prior.id };
  const requiredOutput = captureMeetingAnalysisRequirement(record);
  const key = createHash('sha256').update(JSON.stringify({ meetingId, prior: expectedTaskId, requiredOutput })).digest('hex');
  const task = createBackgroundTask({
    explicitId: `bg-meeting-${key}`,
    title: `Prepare meeting summary: ${record.title || record.platform || record.id}`,
    prompt: buildAnalyzerPrompt(record, record.artifactPath!),
    requiredOutput,
    source: 'daemon', channel: 'electron:meeting-capture', maxMinutes: 30,
  });
  patchMeetingRecord(record.id, { analysisTaskId: task.id, analysisError: undefined, analysisUpdatedAt: new Date().toISOString() });
  return { taskId: task.id };
}
