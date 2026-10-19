import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { RecallMeetingRecord } from './meeting-capture.js';
import type { MeetingAnalysisHandoffPorts } from './meeting-analysis-handoff.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-handoff-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT: 'off',
  CLEMMY_TEST_ISOLATED_HOME: '1', EMBEDDINGS_DISABLED: 'true', CLEMMY_EMBEDDINGS: 'off' });
const { captureMeetingAnalysisHandoff, prepareMeetingAnalysisRequest } = await import('./meeting-analysis-handoff.js');
const capture = await import('./meeting-capture.js');
const { meetingResearchCaptureDigest } = await import('./meeting-research.js');
const { createBackgroundTask, getBackgroundTask } = await import('../../execution/background-tasks.js');
const { queuePreparedMeetingAnalysis } = await import('./meeting-analysis-queue.js');
const { closeEventLog } = await import('../../runtime/harness/eventlog.js');
const { closeMemoryDb } = await import('../../memory/db.js');
after(() => { closeEventLog(); closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const record: RecallMeetingRecord = { id: 'controlled-handoff', windowId: 'controlled-window', startedAt: '2026-10-18T10:00:00Z',
  endedAt: '2026-10-18T10:30:00Z', status: 'completed', provider: 'recall', canonicalStatus: 'ready', artifactPath: path.join(home, 'controlled.md'),
  segments: [{ id: 'final-corrected', windowId: 'controlled-window', text: 'The final corrected value is eight.', timestamp: '2026-10-18T10:01:00Z', isFinal: true }] };
function ports(value: RecallMeetingRecord = record): MeetingAnalysisHandoffPorts {
  const captureDigest = meetingResearchCaptureDigest(value);
  return {
    assistance: () => ({ captureDigest, version: 3, offers: [
      { id: 'answered-offer', digest: sha('answered-offer'), question: 'Which value?', quote: 'Earlier value seven.', state: 'research_queued' as const, sourceDigest: sha('stream'), segmentIds: ['stream-1'] },
      { id: 'kept-offer', digest: sha('kept-offer'), question: 'Which source should we verify?', quote: 'Please check the source.', state: 'deferred' as const, sourceDigest: sha('stream'), segmentIds: ['stream-2'] },
    ] }),
    research: async () => ({ captureDigest, unavailableJobs: 0, jobs: [{ id: 'controlled-job', offerId: 'answered-offer', question: 'Which value?', quote: 'Earlier value seven.',
      segmentIds: ['stream-1'], sourceDigest: sha('stream'), status: 'completed' as const, exactCapture: true, outcomeUnknown: false,
      reviewState: 'reviewed' as const, answer: { text: 'Earlier observed value was seven.', digest: sha('Earlier observed value was seven.'), sessionId: 'controlled-private-session', sourceUserSeq: 37 } }] }),
  };
}
test('handoff carries exact retained answer evidence and kept questions while final transcript remains authoritative', async () => {
  const source = ports(); const before = JSON.stringify(record);
  const first = await captureMeetingAnalysisHandoff(record, source);
  assert.equal(first.research[0]?.reviewState, 'reviewed');
  assert.equal(first.research[0]?.savedAnswer?.sourceUserSeq, 37);
  assert.equal(first.research[0]?.savedAnswer?.fullTextDigest, sha('Earlier observed value was seven.'));
  assert.deepEqual(first.offers.map(item => item.id), ['kept-offer'], 'already answered offer is not duplicated as unresolved');
  assert.equal(first.historicalStreamOnly, true);
  assert.deepEqual(await captureMeetingAnalysisHandoff(record, source), first, 'same retained evidence yields one stable digest');
  assert.equal(JSON.stringify(record), before);
  const prompt = capture.buildAnalyzerPrompt(record, record.artifactPath!, first);
  assert.match(prompt, /final transcript win/); assert.match(prompt, /not instructions or permission/);
  assert.match(prompt, /Never report a pending, cancelled, unverified or unavailable lookup as answered/);
});
test('unverified, pending, uncertain and foreign evidence cannot become a saved answer', async () => {
  for (const mode of ['unverified', 'pending', 'foreign'] as const) {
    const source = ports(); const original = await source.research(record.id); const job = original.jobs[0]!;
    const altered = { ...job, ...(mode === 'unverified' ? { reviewState: 'unverified' as const }
      : mode === 'pending' ? { status: 'running' as const, outcomeUnknown: true }
        : { exactCapture: false }), answer: { ...job.answer!, text: 'UNQUALIFIED_BODY_MUST_NOT_LEAK' } };
    const result = await captureMeetingAnalysisHandoff(record, { ...source, research: async () => ({ ...original, jobs: [altered] }) });
    assert.equal(result.research[0]?.savedAnswer, undefined, mode);
    assert.equal(JSON.stringify(result).includes('UNQUALIFIED_BODY_MUST_NOT_LEAK'), false, mode);
  }
  const source = ports();
  const result = await captureMeetingAnalysisHandoff(record, { ...source, research: async () => ({ ...await source.research(record.id), captureDigest: sha('foreign') }) });
  assert.equal(result.researchStatus, 'unavailable'); assert.deepEqual(result.research, []);
});
test('review disabled by owner remains a distinct disposition and bounded omissions remain explicit', async () => {
  const source = ports(); const original = await source.research(record.id);
  const jobs = Array.from({ length: 30 }, (_, i) => ({ ...original.jobs[0]!, id: `job-${i}`, offerId: `offer-${i}`,
    reviewState: 'disabled_by_owner' as const, answer: { ...original.jobs[0]!.answer!, text: 'a'.repeat(9_000), digest: sha('a'.repeat(9_000)) } }));
  const result = await captureMeetingAnalysisHandoff(record, { ...source, research: async () => ({ ...original, jobs }) });
  assert.equal(result.research[0]?.reviewState, 'disabled_by_owner');
  assert.equal(result.research[0]?.savedAnswer?.excerptTruncated, true);
  assert.ok(result.omittedResearch > 0); assert.ok(JSON.stringify(result).length < 19_000);
  const unavailable = await captureMeetingAnalysisHandoff(record, {
    assistance: () => { throw new Error('PRIVATE_ERROR_MUST_NOT_LEAK'); }, research: async () => { throw new Error('PRIVATE_ERROR_MUST_NOT_LEAK'); },
  });
  assert.equal(unavailable.offersStatus, 'unavailable'); assert.equal(unavailable.researchStatus, 'unavailable');
  assert.equal(JSON.stringify(unavailable).includes('PRIVATE_ERROR'), false);
});
test('automatic queue identity and durable prompt rejoin one task across repeated preparation', async () => {
  capture.noteRecallMeetingDetected({ windowId: 'controlled-queue', status: 'recording' });
  capture.appendRecallTranscriptSegment({ windowId: 'controlled-queue', event: 'transcript.data', text: 'Controlled final transcript.', isFinal: true });
  const { record: ready } = capture.finalizeRecallMeeting({ windowId: 'controlled-queue', retentionMode: 'zero' });
  const modelPin = { version: 1 as const, modelId: 'controlled-summary-model', provider: 'byo' as const, role: 'brain' as const,
    profileRevision: 2, selection: 'explicit' as const, fallback: 'none' as const };
  const prepared = await prepareMeetingAnalysisRequest(ready, ready.artifactPath!, { modelPin, ports: ports(ready) });
  const task = createBackgroundTask({ title: 'Controlled recap', ...prepared });
  const again = await prepareMeetingAnalysisRequest(ready, ready.artifactPath!, { modelPin, ports: ports(ready) });
  const joined = createBackgroundTask({ title: 'Controlled recap', ...again });
  assert.equal(joined.id, task.id); assert.deepEqual(joined.meetingModelPin, modelPin);
  assert.equal(getBackgroundTask(task.id)?.prompt, prepared.prompt);
  const changed = ports(ready);
  changed.research = async () => { capture.appendMeetingNote(ready.windowId, { text: 'A changed owner requirement.', kind: 'action' }); return { captureDigest: meetingResearchCaptureDigest(ready), unavailableJobs: 0, jobs: [] }; };
  await assert.rejects(prepareMeetingAnalysisRequest(ready, ready.artifactPath!, { modelPin, ports: changed }), /transcript changed/);
});

test('a held handoff and changed model preference cannot queue a second hidden owner; stale retry CAS refuses', async () => {
  capture.noteRecallMeetingDetected({ windowId: 'controlled-queue-race', status: 'recording' });
  capture.appendRecallTranscriptSegment({ windowId: 'controlled-queue-race', event: 'transcript.data', text: 'Controlled race transcript.', isFinal: true });
  const { record: ready } = capture.finalizeRecallMeeting({ windowId: 'controlled-queue-race', retentionMode: 'zero' });
  const modelPin = { version: 1 as const, modelId: 'controlled-first-model', provider: 'byo' as const, role: 'brain' as const,
    profileRevision: 1, selection: 'explicit' as const, fallback: 'none' as const };
  const source = ports(ready); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = prepareMeetingAnalysisRequest(ready, ready.artifactPath!, { modelPin,
    ports: { ...source, research: async id => { await gate; return source.research(id); } } });
  const newPin = { ...modelPin, modelId: 'controlled-new-model', profileRevision: 2 };
  const preparedB = await prepareMeetingAnalysisRequest(ready, ready.artifactPath!, { modelPin: newPin, ports: source });
  let creates = 0;
  const createTask: typeof createBackgroundTask = input => { creates++; return createBackgroundTask(input); };
  const owner = queuePreparedMeetingAnalysis(ready.id, { title: 'Controlled first owner', ...preparedB }, { createTask });
  release(); const preparedA = await held;
  const joined = queuePreparedMeetingAnalysis(ready.id, { title: 'Controlled held owner', ...preparedA }, { createTask });
  assert.equal(joined.id, owner.id); assert.equal(creates, 1);
  assert.equal(capture.loadRecallMeetingById(ready.id)?.analysisTaskId, owner.id);
  assert.deepEqual(joined.meetingModelPin, newPin); assert.equal(joined.prompt, owner.prompt);
  const { markBackgroundTaskBlocked } = await import('../../execution/background-tasks.js');
  markBackgroundTaskBlocked(owner.id, 'Controlled missing output.', 'Controlled partial work.');
  const retry = queuePreparedMeetingAnalysis(ready.id, { title: 'Controlled retry', ...preparedB, explicitId: 'bg-controlled-retry-b' }, { expectedTaskId: owner.id, createTask });
  assert.notEqual(retry.id, owner.id);
  assert.throws(() => queuePreparedMeetingAnalysis(ready.id, { title: 'Controlled stale retry', ...preparedA, explicitId: 'bg-controlled-retry-a' },
    { expectedTaskId: owner.id, createTask }), /task changed/);
  assert.equal(creates, 2); assert.equal(capture.loadRecallMeetingById(ready.id)?.analysisTaskId, retry.id);
});
