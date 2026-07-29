/**
 * Run: npx tsx --test src/integrations/recall/sdk-upload-reconcile.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-sdk-upload-reconcile-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';

const meetings = await import('./meeting-capture.js');
const reconcile = await import('./sdk-upload-reconcile.js');
type RecallRegion = 'us-west-2' | 'us-east-1' | 'eu-central-1' | 'ap-northeast-1';

let seedNumber = 0;
function seedMeeting(options: {
  retentionMode?: 'timed' | 'zero';
  recordingId?: string;
  sdkUploadRegion?: RecallRegion;
} = {}) {
  seedNumber += 1;
  const windowId = `sdk-window-${seedNumber}`;
  const sdkUploadId = `sdk-upload-${seedNumber}`;
  meetings.noteRecallMeetingDetected({
    windowId,
    sdkUploadId,
    sdkUploadRegion: options.sdkUploadRegion,
    provider: 'recall',
    status: 'recording',
    title: `SDK meeting ${seedNumber}`,
  });
  return meetings.finalizeRecallMeeting({
    windowId,
    sdkUploadId,
    sdkUploadRegion: options.sdkUploadRegion,
    recordingId: options.recordingId,
    retentionMode: options.retentionMode ?? 'timed',
    retentionHours: 24,
    canonicalBackfill: options.retentionMode !== 'zero',
  });
}

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('no realtime transcript reconciles SDK upload, migrates record, backfills, then queues analysis', async () => {
  const seeded = seedMeeting();
  assert.equal(seeded.segmentCount, 0, 'fixture has no realtime transcript events');
  assert.equal(seeded.artifactPath, undefined, 'no streamed artifact exists yet');

  let calls = 0;
  const result = await reconcile.reconcileRecallSdkUpload(
    { meetingId: seeded.record.id },
    {
      pollIntervalMs: 1,
      sleep: async () => undefined,
      getUpload: async () => {
        calls += 1;
        return calls === 1
          ? { id: seeded.record.sdkUploadId!, status: { code: 'recording_ended' } }
          : { id: seeded.record.sdkUploadId!, status: { code: 'complete' }, recording: { id: 'recording-final-1' } };
      },
      backfill: async ({ recordingId }) => {
        assert.equal(recordingId, 'recording-final-1');
        const current = meetings.loadRecallMeetingById(seeded.record.id)!;
        meetings.applyCanonicalTranscript(current, [{
          id: 'canonical-1',
          windowId: current.windowId,
          recordingId,
          event: 'transcript.canonical',
          speaker: 'Alex',
          text: 'This transcript arrived only after SDK upload completion.',
          timestamp: current.startedAt,
          isFinal: true,
        }]);
        return { status: 'ready', segmentCount: 1 };
      },
    },
  );

  assert.equal(result.status, 'complete');
  assert.equal(result.recordingId, 'recording-final-1');
  assert.equal(result.backfillStatus, 'ready');
  assert.equal(calls, 2);
  const migrated = meetings.loadRecallMeetingById(seeded.record.id)!;
  assert.equal(migrated.recordingId, 'recording-final-1');
  assert.equal(migrated.sdkUploadStatus, 'complete');
  assert.equal(migrated.canonicalStatus, 'ready');
  assert.equal(migrated.segments.length, 1);
  assert.ok(migrated.artifactPath && existsSync(migrated.artifactPath));
  assert.ok(migrated.analysisTaskId, 'post-backfill analysis was queued');
  assert.equal(meetings.findRecallMeetingRecord({ windowId: seeded.record.windowId }), null, 'window-key placeholder migrated away');
  assert.equal(meetings.findRecallMeetingRecord({ recordingId: 'recording-final-1' })?.id, seeded.record.id);
});

test('terminal SDK upload failure is durable and never starts canonical backfill', async () => {
  const seeded = seedMeeting();
  let backfillCalls = 0;
  const result = await reconcile.reconcileRecallSdkUpload(
    { sdkUploadId: seeded.record.sdkUploadId },
    {
      getUpload: async () => ({
        id: seeded.record.sdkUploadId!,
        status: { code: 'failed', sub_code: 'upload_interrupted' },
      }),
      backfill: async () => { backfillCalls += 1; return { status: 'ready' }; },
    },
  );
  assert.equal(result.status, 'failed');
  assert.equal(backfillCalls, 0);
  const failed = meetings.loadRecallMeetingById(seeded.record.id)!;
  assert.equal(failed.sdkUploadStatus, 'failed');
  assert.equal(failed.canonicalStatus, 'failed');
  assert.match(failed.sdkUploadError ?? '', /upload_interrupted/);
});

test('nonterminal upload polling is bounded and persists timeout/attempt state', async () => {
  const seeded = seedMeeting();
  let clock = Date.parse('2030-01-01T00:00:00.000Z');
  const result = await reconcile.reconcileRecallSdkUpload(
    { meetingId: seeded.record.id },
    {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 5,
      timeoutMs: 10,
      maxAttempts: 20,
      getUpload: async () => ({ id: seeded.record.sdkUploadId!, status: { code: 'uploading' } }),
    },
  );
  assert.equal(result.status, 'timed_out');
  const timedOut = meetings.loadRecallMeetingById(seeded.record.id)!;
  assert.equal(timedOut.sdkUploadStatus, 'timed_out');
  assert.equal(timedOut.canonicalStatus, 'timed_out');
  assert.equal(timedOut.sdkUploadAttempts, 2);
  assert.ok(timedOut.sdkUploadDeadlineAt);
  assert.match(timedOut.sdkUploadError ?? '', /timed out after 2 attempts/);
});

test('startup recovery finds both pending uploads and post-migration backfills', () => {
  const pending = seedMeeting();
  meetings.patchMeetingRecord(pending.record.id, {
    sdkUploadStatus: 'pending',
    sdkUploadAttempts: 3,
    sdkUploadDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const postMigration = seedMeeting({ recordingId: 'recording-restart' });
  meetings.patchMeetingRecord(postMigration.record.id, {
    sdkUploadStatus: 'complete',
    canonicalStatus: 'pending',
  });

  const terminal = seedMeeting();
  meetings.patchMeetingRecord(terminal.record.id, { sdkUploadStatus: 'failed' });

  const started: string[] = [];
  const recovered = reconcile.recoverPendingRecallSdkUploads({
    start: ({ meetingId }) => { started.push(meetingId); },
  });
  assert.deepEqual(new Set(recovered), new Set([pending.record.id, postMigration.record.id]));
  assert.deepEqual(new Set(started), new Set(recovered));
  assert.equal(recovered.includes(terminal.record.id), false);
});

test('reconciliation resumes persisted retry state after a restart', async () => {
  const seeded = seedMeeting();
  let clock = Date.parse('2031-01-01T00:00:00.000Z');
  meetings.patchMeetingRecord(seeded.record.id, {
    sdkUploadStatus: 'pending',
    sdkUploadAttempts: 4,
    sdkUploadNextAttemptAt: new Date(clock + 25).toISOString(),
    sdkUploadDeadlineAt: new Date(clock + 100).toISOString(),
  });

  const sleeps: number[] = [];
  const result = await reconcile.reconcileRecallSdkUpload(
    { meetingId: seeded.record.id },
    {
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      pollIntervalMs: 5,
      timeoutMs: 100,
      getUpload: async () => ({
        id: seeded.record.sdkUploadId!,
        status: { code: 'complete' },
        recording: { id: 'recording-after-restart' },
      }),
      backfill: async () => ({ status: 'ready', segmentCount: 0 }),
    },
  );

  assert.equal(result.status, 'complete');
  assert.deepEqual(sleeps, [25], 'persisted next-at is honored before polling');
  const resumed = meetings.loadRecallMeetingById(seeded.record.id)!;
  assert.equal(resumed.sdkUploadAttempts, 5, 'attempt counter resumes instead of resetting');
  assert.equal(resumed.recordingId, 'recording-after-restart');
  assert.equal(resumed.sdkUploadStatus, 'complete');
});

test('capture-stamped region survives settings changes for upload polling and canonical backfill', async () => {
  const seeded = seedMeeting({ sdkUploadRegion: 'eu-central-1' });
  meetings.saveRecallMeetingSettings({ region: 'us-east-1' });
  let polledRegion: RecallRegion | undefined;
  let backfillRegion: RecallRegion | undefined;

  const result = await reconcile.reconcileRecallSdkUpload(
    { meetingId: seeded.record.id },
    {
      getUpload: async (_sdkUploadId, options) => {
        polledRegion = options?.region;
        return {
          id: seeded.record.sdkUploadId!,
          status: { code: 'complete' },
          recording: { id: 'recording-pinned-region' },
        };
      },
      backfill: async (input) => {
        backfillRegion = input.region;
        return { status: 'ready', segmentCount: 0 };
      },
    },
  );

  assert.equal(result.status, 'complete');
  assert.equal(polledRegion, 'eu-central-1');
  assert.equal(backfillRegion, 'eu-central-1');
  assert.equal(meetings.loadRecallMeetingById(seeded.record.id)?.sdkUploadRegion, 'eu-central-1');
});

test('zero retention records recording id but skips unavailable post-call media', async () => {
  const seeded = seedMeeting({ retentionMode: 'zero' });
  let backfillCalls = 0;
  const result = await reconcile.reconcileRecallSdkUpload(
    { meetingId: seeded.record.id },
    {
      getUpload: async () => ({
        id: seeded.record.sdkUploadId!,
        status: { code: 'complete' },
        recording_id: 'zero-retention-recording',
      }),
      backfill: async () => { backfillCalls += 1; return { status: 'ready' }; },
    },
  );
  assert.equal(result.status, 'complete');
  assert.equal(backfillCalls, 0);
  const completed = meetings.loadRecallMeetingById(seeded.record.id)!;
  assert.equal(completed.recordingId, 'zero-retention-recording');
  assert.equal(completed.sdkUploadStatus, 'complete');
  assert.equal(completed.canonicalStatus, 'not_started');
  assert.equal(completed.analysisTaskId, undefined);
});

test('two pending uploads from one reused window reconcile independently', async () => {
  const windowId = 'sdk-reused-window';
  const first = meetings.noteRecallMeetingDetected({
    windowId,
    sdkUploadId: 'reused-upload-1',
    provider: 'recall',
    status: 'recording',
    startedAt: '2026-07-13T10:00:00.000Z',
  });
  meetings.finalizeRecallMeeting({
    windowId,
    sdkUploadId: 'reused-upload-1',
    retentionMode: 'zero',
    canonicalBackfill: false,
  });
  const second = meetings.noteRecallMeetingDetected({
    windowId,
    sdkUploadId: 'reused-upload-2',
    provider: 'recall',
    status: 'recording',
    startedAt: '2026-07-13T11:00:00.000Z',
  });
  meetings.finalizeRecallMeeting({
    windowId,
    sdkUploadId: 'reused-upload-2',
    retentionMode: 'zero',
    canonicalBackfill: false,
  });
  assert.notEqual(first.id, second.id);

  const getUpload = async (sdkUploadId: string) => ({
    id: sdkUploadId,
    status: { code: 'complete' },
    recording_id: sdkUploadId === 'reused-upload-1' ? 'reused-recording-1' : 'reused-recording-2',
  });
  const [firstResult, secondResult] = await Promise.all([
    reconcile.reconcileRecallSdkUpload({ meetingId: first.id }, { getUpload }),
    reconcile.reconcileRecallSdkUpload({ meetingId: second.id }, { getUpload }),
  ]);

  assert.equal(firstResult.recordingId, 'reused-recording-1');
  assert.equal(secondResult.recordingId, 'reused-recording-2');
  assert.equal(meetings.findRecallMeetingRecord({ recordingId: 'reused-recording-1' })?.id, first.id);
  assert.equal(meetings.findRecallMeetingRecord({ recordingId: 'reused-recording-2' })?.id, second.id);
  const records = meetings.listAllRecallMeetingRecords().filter((record) => record.windowId === windowId);
  assert.equal(records.length, 2);
});

test('explicit retry resets a terminal SDK handoff once and delegates to the bounded reconciler', () => {
  const seeded = seedMeeting();
  meetings.patchMeetingRecord(seeded.record.id, {
    sdkUploadStatus: 'timed_out',
    sdkUploadAttempts: 180,
    sdkUploadDeadlineAt: '2026-07-20T12:15:00.000Z',
    sdkUploadNextAttemptAt: '2026-07-20T12:14:55.000Z',
    sdkUploadError: 'Recall SDK upload reconciliation timed out after 180 attempts',
    canonicalStatus: 'timed_out',
    canonicalError: 'Recall SDK upload reconciliation timed out after 180 attempts',
  });

  const starts: string[] = [];
  const result = reconcile.requestRecallMeetingTranscriptRetry(seeded.record.id, {
    startSdk: ({ meetingId }) => { starts.push(meetingId); },
  });

  assert.equal(result.status, 'started');
  assert.equal(result.mode, 'sdk_upload');
  assert.deepEqual(starts, [seeded.record.id]);
  const reset = meetings.loadRecallMeetingById(seeded.record.id)!;
  assert.equal(reset.sdkUploadStatus, 'pending');
  assert.equal(reset.sdkUploadAttempts, 0);
  assert.equal(reset.sdkUploadDeadlineAt, undefined);
  assert.equal(reset.sdkUploadNextAttemptAt, undefined);
  assert.equal(reset.sdkUploadError, undefined);
  assert.equal(reset.canonicalStatus, 'pending');
  assert.equal(reset.canonicalError, undefined);
});

test('explicit retry re-runs canonical backfill after upload completion without resetting the upload', () => {
  const seeded = seedMeeting({ recordingId: 'recording-canonical-retry' });
  meetings.patchMeetingRecord(seeded.record.id, {
    sdkUploadStatus: 'complete',
    canonicalStatus: 'failed',
    canonicalError: 'canonical transcript came back empty',
  });

  const starts: string[] = [];
  const result = reconcile.requestRecallMeetingTranscriptRetry(seeded.record.id, {
    startSdk: ({ meetingId }) => { starts.push(meetingId); },
  });

  assert.equal(result.status, 'started');
  assert.equal(result.mode, 'canonical');
  assert.deepEqual(starts, [seeded.record.id]);
  const reset = meetings.loadRecallMeetingById(seeded.record.id)!;
  assert.equal(reset.sdkUploadStatus, 'complete');
  assert.equal(reset.recordingId, 'recording-canonical-retry');
  assert.equal(reset.canonicalStatus, 'pending');
  assert.equal(reset.canonicalError, undefined);
});

test('legacy recording ids retry canonical backfill even when sdkUploadStatus was never persisted', () => {
  const seeded = seedMeeting({ recordingId: 'legacy-recording-canonical-retry' });
  meetings.patchMeetingRecord(seeded.record.id, {
    sdkUploadStatus: undefined,
    canonicalStatus: 'failed',
    canonicalError: 'legacy canonical failure',
  });

  const starts: string[] = [];
  const result = reconcile.requestRecallMeetingTranscriptRetry(seeded.record.id, {
    startCanonical: (record) => { starts.push(record.id); },
  });

  assert.equal(result.status, 'started');
  assert.equal(result.mode, 'canonical');
  assert.deepEqual(starts, [seeded.record.id]);
  const reset = meetings.loadRecallMeetingById(seeded.record.id)!;
  assert.equal(reset.sdkUploadStatus, undefined);
  assert.equal(reset.recordingId, 'legacy-recording-canonical-retry');
  assert.equal(reset.canonicalStatus, 'pending');
});

test('legacy recording ids with no canonical or retention fields can retry and recover after restart', () => {
  const seeded = seedMeeting({ recordingId: 'legacy-recording-without-state' });
  meetings.patchMeetingRecord(seeded.record.id, {
    sdkUploadId: undefined,
    sdkUploadStatus: undefined,
    recallRetentionMode: undefined,
    canonicalStatus: undefined,
  });

  const requestedStarts: string[] = [];
  const requested = reconcile.requestRecallMeetingTranscriptRetry(seeded.record.id, {
    startCanonical: (record) => { requestedStarts.push(record.id); },
  });
  assert.equal(requested.status, 'started');
  assert.equal(requested.mode, 'canonical');
  assert.deepEqual(requestedStarts, [seeded.record.id]);
  assert.equal(meetings.loadRecallMeetingById(seeded.record.id)?.canonicalStatus, 'pending');

  const recoveredStarts: string[] = [];
  const recovered = reconcile.recoverPendingRecallSdkUploads({
    start: () => undefined,
    startCanonical: (record) => { recoveredStarts.push(record.id); },
  });
  assert.ok(recovered.includes(seeded.record.id));
  assert.ok(recoveredStarts.includes(seeded.record.id));
});

test('a synchronous retry starter failure restores an honest terminal state', () => {
  const seeded = seedMeeting();
  meetings.patchMeetingRecord(seeded.record.id, {
    sdkUploadStatus: 'timed_out',
    sdkUploadAttempts: 180,
    sdkUploadError: 'original timeout',
    canonicalStatus: 'timed_out',
    canonicalError: 'original timeout',
  });

  const result = reconcile.requestRecallMeetingTranscriptRetry(seeded.record.id, {
    startSdk: () => { throw new Error('worker dispatch unavailable'); },
  });

  assert.equal(result.status, 'start_failed');
  assert.match(result.reason ?? '', /worker dispatch unavailable/);
  const failed = meetings.loadRecallMeetingById(seeded.record.id)!;
  assert.equal(failed.sdkUploadStatus, 'failed');
  assert.equal(failed.canonicalStatus, 'failed');
  assert.match(failed.sdkUploadError ?? '', /worker dispatch unavailable/);
  assert.match(failed.canonicalError ?? '', /worker dispatch unavailable/);
});

test('an immediate duplicate retry joins the active worker instead of becoming not-retryable', () => {
  const seeded = seedMeeting();
  meetings.patchMeetingRecord(seeded.record.id, {
    sdkUploadStatus: 'timed_out',
    sdkUploadError: 'original timeout',
    canonicalStatus: 'timed_out',
    canonicalError: 'original timeout',
  });

  let active = false;
  let starts = 0;
  const options = {
    isSdkActive: () => active,
    startSdk: () => {
      starts += 1;
      active = true;
    },
  };
  const first = reconcile.requestRecallMeetingTranscriptRetry(seeded.record.id, options);
  const second = reconcile.requestRecallMeetingTranscriptRetry(seeded.record.id, options);

  assert.equal(first.status, 'started');
  assert.equal(second.status, 'already_running');
  assert.equal(starts, 1);
});

test('a pending direct canonical retry is recovered after a daemon restart', () => {
  const seeded = meetings.finalizeRecallMeeting({
    windowId: 'legacy-direct-restart-window',
    recordingId: 'legacy-direct-restart-recording',
    retentionMode: 'timed',
    canonicalBackfill: true,
  });
  meetings.patchMeetingRecord(seeded.record.id, {
    canonicalStatus: 'failed',
    canonicalError: 'temporary canonical failure',
  });
  const requested = reconcile.requestRecallMeetingTranscriptRetry(seeded.record.id, {
    startCanonical: () => { /* simulate process exit before worker ownership */ },
  });
  assert.equal(requested.status, 'started');
  assert.equal(meetings.loadRecallMeetingById(seeded.record.id)?.canonicalStatus, 'pending');

  const canonicalStarts: string[] = [];
  const recovered = reconcile.recoverPendingRecallSdkUploads({
    start: () => undefined,
    startCanonical: (record) => { canonicalStarts.push(record.id); },
  });
  assert.ok(recovered.includes(seeded.record.id));
  assert.ok(canonicalStarts.includes(seeded.record.id));
});

