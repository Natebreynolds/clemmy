import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-read-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { searchMeetings, readMeeting } = await import('./meeting-read-tools.js');
const { persistMeetingAnalysis } = await import('./meeting-analysis-tools.js');
const meetings = await import('../integrations/recall/meeting-capture.js');
const { TOOL_REGISTRY, deriveNeedsApproval, deriveOrchestratorDiscoveryNames } = await import('./tool-registry.js');
const { closeMemoryDb } = await import('../memory/db.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
after(() => { closeMemoryDb(); closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function seed(windowId: string, provider: 'recall' | 'local' = 'recall') {
  meetings.noteRecallMeetingDetected({ windowId, provider, title: 'Launch planning', status: 'recording', startedAt: '2026-09-28T18:00:00.000Z' });
  for (const text of ['Launch is Friday.', 'The preview needs review.', 'Do not send the draft yet.']) {
    meetings.appendRecallTranscriptSegment({ windowId, event: 'transcript.data', speaker: 'Pat', text });
  }
  return meetings.finalizeRecallMeeting({ windowId }).record;
}

test('local meeting library is searchable and readable before analysis exists', () => {
  const record = seed('launch-discussion');
  const found = searchMeetings({ query: 'Pat Friday', after: '2026-09-28T00:00:00Z', before: '2026-09-29T00:00:00Z' });
  assert.equal(found.total, 1);
  assert.equal(found.meetings[0]?.id, record.id);
  assert.equal(found.meetings[0]?.transcriptAvailable, true);
  const first = readMeeting({ meeting_id: record.id, limit: 2 });
  assert.equal(first.analysis, null);
  assert.equal(first.totalSegments, 3);
  assert.equal(first.nextOffset, 2);
  const second = readMeeting({ meeting_id: record.id, offset: first.nextOffset, transcript_revision: first.transcriptRevision });
  assert.equal(second.nextOffset, null);
  assert.deepEqual([...first.segments, ...second.segments].map((s) => s.text), record.segments.map((s) => s.text));
  assert.throws(() => readMeeting({ meeting_id: record.id, offset: 2, transcript_revision: 'stale' }), /Transcript changed/);
  assert.equal(searchMeetings({ query: 'no-such-participant' }).total, 0);
  assert.throws(() => readMeeting({ meeting_id: 'missing' }), /Meeting not found/);
});

test('local audio shares the library; fresh analysis immediately appears after a cached search', () => {
  const record = seed('local-launch', 'local');
  assert.equal(searchMeetings({}).meetings.find((m) => m.id === record.id)?.hasAnalysis, false);
  persistMeetingAnalysis({ meeting_id: record.id, analysis: {
    title: 'Launch review', summary: 'Pat reviewed the launch.', decisions: [], actionItems: [], topics: ['Launch'], participants: ['Pat'],
  } });
  assert.equal(searchMeetings({}).meetings.find((m) => m.id === record.id)?.hasAnalysis, true);
  assert.equal(readMeeting({ meeting_id: record.id }).analysis?.summary, 'Pat reviewed the launch.');
});

test('analysis and transcript tools require no approval; analysis defaults on for completed calls', () => {
  assert.equal(meetings.loadRecallMeetingSettings().analyzeOnComplete, true);
  for (const name of ['meeting_analysis_save', 'meeting_search', 'meeting_read']) {
    const tool = TOOL_REGISTRY.find((t) => t.name === name);
    assert.ok(tool);
    assert.equal(deriveNeedsApproval(tool), false, name);
  }
});

test('the exact failed discovery query finds a native meeting reader without external sources', async () => {
  const { registerToolSearchTool } = await import('./tool-search-tool.js');
  let handler: ((args: unknown) => Promise<{ content: Array<{ text: string }> }>) | undefined;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, fn: typeof handler) { handler = fn; } } as never,
    { allowedNames: new Set(deriveOrchestratorDiscoveryNames()), candidateSources: [] });
  assert.ok(handler);
  const result = await handler({ query: 'find meeting notes or transcript of a recent meeting', limit: 8 });
  const body = JSON.parse(result.content[0]!.text);
  assert.ok(body.results.some((r: { name: string }) => r.name === 'meeting_search'), JSON.stringify(body.results.map((r: { name: string }) => r.name)));
});
