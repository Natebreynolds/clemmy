import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-policy-routes-'));
process.env.CLEMENTINE_HOME = home; process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
const { registerMeetingAssistantPolicyRoutes } = await import('./meeting-assistant-policy-routes.js');
const { MeetingAssistantPolicyError } = await import('../integrations/recall/meeting-assistant-policy.js');
test.after(() => rmSync(home, { recursive: true, force: true }));

test('owner authentication precedes every read and mutation; typed failures do not start work', async () => {
  let authorized = false; let reads = 0; let writes = 0;
  let failure: string | null = null;
  const snapshot = { version: 1 as const, revision: 0, updatedAt: null,
    before: { calendarPrepSuggestions: false }, during: { modelId: null }, after: { modelId: null },
    modelOptions: { live: [], after: [] }, defaults: {
      live: { modelId: 'controlled-quick', label: 'Controlled Quick', available: false },
      after: { modelId: 'controlled-brain', label: 'Controlled brain', available: false } } };
  const app = express(); app.use(express.json());
  registerMeetingAssistantPolicyRoutes(app, () => authorized, {
    snapshot: () => { reads++; if (failure === 'read') throw new Error('private diagnostic must not leak'); return snapshot; },
    save: () => { writes++;
      if (failure === 'conflict') throw new MeetingAssistantPolicyError('conflict', 'Review the latest choices.');
      if (failure === 'invalid') throw new MeetingAssistantPolicyError('invalid', 'Choose preferences.');
      return snapshot;
    },
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/meetings/policy`;
  const patch = () => fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
  try {
    assert.equal((await fetch(url)).status, 401); assert.equal((await patch()).status, 401);
    assert.equal(reads, 0); assert.equal(writes, 0);
    authorized = true;
    assert.deepEqual(await (await fetch(url)).json(), snapshot);
    assert.equal(writes, 0, 'a GET never writes or launches any work');
    failure = 'conflict'; assert.equal((await patch()).status, 409);
    failure = 'invalid'; assert.equal((await patch()).status, 400);
    failure = 'read'; const unavailable = await fetch(url);
    assert.equal(unavailable.status, 503);
    assert.equal(JSON.stringify(await unavailable.json()).includes('private diagnostic'), false);
    failure = null; assert.equal((await patch()).status, 200);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
