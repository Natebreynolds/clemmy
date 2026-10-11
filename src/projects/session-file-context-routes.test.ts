/** Run: node scripts/run-tests-isolated.mjs src/projects/session-file-context-routes.test.ts */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';

process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
const { registerConsoleRoutes } = await import('../dashboard/console-routes.js');
const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('../channels/mobile-routes.js');
const { createSession: createMobileSession } = await import('../runtime/mobile-sessions.js');
const { recordDeliverable } = await import('../memory/deliverable-index.js');
const { createSession, claimRunAttemptLease, getActiveRunAttempt, getHarnessChatRequestReceipt, listEvents, recordRunAttemptUserInput } = await import('../runtime/harness/eventlog.js');
const { loadInboxAttachment } = await import('../runtime/attachments.js');

test('both authenticated surfaces prepare exact context, refuse stale previews and preserve busy attachments before admission', async () => {
  const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clem-context-routes-')));
  const stateDir = path.join(work, 'mobile');
  const mobile = await createMobileSession({ deviceLabel: 'Controlled artifact context' }, { stateDir });
  const auth = { allowed: true };
  let modelCalls = 0;
  const assistant = { respond: async () => { modelCalls++; throw new Error('preparation or busy rejection must not run a model'); },
    getRuntime: () => ({ listPendingApprovals: () => [] }) };
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => auth.allowed, assistant as never, { serveLegacyAtRoot: false });
  app.use('/m', createMobileRouter({ stateDir, cookieSecure: false, isAdminAuthorized: () => false, assistant: assistant as never }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = createSession({ kind: 'agent', title: 'Controlled file owner' }).id;
  const target = path.join(work, 'result', 'draft.html');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, '<p>Exact draft selected by the owner</p>');
  recordDeliverable({ kind: 'file', target, sessionId: owner });
  let firstId: string | undefined;
  try {
    for (const surface of ['desktop', 'mobile'] as const) {
      const sessions = surface === 'desktop' ? '/api/console/sessions' : '/m/api/chat/sessions';
      const headers = { 'content-type': 'application/json', ...(surface === 'mobile' ? { cookie: `${MOBILE_SESSION_COOKIE}=${mobile.token}` } : {}) };
      const details = await fetch(`${base}${sessions}/${owner}/file?name=draft.html`, { headers });
      assert.equal(details.status, 200);
      const { file } = await details.json() as { file: { fileId: string; revision: string; text: string } };
      assert.match(file.revision, /^sha256:[a-f0-9]{64}$/);
      const body = JSON.stringify({ fileId: file.fileId, expectedRevision: file.revision });
      const prepared = await fetch(`${base}${sessions}/${owner}/file/context`, { method: 'POST', headers, body });
      assert.equal(prepared.status, 200);
      const result = await prepared.json() as { id: string; provenance: { originalPath: string } };
      assert.ok(loadInboxAttachment(result.id)?.markdown?.includes('Exact draft selected by the owner'));
      assert.equal(result.provenance.originalPath, target);
      if (firstId) assert.equal(result.id, firstId, 'cross-surface retry is idempotent');
      firstId = result.id;
      writeFileSync(target, '<p>Changed after preview</p>');
      assert.equal((await fetch(`${base}${sessions}/${owner}/file/context`, { method: 'POST', headers, body })).status, 409);
      const content = await fetch(`${base}${sessions}/${owner}/file/content?fileId=${file.fileId}&expectedRevision=${encodeURIComponent(file.revision)}`, { headers });
      assert.equal(content.status, 409, 'a preview cannot display different bytes under the selected revision');
      writeFileSync(target, file.text);

      for (const phase of ['lease_live', 'recovering_in_flight'] as const) {
        const chat = createSession({ kind: 'chat', channel: surface, userId: surface === 'mobile' ? mobile.record.deviceId : undefined }).id;
        const lease = claimRunAttemptLease({ sessionId: chat, runId: `context-busy-owner-${surface}-${phase}`, ownerId: 'context-busy-fixture', leaseMs: 60000, ...(phase === 'recovering_in_flight' ? { nowMs: Date.now() - 120000 } : {}) });
        assert.ok(lease.claimed && lease.attempt);
        const active = lease.attempt;
        recordRunAttemptUserInput(active, { turn: 1, role: 'user', data: { text: 'Controlled ongoing work' } }, { armRunInFlight: true });
        const beforeSources = listEvents(chat, { types: ['user_input_received'] }).length;
        const requestId = `context-busy-${surface}-${phase}`;
        const busy = await fetch(`${base}${surface === 'desktop' ? '/api/harness/chat' : '/m/api/chat/send'}`, {
          method: 'POST', headers: { ...headers, 'idempotency-key': requestId },
          body: JSON.stringify(surface === 'desktop'
            ? { input: 'Discuss the selected draft.', sessionId: chat, clientRequestId: requestId, attachments: [result.id] }
            : { message: 'Discuss the selected draft.', sessionId: chat, attachments: [result.id], async: true }),
        });
        assert.equal(busy.status, 409, `${surface} ${phase}`);
        assert.equal((await busy.json() as { error: string }).error, 'ATTACHMENTS_REQUIRE_IDLE_CHAT');
        assert.equal(getActiveRunAttempt(chat)?.attemptId, active.attemptId, 'existing work was not superseded');
        assert.equal(listEvents(chat, { types: ['user_input_received'] }).length, beforeSources, 'no competing turn admitted');
        if (surface === 'desktop') assert.equal(getHarnessChatRequestReceipt(requestId), null, 'client may deliberately retry its unchanged request');
      }
    }
    auth.allowed = false;
    for (const sessions of ['/api/console/sessions', '/m/api/chat/sessions']) {
      assert.equal((await fetch(`${base}${sessions}/${owner}/file/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    }
    assert.equal(modelCalls, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(work, { recursive: true, force: true });
  }
});
