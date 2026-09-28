import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-routes-'));
process.env.CLEMENTINE_HOME = home;
const { registerCliSessionRoutes } = await import('./cli-session-routes.js');
const { BASE_DIR } = await import('../config.js');

test('desktop and mobile process controls require authentication and exact conversation identity', async () => {
  const app = express(); app.use(express.json());
  const guard: express.RequestHandler = (req, res, next) => {
    if (req.headers['x-fixture-owner'] !== 'owner') { res.sendStatus(401); return; } next();
  };
  for (const prefix of ['/api/console', '/m/api']) registerCliSessionRoutes(app, guard, prefix);
  const directory = path.join(BASE_DIR, 'state', 'cli-jobs'); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'cli-abcdef.json'), JSON.stringify({ id: 'cli-abcdef', sessionId: 'sess-owner',
    bootId: 'prior-boot', status: 'running', title: 'Controlled fixture', output: '', startedAt: new Date().toISOString() }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const prefix of ['/api/console', '/m/api']) {
      assert.equal((await fetch(`${base}${prefix}/cli-sessions?sessionId=sess-owner`)).status, 401);
      const headers = { 'x-fixture-owner': 'owner', 'content-type': 'application/json' };
      const own = await fetch(`${base}${prefix}/cli-sessions?sessionId=sess-owner`, { headers });
      assert.equal(own.headers.get('cache-control'), 'no-store');
      assert.equal((await own.json()).jobs[0].status, 'interrupted');
      const foreign = await fetch(`${base}${prefix}/cli-sessions?sessionId=sess-other`, { headers });
      assert.deepEqual((await foreign.json()).jobs, []);
      for (const action of ['input', 'cancel']) assert.equal((await fetch(`${base}${prefix}/cli-sessions/cli-abcdef/${action}`, {
        method: 'POST', headers, body: JSON.stringify({ sessionId: 'sess-other', input: 'fixture' }),
      })).status, 409);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});
