import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-summary-output-'));
process.env.CLEMENTINE_HOME = home;
const capture = await import('./meeting-capture.js');
const contract = await import('./meeting-analysis-contract.js');
const tasks = await import('../../execution/background-tasks.js');
const status = await import('./meeting-analysis-status.js');
const events = await import('../../runtime/harness/eventlog.js');
const { persistMeetingAnalysis } = await import('../../tools/meeting-analysis-tools.js');
const { closeMemoryDb } = await import('../../memory/db.js');
after(() => { events.closeEventLog(); closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });

const content = { title: 'Controlled meeting summary', summary: 'The fixture team agreed to review a draft.',
  decisions: ['Review the draft'], actionItems: [{ text: 'Review draft', owner: null, dueDate: null }],
  topics: ['Draft'], participants: ['Fixture speaker'] };
const modelPin = { version: 1 as const, modelId: 'controlled-summary-model', provider: 'byo' as const,
  role: 'brain' as const, profileRevision: 2, selection: 'explicit' as const, fallback: 'none' as const };
let number = 0;
function fixture() {
  const windowId = `summary-output-${++number}`;
  capture.noteRecallMeetingDetected({ windowId, status: 'recording' });
  capture.appendRecallTranscriptSegment({ windowId, event: 'transcript.data', text: 'Review the draft.', isFinal: true });
  const { record } = capture.finalizeRecallMeeting({ windowId, retentionMode: 'zero' });
  const requiredOutput = contract.captureMeetingAnalysisRequirement(record);
  const task = tasks.createBackgroundTask({ title: 'Controlled summary', prompt: 'Save structured analysis for this fixture.', requiredOutput, meetingModelPin: modelPin });
  events.createSession({ id: task.runSessionId, kind: 'execution', channel: 'electron:meeting-capture' });
  const source = events.appendEvent({ sessionId: task.runSessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: task.prompt } });
  capture.patchMeetingRecord(record.id, { analysisTaskId: task.id });
  return { record, requiredOutput, task, source };
}
function checker(f: ReturnType<typeof fixture>) {
  return contract.verifyMeetingAnalysisOutput({ requiredOutput: f.requiredOutput, runSessionId: f.task.runSessionId,
    sourceExists: (sessionId, seq) => Boolean(events.getUserInputEventAtSequence(sessionId, seq)) });
}
/** A checker unit fixture only: genuine host dispatch is exercised separately
 * by meeting-analysis-authority.test.ts, never inferred from this seeded proof. */
function saveCheckerFixture(f: ReturnType<typeof fixture>) {
  return persistMeetingAnalysis({ meeting_id: f.record.id, analysis: content }, {
    version: 1, meetingId: f.record.id, transcriptDigest: f.requiredOutput.transcriptDigest,
    contentDigest: contract.meetingAnalysisContentDigest(content), sessionId: f.task.runSessionId, sourceUserSeq: f.source.seq,
  });
}

test('separate file and successful prose cannot satisfy a missing canonical meeting output', async () => {
  const f = fixture();
  const separate = path.join(home, 'separate-summary.md');
  writeFileSync(separate, 'A plausible summary is kept here.');
  assert.equal(checker(f).ok, false);
  assert.equal((await tasks.verifyBackgroundTaskDelivery(f.task, `Done. Saved ${separate}`)).outcome, 'blocked');
  assert.equal(tasks.markBackgroundTaskDone(f.task.id, `Done. Saved ${separate}`)?.status, 'blocked');
  assert.equal(status.projectMeetingAnalysisState(capture.loadRecallMeetingById(f.record.id)!, true).status, 'incomplete');
});

test('canonical schema, exact source, record link and filed bytes redeem the output idempotently', async () => {
  const f = fixture(); saveCheckerFixture(f);
  assert.equal(checker(f).ok, true);
  const before = readFileSync(capture.analysisPathFor(f.record.id), 'utf8');
  assert.equal(saveCheckerFixture(f).noteUpdated, false);
  assert.equal(readFileSync(capture.analysisPathFor(f.record.id), 'utf8'), before);
  assert.equal(checker(f).ok, true, 'filing the summary must not alter the source transcript identity');
  assert.equal((await tasks.verifyBackgroundTaskDelivery(f.task, 'The summary is saved.')).outcome, 'done');
  assert.equal(tasks.markBackgroundTaskDone(f.task.id, 'The summary is saved.')?.status, 'done');
  assert.equal(status.projectMeetingAnalysisState(capture.loadRecallMeetingById(f.record.id)!, true).status, 'complete');
});

