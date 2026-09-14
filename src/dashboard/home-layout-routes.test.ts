import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-home-api-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.MARKITDOWN_WARM = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
const { registerConsoleRoutes } = await import('./console-routes.js');
const { createMobileRouter } = await import('../channels/mobile-routes.js');
const { createMobilePairingCode } = await import('../runtime/mobile-pairing.js');
const { spaceStore } = await import('../spaces/store.js');
const { HOME_LAYOUT_PATH } = await import('../runtime/home-layout.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
after(() => { closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('desktop and paired mobile share durable Home edits, conflict recovery and honest corrupt-state errors', async () => {
  const app = express();
  app.use(express.json());
  const auth = (req: express.Request) => req.headers.authorization === 'Bearer home-test';
  registerConsoleRoutes(app, auth, {} as Parameters<typeof registerConsoleRoutes>[2]);
  app.use('/m', createMobileRouter({ isAdminAuthorized: auth, cookieSecure: false, pwaDistDir: null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const send = (route: string, body?: unknown, cookie?: string) => fetch(base + route, {
    method: body === undefined ? 'GET' : 'PATCH', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : { authorization: 'Bearer home-test' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await fetch(base + '/api/console/home/layout')).status, 401);
    assert.equal((await fetch(base + '/m/api/home/layout')).status, 401);
    const pair = await createMobilePairingCode();
    const paired = await fetch(base + '/m/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairToken: pair.token, deviceLabel: 'Home test' }) });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');assert.ok(cookie);
    const board = spaceStore.save({ id: 'home-route-board', title: 'Home route board', viewContent: '<!doctype html><html><body><h1>Home route board</h1></body></html>' });
    const created = await send('/api/console/home/layout', { operation: 'pin', space_id: board.id, expected_revision: 0 });
    assert.equal(created.status, 200);
    const desktop = await (await send('/api/console/home/layout')).json();
    assert.deepEqual(await (await send('/m/api/home/layout', undefined, cookie)).json(), desktop);
    const edit = await send('/m/api/home/layout', { operation: 'update', space_id: board.id, expected_revision: desktop.layout.revision, width: 'wide' }, cookie);
    assert.equal(edit.status, 200);
    const latest = await edit.json();
    assert.equal(latest.layout.tiles[0].width, 'wide');
    assert.equal((await send('/api/console/home/layout', { operation: 'update', space_id: board.id, expected_revision: desktop.layout.revision, width: 'small' })).status, 409);
    assert.equal((await send('/api/console/home/layout', { operation: 'pin' })).status, 400);
    const bytes = readFileSync(HOME_LAYOUT_PATH, 'utf8');
    writeFileSync(HOME_LAYOUT_PATH, '{broken');
    for (const [route, credential] of [['/api/console/home/layout', undefined], ['/m/api/home/layout', cookie]] as const) {
      assert.equal((await send(route, undefined, credential)).status, 500);
      assert.equal((await send(route, { operation: 'remove', space_id: board.id, expected_revision: latest.layout.revision }, credential)).status, 500);
      assert.equal(readFileSync(HOME_LAYOUT_PATH, 'utf8'), '{broken');
    }
    writeFileSync(HOME_LAYOUT_PATH, bytes);
    assert.equal((await send('/m/api/home/layout', { operation: 'remove', space_id: board.id, expected_revision: latest.layout.revision }, cookie)).status, 200);
    assert.ok(spaceStore.get(board.id), 'unpin never deletes the Space');
    assert.deepEqual((await (await send('/api/console/home/layout')).json()).layout.tiles, []);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
