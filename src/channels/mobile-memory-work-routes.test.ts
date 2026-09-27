/**
 * Run: node scripts/run-tests-isolated.mjs src/channels/mobile-memory-work-routes.test.ts
 *
 * The phone's Memory-at-work doors serve the same snapshot and undo as the
 * desktop, and only behind the phone session check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';

const { registerMobileMemoryWorkRoutes } = await import('./mobile-memory-work-routes.js');
const { createMobileRouter } = await import('./mobile-routes.js');
const { runMemoryJob } = await import('../memory/memory-work-journal.js');
const { rememberFact, getFact } = await import('../memory/facts.js');

async function listen(app: express.Express) {
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('the phone doors refuse a request with no session', async () => {
  const app = express();
  app.use(express.json());
  app.use('/m', createMobileRouter({
    stateDir: mkdtempSync(path.join(os.tmpdir(), 'clem-mobile-memory-work-')),
    isAdminAuthorized: () => false,
  }));
  const { url, close } = await listen(app);
  try {
    // Registered (an unknown path is not found), and gated.
    assert.equal((await fetch(`${url}/m/api/memory/not-a-door`)).status, 404);
    assert.equal((await fetch(`${url}/m/api/memory/work`)).status, 401);
    assert.equal((await fetch(`${url}/m/api/memory/work/some-event/undo`, { method: 'POST' })).status, 401);
  } finally {
    await close();
  }
});

test('behind a session the phone gets the snapshot and can undo a run', async () => {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const seen: string[] = [];
  registerMobileMemoryWorkRoutes(router, (req, _res, next) => { seen.push(req.path); next(); });
  app.use('/m', router);
  const { url, close } = await listen(app);
  try {
    const id = rememberFact({ kind: 'project', content: 'A memory learned from a phone chat' }).id;
    await runMemoryJob('learn', {}, async () => 1, () => ({ outcome: 'ok', produced: { learned: 1 }, facts: { learned: [String(id)] } }));
    const res = await fetch(`${url}/m/api/memory/work`);
    assert.equal(res.status, 200);
    const snap = await res.json() as { state: string; jobs: unknown[]; recent: Array<{ id: string; undo: unknown }> };
    assert.equal(snap.jobs.length, 10);
    assert.deepEqual(snap.recent[0].undo, { kind: 'forget', count: 1 });

    const undo = await fetch(`${url}/m/api/memory/work/${snap.recent[0].id}/undo`, { method: 'POST' });
    assert.deepEqual(await undo.json(), { ok: true, changed: 1 });
    assert.equal(getFact(id)?.active, false);
    assert.equal((await fetch(`${url}/m/api/memory/work/${encodeURIComponent('bad id!')}/undo`, { method: 'POST' })).status, 400);
    assert.ok(seen.includes('/api/memory/work'), 'the session check ran');
  } finally {
    await close();
  }
});
