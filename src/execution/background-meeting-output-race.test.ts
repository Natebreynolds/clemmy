import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-settle-race-'));
process.env.CLEMENTINE_HOME = home;
const tasks = await import('./background-tasks.js');
const capture = await import('../integrations/recall/meeting-capture.js');
const contract = await import('../integrations/recall/meeting-analysis-contract.js');
const events = await import('../runtime/harness/eventlog.js');
const { listRuns } = await import('../runtime/run-events.js');
const { persistMeetingAnalysis } = await import('../tools/meeting-analysis-tools.js');
const { closeMemoryDb } = await import('../memory/db.js');
after(() => {
  tasks._setBackgroundResponseExecutorForTests(null);
  tasks._setBackgroundTaskSettlementCasHookForTests(null);
  events.closeEventLog(); closeMemoryDb(); rmSync(home, { recursive: true, force: true });
});

test('a missing meeting link at final settlement blocks both task and tracked run, never reports completion', async () => {
  const windowId = 'controlled-meeting-cas-race';
  capture.noteRecallMeetingDetected({ windowId, status: 'recording' });
  capture.appendRecallTranscriptSegment({ windowId, event: 'transcript.data', text: 'Review the controlled draft.', isFinal: true });
  const record = capture.finalizeRecallMeeting({ windowId, retentionMode: 'zero' }).record;
  const requiredOutput = contract.captureMeetingAnalysisRequirement(record);
  const task = tasks.createBackgroundTask({ title: 'Controlled meeting race', prompt: 'Prepare the exact meeting summary.', requiredOutput, maxMinutes: 1 });
  let modelTurns = 0;
  tasks._setBackgroundResponseExecutorForTests(async () => {
    modelTurns += 1;
    const source = events.appendEvent({ sessionId: task.runSessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: task.prompt } });
    const analysis = { title: 'Controlled draft review', summary: 'The fixture group agreed to review the draft.', decisions: [], actionItems: [], topics: [], participants: [] };
    // Seed checker input only. The separate authority fixture covers genuine
    // host save; this control targets the later verifier → settlement race.
    persistMeetingAnalysis({ meeting_id: record.id, analysis }, { version: 1, meetingId: record.id,
      transcriptDigest: requiredOutput.transcriptDigest, contentDigest: contract.meetingAnalysisContentDigest(analysis),
      sessionId: task.runSessionId, sourceUserSeq: source.seq });
    tasks._setBackgroundTaskSettlementCasHookForTests(() => {
      tasks._setBackgroundTaskSettlementCasHookForTests(null);
      capture.patchMeetingRecord(record.id, { analysisPath: undefined });
    });
    return { text: 'The meeting summary is saved.', sessionId: task.runSessionId, stoppedReason: 'success' };
  });
  assert.equal(await tasks.processBackgroundTasks({ getRuntime() { return {}; } } as never, 1), 1);
  assert.equal(modelTurns, 1);
  assert.equal(tasks.getBackgroundTask(task.id)?.status, 'blocked');
  const tracked = listRuns(20).find(run => run.sessionId === task.runSessionId);
  assert.equal(tracked?.status, 'blocked');
  assert.notEqual(tasks.getBackgroundTask(task.id)?.terminalReportBack?.outcome, 'done', 'no done report may be queued');
  assert.match(tasks.getBackgroundTask(task.id)?.error ?? '', /not been saved back/);
});
