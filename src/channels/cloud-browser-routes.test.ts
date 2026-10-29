import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cloud-routes-'));
process.env.CLEMENTINE_HOME = home;
const { registerCloudBrowserRoutes } = await import('./cloud-browser-routes.js');
const { BrowserbaseServiceError } = await import('../integrations/browserbase.js');
test.after(() => rmSync(home, { recursive: true, force: true }));

async function fixture(run: (request: (method: string, suffix: string, body?: unknown, authorized?: boolean) => Promise<Response>, calls: unknown[]) => Promise<void>) {
  const calls: unknown[] = [];
  const resource = { id: 'owned', conversationId: 'chat-a', controlVersion: 2, state: 'active', controller: 'human' };
  const service = {
    status: async () => ({ configured: true, projectId: 'fixture-project' }),
    configure: async (value: unknown) => { calls.push(value); return { configured: true }; },
    list: async (conversationId: string) => { calls.push(['list', conversationId]); return [resource]; },
    get: async (id: string, conversationId: string) => { calls.push(['get', id, conversationId]); return resource; },
    create: async (value: unknown) => { calls.push(['create', value]); return resource; },
    control: async (id: string, conversationId: string, value: unknown) => { calls.push(['control', id, conversationId, value]); return resource; },
    humanInput: async (id: string, conversationId: string, value: unknown) => { calls.push(['input', id, conversationId, value]); return { resource, result: { ok: true }, receipt: { effect: 'confirmed' } }; },
    stop: async () => { throw new BrowserbaseServiceError('control_changed', 'none'); },
    touch: async () => resource,
    detach: async (id: string, conversationId: string, value: unknown) => { calls.push(['detach', id, conversationId, value]); return resource; },
    view: async () => ({ url: 'https://www.browserbase.com/live?opaque=fixture-only', expiresAt: '2026-10-03T00:05:00Z', controller: 'human', controlVersion: 2, viewerLeaseId: '00000000-0000-4000-8000-000000000001' }),
  };
  const app = express(); app.use(express.json());
  registerCloudBrowserRoutes(app, (req, res, next) => {
    if (req.headers.authorization !== 'Bearer fixture') { res.status(401).end(); return; }
    next();
  }, '/fixture', { service: service as never, hasConversation: id => id === 'chat-a' });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture/cloud-browser`;
  try { await run((method, suffix, body, authorized = true) => fetch(origin + suffix, {
    method, headers: { ...(authorized ? { Authorization: 'Bearer fixture' } : {}), 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), calls); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('all cloud routes require supplied first-party authentication before touching the adapter', async () => {
  await fixture(async (request, calls) => {
    for (const [method, suffix, body] of [
      ['GET', '/status'], ['GET', '/resources?conversationId=chat-a'], ['GET', '/resources/owned?conversationId=chat-a'],
      ['POST', '/configuration', { apiKey: 'private-fixture', projectId: 'p' }],
      ['POST', '/resources', { conversationId: 'chat-a', requestId: 'r' }],
      ...['view', 'control', 'input', 'stop', 'touch', 'recover', 'detach'].map(action => ['POST', `/resources/owned/${action}`, { conversationId: 'chat-a', expectedVersion: 2 }]),
    ] as Array<[string, string, unknown?]>) assert.equal((await request(method, suffix, body, false)).status, 401, suffix);
    assert.equal(calls.length, 0);
  });
});
test('missing conversation and widened input refuse before a browser operation', async () => {
  await fixture(async (request, calls) => {
    assert.equal((await request('POST', '/resources', { conversationId: 'other', requestId: 'r' })).status, 404);
    assert.equal((await request('POST', '/resources/owned/input', { conversationId: 'chat-a', expectedVersion: 2, targetId: 'page', text: 'x', key: 'Enter' })).status, 400);
    assert.equal((await request('POST', '/resources/owned/control', { conversationId: 'chat-a', expectedVersion: 2, controller: 'human', connectUrl: 'wss://foreign.invalid/' })).status, 400);
    assert.equal((await request('POST', '/resources/owned/input', { conversationId: 'chat-a', expectedVersion: 2, targetId: 'page', key: 'Meta' })).status, 400);
    assert.equal((await request('POST', '/resources/owned/view', { conversationId: 'chat-a' })).status, 400);
    assert.equal((await request('POST', '/resources/owned/input', { conversationId: 'chat-a', expectedVersion: 2, targetId: 'page', text: 'x' })).status, 400);
    assert.equal(calls.length, 0);
  });
});
test('input preserves exact conversation, page and control version and returns actual acknowledgment', async () => {
  await fixture(async (request, calls) => {
    const input = { conversationId: 'chat-a', expectedVersion: 2, viewerLeaseId: '00000000-0000-4000-8000-000000000001', targetId: 'page-exact', text: 'fixture text' };
    const response = await request('POST', '/resources/owned/input', input);
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], ['input', 'owned', 'chat-a', input]);
    assert.equal((await response.json()).result.ok, true);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});
test('viewer capabilities are private noncacheable responses and stale control failures remain failures', async () => {
  await fixture(async request => {
    const view = await request('POST', '/resources/owned/view', { conversationId: 'chat-a', expectedVersion: 2, viewerLeaseId: '00000000-0000-4000-8000-000000000001' });
    assert.equal(view.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(view.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(await view.json()).sort(), ['controlVersion', 'controller', 'expiresAt', 'url', 'viewerLeaseId']);
    const stopped = await request('POST', '/resources/owned/stop', { conversationId: 'chat-a', expectedVersion: 1 });
    assert.equal(stopped.status, 409);
    const failure = await stopped.json();
    assert.equal(failure.effect, 'none');
    assert.equal(failure.code, 'control_changed');
    assert.equal(failure.resource, undefined, 'a failed stop cannot masquerade as a successful state transition');
  });
});

test('a detached viewer acknowledgment names the exact owned lease even after its control epoch is revoked', async () => {
  await fixture(async (request, calls) => {
    const input = { conversationId: 'chat-a', viewerLeaseId: '00000000-0000-4000-8000-000000000002' };
    assert.equal((await request('POST', '/resources/owned/detach', { ...input, conversationId: 'other' })).status, 404);
    assert.equal(calls.length, 0);
    const response = await request('POST', '/resources/owned/detach', input);
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], ['detach', 'owned', 'chat-a', input]);
    assert.equal((await response.json()).resource.id, 'owned');
  });
});

test('on macOS and Linux the cloud browser is not set up or chosen, and its status says it is retired; Windows sets it up as before', async () => {
  const { _testOnly_setBrowserPlatform } = await import('../tools/browser-backend.js');
  try {
    for (const platform of ['darwin', 'linux'] as const) {
      _testOnly_setBrowserPlatform(platform);
      await fixture(async (request, calls) => {
        const configured = await request('POST', '/configuration', { provider: 'kernel', apiKey: 'private-fixture' });
        assert.equal(configured.status, 409);
        const body = await configured.json() as { error: string; code: string };
        assert.equal(body.code, 'browser_retired');
        assert.match(body.error, /Clem's browser is your computer \(Connect → Your computer\).*nothing was set up/);
        assert.equal((await request('POST', '/selection', { browser: 'local' })).status, 409);
        assert.equal(calls.length, 0, 'nothing reached the provider');
        assert.equal((await (await request('GET', '/status')).json() as { retired: boolean }).retired, true);
      });
    }
    _testOnly_setBrowserPlatform('win32');
    await fixture(async (request, calls) => {
      assert.equal((await request('POST', '/configuration', { provider: 'browserbase', apiKey: 'private-fixture', projectId: 'p' })).status, 200);
      assert.equal(calls.length, 1);
      assert.equal((await (await request('GET', '/status')).json() as { retired: boolean }).retired, false);
    });
  } finally { _testOnly_setBrowserPlatform(null); }
});
