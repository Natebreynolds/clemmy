/**
 * Run with: npx tsx --test apps/desktop/src/recall-capture.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { getRecallPlatformSupport, RecallDesktopCapture } from './recall-capture.js';

test('Recall native capture supports only Apple Silicon macOS and x64 Windows', () => {
  assert.deepEqual(getRecallPlatformSupport('darwin', 'arm64'), {
    supported: true,
    platform: 'darwin',
    arch: 'arm64',
  });
  assert.deepEqual(getRecallPlatformSupport('win32', 'x64'), {
    supported: true,
    platform: 'win32',
    arch: 'x64',
  });

  const intelMac = getRecallPlatformSupport('darwin', 'x64');
  assert.equal(intelMac.supported, false);
  assert.match(intelMac.message ?? '', /Apple Silicon Mac/);
  assert.match(intelMac.message ?? '', /Intel Macs/);

  const armWindows = getRecallPlatformSupport('win32', 'arm64');
  assert.equal(armWindows.supported, false);
  assert.match(armWindows.message ?? '', /x64/);

  const linux = getRecallPlatformSupport('linux', 'x64');
  assert.equal(linux.supported, false);
  assert.match(linux.message ?? '', /not available/);
});

test('unsupported Intel Macs return a clear status without importing the SDK', async () => {
  const events: Array<Record<string, unknown>> = [];
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => '',
    getWebhookToken: () => '',
    emit: (event) => events.push(event),
    runtime: { platform: 'darwin', arch: 'x64' },
  });

  const status = await capture.configure({ enabled: true });
  assert.equal(status.enabled, true);
  assert.equal(status.sdkAvailable, false);
  assert.equal(status.initialized, false);
  assert.equal(status.platformSupport.supported, false);
  assert.match(status.lastError ?? '', /Apple Silicon Mac/);
  assert.equal(events.at(-1)?.type, 'unsupported-platform');

  await assert.rejects(
    capture.startManualRecording(),
    /Apple Silicon Mac/,
  );
});

test('new Recall lifecycle events update diagnostic status and are forwarded', async () => {
  const emitted: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => '',
    getWebhookToken: () => '',
    emit: (event) => emitted.push(event),
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => null,
    startRecording: async () => null,
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);

  await capture.configure({ enabled: true });
  for (const eventType of [
    'meeting-updated',
    'network-status',
    'media-capture-status',
    'compliance-message-status',
    'shutdown',
  ]) {
    assert.equal(listeners.has(eventType), true, `${eventType} listener should be registered`);
  }

  listeners.get('meeting-updated')?.({
    window: { id: 'meeting-1', platform: 'zoom', title: 'Roadmap review' },
  });
  listeners.get('network-status')?.({ status: 'disconnected' });
  listeners.get('media-capture-status')?.({
    window: { id: 'meeting-1', platform: 'zoom' },
    type: 'audio',
    capturing: true,
  });
  listeners.get('compliance-message-status')?.({
    window: { id: 'meeting-1', platform: 'zoom' },
    status: 'sent',
  });

  let status = capture.status();
  assert.equal(status.detectedWindows[0]?.title, 'Roadmap review');
  assert.equal(status.networkStatus, 'disconnected');
  assert.deepEqual(status.mediaCaptureStatuses['meeting-1'], { audio: true });
  assert.equal(status.complianceMessageStatuses['meeting-1'], 'sent');
  assert.equal(emitted.some((event) => event.type === 'meeting-updated'), true);

  Reflect.set(capture, 'recording', true);
  Reflect.set(capture, 'currentWindowId', 'meeting-1');
  listeners.get('shutdown')?.({ code: 9, signal: 'SIGKILL' });
  status = capture.status();
  assert.equal(status.recording, false);
  assert.equal(status.lastEvent, 'shutdown');
  assert.match(status.lastError ?? '', /stopped unexpectedly/);
  assert.equal(emitted.at(-1)?.type, 'shutdown');
});

test('SDK upload id is never treated as the canonical Recall recording id', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const daemonCalls: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => null,
    startRecording: async () => null,
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string, body: Record<string, unknown>) => {
    daemonCalls.push({ pathname, body });
    if (pathname.endsWith('/upload-token')) {
      return {
        uploadToken: 'upload-token',
        sdkUploadId: 'sdk-upload-123',
        id: 'sdk-upload-123',
        region: 'eu-central-1',
      };
    }
    return {};
  });

  await capture.configure({ enabled: true, liveTranscript: true, region: 'eu-central-1' });
  await capture.recordDetectedWindow('meeting-window-1');
  const detected = daemonCalls.find((call) => call.pathname.endsWith('/detected'));
  assert.equal(detected?.body.sdkUploadId, 'sdk-upload-123');
  assert.equal(detected?.body.sdkUploadRegion, 'eu-central-1');
  assert.equal(detected?.body.recordingId, undefined);

  // Changing the default while a capture is in progress must not retarget
  // this upload's later reconciliation to a different data region.
  await capture.configure({ enabled: true, liveTranscript: true, region: 'us-east-1' });

  listeners.get('realtime-event')?.({
    event: 'transcript.partial_data',
    window: { id: 'meeting-window-1' },
    data: { text: 'Interim words', recording_id: 'rec-canonical-456' },
  });
  listeners.get('realtime-event')?.({
    event: 'transcript.data',
    window: { id: 'meeting-window-1' },
    data: { text: 'Final words', recording_id: 'rec-canonical-456' },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const transcript = daemonCalls.find((call) => call.pathname.endsWith('/transcript-event'));
  assert.equal(transcript?.body.sdkUploadId, 'sdk-upload-123');
  assert.equal(transcript?.body.recordingId, 'rec-canonical-456');
  await capture.stopRecording();

  const completed = daemonCalls.find((call) => call.pathname.endsWith('/complete'));
  assert.equal(completed?.body.sdkUploadId, 'sdk-upload-123');
  assert.equal(completed?.body.sdkUploadRegion, 'eu-central-1');
  assert.equal(completed?.body.recordingId, 'rec-canonical-456');
  assert.notEqual(completed?.body.recordingId, 'sdk-upload-123');
});

test('synchronous SDK transcript and end events retain the pending upload context', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const daemonCalls: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => null,
    startRecording: async ({ windowId }: { windowId: string }) => {
      listeners.get('realtime-event')?.({
        event: 'transcript.partial_data',
        window: { id: windowId },
        data: { text: 'The first words', recording_id: 'rec-sync-1' },
      });
      listeners.get('recording-ended')?.({ window: { id: windowId, platform: 'zoom' } });
      return null;
    },
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string, body: Record<string, unknown>) => {
    daemonCalls.push({ pathname, body });
    if (pathname.endsWith('/upload-token')) {
      return {
        uploadToken: 'token-sync-1',
        sdkUploadId: 'upload-sync-1',
        region: 'us-east-1',
        retentionMode: 'zero',
        retentionHours: 1,
      };
    }
    return {};
  });

  await capture.configure({ enabled: true, region: 'us-east-1' });
  await capture.recordDetectedWindow('window-sync-1');
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(capture.status().recording, false);
  const completeCalls = daemonCalls.filter((call) => call.pathname.endsWith('/complete'));
  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0]?.body.sdkUploadId, 'upload-sync-1');
  assert.equal(completeCalls[0]?.body.sdkUploadRegion, 'us-east-1');
  assert.equal(completeCalls[0]?.body.recallRetentionMode, 'zero');
  assert.equal(completeCalls[0]?.body.recallRetentionHours, 1);
  assert.equal(completeCalls[0]?.body.recordingId, 'rec-sync-1');
});

test('manual stop owns a synchronous recording-ended echo and preserves later id enrichment', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const daemonCalls: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  let shutdownCalls = 0;
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => { shutdownCalls += 1; return null; },
    startRecording: async () => null,
    stopRecording: async ({ windowId }: { windowId: string }) => {
      listeners.get('recording-ended')?.({ window: { id: windowId } });
      listeners.get('realtime-event')?.({
        event: 'transcript.partial_data',
        window: { id: windowId },
        data: { text: 'Final id arrived while stopping', recording_id: 'rec-stop-1' },
      });
      return null;
    },
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string, body: Record<string, unknown>) => {
    daemonCalls.push({ pathname, body });
    if (pathname.endsWith('/upload-token')) {
      return {
        uploadToken: 'token-stop-1',
        sdkUploadId: 'upload-stop-1',
        region: 'us-east-1',
        retentionMode: 'timed',
        retentionHours: 6,
      };
    }
    return {};
  });

  await capture.configure({ enabled: true, region: 'us-east-1' });
  await capture.recordDetectedWindow('window-stop-1');
  await capture.configure({ enabled: true, region: 'eu-central-1' });
  assert.equal(shutdownCalls, 0, 'region reinitialization must wait for the active capture');
  await capture.stopRecording();
  listeners.get('recording-ended')?.({ window: { id: 'window-stop-1' } });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const completeCalls = daemonCalls.filter((call) => call.pathname.endsWith('/complete'));
  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0]?.body.sdkUploadId, 'upload-stop-1');
  assert.equal(completeCalls[0]?.body.sdkUploadRegion, 'us-east-1');
  assert.equal(completeCalls[0]?.body.recallRetentionMode, 'timed');
  assert.equal(completeCalls[0]?.body.recallRetentionHours, 6);
  assert.equal(completeCalls[0]?.body.recordingId, 'rec-stop-1');
});

test('two sequential captures in the same window each complete by SDK upload session', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const daemonCalls: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  let uploadNumber = 0;
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => null,
    startRecording: async () => null,
    stopRecording: async ({ windowId }: { windowId: string }) => {
      listeners.get('recording-ended')?.({ window: { id: windowId } });
      return null;
    },
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string, body: Record<string, unknown>) => {
    daemonCalls.push({ pathname, body });
    if (pathname.endsWith('/upload-token')) {
      uploadNumber += 1;
      return {
        uploadToken: `token-${uploadNumber}`,
        sdkUploadId: `upload-${uploadNumber}`,
        region: 'us-west-2',
        retentionMode: 'timed',
        retentionHours: 24,
      };
    }
    return {};
  });

  await capture.configure({ enabled: true, region: 'us-west-2' });
  await capture.recordDetectedWindow('reused-window');
  await capture.stopRecording();
  await capture.recordDetectedWindow('reused-window');
  await capture.stopRecording();

  const completeCalls = daemonCalls.filter((call) => call.pathname.endsWith('/complete'));
  assert.deepEqual(
    completeCalls.map((call) => call.body.sdkUploadId),
    ['upload-1', 'upload-2'],
  );
});

test('concurrent starts share one same-window handshake and reject another window', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  let resolveUpload!: (value: Record<string, unknown>) => void;
  const uploadResponse = new Promise<Record<string, unknown>>((resolve) => { resolveUpload = resolve; });
  let uploadCalls = 0;
  let nativeStartCalls = 0;
  let detectedRecordingCalls = 0;
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => null,
    startRecording: async () => { nativeStartCalls += 1; return null; },
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string, body: Record<string, unknown>) => {
    if (pathname.endsWith('/upload-token')) {
      uploadCalls += 1;
      return uploadResponse;
    }
    if (pathname.endsWith('/detected') && body.status === 'recording') detectedRecordingCalls += 1;
    return {};
  });

  await capture.configure({ enabled: true, region: 'us-west-2' });
  const first = capture.recordDetectedWindow('window-concurrent');
  const sameWindow = capture.recordDetectedWindow('window-concurrent');
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    capture.recordDetectedWindow('window-other'),
    /already starting a recording/,
  );
  resolveUpload({
    uploadToken: 'token-concurrent',
    sdkUploadId: 'upload-concurrent',
    region: 'us-west-2',
    retentionMode: 'timed',
    retentionHours: 24,
  });
  await Promise.all([first, sameWindow]);

  assert.equal(uploadCalls, 1);
  assert.equal(nativeStartCalls, 1);
  assert.equal(detectedRecordingCalls, 1);
});

test('a failed native start rolls back pending ids and permits a clean retry', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const daemonCalls: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  let nativeAttempts = 0;
  let uploadAttempts = 0;
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => null,
    startRecording: async ({ windowId }: { windowId: string }) => {
      nativeAttempts += 1;
      if (nativeAttempts === 1) {
        listeners.get('realtime-event')?.({
          event: 'transcript.partial_data',
          window: { id: windowId },
          data: { text: 'Should be rolled back', recording_id: 'rec-failed-start' },
        });
        throw new Error('native start failed');
      }
      return null;
    },
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string, body: Record<string, unknown>) => {
    daemonCalls.push({ pathname, body });
    if (pathname.endsWith('/upload-token')) {
      uploadAttempts += 1;
      return {
        uploadToken: `retry-token-${uploadAttempts}`,
        sdkUploadId: `retry-upload-${uploadAttempts}`,
        region: 'us-west-2',
        retentionMode: 'timed',
        retentionHours: 24,
      };
    }
    return {};
  });

  await capture.configure({ enabled: true, region: 'us-west-2' });
  await assert.rejects(capture.recordDetectedWindow('retry-window'), /native start failed/);
  assert.equal(capture.status().recording, false);
  assert.equal(capture.status().currentWindowId, undefined);

  await capture.recordDetectedWindow('retry-window');
  await capture.stopRecording();
  const completeCalls = daemonCalls.filter((call) => call.pathname.endsWith('/complete'));
  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0]?.body.sdkUploadId, 'retry-upload-2');
  assert.equal(completeCalls[0]?.body.recordingId, undefined);
});

test('prepareForShutdown drains a start-in-flight through native stop and daemon completion', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const calls: string[] = [];
  let resolveUpload!: (value: Record<string, unknown>) => void;
  const upload = new Promise<Record<string, unknown>>((resolve) => { resolveUpload = resolve; });
  let resolveComplete!: (value: Record<string, unknown>) => void;
  const completion = new Promise<Record<string, unknown>>((resolve) => { resolveComplete = resolve; });
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => { calls.push('sdk-shutdown'); return null; },
    startRecording: async () => { calls.push('native-start'); return null; },
    stopRecording: async () => { calls.push('native-stop'); return null; },
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string) => {
    calls.push(pathname);
    if (pathname.endsWith('/upload-token')) return upload;
    if (pathname.endsWith('/complete')) return completion;
    return {};
  });

  await capture.configure({ enabled: true, region: 'us-west-2' });
  const starting = capture.recordDetectedWindow('shutdown-start-window');
  await new Promise<void>((resolve) => setImmediate(resolve));

  let prepared = false;
  const preparing = capture.prepareForShutdown().then(() => { prepared = true; });
  await assert.rejects(
    capture.recordDetectedWindow('shutdown-other-window'),
    /preparing to shut down/,
  );
  assert.equal(prepared, false);
  assert.equal(calls.includes('native-start'), false);

  resolveUpload({
    uploadToken: 'shutdown-token',
    sdkUploadId: 'shutdown-upload',
    region: 'us-west-2',
    retentionMode: 'timed',
    retentionHours: 24,
  });
  await starting;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.includes('native-start'), true);
  assert.equal(calls.includes('native-stop'), true);
  assert.equal(calls.some((value) => value.endsWith('/complete')), true);
  assert.equal(prepared, false, 'daemon completion still owns the shutdown drain');

  resolveComplete({ ok: true });
  await preparing;
  assert.equal(prepared, true);
  assert.equal(capture.status().recording, false);
});

test('prepareForShutdown waits for a natural recording-ended completion after visible state clears', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  let resolveComplete!: (value: Record<string, unknown>) => void;
  const completion = new Promise<Record<string, unknown>>((resolve) => { resolveComplete = resolve; });
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => null,
    startRecording: async () => null,
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string) => {
    if (pathname.endsWith('/upload-token')) {
      return {
        uploadToken: 'natural-token',
        sdkUploadId: 'natural-upload',
        region: 'us-west-2',
        retentionMode: 'timed',
        retentionHours: 24,
      };
    }
    if (pathname.endsWith('/complete')) return completion;
    return {};
  });

  await capture.configure({ enabled: true, region: 'us-west-2' });
  await capture.recordDetectedWindow('natural-window');
  listeners.get('recording-ended')?.({ window: { id: 'natural-window' } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(capture.status().recording, false);

  let prepared = false;
  const preparing = capture.prepareForShutdown().then(() => { prepared = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(prepared, false);
  resolveComplete({ ok: true });
  await preparing;
  assert.equal(prepared, true);
});

test('prepareForShutdown shares a stop already in flight and waits for its daemon completion', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  let nativeStopCalls = 0;
  let resolveComplete!: (value: Record<string, unknown>) => void;
  const completion = new Promise<Record<string, unknown>>((resolve) => { resolveComplete = resolve; });
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => null,
    startRecording: async () => null,
    stopRecording: async () => { nativeStopCalls += 1; return null; },
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string) => {
    if (pathname.endsWith('/upload-token')) {
      return {
        uploadToken: 'stopping-token',
        sdkUploadId: 'stopping-upload',
        region: 'us-west-2',
        retentionMode: 'timed',
        retentionHours: 24,
      };
    }
    if (pathname.endsWith('/complete')) return completion;
    return {};
  });

  await capture.configure({ enabled: true, region: 'us-west-2' });
  await capture.recordDetectedWindow('stopping-window');
  const stopping = capture.stopRecording();
  await new Promise<void>((resolve) => setImmediate(resolve));

  let prepared = false;
  const preparing = capture.prepareForShutdown().then(() => { prepared = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(nativeStopCalls, 1, 'shutdown preparation must share the existing stop');
  assert.equal(prepared, false, 'the stop completion still owns the shutdown drain');

  resolveComplete({ ok: true });
  await Promise.all([stopping, preparing]);
  assert.equal(prepared, true);
});

test('native SDK shutdown completes the owned upload and clean exit can initialize again', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const daemonCalls: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  let initCalls = 0;
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => { initCalls += 1; return null; },
    shutdown: async () => null,
    startRecording: async () => null,
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string, body: Record<string, unknown>) => {
    daemonCalls.push({ pathname, body });
    if (pathname.endsWith('/upload-token')) {
      return {
        uploadToken: 'exit-token',
        sdkUploadId: 'exit-upload',
        region: 'eu-central-1',
        retentionMode: 'zero',
        retentionHours: 1,
      };
    }
    return {};
  });

  await capture.configure({ enabled: true, region: 'eu-central-1' });
  await capture.recordDetectedWindow('exit-window');
  listeners.get('shutdown')?.({ code: 0, signal: '' });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const complete = daemonCalls.find((call) => call.pathname.endsWith('/complete'));
  assert.equal(complete?.body.sdkUploadId, 'exit-upload');
  assert.equal(complete?.body.sdkUploadRegion, 'eu-central-1');
  assert.equal(complete?.body.recallRetentionMode, 'zero');
  assert.equal(capture.status().recording, false);
  assert.equal(capture.status().initialized, false);

  await capture.testConnection();
  assert.equal(initCalls, 2, 'clean native exit must not leave initialize short-circuited');
  assert.equal(capture.status().initialized, true);
});
