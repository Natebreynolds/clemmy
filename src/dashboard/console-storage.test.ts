import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-storage-route-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
writeFileSync(path.join(home, 'private-file-name'), 'private contents');
const { registerConsoleRoutes } = await import('./console-routes.js');
test.after(() => rmSync(home, { recursive: true, force: true }));

test('console storage is an authenticated metadata read; caller paths cannot change the scanned home', async () => {
  const app = express();
  registerConsoleRoutes(app, req => req.get('authorization') === 'Bearer storage-fixture', {} as never, { serveLegacyAtRoot: false });
  const server = await new Promise<Server>(resolve => {
    const instance = createServer(app); instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/storage`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { authorization: 'Bearer storage-fixture' };
    const response = await fetch(`${url}?baseDir=/&maxEntries=999999999`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.complete, true);
    assert.equal(result.categories.length, 6);
    const rendered = JSON.stringify(result);
    for (const privateValue of [home, 'private-file-name', 'private contents']) assert.equal(rendered.includes(privateValue), false);
    assert.deepEqual(await (await fetch(url, { headers })).json(), result, 'repeat requests reuse the bounded scan');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
