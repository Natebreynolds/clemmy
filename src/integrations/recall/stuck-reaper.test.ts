/**
 * Run: npx tsx --test src/integrations/recall/stuck-reaper.test.ts
 *
 * Covers the two meeting-capture changes that fix the cluttered /
 * stuck-recording behavior:
 *
 *   1. listAllRecallMeetingRecords() drops empty `detected` stubs
 *      entirely (they're noise — one per call window the SDK ever saw).
 *   2. reapStuckRecallRecordings() finalizes `recording` records that
 *      have had no transcript activity for the idle window, and leaves
 *      genuinely-active (recent) recordings alone.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-stuck-reaper-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const mc = await import('./meeting-capture.js');

test('listAllRecallMeetingRecords: empty detected stubs are excluded from the list', () => {
  // A bare detection with no segments — the SDK fires this for every
  // Zoom/Meet window even when the user never records.
  mc.noteRecallMeetingDetected({ windowId: 'win-stub', platform: 'zoom', status: 'detected' });
  const ids = mc.listAllRecallMeetingRecords().map((r) => r.windowId);
  assert.ok(!ids.includes('win-stub'), 'empty detected stub should not appear in the list');
});

test('reapStuckRecallRecordings: finalizes an idle recording, spares a fresh one', () => {
  // Stuck: a recording whose only segment is well past the idle window.
  mc.appendRecallTranscriptSegment({
    windowId: 'win-stuck',
    recordingId: 'rec-stuck',
    event: 'transcript.data',
    speaker: 'Host',
    text: 'this capture was abandoned',
    timestamp: new Date(Date.now() - 90 * 60 * 1000).toISOString(), // 90 min ago
    isFinal: true,
  });
  // Fresh: a recording with activity right now.
  mc.appendRecallTranscriptSegment({
    windowId: 'win-fresh',
    recordingId: 'rec-fresh',
    event: 'transcript.data',
    speaker: 'Host',
    text: 'live and talking',
    timestamp: new Date().toISOString(),
    isFinal: true,
  });

  const finalized = mc.reapStuckRecallRecordings({ idleMs: 60 * 60 * 1000 });
  const finalizedWindows = finalized.map((f) => f.record.windowId);

  assert.ok(finalizedWindows.includes('win-stuck'), 'idle recording should be finalized');
  assert.ok(!finalizedWindows.includes('win-fresh'), 'fresh recording must not be cut off');

  const stuck = mc.listAllRecallMeetingRecords().find((r) => r.windowId === 'win-stuck');
  assert.equal(stuck?.status, 'completed', 'reaped record flips to completed');
  assert.ok(stuck?.endedAt, 'reaped record gets an endedAt');

  const fresh = mc.listAllRecallMeetingRecords().find((r) => r.windowId === 'win-fresh');
  assert.equal(fresh?.status, 'recording', 'fresh record stays recording');
});
