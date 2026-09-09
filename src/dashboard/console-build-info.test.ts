import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-console-build-info-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.NODE_ENV = 'test';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const { registerConsoleRoutes } = await import('./console-routes.js');

test.after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

async function boot() {
  const app = express();
  registerConsoleRoutes(app, req => req.get('authorization') === 'Bearer fixture-build-reader',
    {} as never, { serveLegacyAtRoot: false });
  const server = await new Promise<Server>(resolve => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/build-info`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test('authenticated build identity remains identical across requests, clock movement, and route registrations', async (t) => {
  const first = await boot();
  t.after(() => first.close());
  const headers = { authorization: 'Bearer fixture-build-reader' };
  const initial = await fetch(first.url, { headers });
  assert.equal(initial.status, 200);
  const expected = await initial.json() as Record<string, unknown>;
  assert.match(String(expected.daemonInstanceId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(expected.daemonProcessId, process.pid);
  assert.ok(Number.isFinite(Date.parse(String(expected.startedAt))));
  assert.ok(Date.parse(String(expected.startedAt)) <= Date.now());

  // A wall-clock correction exposes the old request-time reconstruction
  // deterministically; no timestamp tolerance can conceal identity drift.
  const realNow = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => realNow() + 3_000);
  const second = await boot();
  t.after(() => second.close());
  for (const url of [first.url, second.url, first.url]) {
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  }
});

test('build identity remains behind the existing console authorization gate', async (t) => {
  const server = await boot();
  t.after(() => server.close());
  const response = await fetch(server.url);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});
