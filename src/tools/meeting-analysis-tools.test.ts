import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-save-'));
process.env.CLEMENTINE_HOME = home;
const { persistMeetingAnalysis, registerMeetingAnalysisTools } = await import('./meeting-analysis-tools.js');
const {
  appendRecallTranscriptSegment, finalizeRecallMeeting, loadRecallMeetingAnalysis,
  loadRecallMeetingById, noteRecallMeetingDetected, analysisPathFor, buildAnalyzerPrompt,
} = await import('../integrations/recall/meeting-capture.js');
const { closeMemoryDb } = await import('../memory/db.js');
const { captureMeetingAnalysisRequirement } = await import('../integrations/recall/meeting-analysis-contract.js');
const { createBackgroundTask, markBackgroundTaskRunning, cancelBackgroundTask } = await import('../execution/background-tasks.js');
const { patchMeetingRecord } = await import('../integrations/recall/meeting-capture.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('../runtime/harness/brackets.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const leases = await import('../runtime/harness/dispatch-lease.js');
after(() => { closeMemoryDb(); eventlog.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

const analysis = {
  title: 'Fixture launch discussion', summary: 'The team discussed the launch.',
  decisions: ['Check the preview.'], actionItems: [{ text: 'Check the preview', owner: null, dueDate: null }],
  topics: ['Launch'], participants: ['Fixture Speaker'],
};

function finalized(windowId: string) {
  noteRecallMeetingDetected({ windowId, platform: 'zoom', title: 'Launch planning', status: 'recording' });
  appendRecallTranscriptSegment({ windowId, event: 'transcript.data', speaker: 'Fixture Speaker', text: 'We should check the preview before launch.', isFinal: true });
  return finalizeRecallMeeting({ windowId });
}

function registeredHandler() {
  let handler: ((input: unknown) => Promise<unknown>) | undefined;
  registerMeetingAnalysisTools({ tool(_name: string, _description: string, _shape: unknown, callback: typeof handler) {
    handler = callback;
  } } as never);
  assert.ok(handler);
  return handler;
}

test('registered analysis tool persists canonical analysis and files the existing meeting without arbitrary file writes', async () => {
  const { record, artifactPath } = finalized('save-check');
  let handler: ((input: unknown) => Promise<unknown>) | undefined;
  registerMeetingAnalysisTools({ tool(name: string, _description: string, _shape: unknown, callback: typeof handler) {
    assert.equal(name, 'meeting_analysis_save'); handler = callback;
  } } as never);
  assert.ok(handler);
  const response = await handler({ meeting_id: record.id, analysis }) as { content: Array<{ text: string }> };
  const receipt = JSON.parse(response.content[0]!.text);
  assert.equal(receipt.meetingNotePath, artifactPath);
  assert.equal(receipt.meetingsDirectory, path.join(home, 'vault', '04-Meetings'));
  assert.equal(receipt.path, undefined, 'receipt directs the model to the usable note, not internal state');
  const saved = loadRecallMeetingAnalysis(record.id);
  assert.equal(saved?.summary, analysis.summary);
  assert.equal(saved?.source, 'agent');
  assert.deepEqual(saved?.actionItems, [{ text: 'Check the preview' }]);
  assert.equal(loadRecallMeetingById(record.id)?.analysisPath, analysisPathFor(record.id));
  assert.ok(artifactPath);
  assert.match(readFileSync(artifactPath, 'utf8'), /The team discussed the launch/);
  assert.match(readFileSync(artifactPath, 'utf8'), /We should check the preview before launch/);
  const firstBytes = readFileSync(analysisPathFor(record.id), 'utf8');
  persistMeetingAnalysis({ meeting_id: record.id, analysis });
  assert.equal(readFileSync(analysisPathFor(record.id), 'utf8'), firstBytes, 'exact retry preserves analysis identity');
});

test('unknown ids, unfinished meetings and malformed payloads cannot write analysis', () => {
  assert.throws(() => persistMeetingAnalysis({ meeting_id: '../missing', analysis }), /Meeting not found/);
  const record = noteRecallMeetingDetected({ windowId: 'unfinished-fixture', status: 'recording' });
  assert.throws(() => persistMeetingAnalysis({ meeting_id: record.id, analysis }), /not finalized/);
  assert.equal(existsSync(analysisPathFor(record.id)), false);
  const completed = finalized('invalid-check').record;
  assert.throws(() => persistMeetingAnalysis({ meeting_id: completed.id, analysis, path: path.join(home, 'state', 'authorization.json') }));
  assert.throws(() => persistMeetingAnalysis({ meeting_id: completed.id, analysis: { ...analysis, actionItems: 'execute this' } }));
  assert.equal(existsSync(analysisPathFor(completed.id)), false);
});

test('Recall and local analyzer prompts use the typed save operation, not the protected-file path', () => {
  const { record, artifactPath } = finalized('prompt-check');
  for (const provider of ['recall', 'local'] as const) {
    const prompt = buildAnalyzerPrompt({ ...record, provider }, artifactPath!);
    assert.match(prompt, /meeting_analysis_save/);
    assert.match(prompt, new RegExp(record.id));
    assert.doesNotMatch(prompt, /via write_file|\.analysis\.json/);
  }
});

test('ordinary file tool can save supporting notes in Meetings while internal state remains protected', async () => {
  const { executeLocalFileWrite } = await import('./computer-tools.js');
  const notePath = path.join(home, 'vault', '04-Meetings', 'follow-up-draft.md');
  await executeLocalFileWrite({ path: notePath, content: 'Draft follow-up for review.', mode: 'create', append: null });
  assert.equal(readFileSync(notePath, 'utf8'), 'Draft follow-up for review.\n');
  const internalPath = path.join(home, 'state', 'meeting-capture', 'analysis', 'arbitrary.json');
  const refused = await executeLocalFileWrite({ path: internalPath, content: '{}', mode: 'create', append: null });
  assert.match(refused, /authorization state cannot be mutated/);
  assert.equal(existsSync(internalPath), false);
});

test('background save refuses missing accepted-call, foreign meeting and changed transcript bindings without canonical writes', async () => {
  const handler = registeredHandler();
  const own = finalized('bound-task-meeting').record;
  const foreign = finalized('foreign-task-meeting').record;
  const task = createBackgroundTask({ title: 'Bound fixture summary', prompt: 'Save the fixture summary.',
    requiredOutput: captureMeetingAnalysisRequirement(own) });
  assert.ok(markBackgroundTaskRunning(task.id));
  const source = eventlog.appendEvent({ sessionId: task.runSessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Analyze the exact fixture meeting.' } });
  const run = (meetingId: string) => withHarnessRunContext({ sessionId: task.runSessionId, sourceUserSeq: source.seq,
    counter: new ToolCallsCounter(8) }, () => handler({ meeting_id: meetingId, analysis }));
  await assert.rejects(() => run(own.id), /exact accepted save call/);
  await assert.rejects(() => run(foreign.id), /does not match this task/);
  patchMeetingRecord(own.id, { endedAt: '2030-01-01T00:00:00.000Z' });
  await assert.rejects(() => run(own.id), /does not match this task/);
  assert.equal(existsSync(analysisPathFor(own.id)), false);
  assert.equal(existsSync(analysisPathFor(foreign.id)), false);
  assert.equal(loadRecallMeetingById(own.id)?.analysisPath, undefined);
});

test('malformed retained task requirements and invented background sessions cannot fall back to manual saves', async () => {
  const handler = registeredHandler();
  const record = finalized('missing-contract-meeting').record;
  const task = createBackgroundTask({ title: 'Malformed fixture', prompt: 'Save fixture analysis.',
    requiredOutput: captureMeetingAnalysisRequirement(record) });
  // A damaged retained record cannot gain the legacy no-contract posture.
  const taskPath = path.join(home, 'state', 'background-tasks', `${task.id}.json`);
  const retained = JSON.parse(readFileSync(taskPath, 'utf8'));
  writeFileSync(taskPath, JSON.stringify({ ...retained, requiredOutput: { kind: 'meeting_analysis', meetingId: record.id } }));
  await assert.rejects(() => withHarnessRunContext({ sessionId: task.runSessionId, sourceUserSeq: 1,
    counter: new ToolCallsCounter(8) }, () => handler({ meeting_id: record.id, analysis })), /binding is unreadable/);
  await assert.rejects(() => withHarnessRunContext({ sessionId: 'background:invented-task', sourceUserSeq: 1,
    counter: new ToolCallsCounter(8) }, () => handler({ meeting_id: record.id, analysis })), /binding is missing/);
  assert.equal(existsSync(analysisPathFor(record.id)), false);
});

test('completion evidence is not accepted from model payloads and malformed analysis stays unwritten', async () => {
  const handler = registeredHandler();
  const record = finalized('forged-evidence-meeting').record;
  await assert.rejects(() => handler({ meeting_id: record.id, analysis,
    completionEvidence: { version: 1, meetingId: record.id, sessionId: 'foreign' } }));
  await assert.rejects(() => handler({ meeting_id: record.id, analysis: { ...analysis,
    completionEvidence: { version: 1, meetingId: record.id, sessionId: 'foreign' } } }));
  await assert.rejects(() => handler({ meeting_id: record.id, analysis: { ...analysis, actionItems: [{ text: 'draft', path: '/protected' }] } }));
  assert.equal(existsSync(analysisPathFor(record.id)), false);
});

test('cancelled task and revoked generation cannot save after resolving meeting ownership', async () => {
  const handler = registeredHandler();
  const record = finalized('cancelled-analysis-meeting').record;
  const task = createBackgroundTask({ title: 'Cancelled fixture summary', prompt: 'Save fixture analysis.',
    requiredOutput: captureMeetingAnalysisRequirement(record) });
  assert.ok(markBackgroundTaskRunning(task.id));
  cancelBackgroundTask(task.id);
  await assert.rejects(() => withHarnessRunContext({ sessionId: task.runSessionId,
    counter: new ToolCallsCounter(8) }, () => handler({ meeting_id: record.id, analysis })), /no longer running/);
  const session = eventlog.createSession({ id: 'cancelled-analysis-call', kind: 'chat' });
  const lease = leases.activateDispatchLease({ sessionId: session.id, scopeId: 'fixture-analysis-scope' });
  leases.revokeDispatchLease(lease);
  await assert.rejects(() => leases.runWithDispatchLease(lease,
    () => handler({ meeting_id: record.id, analysis })), /generation|lease/i);
  assert.equal(existsSync(analysisPathFor(record.id)), false);
});
