/** Run: node scripts/run-tests-isolated.mjs src/dashboard/delivered-routes.test.ts */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import type { DeliveredGroup } from '../memory/deliverable-index.js';

process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';

const { registerConsoleRoutes } = await import('./console-routes.js');
const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('../channels/mobile-routes.js');
const { createSession: createMobileSession } = await import('../runtime/mobile-sessions.js');
const { recordDeliverable } = await import('../memory/deliverable-index.js');
const { createSession, appendEvent } = await import('../runtime/harness/eventlog.js');

test('desktop and phone delivered routes share scoped worker refs, source links and validation behind auth', async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'clem-delivered-route-'));
  const stateDir = path.join(work, 'mobile-state');
  const parent = createSession({ kind: 'chat', title: 'Controlled artifact route' }).id;
  const sibling = createSession({ kind: 'chat', metadata: { channelId: parent, projectId: 'elsewhere' } }).id;
  const worker = createSession({ kind: 'agent', metadata: { source: 'delegated_worker', workerScope: true, parentSessionId: parent } }).id;
  appendEvent({ sessionId: parent, turn: 0, role: 'system', type: 'worker_started', data: { childSessionId: worker } });
  for (const session of [worker, sibling]) {
    const target = path.join(work, session, 'email.html');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `<p>${session}</p>`);
    recordDeliverable({ kind: 'file', target, sessionId: session });
  }
  const auth = { allowed: true };
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => auth.allowed, {} as never, { serveLegacyAtRoot: false });
  app.use('/m', createMobileRouter({ stateDir, cookieSecure: false, isAdminAuthorized: () => false }));
  const server: Server = await new Promise(resolve => {
    const listening = createServer(app);
    listening.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const mobile = await createMobileSession({ deviceLabel: 'Controlled artifact route' }, { stateDir });
    const headers = { cookie: `${MOBILE_SESSION_COOKIE}=${mobile.token}` };
    for (const [route, sessions, requestHeaders] of [
      ['/api/console/delivered', '/api/console/sessions', {}],
      ['/m/api/delivered', '/m/api/chat/sessions', headers],
    ] as const) {
      const response = await fetch(`${base}${route}?sessionIds=${encodeURIComponent(parent)}`, { headers: requestHeaders });
      assert.equal(response.status, 200, route);
      const body = await response.json() as { groups: DeliveredGroup[] };
      assert.deepEqual(body.groups.map(group => group.sessionId), [worker], 'sibling project stays out');
      const group = body.groups[0]!;
      assert.equal(group.conversationSessionId, parent);
      assert.equal(group.artifacts[0]!.conversationSessionId, parent);
      const ref = group.artifacts[0]!.fileRef!;
      assert.equal(ref.sessionId, worker, 'file access still uses the actual writer');
      const file = await fetch(`${base}${sessions}/${ref.sessionId}/file?fileId=${ref.fileId}`, { headers: requestHeaders });
      assert.equal(file.status, 200);
      assert.equal((await file.json() as { file: { text: string } }).file.text, `<p>${worker}</p>`);
      for (const query of ['sessionIds=', 'sessionIds=a&sessionIds=b', `sessionIds=${'a'.repeat(161)}`]) {
        assert.equal((await fetch(`${base}${route}?${query}`, { headers: requestHeaders })).status, 400, query);
      }
    }
    auth.allowed = false;
    assert.equal((await fetch(`${base}/api/console/delivered?sessionIds=${parent}`)).status, 401);
    assert.equal((await fetch(`${base}/m/api/delivered?sessionIds=${parent}`)).status, 401);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(work, { recursive: true, force: true });
  }
});
