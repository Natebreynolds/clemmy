/**
 * Run: npx tsx --test src/integrations/recall/meeting-notes.test.ts
 *
 * Live scratchpad notes: helpers round-trip by windowId, notes render into the
 * vault artifact (## Notes, outside the analysis markers) and the analyzer
 * prompt, and survive re-detection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-meeting-notes-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  appendMeetingNote,
  listMeetingNotes,
  updateMeetingNote,
  removeMeetingNote,
  appendRecallTranscriptSegment,
  finalizeRecallMeeting,
  saveRecallMeetingAnalysis,
  fileMeetingFromAnalysis,
  buildAnalyzerPrompt,
  noteRecallMeetingDetected,
  loadRecallMeetingById,
} = await import('./meeting-capture.js');
const { closeMemoryDb } = await import('../../memory/db.js');

test.after(() => {
  closeMemoryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('append → list round-trips a note with marker + timestamp', () => {
  const windowId = 'win-notes-basic';
  noteRecallMeetingDetected({ windowId, status: 'recording', startedAt: '2026-07-14T10:00:00.000Z' });

  const added = appendMeetingNote(windowId, { text: '  send revised CSQL terms  ', kind: 'action', atSeconds: 125 });
  assert.ok(added, 'note appended');
  assert.equal(added!.note.text, 'send revised CSQL terms', 'text trimmed');
  assert.equal(added!.note.kind, 'action');
  assert.equal(added!.note.atSeconds, 125);
  assert.ok(added!.note.id && added!.note.createdAt);

  const listed = listMeetingNotes(windowId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, added!.note.id);
});

test('append returns null for an unknown windowId; bad kind is dropped', () => {
  assert.equal(appendMeetingNote('win-does-not-exist', { text: 'orphan' }), null);

  const windowId = 'win-notes-kind';
  noteRecallMeetingDetected({ windowId, status: 'recording' });
  const added = appendMeetingNote(windowId, { text: 'plain', kind: 'nonsense' as never });
  assert.equal(added!.note.kind, undefined, 'invalid marker sanitized to plain note');
});

test('update edits text/marker and clears it; remove deletes', () => {
  const windowId = 'win-notes-edit';
  noteRecallMeetingDetected({ windowId, status: 'recording' });
  const a = appendMeetingNote(windowId, { text: 'first', kind: 'question' })!;

  const afterEdit = updateMeetingNote(windowId, a.note.id, { text: 'first (edited)', kind: 'followup' });
  assert.equal(afterEdit!.notes![0].text, 'first (edited)');
  assert.equal(afterEdit!.notes![0].kind, 'followup');

  const afterClear = updateMeetingNote(windowId, a.note.id, { kind: null });
  assert.equal(afterClear!.notes![0].kind, undefined, 'kind: null clears the marker');

  assert.equal(updateMeetingNote(windowId, 'no-such-id', { text: 'x' }), null);
  assert.ok(removeMeetingNote(windowId, a.note.id));
  assert.equal(listMeetingNotes(windowId).length, 0);
  assert.equal(removeMeetingNote(windowId, a.note.id), null, 'removing again is a no-op null');
});

test('notes render a ## Notes section (mm:ss + marker) in the vault artifact', () => {
  const windowId = 'win-notes-artifact';
  appendRecallTranscriptSegment({ windowId, event: 'transcript.data', speaker: 'Host', text: 'lets review the pipeline' });
  appendMeetingNote(windowId, { text: 'push back on the 50% rule', kind: 'action', atSeconds: 872 });
  appendMeetingNote(windowId, { text: 'who owns the quota?', kind: 'question', atSeconds: 65 });

  const { artifactPath } = finalizeRecallMeeting({ windowId, platform: 'zoom' });
  const filed = readFileSync(artifactPath as string, 'utf-8');
  assert.match(filed, /## Notes/, 'has a Notes section');
  // Sorted by atSeconds: 01:05 before 14:32.
  assert.match(filed, /- \[01:05\] ❓ who owns the quota\?/);
  assert.match(filed, /- \[14:32\] ★ push back on the 50% rule/);
  assert.ok(filed.indexOf('## Notes') < filed.indexOf('## Transcript'), 'Notes precede Transcript');
});

test('## Notes lives OUTSIDE the analysis managed markers (survives re-file)', () => {
  const windowId = 'win-notes-markers';
  appendRecallTranscriptSegment({ windowId, event: 'transcript.data', speaker: 'Host', text: 'quarterly review' });
  appendMeetingNote(windowId, { text: 'user note stays', kind: 'followup', atSeconds: 10 });
  const { record, artifactPath } = finalizeRecallMeeting({ windowId, platform: 'zoom' });

  saveRecallMeetingAnalysis(record.id, {
    title: 'Quarterly Review',
    summary: 'Reviewed the quarter.',
    generatedAt: new Date().toISOString(),
    source: 'agent',
  });
  fileMeetingFromAnalysis(record.id);

  const filed = readFileSync(artifactPath as string, 'utf-8');
  const endMarker = filed.indexOf('clem:analysis:end');
  const notesAt = filed.indexOf('## Notes');
  assert.ok(endMarker >= 0, 'analysis markers present');
  assert.ok(notesAt > endMarker, 'Notes section sits after the analysis end marker (never clobbered)');
  assert.match(filed, /user note stays/, 'note survives the analyzer re-file');
});

test('analyzer prompt injects the notes block + weighting rule', () => {
  const windowId = 'win-notes-prompt';
  appendRecallTranscriptSegment({ windowId, event: 'transcript.data', speaker: 'Host', text: 'ok' });
  appendMeetingNote(windowId, { text: 'flagged action item', kind: 'action', atSeconds: 5 });
  const record = loadRecallMeetingById(noteRecallMeetingDetected({ windowId }).id)!;

  const prompt = buildAnalyzerPrompt(record, '/tmp/whatever.md');
  assert.match(prompt, /User notes taken live during the meeting/);
  assert.match(prompt, /- \[00:05\] ★ flagged action item/);
  assert.match(prompt, /Weight these notes ABOVE your own inference/);
});

test('noteRecallMeetingDetected preserves notes across re-detection', () => {
  const windowId = 'win-notes-redetect';
  noteRecallMeetingDetected({ windowId, status: 'recording' });
  appendMeetingNote(windowId, { text: 'keep me', kind: 'action', atSeconds: 3 });
  // A later detect/segment on the same window must not drop notes.
  noteRecallMeetingDetected({ windowId, status: 'recording', platform: 'zoom' });
  appendRecallTranscriptSegment({ windowId, event: 'transcript.data', text: 'more talk' });

  const notes = listMeetingNotes(windowId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, 'keep me');
});