test('explicit retry rejects local, healthy, and already-running meetings without dispatching', () => {
  const healthy = seedMeeting({ recordingId: 'recording-healthy-no-retry' });
  meetings.patchMeetingRecord(healthy.record.id, {
    sdkUploadStatus: 'complete',
    canonicalStatus: 'ready',
    segments: [{
      id: 'healthy-segment',
      windowId: healthy.record.windowId,
      recordingId: 'recording-healthy-no-retry',
      event: 'transcript.canonical',
      text: 'Already transcribed.',
      timestamp: healthy.record.startedAt,
      isFinal: true,
    }],
  });

  let starts = 0;
  const notRetryable = reconcile.requestRecallMeetingTranscriptRetry(healthy.record.id, {
    startSdk: () => { starts += 1; },
  });
  assert.equal(notRetryable.status, 'not_retryable');

  meetings.patchMeetingRecord(healthy.record.id, {
    canonicalStatus: 'failed',
    canonicalError: 'temporary failure',
    segments: [],
  });
  const alreadyRunning = reconcile.requestRecallMeetingTranscriptRetry(healthy.record.id, {
    isSdkActive: () => true,
    startSdk: () => { starts += 1; },
  });
  assert.equal(alreadyRunning.status, 'already_running');
  assert.equal(starts, 0);
  assert.equal(
    meetings.loadRecallMeetingById(healthy.record.id)?.canonicalStatus,
    'failed',
    'an already-running response must not rewrite durable progress',
  );
});
