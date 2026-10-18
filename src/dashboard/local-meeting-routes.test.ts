import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-local-routes-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';

const { registerConsoleRoutes } = await import('./console-routes.js');
const local = await import('../integrations/local-meetings/meeting-capture.js');
const recall = await import('../integrations/recall/meeting-capture.js');

test.after(() => {
  local._setLocalMeetingTranscriberForTests(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

async function boot(authorized: { value: boolean }) {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized.value, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test('local meeting routes require auth and complete the start → ingest → history lifecycle', async () => {
  const authorized = { value: false };
  const harness = await boot(authorized);
  try {
    assert.equal((await fetch(`${harness.url}/api/console/meetings/local/status`)).status, 401);
    assert.equal((await fetch(`${harness.url}/api/console/meetings/local/start`, json('POST', { sessionId: 'route-test-123' }))).status, 401);
    assert.equal((await fetch(`${harness.url}/api/console/meetings/local/retry`, json('POST', { meetingId: 'anything' }))).status, 401);
    assert.equal((await fetch(`${harness.url}/api/console/meetings/recall/anything/retry-transcript`, json('POST'))).status, 401);

    authorized.value = true;
    assert.equal((await fetch(`${harness.url}/api/console/meetings/local/retry`, json('POST', {}))).status, 400);
    assert.equal((await fetch(`${harness.url}/api/console/meetings/recall/missing/retry-transcript`, json('POST'))).status, 404);
    recall.noteRecallMeetingDetected({ windowId: 'route-recall-ready', status: 'recording' });
    recall.appendRecallTranscriptSegment({
      windowId: 'route-recall-ready',
      event: 'transcript.data',
      text: 'This live transcript is already usable.',
      isFinal: true,
    });
    const readyRecall = recall.finalizeRecallMeeting({
      windowId: 'route-recall-ready',
      retentionMode: 'zero',
      canonicalBackfill: false,
    });
    const healthyRetry = await fetch(
      `${harness.url}/api/console/meetings/recall/${encodeURIComponent(readyRecall.record.id)}/retry-transcript`,
      json('POST'),
    );
    assert.equal(healthyRetry.status, 409, 'a healthy transcript cannot start duplicate recovery work');
    const healthyRetryBody = await healthyRetry.json() as Record<string, unknown>;
    assert.equal('record' in healthyRetryBody, false, 'retry responses never echo a potentially large transcript record');
    assert.equal((await fetch(`${harness.url}/api/console/meetings/recall/upload-token`, json('POST', {
      region: 'invalid-region',
    }))).status, 400);
    assert.equal((await fetch(`${harness.url}/api/console/meetings/recall/upload-token`, json('POST', {
      region: 'constructor',
    }))).status, 400, 'prototype properties are not valid Recall regions');
    const enabledResponse = await fetch(`${harness.url}/api/console/meetings/local/settings`, json('PATCH', {
      enabled: true,
      analyzeOnComplete: false,
      keepAudio: true,
    }));
    assert.equal(enabledResponse.status, 200);

    // A partial PATCH must not reset the enabled/analyze flags.
    const partial = await (await fetch(`${harness.url}/api/console/meetings/local/settings`, json('PATCH', {
      language: 'en_US',
    }))).json() as { settings: { enabled: boolean; analyzeOnComplete: boolean; language: string } };
    assert.equal(partial.settings.enabled, true);
    assert.equal(partial.settings.analyzeOnComplete, false);
    assert.equal(partial.settings.language, 'en');

    local._setLocalMeetingTranscriberForTests(async () => ({
      text: 'Route-level local transcript',
      segments: [{ text: 'Route-level local transcript', startSeconds: 0, endSeconds: 1 }],
      model: 'base.en',
      language: 'en',
    }));
    const startedResponse = await fetch(`${harness.url}/api/console/meetings/local/start`, json('POST', {
      sessionId: 'route-test-123',
      title: 'Route test',
      sampleRate: 16_000,
      channels: 1,
    }));
    assert.equal(startedResponse.status, 200);
    const started = await startedResponse.json() as { audioPath: string; record: { id: string; provider: string } };
    assert.equal(started.record.provider, 'local');
    writeFileSync(started.audioPath, Buffer.from('RIFF fake route audio'));

    const ingestResponse = await fetch(`${harness.url}/api/console/meetings/local/ingest`, json('POST', {
      sessionId: 'route-test-123',
      audioPath: started.audioPath,
      durationSeconds: 1,
    }));
    assert.equal(ingestResponse.status, 202);

    let status: { record?: { transcriptionStatus?: string } } = {};
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      status = await (await fetch(`${harness.url}/api/console/meetings/local/status?sessionId=route-test-123`)).json() as typeof status;
      if (status.record?.transcriptionStatus === 'ready') break;
      await delay(20);
    }
    assert.equal(status.record?.transcriptionStatus, 'ready');

    const history = await (await fetch(`${harness.url}/api/console/meetings/recall/recent`)).json() as {
      meetings: Array<{ id: string; provider?: string; transcriptionStatus?: string }>;
    };
    const meeting = history.meetings.find((candidate) => candidate.id === started.record.id);
    assert.equal(meeting?.provider, 'local');
    assert.equal(meeting?.transcriptionStatus, 'ready');

    const cancellable = await (await fetch(`${harness.url}/api/console/meetings/local/start`, json('POST', {
      sessionId: 'route-cancel-456',
    }))).json() as { record: { id: string } };
    const cancelled = await fetch(`${harness.url}/api/console/meetings/local/cancel`, json('POST', {
      sessionId: 'route-cancel-456',
    }));
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { meetingId?: string }).meetingId, cancellable.record.id);
  } finally {
    await harness.close();
  }
});


test('Recall final ingress acknowledges only exact persisted events, even if optional assistance is corrupt', async () => {
  const harness = await boot({ value: true });
  const record = recall.noteRecallMeetingDetected({ windowId: 'controlled-final-route-window', sdkUploadId: 'controlled-final-route-upload', status: 'recording' });
  const assistanceDirectory = path.join(TMP_HOME, 'state', 'meeting-capture', 'assistance');
  mkdirSync(assistanceDirectory, { recursive: true });
  const statePath = path.join(assistanceDirectory, `${createHash('sha256').update(JSON.stringify(record.id)).digest('hex')}.json`);
  writeFileSync(statePath, '{ controlled corrupt optional state');
  const payload = { windowId: record.windowId, sdkUploadId: record.sdkUploadId, eventId: `recall-final-${'d'.repeat(64)}`, eventIdentity: 'sdk',
    event: 'transcript.data', text: 'Controlled final persisted content', isFinal: true };
  try {
    const send = () => fetch(`${harness.url}/api/console/meetings/recall/transcript-event`, json('POST', payload));
    const accepted = await send(); assert.equal(accepted.status, 200);
    const ack = await accepted.json() as Record<string, unknown>;
    assert.equal(ack.status, 'accepted'); assert.equal(ack.meetingId, record.id); assert.equal(ack.segmentCount, 1);
    assert.equal('record' in ack, false); assert.equal(JSON.stringify(ack).includes(payload.text), false);
    const repeated = await send(); assert.equal((await repeated.json() as { status: string }).status, 'duplicate');
    assert.equal(recall.loadRecallMeetingById(record.id)!.segments.length, 1);
    const unknown = await fetch(`${harness.url}/api/console/meetings/recall/transcript-event`, json('POST', { ...payload, sdkUploadId: 'foreign-upload' }));
    assert.equal((await unknown.json() as { status: string }).status, 'ignored');
    assert.equal(readFileSync(statePath, 'utf8'), '{ controlled corrupt optional state');
  } finally { await harness.close(); }
});

test('delivery status updates are authenticated exact-capture metadata and never restart a completed meeting', async () => {
  const auth = { value: false }; const harness = await boot(auth);
  const record = recall.noteRecallMeetingDetected({ windowId: 'controlled-delivery-route', sdkUploadId: 'controlled-delivery-upload', status: 'recording' });
  const payload = { windowId: record.windowId, sdkUploadId: record.sdkUploadId, unresolvedFinalCount: 1 };
  const route = `${harness.url}/api/console/meetings/recall/transcript-delivery-status`;
  try {
    assert.equal((await fetch(route, json('POST', payload))).status, 401); auth.value = true;
    for (const invalid of [{ ...payload, unresolvedFinalCount: -1 }, { ...payload, unresolvedFinalCount: 1.5 }, { ...payload, text: 'not accepted' }]) {
      assert.equal((await fetch(route, json('POST', invalid))).status, 400);
    }
    recall.finalizeRecallMeeting({ windowId: record.windowId, sdkUploadId: record.sdkUploadId, retentionMode: 'zero', canonicalBackfill: false });
    const changed = await fetch(route, json('POST', payload));
    assert.equal(changed.status, 200); const ack = await changed.json() as Record<string, unknown>;
    assert.equal(ack.status, 'updated'); assert.equal('record' in ack, false);
    assert.deepEqual(recall.loadRecallMeetingById(record.id)!.liveTranscriptDelivery, { status: 'incomplete', failedFinalCount: 1 });
    assert.equal(recall.loadRecallMeetingById(record.id)!.status, 'completed');
    const foreign = await fetch(route, json('POST', { ...payload, windowId: 'foreign-window', unresolvedFinalCount: 0 }));
    assert.equal((await foreign.json() as { status: string }).status, 'ignored');
    assert.equal(recall.loadRecallMeetingById(record.id)!.liveTranscriptDelivery!.failedFinalCount, 1);
    await fetch(route, json('POST', { ...payload, unresolvedFinalCount: 0 }));
    assert.equal(recall.loadRecallMeetingById(record.id)!.liveTranscriptDelivery, undefined);
  } finally { await harness.close(); }
});

test('Recall routes retain the exact upload-bound native recording epoch without rewriting history timestamps', async () => {
  const auth = { value: false }; const harness = await boot(auth);
  const windowId = 'route-canonical-epoch-fixture'; const sdkUploadId = 'route-canonical-epoch-upload';
  // Deterministically newest within this disposable test home; no wall-clock or
  // history fixture can make the status endpoint choose a different record.
  const detectedAt = '2099-10-18T10:00:00.000Z'; const recordingStartedAt = '2099-10-18T10:02:00.123Z';
  const placeholder = recall.noteRecallMeetingDetected({ windowId, startedAt: detectedAt, status: 'detected' });
  const route = `${harness.url}/api/console/meetings/recall/detected`;
  const payload = { windowId, sdkUploadId, recordingStartedAt, status: 'recording' };
  try {
    assert.equal((await fetch(route, json('POST', payload))).status, 401);
    auth.value = true;
    const response = await fetch(route, json('POST', payload)); assert.equal(response.status, 200);
    const body = await response.json() as { record: { id: string; startedAt: string; recordingStartedAt?: string } };
    assert.equal(body.record.id, placeholder.id); assert.equal(body.record.startedAt, detectedAt);
    assert.equal(body.record.recordingStartedAt, recordingStartedAt);
    const before = JSON.stringify(recall.loadRecallMeetingById(placeholder.id));
    assert.equal((await fetch(route, json('POST', payload))).status, 200, 'same exact epoch replay is valid');
    const conflict = await fetch(route, json('POST', { ...payload, recordingStartedAt: '2099-10-18T10:02:00.124Z', title: 'Must not save' }));
    assert.equal(conflict.status, 409);
    for (const invalid of ['', '2099-02-30T10:00:00.000Z', '2099-10-18T10:00:00Z', null, 1]) {
      assert.equal((await fetch(route, json('POST', { ...payload, recordingStartedAt: invalid }))).status, 400);
    }
    assert.equal((await fetch(route, json('POST', { windowId, recordingStartedAt }))).status, 400, 'window-only requests cannot establish capture identity');
    assert.equal(JSON.stringify(recall.loadRecallMeetingById(placeholder.id)), before, 'rejections never change a retained record');
    const status = await (await fetch(`${harness.url}/api/console/meetings/recall`)).json() as Record<string, unknown>;
    assert.equal(status.activeMeetingId, placeholder.id); assert.equal(status.activeWindowId, windowId);
    assert.equal(status.activeStartedAt, detectedAt); assert.equal(status.activeRecordingStartedAt, recordingStartedAt);
    const recent = await (await fetch(`${harness.url}/api/console/meetings/recall/recent`)).json() as { meetings: Array<{ id: string; recordingStartedAt?: string }> };
    assert.equal(recent.meetings.find(row => row.id === placeholder.id)?.recordingStartedAt, recordingStartedAt);
    const detail = await (await fetch(`${harness.url}/api/console/meetings/recall/${placeholder.id}`)).json() as typeof body;
    assert.equal(detail.record.recordingStartedAt, recordingStartedAt); assert.equal(detail.record.startedAt, detectedAt);
  } finally { await harness.close(); }
});
