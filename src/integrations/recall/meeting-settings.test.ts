import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-recall-settings-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const meetings = await import('./meeting-capture.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('Recall settings preserve omitted booleans and bound timed retention', () => {
  meetings.saveRecallMeetingSettings({
    enabled: true,
    autoRecord: true,
    liveTranscript: true,
    analyzeOnComplete: false,
    retentionMode: 'timed',
    retentionHours: 24,
  });
  const updated = meetings.saveRecallMeetingSettings({ region: 'eu-central-1' });
  assert.equal(updated.enabled, true);
  assert.equal(updated.autoRecord, true);
  assert.equal(updated.liveTranscript, true);
  assert.equal(updated.analyzeOnComplete, false);
  assert.equal(updated.region, 'eu-central-1');
  assert.equal(updated.retentionHours, 24);

  assert.equal(meetings.saveRecallMeetingSettings({ retentionHours: 10_000 }).retentionHours, 24 * 30);
});

test('Create SDK Upload body always has explicit timed or zero retention', () => {
  const timed = meetings.buildRecallSdkUploadBody({}, {
    ...meetings.DEFAULT_RECALL_MEETING_SETTINGS,
    retentionMode: 'timed',
    retentionHours: 24,
  });
  assert.deepEqual(timed, {
    recording_config: { retention: { type: 'timed', hours: 24 } },
  });

  const zero = meetings.buildRecallSdkUploadBody({ liveTranscript: true }, {
    ...meetings.DEFAULT_RECALL_MEETING_SETTINGS,
    retentionMode: 'zero',
  }) as { recording_config: { retention: unknown; transcript?: unknown } };
  assert.equal(zero.recording_config.retention, null);
  assert.ok(zero.recording_config.transcript, 'zero retention still supports real-time transcription');
});

test('zero retention enforces realtime transcript delivery', () => {
  const settings = meetings.saveRecallMeetingSettings({
    retentionMode: 'zero',
    liveTranscript: false,
  });
  assert.equal(settings.retentionMode, 'zero');
  assert.equal(settings.liveTranscript, true);

  const body = meetings.buildRecallSdkUploadBody({ liveTranscript: false }, settings) as {
    recording_config: { retention: unknown; transcript?: unknown; realtime_endpoints?: unknown[] };
  };
  assert.equal(body.recording_config.retention, null);
  assert.ok(body.recording_config.transcript);
  assert.ok(body.recording_config.realtime_endpoints?.length);
});

test('SDK upload id is persisted separately and cannot trigger canonical backfill', () => {
  const record = meetings.noteRecallMeetingDetected({
    windowId: 'sdk-upload-only',
    sdkUploadId: 'upload-123',
    sdkUploadRegion: 'eu-central-1',
    provider: 'recall',
    status: 'recording',
  });
  assert.equal(record.sdkUploadId, 'upload-123');
  assert.equal(record.recordingId, undefined);
  const finalized = meetings.finalizeRecallMeeting({
    windowId: record.windowId,
    // A settings/UI change after capture must not move an existing upload.
    sdkUploadRegion: 'us-east-1',
  });
  assert.equal(finalized.record.sdkUploadId, 'upload-123');
  assert.equal(finalized.record.sdkUploadRegion, 'eu-central-1');
  assert.equal(finalized.record.recordingId, undefined);
  assert.equal(finalized.record.canonicalStatus, 'not_started');
});

test('zero-retention Recall recording never enters pending canonical state', () => {
  const finalized = meetings.finalizeRecallMeeting({
    windowId: 'zero-retention',
    recordingId: 'recording-123',
    canonicalBackfill: false,
  });
  assert.equal(finalized.record.canonicalStatus, 'not_started');
});

test('capture-stamped retention cannot be overwritten before completion', () => {
  const detected = meetings.noteRecallMeetingDetected({
    windowId: 'retention-pinned-window',
    sdkUploadId: 'retention-pinned-upload',
    recallRetentionMode: 'zero',
    recallRetentionHours: 12,
    status: 'recording',
  });
  const finalized = meetings.finalizeRecallMeeting({
    windowId: detected.windowId,
    recordingId: 'retention-pinned-recording',
    retentionMode: 'timed',
    retentionHours: 48,
    canonicalBackfill: true,
  });
  assert.equal(finalized.record.recallRetentionMode, 'zero');
  assert.equal(finalized.record.recallRetentionHours, 12);
  assert.equal(finalized.record.canonicalStatus, 'not_started');
});

test('Create SDK Upload uses a capture-scoped region without mutating the default', async () => {
  const previousKey = process.env.RECALL_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.RECALL_API_KEY = 'test-recall-key';
  meetings.saveRecallMeetingSettings({
    enabled: true,
    region: 'us-west-2',
    retentionMode: 'timed',
    retentionHours: 12,
  });
  let requestedUrl = '';
  let requestedBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: 'atomic-region-upload', upload_token: 'atomic-region-token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const upload = await meetings.createRecallSdkUpload({ region: 'eu-central-1' });
    assert.equal(upload.region, 'eu-central-1');
    assert.equal(upload.apiUrl, meetings.RECALL_REGIONS['eu-central-1']);
    assert.equal(requestedUrl, `${meetings.RECALL_REGIONS['eu-central-1']}/api/v1/sdk_upload/`);
    assert.deepEqual(requestedBody, {
      recording_config: { retention: { type: 'timed', hours: 12 } },
    });
    assert.equal(meetings.loadRecallMeetingSettings().region, 'us-west-2');
    await assert.rejects(
      meetings.createRecallSdkUpload({ region: 'not-a-region' as never }),
      /Unsupported Recall region/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.RECALL_API_KEY;
    else process.env.RECALL_API_KEY = previousKey;
  }
});
