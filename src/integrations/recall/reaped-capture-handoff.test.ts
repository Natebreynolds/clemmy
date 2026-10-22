/**
 * Run: node scripts/run-tests-isolated.mjs src/integrations/recall/reaped-capture-handoff.test.ts
 *
 * A capture the reaper finalizes gets the recording-ended route's handoff.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handOffReapedCapture } from './reaped-capture-handoff.js';

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      startSdkUpload: ({ meetingId }: { meetingId: string }) => { calls.push(`upload:${meetingId}`); },
      startBackfill: ({ recordingId }: { recordingId: string }) => { calls.push(`backfill:${recordingId}`); },
      queueAnalysis: async () => { calls.push('analysis'); },
    },
  };
}

test('a reaped capture with an upload id and no recording id has its upload polled', async () => {
  // Live 2026-10-21: an interview capture lost its ended event across two
  // service restarts; the reaper finalized it with only an upload id and
  // nothing polled the upload, so it sat at "upload pending" for good.
  const { calls, deps } = recorder();
  const result = await handOffReapedCapture({ id: 'm1', windowId: 'w1', sdkUploadId: 'up-1', recallRetentionMode: 'timed' },
    '/vault/m1.md', { analyzeOnComplete: true }, deps);
  assert.deepEqual(calls, ['upload:m1'], 'the upload is polled; a timed upload is analyzed after its canonical transcript');
  assert.deepEqual(result, { transcript: 'sdk_upload', analysis: 'after_canonical' });
});

test('an upload with zero retention is polled and analyzed from what was captured', async () => {
  const { calls, deps } = recorder();
  const result = await handOffReapedCapture({ id: 'm2', windowId: 'w2', sdkUploadId: 'up-2', recallRetentionMode: 'zero' },
    '/vault/m2.md', { analyzeOnComplete: true }, deps);
  assert.deepEqual(calls, ['upload:m2', 'analysis']);
  assert.deepEqual(result, { transcript: 'sdk_upload', analysis: 'now' });
});

test('a recording id without an upload id keeps the canonical backfill, and nothing is analyzed when analysis is off', async () => {
  const { calls, deps } = recorder();
  const result = await handOffReapedCapture({ id: 'm3', windowId: 'w3', recordingId: 'rec-3' },
    '/vault/m3.md', { analyzeOnComplete: false }, deps);
  assert.deepEqual(calls, ['backfill:rec-3']);
  assert.deepEqual(result, { transcript: 'canonical_backfill', analysis: 'none' });
  const none = recorder();
  assert.deepEqual(await handOffReapedCapture({ id: 'm4', windowId: 'w4', recordingId: 'rec-4', recallRetentionMode: 'zero' },
    undefined, { analyzeOnComplete: true }, none.deps), { transcript: 'none', analysis: 'none' });
  assert.deepEqual(none.calls, []);
});
