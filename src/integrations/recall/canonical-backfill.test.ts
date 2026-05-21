/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-canonical-test npx tsx --test \
 *   src/integrations/recall/canonical-backfill.test.ts
 *
 * End-to-end coverage for the canonical-transcript backfill swap.
 * Does NOT hit Recall's API — calls `applyCanonicalTranscript` directly
 * with a parsed canonical segment list, then verifies:
 *
 *   1. record.segments is replaced (streamed → canonical)
 *   2. canonicalStatus → 'ready', canonicalError cleared
 *   3. artifact markdown is rewritten to reflect the canonical
 *      speakers (real names) and the canonical source label
 *   4. markCanonicalTranscriptIncomplete keeps streamed segments
 *      untouched on failure (no regression vs. today's behavior)
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-canonical-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const mc = await import('./meeting-capture.js');
const tp = await import('./transcript-parser.js');

let seedCount = 0;
function seedStreamedMeeting() {
  // Each test gets a unique windowId/recordingId so the on-disk
  // record file from one test doesn't leak into the next.
  seedCount += 1;
  const windowId = `win-${seedCount}`;
  const recordingId = `rec-${seedCount}`;
  // Streamed segments: generic Recall labels (the bug we're fixing —
  // they're "Host" + "Speaker 2", not real names).
  mc.appendRecallTranscriptSegment({
    windowId,
    recordingId,
    event: 'transcript.data',
    speaker: 'Host',
    text: 'okay everyone',
    timestamp: '2026-05-21T18:35:25.000Z',
    isFinal: true,
  });
  mc.appendRecallTranscriptSegment({
    windowId,
    recordingId,
    event: 'transcript.data',
    speaker: 'Speaker 2',
    text: 'sounds good',
    timestamp: '2026-05-21T18:35:38.000Z',
    isFinal: true,
  });
  return mc.finalizeRecallMeeting({
    windowId,
    recordingId,
    platform: 'zoom',
    title: 'Q3 Strategy Sync',
  });
}

test('applyCanonicalTranscript: swaps streamed segments for canonical, rewrites artifact', () => {
  const finalized = seedStreamedMeeting();
  const artifactPath = finalized.artifactPath;
  assert.ok(artifactPath, 'streamed artifact should be written');
  assert.equal(finalized.record.canonicalStatus, 'pending');
  // Streamed artifact has generic speaker labels.
  const streamedBody = readFileSync(artifactPath, 'utf-8');
  assert.match(streamedBody, /Host:/);
  assert.match(streamedBody, /Speaker 2:/);
  assert.match(streamedBody, /recall\.ai-desktop-sdk \(streamed\)/);

  // Now apply a canonical transcript with REAL participant names.
  const canonical = tp.parseTranscriptToSegments(
    [
      {
        participant: { id: 1, name: 'Nate Reynolds' },
        words: [
          { text: 'okay', start_timestamp: { relative: 0 }, end_timestamp: { relative: 1 } },
          { text: 'everyone', start_timestamp: { relative: 1 }, end_timestamp: { relative: 2 } },
        ],
      },
      {
        participant: { id: 2, name: 'Jane Smith' },
        words: [
          { text: 'sounds', start_timestamp: { relative: 13 }, end_timestamp: { relative: 14 } },
          { text: 'good', start_timestamp: { relative: 14 }, end_timestamp: { relative: 15 } },
        ],
      },
    ],
    {
      windowId: finalized.record.windowId,
      recordingId: finalized.record.recordingId,
      startedAt: finalized.record.startedAt,
    },
  );

  const applied = mc.applyCanonicalTranscript(finalized.record, canonical);
  assert.equal(applied.record.canonicalStatus, 'ready');
  assert.equal(applied.record.canonicalError, undefined);
  assert.equal(applied.record.segments.length, 2);
  assert.equal(applied.record.segments[0].speaker, 'Nate Reynolds');
  assert.equal(applied.record.segments[1].speaker, 'Jane Smith');

  // Artifact rewritten with canonical speakers + source label.
  const canonicalBody = readFileSync(artifactPath, 'utf-8');
  assert.match(canonicalBody, /Nate Reynolds:/);
  assert.match(canonicalBody, /Jane Smith:/);
  assert.doesNotMatch(canonicalBody, /Host:/);
  assert.match(canonicalBody, /recall\.ai async transcript \(canonical\)/);
});

test('markCanonicalTranscriptIncomplete: streamed segments survive a failed backfill', () => {
  const finalized = seedStreamedMeeting();
  const failed = mc.markCanonicalTranscriptIncomplete(finalized.record, 'failed', 'transcript empty');
  assert.equal(failed.canonicalStatus, 'failed');
  assert.equal(failed.canonicalError, 'transcript empty');
  // Segments untouched — the dashboard still shows the partial streamed
  // transcript rather than a blank panel.
  assert.equal(failed.segments.length, finalized.record.segments.length);
  assert.equal(failed.segments[0].speaker, 'Host');
});

test('finalizeRecallMeeting: no recordingId → canonicalStatus=not_started, no backfill kicked off', () => {
  // Different windowId so it doesn't collide with the seed above.
  mc.appendRecallTranscriptSegment({
    windowId: 'win-no-rec',
    event: 'transcript.data',
    speaker: 'Host',
    text: 'meeting without sdk upload',
    isFinal: true,
  });
  const finalized = mc.finalizeRecallMeeting({ windowId: 'win-no-rec', platform: 'zoom' });
  assert.equal(finalized.record.canonicalStatus, 'not_started');
});
