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
  assert.equal(status.capturePhase, 'idle');
  assert.equal(status.detectedWindows.length, 0);
  assert.equal(status.lastEvent, 'shutdown');
  assert.match(status.lastError ?? '', /stopped unexpectedly/);
  assert.equal(emitted.at(-1)?.type, 'shutdown');
});

test('meeting prompts recover, dismiss until close, and expose confirmed capture phases', async () => {
  const emitted: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let phaseDuringStartedEvent = '';
  let capture!: RecallDesktopCapture;
  capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: (event) => {
      emitted.push(event);
      if (event.type === 'recording-started') phaseDuringStartedEvent = capture.status().capturePhase;
    },
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => null,
    startRecording: async ({ windowId }: { windowId: string }) => {
      listeners.get('recording-started')?.({ window: { id: windowId } });
      return null;
    },
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string) => pathname.endsWith('/upload-token')
    ? { uploadToken: 'token', sdkUploadId: 'upload', region: 'us-west-2' }
    : {});

  await capture.configure({ enabled: true });
  const detected = { window: { id: 'prompt-window', platform: 'zoom', title: 'Roadmap review' } };
  listeners.get('meeting-detected')?.(detected);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const firstDetectedAt = capture.status().pendingMeeting?.detectedAt;
  assert.equal(capture.status().capturePhase, 'prompt');
  assert.equal(capture.status().pendingMeeting?.windowId, 'prompt-window');

  listeners.get('meeting-detected')?.(detected);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(capture.status().pendingMeeting?.detectedAt, firstDetectedAt);
  assert.equal(emitted.filter((event) => event.type === 'meeting-prompt-required').length, 1);

  capture.dismissDetectedWindow('prompt-window');
  assert.equal(capture.status().capturePhase, 'idle');
  await assert.rejects(capture.recordPromptedWindow('prompt-window'), /no longer active/);
  listeners.get('meeting-detected')?.(detected);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(emitted.filter((event) => event.type === 'meeting-prompt-required').length, 1);

  listeners.get('meeting-closed')?.(detected);
  listeners.get('meeting-detected')?.(detected);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(emitted.filter((event) => event.type === 'meeting-prompt-required').length, 2);
  await capture.recordPromptedWindow('prompt-window');
  assert.equal(phaseDuringStartedEvent, 'recording');
  assert.equal(capture.status().capturePhase, 'recording');

  listeners.get('media-capture-status')?.({
    window: detected.window,
    type: 'audio',
    capturing: true,
  });
  const mediaEvent = emitted.filter((event) => event.type === 'media-capture-status').at(-1);
  assert.equal(mediaEvent?.mediaType, 'audio');
  await capture.stopRecording();
  assert.equal(capture.status().capturePhase, 'idle');
});

test('ordinary Notch record reports starting throughout async initialization', async () => {
  let releaseInitialization!: () => void;
  let markInitializationStarted!: () => void;
  const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve; });
  const initializationStarted = new Promise<void>((resolve) => { markInitializationStarted = resolve; });
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => {
      markInitializationStarted();
      await initializationGate;
      throw new Error('initialization failed');
    },
    shutdown: async () => null,
    startRecording: async () => null,
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: () => undefined,
    removeAllEventListeners: () => undefined,
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'detectedWindows', new Map([[
    'prompt-window',
    { windowId: 'prompt-window', platform: 'zoom', title: 'Roadmap review', detectedAt: new Date().toISOString() },
  ]]));
  Reflect.set(capture, 'promptedWindows', new Set(['prompt-window']));

  const startAttempt = capture.recordPromptedWindow('prompt-window');
  await initializationStarted;
  assert.equal(capture.status().capturePhase, 'starting');
  const rejectedStart = assert.rejects(startAttempt, /initialization failed/);
  releaseInitialization();
  await rejectedStart;
  assert.equal(capture.status().capturePhase, 'prompt');
});