test('stale transcript, foreign source, malformed analysis, broken record link and note drift fail closed', () => {
  const f = fixture(); saveCheckerFixture(f);
  const canonicalPath = capture.analysisPathFor(f.record.id);
  const valid = JSON.parse(readFileSync(canonicalPath, 'utf8'));
  for (const broken of [
    { ...valid, completionEvidence: { ...valid.completionEvidence, sessionId: 'background:foreign' } },
    { ...valid, completionEvidence: { ...valid.completionEvidence, sourceUserSeq: f.source.seq + 1000000 } },
    { ...valid, summary: '' },
    { ...valid, summary: 'Changed after the save receipt' },
  ]) { writeFileSync(canonicalPath, JSON.stringify(broken)); assert.equal(checker(f).ok, false); }
  writeFileSync(canonicalPath, JSON.stringify(valid));
  capture.patchMeetingRecord(f.record.id, { analysisPath: path.join(home, 'another.json') });
  assert.equal(checker(f).ok, false);
  capture.patchMeetingRecord(f.record.id, { analysisPath: canonicalPath });
  writeFileSync(f.record.artifactPath!, 'A different note.'); assert.equal(checker(f).ok, false);
  capture.fileMeetingFromAnalysis(f.record.id); assert.equal(checker(f).ok, true);
  assert.ok(capture.appendMeetingNote(f.record.windowId, { text: 'A new owner requirement.', kind: 'action' }));
  assert.equal(checker(f).ok, false);
});

test('required output is immutable and malformed retained output never falls back to generic success', async () => {
  const f = fixture();
  assert.throws(() => tasks.updateBackgroundTask(f.task.id, { requiredOutput: { ...f.requiredOutput, meetingId: 'foreign' } }), /cannot be changed/);
  assert.throws(() => tasks.updateBackgroundTask(f.task.id, { meetingModelPin: { ...modelPin, modelId: 'different-model' } }), /cannot be changed/);
  assert.throws(() => tasks.createBackgroundTask({ title: 'Unbound pin', prompt: 'Controlled only.', meetingModelPin: modelPin }), /exact meeting/);
  assert.throws(() => tasks.createBackgroundTask({ title: 'Wrong role', prompt: 'Controlled only.', requiredOutput: f.requiredOutput,
    meetingModelPin: { ...modelPin, role: 'quick' } }), /exact meeting/);
  const taskPath = path.join(home, 'state', 'background-tasks', `${f.task.id}.json`);
  const retained = JSON.parse(readFileSync(taskPath, 'utf8')); retained.requiredOutput = null;
  writeFileSync(taskPath, JSON.stringify(retained));
  const corrupted = tasks.getBackgroundTask(f.task.id)!;
  assert.equal((await tasks.verifyBackgroundTaskDelivery(corrupted, 'Done.')).outcome, 'blocked');
  assert.equal(tasks.markBackgroundTaskDone(f.task.id, 'Done.')?.status, 'blocked');
  assert.equal(status.projectMeetingAnalysisState(capture.loadRecallMeetingById(f.record.id)!, true).status, 'unavailable');
  const legacy = tasks.createBackgroundTask({ title: 'Legacy task', prompt: 'Return an answer.' });
  assert.equal(tasks.markBackgroundTaskDone(legacy.id, 'An answer is ready.')?.status, 'done');
});

test('explicit summary retry binds the current transcript and reuses active ownership', async () => {
  const f = fixture();
  assert.equal((await status.requestMeetingAnalysisRetry(f.record.id, f.task.id)).taskId, f.task.id);
  tasks.markBackgroundTaskBlocked(f.task.id, 'Canonical save was not confirmed.', 'Partial summary work is kept.');
  const retried = await status.requestMeetingAnalysisRetry(f.record.id, f.task.id);
  assert.notEqual(retried.taskId, f.task.id);
  const current = tasks.getBackgroundTask(retried.taskId)!;
  assert.deepEqual(current.requiredOutput, f.requiredOutput);
  assert.deepEqual(current.meetingModelPin, modelPin);
  assert.equal(current.prompt, f.task.prompt, 'the same accepted transcript retains its original handoff and chosen model');
  assert.equal((await status.requestMeetingAnalysisRetry(f.record.id, current.id)).taskId, current.id);
  await assert.rejects(status.requestMeetingAnalysisRetry(f.record.id, f.task.id), /changed/);
  assert.equal(capture.loadRecallMeetingById(f.record.id)?.analysisTaskId, current.id);
});

