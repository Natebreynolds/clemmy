/**
 * Run: npx tsx --test src/integrations/local-meetings/live-transcript.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-live-transcript-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const live = await import('./live-transcript.js');

const BYTES_PER_SECOND = 32_000;
function writePartFile(dir: string, name: string, pcmSeconds: number): string {
  const finalPath = path.join(dir, name);
  const pcm = Buffer.alloc(Math.floor(pcmSeconds * BYTES_PER_SECOND));
  // Header intentionally claims 0 data bytes — exactly like the desktop
  // recorder's part-file before finalization.
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.write('WAVE', 8, 'ascii');
  writeFileSync(`${finalPath}.part`, Buffer.concat([header, pcm]));
  return finalPath;
}

test.after(() => {
  live._setLiveTranscriberForTests(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('incremental pass transcribes new audio, offsets timestamps, and dedupes the overlap', async () => {
  const calls: Array<{ durationSeconds: number }> = [];
  live._setLiveTranscriberForTests(async ({ durationSeconds }) => {
    calls.push({ durationSeconds });
    return {
      text: 'hello world',
      segments: [{ text: `chunk-${calls.length}`, startSeconds: 0.5, endSeconds: Math.max(1, durationSeconds - 1) }],
      model: 'base.en',
    };
  });
  const finalPath = writePartFile(TMP_HOME, 'local-live-a.wav', 30);
  // First poll kicks the pass; snapshot is immediate (empty until the pass lands).
  live.noteLiveTranscriptOpportunity('live-a', finalPath);
  await delay(50);
  const snap1 = live.getLiveTranscriptSnapshot('live-a');
  assert.equal(snap1.segments.length, 1, 'first slice transcribed');
  assert.equal(Math.round(snap1.throughSeconds), 30, 'covered through the available audio');
  assert.equal(snap1.segments[0].startSeconds, 0.5, 'first slice starts at 0 — no offset');

  // 10 more seconds arrive: below the 15s cadence → no new pass.
  writeFileSync(`${finalPath}.part`, Buffer.concat([Buffer.alloc(44), Buffer.alloc(40 * BYTES_PER_SECOND)]));
  live.noteLiveTranscriptOpportunity('live-a', finalPath);
  await delay(50);
  assert.equal(live.getLiveTranscriptSnapshot('live-a').segments.length, 1, 'sub-cadence audio waits');

  // 20 more (total 50): a second pass runs over the new slice with 2s overlap.
  writeFileSync(`${finalPath}.part`, Buffer.concat([Buffer.alloc(44), Buffer.alloc(50 * BYTES_PER_SECOND)]));
  live.noteLiveTranscriptOpportunity('live-a', finalPath);
  await delay(50);
  const snap2 = live.getLiveTranscriptSnapshot('live-a');
  assert.equal(snap2.segments.length, 2, 'second slice appended');
  assert.ok(snap2.segments[1].startSeconds >= 28, `second slice offset by the slice start (got ${snap2.segments[1].startSeconds})`);
  assert.equal(Math.round(snap2.throughSeconds), 50);
  assert.equal(calls.length, 2, 'exactly two whisper passes for two cadence crossings');

  live.clearLiveTranscript('live-a');
  assert.equal(live.getLiveTranscriptSnapshot('live-a').segments.length, 0, 'cleared at stop');
});

test('a transcriber failure is contained: snapshot carries lastError, the poll never throws', async () => {
  live._setLiveTranscriberForTests(async () => { throw new Error('model exploded'); });
  const finalPath = writePartFile(TMP_HOME, 'local-live-b.wav', 20);
  live.noteLiveTranscriptOpportunity('live-b', finalPath);
  await delay(50);
  const snap = live.getLiveTranscriptSnapshot('live-b');
  assert.equal(snap.segments.length, 0);
  assert.match(snap.lastError ?? '', /model exploded/);
  live.clearLiveTranscript('live-b');
});

test('kill-switch: CLEMMY_LIVE_TRANSCRIPT=off yields an inert empty view', async () => {
  process.env.CLEMMY_LIVE_TRANSCRIPT = 'off';
  try {
    const finalPath = writePartFile(TMP_HOME, 'local-live-c.wav', 30);
    const snap = live.noteLiveTranscriptOpportunity('live-c', finalPath);
    assert.equal(snap.segments.length, 0);
    await delay(30);
    assert.equal(live.getLiveTranscriptSnapshot('live-c').segments.length, 0);
  } finally {
    delete process.env.CLEMMY_LIVE_TRANSCRIPT;
  }
});