test('Notch always-record rolls back durable consent when the current start fails', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const settingsWrites: boolean[] = [];
  let nativeStarts = 0;
  let releaseConsentWrite!: () => void;
  let markConsentWriteStarted!: () => void;
  const consentWriteGate = new Promise<void>((resolve) => { releaseConsentWrite = resolve; });
  const consentWriteStarted = new Promise<void>((resolve) => { markConsentWriteStarted = resolve; });
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => null,
    startRecording: async () => {
      nativeStarts += 1;
      throw new Error('native start failed');
    },
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string, body: Record<string, unknown>) => {
    if (pathname.endsWith('/settings')) {
      settingsWrites.push(body.autoRecord === true);
      if (body.autoRecord === true) {
        markConsentWriteStarted();
        await consentWriteGate;
      }
      return {};
    }
    if (pathname.endsWith('/upload-token')) {
      return { uploadToken: 'token', sdkUploadId: 'upload', region: 'us-west-2' };
    }
    return {};
  });

  await capture.configure({ enabled: true, autoRecord: false });
  const detected = { window: { id: 'always-window', platform: 'zoom', title: 'Planning' } };
  listeners.get('meeting-detected')?.(detected);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const startAttempt = capture.enableAutoRecordAndRecordPrompted('always-window');
  await consentWriteStarted;
  assert.equal(capture.status().capturePhase, 'starting');
  const rejectedStart = assert.rejects(startAttempt, /native start failed/);
  releaseConsentWrite();
  await rejectedStart;
  assert.equal(nativeStarts, 1);
  assert.deepEqual(settingsWrites, [true, false]);
  assert.equal(capture.status().settings.autoRecord, false);
  assert.equal(capture.status().capturePhase, 'prompt');
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