test('explicit current-model recovery makes a fresh pinned attempt without changing or bypassing the previous owner', async () => {
  const settings = { AUTH_MODE: 'api_key', MODEL_ROUTING_MODE: 'all_in', BYO_MODEL_BASE_URL: 'http://127.0.0.1:9',
    BYO_MODEL_API_KEY: 'controlled-unused', BYO_MODEL_ID: 'deepseek-chat', BYO_PROVIDERS: '[]', CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT: 'off' };
  const previous = new Map(Object.keys(settings).map(key => [key, process.env[key]])); Object.assign(process.env, settings);
  try {
    const f = fixture();
    assert.equal((await status.requestMeetingAnalysisRetry(f.record.id, f.task.id, { useCurrentModel: true })).taskId, f.task.id,
      'a current-model request cannot replace an active task');
    const policy = await import('./meeting-assistant-policy.js'); const saved = policy.loadMeetingAssistantPolicy();
    const changed = policy.saveMeetingAssistantPolicy({ expectedRevision: saved.revision,
      before: saved.before, during: saved.during, after: { modelId: null } });
    tasks.markBackgroundTaskBlocked(f.task.id, 'Controlled retired model.', 'Controlled prior work.');
    const oldPath = path.join(home, 'state', 'background-tasks', `${f.task.id}.json`); const oldBytes = readFileSync(oldPath, 'utf8');
    const replacement = await status.requestMeetingAnalysisRetry(f.record.id, f.task.id, { useCurrentModel: true });
    const fresh = tasks.getBackgroundTask(replacement.taskId)!;
    assert.notEqual(fresh.id, f.task.id); assert.equal(fresh.model, 'deepseek-chat');
    assert.equal(fresh.meetingModelPin?.profileRevision, changed.revision);
    assert.equal(fresh.meetingModelPin?.selection, 'inherited');
    assert.match(fresh.prompt, /Historical live assistance handoff/); assert.notEqual(fresh.prompt, f.task.prompt);
    assert.equal(readFileSync(oldPath, 'utf8'), oldBytes, 'retired task, original choice and source remain untouched');
    const identity = { meetingId: f.record.id, prior: f.task.id, requiredOutput: f.requiredOutput,
      mode: 'current_meeting_model', meetingModelPin: fresh.meetingModelPin };
    const { createHash } = await import('node:crypto');
    assert.equal(fresh.id, `bg-meeting-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`);
    assert.equal((await status.requestMeetingAnalysisRetry(f.record.id, fresh.id, { useCurrentModel: true })).taskId, fresh.id);
    await assert.rejects(status.requestMeetingAnalysisRetry(f.record.id, f.task.id, { useCurrentModel: true }), /changed/);
    tasks.markBackgroundTaskBlocked(fresh.id, 'Controlled pause.', 'Controlled saved work.');
    const ordinary = tasks.getBackgroundTask((await status.requestMeetingAnalysisRetry(f.record.id, fresh.id, { useCurrentModel: false })).taskId)!;
    assert.deepEqual(ordinary.meetingModelPin, fresh.meetingModelPin); assert.equal(ordinary.prompt, fresh.prompt);
  } finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('analysis progress follows its exact task and partial transcript remains explicit', () => {
  const f = fixture();
  assert.equal(status.projectMeetingAnalysisState(capture.loadRecallMeetingById(f.record.id)!, true).status, 'queued');
  tasks.markBackgroundTaskRunning(f.task.id);
  assert.equal(status.projectMeetingAnalysisState(capture.loadRecallMeetingById(f.record.id)!, true).status, 'running');
  tasks.markBackgroundTaskFailed(f.task.id, 'Controlled failure.');
  assert.equal(status.projectMeetingAnalysisState(capture.loadRecallMeetingById(f.record.id)!, true).status, 'failed');
  const partial = { ...f.record, recallRetentionMode: 'timed' as const, canonicalStatus: 'failed' as const };
  assert.equal(contract.captureMeetingAnalysisRequirement(partial).transcriptCompleteness, 'partial');
  assert.equal(contract.meetingAnalysisRequirementSchema.safeParse({ ...f.requiredOutput, extra: true }).success, false);
});

test('missing or corrupt task ownership cannot promote a retained summary to complete or mint a retry', async () => {
  const f = fixture(); saveCheckerFixture(f);
  const taskPath = path.join(home, 'state', 'background-tasks', `${f.task.id}.json`);
  const bytes = readFileSync(taskPath, 'utf8');
  for (const corrupt of [true, false]) {
    if (corrupt) writeFileSync(taskPath, '{'); else unlinkSync(taskPath);
    assert.equal(status.projectMeetingAnalysisState(capture.loadRecallMeetingById(f.record.id)!, true).status, 'unavailable');
    await assert.rejects(status.requestMeetingAnalysisRetry(f.record.id, f.task.id), /could not be read/);
    writeFileSync(taskPath, bytes);
  }
  assert.equal(status.projectMeetingAnalysisState(capture.loadRecallMeetingById(f.record.id)!, true).status, 'complete');
});

test('retry never adopts an active task with a foreign or malformed meeting contract', async () => {
  const f = fixture(); const foreign = fixture();
  capture.patchMeetingRecord(f.record.id, { analysisTaskId: foreign.task.id });
  await assert.rejects(status.requestMeetingAnalysisRetry(f.record.id, foreign.task.id), /does not belong/);
  const taskPath = path.join(home, 'state', 'background-tasks', `${foreign.task.id}.json`);
  const retained = JSON.parse(readFileSync(taskPath, 'utf8')); retained.requiredOutput = null;
  writeFileSync(taskPath, JSON.stringify(retained));
  await assert.rejects(status.requestMeetingAnalysisRetry(f.record.id, foreign.task.id), /does not belong/);
  assert.equal(tasks.getBackgroundTask(f.task.id)?.status, 'pending');
});
