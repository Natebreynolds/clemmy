import { createHash } from 'node:crypto';
import type { RecallMeetingRecord } from './meeting-capture.js';
import { buildAnalyzerPrompt, loadRecallMeetingById } from './meeting-capture.js';
import { captureMeetingAnalysisRequirement, verifyMeetingAnalysisRequirementTranscript } from './meeting-analysis-contract.js';
import { meetingResearchCaptureDigest } from './meeting-research.js';
import { resolveMeetingModelPin, type MeetingModelPin } from './meeting-assistant-policy.js';
import type { readMeetingAssistanceHandoff } from './meeting-assistance.js';
import type { readMeetingResearchHandoff } from './meeting-research-service.js';

const MAX_CHARS = 18_000;
export interface MeetingAnalysisHandoffPorts {
  assistance(id: string): ReturnType<typeof readMeetingAssistanceHandoff>;
  research(id: string): ReturnType<typeof readMeetingResearchHandoff>;
}

/** A bounded historical context snapshot, not permission, a completed-task
 * claim, or a substitute for the finalized transcript. Saved in the existing
 * durable task prompt so restart never rebuilds it from unrelated later work. */
export async function captureMeetingAnalysisHandoff(record: RecallMeetingRecord, ports?: MeetingAnalysisHandoffPorts) {
  const requirement = captureMeetingAnalysisRequirement(record);
  const captureDigest = meetingResearchCaptureDigest(record);
  const loaded = ports ?? {
    assistance: (await import('./meeting-assistance.js')).readMeetingAssistanceHandoff,
    research: (await import('./meeting-research-service.js')).readMeetingResearchHandoff,
  };
  const base = { version: 1 as const, meetingId: record.id, captureDigest,
    transcriptDigest: requirement.transcriptDigest, transcriptCompleteness: requirement.transcriptCompleteness,
    historicalStreamOnly: true as const };
  const offers: { id: string; digest: string; question: string; quote: string; state: string; sourceDigest: string; segmentIds: string[] }[] = [];
  const research: { id: string; offerId: string; question: string; quote: string; status: string;
    sourceDigest: string; segmentIds: string[]; exactCapture: boolean; outcomeUnknown: boolean; reviewState?: string;
    savedAnswer?: { excerpt: string; excerptTruncated: boolean; fullTextDigest: string; sessionId: string; sourceUserSeq: number } }[] = [];
  let offersStatus: 'available' | 'unavailable' = 'available';
  let researchStatus: 'available' | 'unavailable' = 'available';
  let omittedOffers = 0; let omittedResearch = 0;
  const fits = () => JSON.stringify({ ...base, offers, research }).length <= MAX_CHARS;
  try {
    const snapshot = await loaded.research(record.id);
    if (snapshot.captureDigest !== captureDigest) throw new Error('Foreign capture.');
    if (snapshot.unavailableJobs) { omittedResearch += snapshot.unavailableJobs; researchStatus = 'unavailable'; }
    for (const job of snapshot.jobs) {
      if (!job.exactCapture) { omittedResearch++; researchStatus = 'unavailable'; continue; }
      if (research.length >= 8) { omittedResearch++; continue; }
      const row: typeof research[number] = { id: job.id, offerId: job.offerId, question: job.question, quote: job.quote,
        status: job.status, sourceDigest: job.sourceDigest, segmentIds: [...job.segmentIds],
        exactCapture: job.exactCapture, outcomeUnknown: job.outcomeUnknown,
        ...('reviewState' in job ? { reviewState: job.reviewState } : {}) };
      if (job.exactCapture && job.status === 'completed' && !job.outcomeUnknown
        && 'answer' in job && job.answer && job.answer.text.trim()
        && ['reviewed', 'disabled_by_owner', 'not_required'].includes(job.reviewState ?? '')
        && job.answer.digest === createHash('sha256').update(job.answer.text).digest('hex')) row.savedAnswer = {
        excerpt: job.answer.text.slice(0, 3_000), excerptTruncated: job.answer.text.length > 3_000,
        fullTextDigest: job.answer.digest, sessionId: job.answer.sessionId, sourceUserSeq: job.answer.sourceUserSeq };
      research.push(row); if (!fits()) { research.pop(); omittedResearch++; }
    }
  } catch { research.length = 0; researchStatus = 'unavailable'; }
  try {
    const snapshot = loaded.assistance(record.id);
    if (snapshot.captureDigest !== captureDigest) throw new Error('Foreign capture.');
    const answered = new Set(research.filter(job => job.savedAnswer).map(job => job.offerId));
    for (const offer of snapshot.offers) {
      if (answered.has(offer.id)) continue;
      if (offers.length >= 12) { omittedOffers++; continue; }
      offers.push({ id: offer.id, digest: offer.digest, question: offer.question, quote: offer.quote,
        state: offer.state, sourceDigest: offer.sourceDigest, segmentIds: [...offer.segmentIds] });
      if (!fits()) { offers.pop(); omittedOffers++; }
    }
  } catch { offers.length = 0; offersStatus = 'unavailable'; }
  const payload = { ...base, offersStatus, researchStatus, omittedOffers, omittedResearch, offers, research };
  return { ...payload, digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}
export type MeetingAnalysisHandoff = Awaited<ReturnType<typeof captureMeetingAnalysisHandoff>>;

export async function prepareMeetingAnalysisRequest(record: RecallMeetingRecord, artifactPath: string,
  options: { modelPin?: MeetingModelPin; ports?: MeetingAnalysisHandoffPorts } = {}) {
  if (artifactPath !== record.artifactPath) throw new Error('The summary transcript path does not belong to this meeting.');
  const requiredOutput = captureMeetingAnalysisRequirement(record);
  const meetingModelPin = options.modelPin ?? resolveMeetingModelPin(record.id, 'after');
  const handoff = await captureMeetingAnalysisHandoff(record, options.ports);
  const current = loadRecallMeetingById(record.id);
  if (!current || !verifyMeetingAnalysisRequirementTranscript(requiredOutput, current)) throw new Error('The meeting transcript changed before summary preparation.');
  // One automatic owner per exact finalized transcript, even if preferences
  // change between preparation, task persistence and record ownership repair.
  const queueIdentity = createHash('sha256').update(JSON.stringify(requiredOutput)).digest('hex');
  return { explicitId: `bg-meeting-${queueIdentity}`, prompt: buildAnalyzerPrompt(record, artifactPath, handoff), requiredOutput,
    model: meetingModelPin.modelId, meetingModelPin };
}