test('prepareForShutdown cancels a pre-native Notch start and awaits consent rollback', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const settingsWrites: boolean[] = [];
  let nativeStarts = 0;
  let markConsentWriteStarted!: () => void;
  let markRollbackStarted!: () => void;
  let releaseRollback!: () => void;
  const consentWriteStarted = new Promise<void>((resolve) => { markConsentWriteStarted = resolve; });
  const rollbackStarted = new Promise<void>((resolve) => { markRollbackStarted = resolve; });
  const rollbackGate = new Promise<void>((resolve) => { releaseRollback = resolve; });
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  const fakeSdk = {
    init: async () => null,
    shutdown: async () => null,
    startRecording: async () => { nativeStarts += 1; return null; },
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    removeAllEventListeners: () => listeners.clear(),
  };
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (
    pathname: string,
    body: Record<string, unknown>,
    _method: string,
    signal?: AbortSignal,
  ) => {
    if (!pathname.endsWith('/settings')) return {};
    const autoRecord = body.autoRecord === true;
    settingsWrites.push(autoRecord);
    if (!autoRecord) {
      markRollbackStarted();
      await rollbackGate;
      return {};
    }
    markConsentWriteStarted();
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new Error('consent write aborted for shutdown'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  });

  await capture.configure({ enabled: true, autoRecord: false });
  listeners.get('meeting-detected')?.({
    window: { id: 'shutdown-notch-window', platform: 'zoom', title: 'Planning' },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const starting = capture.enableAutoRecordAndRecordPrompted('shutdown-notch-window');
  const rejectedStart = assert.rejects(starting, /cancelled/);
  await consentWriteStarted;
  assert.equal(capture.status().capturePhase, 'starting');

  let prepared = false;
  const preparing = capture.prepareForShutdown().then(() => { prepared = true; });
  await rollbackStarted;
  assert.equal(prepared, false, 'shutdown must keep the daemon alive for consent rollback');
  assert.equal(nativeStarts, 0);
  assert.deepEqual(settingsWrites, [true, false]);

  releaseRollback();
  await rejectedStart;
  await preparing;
  assert.equal(prepared, true);
  assert.equal(nativeStarts, 0);
  assert.equal(capture.status().settings.autoRecord, false);
  assert.equal(capture.status().capturePhase, 'prompt');
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
  const detected = { window: { id: 'exit-window', platform: 'zoom', title: 'Exit meeting' } };
  listeners.get('meeting-detected')?.(detected);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(capture.status().capturePhase, 'prompt');
  await capture.recordPromptedWindow('exit-window');
  listeners.get('shutdown')?.({ code: 0, signal: '' });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const complete = daemonCalls.find((call) => call.pathname.endsWith('/complete'));
  assert.equal(complete?.body.sdkUploadId, 'exit-upload');
  assert.equal(complete?.body.sdkUploadRegion, 'eu-central-1');
  assert.equal(complete?.body.recallRetentionMode, 'zero');
  assert.equal(capture.status().recording, false);
  assert.equal(capture.status().capturePhase, 'idle');
  assert.equal(capture.status().pendingMeeting, undefined);
  assert.equal(capture.status().detectedWindows.length, 0);
  assert.equal(capture.status().initialized, false);

  await capture.testConnection();
  assert.equal(initCalls, 2, 'clean native exit must not leave initialize short-circuited');
  assert.equal(capture.status().initialized, true);
});

test('re-initialization never duplicates SDK listeners (failed-init retry + post-shutdown reconnect)', async () => {
  // The REAL SDK stores listeners in a MODULE-LEVEL ARRAY (push, no dedup) that
  // survives init() failures and clean shutdowns. The Map-based fakes elsewhere
  // in this file dedupe by construction and can never reproduce duplication —
  // this fake mirrors the array semantics (2026-07-14 pre-release review: every
  // re-init attached all listeners AGAIN, so one transcript event was persisted
  // N times after N reconnects).
  const listeners: Array<{ type: string; cb: (event: unknown) => void }> = [];
  const dispatch = (type: string, event: unknown) => {
    for (const l of [...listeners]) if (l.type === type) l.cb(event);
  };
  const daemonCalls: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  let initCalls = 0;
  const fakeSdk = {
    init: async () => {
      initCalls += 1;
      if (initCalls === 1) throw new Error('simulated init failure');
      return null;
    },
    shutdown: async () => null,
    startRecording: async () => null,
    stopRecording: async () => null,
    prepareDesktopAudioRecording: async () => 'desktop-audio-window',
    requestPermission: async () => null,
    addEventListener: (type: string, cb: (event: unknown) => void) => { listeners.push({ type, cb }); },
    removeAllEventListeners: () => { listeners.length = 0; },
  };
  const capture = new RecallDesktopCapture({
    getDaemonBaseUrl: () => 'http://127.0.0.1:1',
    getWebhookToken: () => 'test-token',
    emit: () => undefined,
    runtime: { platform: 'darwin', arch: 'arm64' },
  });
  Reflect.set(capture, 'loadSdk', async () => fakeSdk);
  Reflect.set(capture, 'postDaemon', async (pathname: string, body: Record<string, unknown>) => {
    daemonCalls.push({ pathname, body });
    if (pathname.endsWith('/upload-token')) {
      return { uploadToken: 'upload-token', sdkUploadId: 'sdk-upload-1', id: 'sdk-upload-1', region: 'us-east-1' };
    }
    return {};
  });

  // Leak path (a): init fails once AFTER listeners were attached; the retry
  // must purge before re-attaching, leaving exactly one listener per type.
  await assert.rejects(capture.configure({ enabled: true, liveTranscript: true }), /simulated init failure/);
  await capture.configure({ enabled: true, liveTranscript: true });
  assert.equal(
    listeners.filter((l) => l.type === 'realtime-event').length,
    1,
    'retry after failed init must not duplicate listeners',
  );

  // The user-facing harm: one transcript event must persist exactly ONCE.
  await capture.recordDetectedWindow('meeting-window-1');
  dispatch('realtime-event', {
    event: 'transcript.data',
    window: { id: 'meeting-window-1' },
    data: { text: 'Only once', recording_id: 'rec-1' },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    daemonCalls.filter((c) => c.pathname.endsWith('/transcript-event')).length,
    1,
    'a single transcript event must persist exactly once',
  );
  await capture.stopRecording();

  // Leak path (b): a clean shutdown (code 0) nulls the wrapper but the module
  // and its listener array survive; the reconnect's initialize() must not
  // stack a second generation of listeners.
  dispatch('shutdown', { code: 0, signal: '' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await capture.configure({ enabled: true, liveTranscript: true });
  assert.equal(
    listeners.filter((l) => l.type === 'realtime-event').length,
    1,
    'post-shutdown reconnect must not duplicate listeners',
  );
});
