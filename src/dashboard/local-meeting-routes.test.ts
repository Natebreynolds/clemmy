import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-local-routes-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';

const { registerConsoleRoutes } = await import('./console-routes.js');
const local = await import('../integrations/local-meetings/meeting-capture.js');

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

    authorized.value = true;
    assert.equal((await fetch(`${harness.url}/api/console/meetings/local/retry`, json('POST', {}))).status, 400);
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
