import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
after(() => { closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });

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
