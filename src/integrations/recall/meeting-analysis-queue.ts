import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { createBackgroundTask, getBackgroundTask, type CreateBackgroundTaskInput } from '../../execution/background-tasks.js';
import { withFileLockSyncStrict } from '../../runtime/atomic-json.js';
import { loadRecallMeetingById, patchMeetingRecord } from './meeting-capture.js';
import { meetingAnalysisRequirementSchema, verifyMeetingAnalysisRequirementTranscript } from './meeting-analysis-contract.js';
import { MeetingModelPinSchema } from './meeting-assistant-policy.js';

/** Preparation can await evidence. Ownership cannot: every producer claims and
 * publishes its exact task under this shared synchronous cross-process lock. */
export function queuePreparedMeetingAnalysis(meetingId: string, input: CreateBackgroundTaskInput,
  options: { expectedTaskId?: string | null; createTask?: typeof createBackgroundTask } = {}) {
  const required = meetingAnalysisRequirementSchema.parse(input.requiredOutput);
  if (required.meetingId !== meetingId) throw new Error('The summary belongs to a different meeting.');
  const directory = path.join(BASE_DIR, 'state', 'meeting-capture', 'analysis-queue');
  mkdirSync(directory, { recursive: true });
  const key = createHash('sha256').update(meetingId).digest('hex');
  return withFileLockSyncStrict(path.join(directory, key), () => {
    const record = loadRecallMeetingById(meetingId);
    if (!record || !verifyMeetingAnalysisRequirementTranscript(required, record)) throw new Error('The meeting transcript changed before summary preparation.');
    const currentId = record.analysisTaskId ?? null;
    const current = currentId ? getBackgroundTask(currentId) : null;
    const currentRequired = meetingAnalysisRequirementSchema.safeParse(current?.requiredOutput);
    if (currentId && (!current || current.runSessionId !== `background:${currentId}`
      || !currentRequired.success || currentRequired.data.meetingId !== meetingId)) throw new Error('The previous summary owner could not be verified.');
    if (current && Object.prototype.hasOwnProperty.call(current, 'meetingModelPin')) {
      const pin = MeetingModelPinSchema.safeParse(current.meetingModelPin);
      if (!pin.success || pin.data.role !== 'brain' || current.model !== pin.data.modelId) throw new Error('The previous summary model could not be verified.');
    }
    if (Object.prototype.hasOwnProperty.call(options, 'expectedTaskId')) {
      if (currentId !== options.expectedTaskId) {
        // A concurrent identical explicit retry rejoins its one durable task.
        if (current && current.id === input.explicitId && currentRequired.success
          && currentRequired.data.transcriptDigest === required.transcriptDigest) return current;
        throw new Error('The summary task changed before retry.');
      }
      if (current && !['done', 'failed', 'blocked', 'aborted'].includes(current.status)) return current;
    } else if (current) {
      if (!currentRequired.success || currentRequired.data.transcriptDigest !== required.transcriptDigest) throw new Error('Another transcript already owns this summary.');
      return current;
    }
    const task = (options.createTask ?? createBackgroundTask)(input);
    const savedRequired = meetingAnalysisRequirementSchema.safeParse(task.requiredOutput);
    if (!savedRequired.success || savedRequired.data.meetingId !== meetingId
      || savedRequired.data.transcriptDigest !== required.transcriptDigest || task.runSessionId !== `background:${task.id}`) {
      throw new Error('The saved summary task does not belong to this transcript.');
    }
    if (!patchMeetingRecord(meetingId, { analysisTaskId: task.id, analysisError: undefined, analysisUpdatedAt: new Date().toISOString() })) {
      throw new Error('The saved summary task needs ownership recovery.');
    }
    return task;
  }, { timeoutMs: 0 });
}
