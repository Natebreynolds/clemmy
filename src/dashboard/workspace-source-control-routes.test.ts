import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-source-control-routes-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const { registerSpaceRoutes } = await import('./space-routes.js');
const { createMobileRouter } = await import('../channels/mobile-routes.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const { spaceStore, resolveInSpace } = await import('../spaces/store.js');
const { closeEventLog, openEventLog } = await import('../runtime/harness/eventlog.js');
const { closeWorkspaceDb } = await import('../spaces/workspace-db.js');
let server: Server;
let base = '';
let cookie = '';
const stateDir = path.join(home, 'paired-devices');
test.before(async () => {
  spaceStore.save({ id: 'control-route-fixture', title: 'Source control route fixture', status: 'active', dataSources: [{ id: 'rows', runner: 'rows.mjs' }] });
  const dir = resolveInSpace('control-route-fixture', 'data'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'rows.mjs'), 'throw new Error("Must not execute in route test");');
  const app = express(); app.use(express.json());
  registerSpaceRoutes(app, req => req.get('authorization') === 'Bearer fixture-owner');
  app.use('/m', createMobileRouter({ stateDir, cookieSecure: false, isAdminAuthorized: () => false }));
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  await setPin('Fixture-Control-Pin1!', { stateDir });
  const login = await fetch(`${base}/m/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'Fixture-Control-Pin1!', deviceLabel: 'Source controls fixture' }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  closeEventLog(); closeWorkspaceDb(); rmSync(home, { recursive: true, force: true });
});
const desktop = '/api/console/spaces/control-route-fixture/source-controls';
const mobile = '/m/api/workspaces/control-route-fixture/source-controls';
function call(url: string, headers: Record<string, string> = {}, body?: unknown) {
  return fetch(`${base}${url}`, { method: body ? 'POST' : 'GET', headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const dh = { authorization: 'Bearer fixture-owner' };

test('both production registrations require their real surface authentication before revealing source state', async () => {
  for (const url of [desktop, mobile]) {
    assert.equal((await call(url)).status, 401);
    assert.equal((await call(`${url}/rows`, {}, { action: 'stop' })).status, 401);
  }
  assert.equal((await call(mobile, dh)).status, 401, 'desktop credential cannot replace a paired mobile session');
  assert.equal((await call(desktop, { cookie })).status, 401, 'mobile credential is not desktop admin authority');
});

test('authored opaque-origin frames cannot operate source controls on either surface', async () => {
  for (const [url, headers] of [[desktop, dh], [mobile, { cookie }]] as const) {
    assert.equal((await call(url, { ...headers, origin: 'null' })).status, 403);
    assert.equal((await call(`${url}/rows`, { ...headers, origin: 'null' }, { action: 'stop' })).status, 403);
  }
});

test('desktop and a paired phone share the exact stop receipt, reject stale decisions, and never execute a script', async () => {
  const get = async (url: string, headers: Record<string, string>) => {
    const result = await call(url, headers); assert.equal(result.status, 200);
    return (await result.json() as { sources: Array<{ revision: string; permission: string }> }).sources[0];
  };
  const first = await get(desktop, dh);
  assert.deepEqual(await get(mobile, { cookie }), first);
  const command = { controlId: randomUUID(), expectedRevision: first.revision, action: 'stop' };
  const stopped = await call(`${desktop}/rows`, dh, command); assert.equal(stopped.status, 200);
  const after = await get(mobile, { cookie }); assert.equal(after.permission, 'stopped');
  assert.notEqual(after.revision, first.revision);
  assert.equal((await call(`${mobile}/rows`, { cookie }, command)).status, 200, 'lost-response retry joins the same receipt across devices');
  assert.equal((await call(`${mobile}/rows`, { cookie }, { ...command, controlId: randomUUID(), action: 'review' })).status, 409);
  assert.equal((await call(`${mobile}/rows`, { cookie }, { action: 'stop' })).status, 400);
  assert.equal((await call(`${mobile}/missing`, { cookie }, command)).status, 409, 'an old identity cannot be reused for another source');
  assert.equal((await call(`${mobile}/missing`, { cookie }, { ...command, controlId: randomUUID() })).status, 404);
  const db = openEventLog();
  assert.equal((db.prepare('SELECT COUNT(*) n FROM workspace_source_control_receipts_v1').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM physical_dispatches').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM saved_source_script_grants_v1').get() as { n: number }).n, 0);
});
