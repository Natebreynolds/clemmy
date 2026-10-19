import { createHash } from 'node:crypto';
import { completeViaConfiguredBrain, type ConfiguredBrainSemanticComplete } from '../../runtime/semantic-boundary/configured-brain-semantic-port.js';
import { createStandaloneModelAccountingJob, standaloneModelAccountingJobBinding, withStandaloneModelAccountingJob } from '../../runtime/usage-log.js';
import { recordStandaloneModelAccountingJobObservation } from '../../runtime/harness/model-transport-observation.js';
import { registerMeetingAssistanceScanPort, type MeetingAssistanceScanPort } from './meeting-assistance.js';
import { MEETING_OPPORTUNITY_SYSTEM, MeetingOpportunityV1Schema } from './meeting-opportunity.js';
import { resolveMeetingModelPin, type MeetingModelPin } from './meeting-assistant-policy.js';

/** One tool-less Quick call per admitted transcript window. Suggesting a
 * lookup cannot read memory, call a tool, approve an effect, or answer it. */
export function createMeetingAssistanceScanPort(
  complete: ConfiguredBrainSemanticComplete = completeViaConfiguredBrain,
  resolvePin: (meetingId: string) => MeetingModelPin = id => resolveMeetingModelPin(id, 'live'),
): MeetingAssistanceScanPort {
  return async (input) => {
    input.signal.throwIfAborted();
    const meetingModelPin = resolvePin(input.meetingId);
    const job = createStandaloneModelAccountingJob({ operation: 'meeting_opportunity',
      operationId: `meeting:${createHash('sha256').update(input.meetingId).digest('hex').slice(0, 40)}`,
      revisionDigest: input.sourceDigest });
    const binding = standaloneModelAccountingJobBinding(job);
    recordStandaloneModelAccountingJobObservation(job, { phase: 'job_started' });
    try {
      const result = await withStandaloneModelAccountingJob(job, () => complete({
        purpose: 'meeting_opportunity', system: MEETING_OPPORTUNITY_SYSTEM,
        user: JSON.stringify({ segments: input.segments, recentOffers: input.recentOffers }),
        schemaName: 'MeetingOpportunityV1', signal: input.signal, deadlineAt: Date.now() + 15_000,
        meetingModelPin,
      }));
      input.signal.throwIfAborted();
      const parsed = MeetingOpportunityV1Schema.parse(result.raw);
      recordStandaloneModelAccountingJobObservation(job, { phase: 'job_finished', outcome: 'returned' });
      return { candidate: parsed.candidate, modelIdentity: result.modelIdentity,
        modelPin: meetingModelPin,
        ...(binding ? { modelAccountingJobId: binding.usageJobId } : {}) };
    } catch (error) {
      recordStandaloneModelAccountingJobObservation(job, { phase: 'job_finished', outcome: 'failed' });
      throw error;
    }
  };
}

export function installMeetingAssistanceModel(): void {
  registerMeetingAssistanceScanPort(createMeetingAssistanceScanPort());
}
