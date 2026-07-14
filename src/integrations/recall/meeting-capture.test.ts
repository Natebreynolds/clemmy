/**
 * Run: npx tsx --test src/integrations/recall/meeting-capture.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-meeting-filing-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  appendRecallTranscriptSegment,
  finalizeRecallMeeting,
  saveRecallMeetingAnalysis,
  fileMeetingFromAnalysis,
  buildMeetingChatPrompt,
  findRecallMeetingRecord,
  listAllRecallMeetingRecords,
  loadRecallMeetingById,
  noteRecallMeetingDetected,
  recordMeetingTitle,
  renameMeeting,
} = await import('./meeting-capture.js');
const { reindexVault } = await import('../../memory/indexer.js');
const { openMemoryDb, closeMemoryDb } = await import('../../memory/db.js');

test.after(() => {
  closeMemoryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('fileMeetingFromAnalysis folds title + analysis into the note, idempotently, and keeps the transcript', () => {
  const windowId = 'win-onboarding';
  // Transcript text is deliberately distinct from the analysis summary so
  // we can prove the curated summary (not just the raw transcript) becomes
  // searchable.
  appendRecallTranscriptSegment({
    windowId,
    event: 'transcript.data',
    speaker: 'Host',
    text: 'alright lets get the screen share going',
  });
  const { record, artifactPath } = finalizeRecallMeeting({ windowId, platform: 'zoom' });
  assert.ok(artifactPath, 'finalize should write a vault artifact');

  saveRecallMeetingAnalysis(record.id, {
    title: 'Clementine onboarding walkthrough',
    summary: 'Walked the guest through installing the desktop app and connecting Salesforce.',
    decisions: ['Skip Discord setup for now'],
    actionItems: [{ text: 'Send the patch build', owner: 'Host', dueDate: '2026-05-27' }],
    topics: ['onboarding', 'salesforce'],
    participants: ['Host', 'Guest'],
    generatedAt: new Date().toISOString(),
    source: 'agent',
  });

  const changed = fileMeetingFromAnalysis(record.id);
  assert.equal(changed, true, 'first filing should rewrite the note');

  const filed = readFileSync(artifactPath as string, 'utf-8');
  assert.match(filed, /^title: Clementine onboarding walkthrough$/m, 'title in frontmatter');
  assert.match(filed, /^# Clementine onboarding walkthrough$/m, 'title in heading');
  assert.match(filed, /## Summary/);
  assert.match(filed, /installing the desktop app and connecting Salesforce/);
  assert.match(filed, /## Action Items/);
  assert.match(filed, /Send the patch build \(owner: Host, due: 2026-05-27\)/);
  assert.match(filed, /## Topics\nonboarding, salesforce/);
  // Transcript preserved verbatim.
  assert.match(filed, /alright lets get the screen share going/);

  // Title persisted onto the record so the dashboard list shows it.
  assert.equal(loadRecallMeetingById(record.id)?.title, 'Clementine onboarding walkthrough');

  // Idempotent: re-filing the same analysis is a no-op.
  assert.equal(fileMeetingFromAnalysis(record.id), false, 'second filing should be a no-op');

  // The curated summary is now searchable via the vault index even though
  // "Salesforce" never appears in the raw transcript.
  const stats = reindexVault();
  assert.equal(stats.errors, 0);
  const rows = openMemoryDb().prepare(
    'SELECT content FROM vault_chunks WHERE path = ?',
  ).all(artifactPath) as Array<{ content: string }>;
  const joined = rows.map((r) => r.content).join('\n');
  assert.match(joined, /connecting Salesforce/, 'summary content should be indexed');
});

test('renameMeeting sets a user title that the analyzer cannot overwrite', () => {
  const windowId = 'win-rename';
  appendRecallTranscriptSegment({ windowId, event: 'transcript.data', speaker: 'Host', text: 'quarterly numbers look good' });
  const { record, artifactPath } = finalizeRecallMeeting({ windowId, platform: 'zoom' });
  assert.ok(artifactPath);

  // User renames the meeting.
  assert.equal(renameMeeting(record.id, 'Q3 Board Review'), true);
  const afterRename = loadRecallMeetingById(record.id);
  assert.equal(afterRename?.title, 'Q3 Board Review');
  assert.equal(afterRename?.titleSource, 'user');
  assert.match(readFileSync(artifactPath as string, 'utf-8'), /^title: Q3 Board Review$/m);

  // A later analyzer pass with a DIFFERENT title must not clobber it.
  saveRecallMeetingAnalysis(record.id, {
    title: 'Some Auto Generated Title',
    summary: 'Reviewed quarterly performance.',
    generatedAt: new Date().toISOString(),
    source: 'agent',
  });
  fileMeetingFromAnalysis(record.id);
  const afterAnalysis = loadRecallMeetingById(record.id);
  assert.equal(afterAnalysis?.title, 'Q3 Board Review', 'user title must survive analyzer filing');
  assert.equal(afterAnalysis?.titleSource, 'user');
  // But the analyzer's summary still gets folded in (searchable).
  assert.match(readFileSync(artifactPath as string, 'utf-8'), /Reviewed quarterly performance/);
});

test('live transcript refresh preserves a user title lock', () => {
  const windowId = 'win-live-rename';
  const initial = appendRecallTranscriptSegment({
    windowId,
    event: 'transcript.data',
    speaker: 'Host',
    text: 'lets talk about client follow up',
  });
  assert.ok(recordMeetingTitle(initial.id, 'Client Follow-up', 'user'));

  appendRecallTranscriptSegment({
    windowId,
    event: 'transcript.data',
    speaker: 'Guest',
    text: 'next steps are clear',
  });
  const afterRefresh = loadRecallMeetingById(initial.id);
  assert.equal(afterRefresh?.title, 'Client Follow-up');
  assert.equal(afterRefresh?.titleSource, 'user');

  const { artifactPath } = finalizeRecallMeeting({ windowId, platform: 'zoom' });
  assert.ok(artifactPath);
  saveRecallMeetingAnalysis(initial.id, {
    title: 'Auto Analyzer Title',
    summary: 'Discussed client follow-up next steps.',
    generatedAt: new Date().toISOString(),
    source: 'agent',
  });
  fileMeetingFromAnalysis(initial.id);

  const afterAnalysis = loadRecallMeetingById(initial.id);
  assert.equal(afterAnalysis?.title, 'Client Follow-up');
  assert.equal(afterAnalysis?.titleSource, 'user');
  assert.match(readFileSync(artifactPath as string, 'utf-8'), /^# Client Follow-up$/m);
});

test('buildMeetingChatPrompt requires the full transcript and asks for next action', () => {
  const windowId = 'win-chat-prompt';
  appendRecallTranscriptSegment({
    windowId,
    event: 'transcript.data',
    speaker: 'Nate',
    text: 'we need to follow up with the design partner after the onboarding call',
  });
  const { record, artifactPath } = finalizeRecallMeeting({ windowId, platform: 'zoom', title: 'Design partner onboarding' });
  assert.ok(artifactPath);

  saveRecallMeetingAnalysis(record.id, {
    title: 'Design Partner Onboarding',
    summary: 'Discussed onboarding and follow-up.',
    actionItems: [{ text: 'Follow up with the design partner', owner: 'Nate' }],
    generatedAt: new Date().toISOString(),
    source: 'agent',
  });

  const prompt = buildMeetingChatPrompt(loadRecallMeetingById(record.id)!);
  assert.match(prompt, /Read the FULL transcript end-to-end/);
  assert.match(prompt, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /What would you like me to act on/);
  assert.match(prompt, /likely follow-up tasks/i);
  assert.match(prompt, /Do not refer to yourself as Clementine/i);
  assert.match(prompt, /Do not send messages, schedule events, update sheets, or create tasks/);
});

test('two SDK uploads in one reused window remain distinct before reconciliation', () => {
  const windowId = 'reused-native-window';
  const first = noteRecallMeetingDetected({
    windowId,
    sdkUploadId: 'same-window-upload-1',
    status: 'recording',
    startedAt: '2026-07-13T10:00:00.000Z',
  });
  appendRecallTranscriptSegment({
    windowId,
    sdkUploadId: 'same-window-upload-1',
    event: 'transcript.data',
    text: 'first sequential meeting',
  });
  finalizeRecallMeeting({
    windowId,
    sdkUploadId: 'same-window-upload-1',
    retentionMode: 'zero',
    canonicalBackfill: false,
  });

  const second = noteRecallMeetingDetected({
    windowId,
    sdkUploadId: 'same-window-upload-2',
    status: 'recording',
    startedAt: '2026-07-13T11:00:00.000Z',
  });
  appendRecallTranscriptSegment({
    windowId,
    sdkUploadId: 'same-window-upload-2',
    event: 'transcript.data',
    text: 'second sequential meeting',
  });
  finalizeRecallMeeting({
    windowId,
    sdkUploadId: 'same-window-upload-2',
    retentionMode: 'zero',
    canonicalBackfill: false,
  });

  assert.notEqual(first.id, second.id);
  assert.equal(findRecallMeetingRecord({ sdkUploadId: 'same-window-upload-1' })?.id, first.id);
  assert.equal(findRecallMeetingRecord({ sdkUploadId: 'same-window-upload-2' })?.id, second.id);
  assert.deepEqual(
    findRecallMeetingRecord({ sdkUploadId: 'same-window-upload-1' })?.segments.map((segment) => segment.text),
    ['first sequential meeting'],
  );
  assert.deepEqual(
    findRecallMeetingRecord({ sdkUploadId: 'same-window-upload-2' })?.segments.map((segment) => segment.text),
    ['second sequential meeting'],
  );
  const records = listAllRecallMeetingRecords().filter((record) => record.windowId === windowId);
  assert.equal(records.length, 2);
  assert.deepEqual(new Set(records.map((record) => record.sdkUploadId)), new Set([
    'same-window-upload-1',
    'same-window-upload-2',
  ]));
  assert.deepEqual(new Set(records.map((record) => record.startedAt)), new Set([
    '2026-07-13T10:00:00.000Z',
    '2026-07-13T11:00:00.000Z',
  ]));
});
