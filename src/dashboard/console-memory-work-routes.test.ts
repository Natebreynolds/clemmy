/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/console-memory-work-routes.test.ts
 *
 * The desktop's Memory-at-work doors: the snapshot and undo, behind the
 * console's auth gate, mounted by the real registerConsoleRoutes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';

const { registerConsoleRoutes } = await import('./console-routes.js');
const { runMemoryJob } = await import('../memory/memory-work-journal.js');
const { rememberFact, getFact } = await import('../memory/facts.js');

async function boot(authorized: { v: boolean }) {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized.v, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('GET /api/console/memory/work serves the snapshot; auth gated', async () => {
  const auth = { v: true };
  const { url, close } = await boot(auth);
  try {
    const res = await fetch(`${url}/api/console/memory/work`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    for (const key of ['generatedAt', 'state', 'running', 'queue', 'model', 'jobs', 'today', 'hourly', 'daily', 'recent', 'retention']) {
      assert.ok(key in body, key);
    }
    assert.equal((body.jobs as unknown[]).length, 10);
    auth.v = false;
    assert.equal((await fetch(`${url}/api/console/memory/work`)).status, 401);
  } finally {
    await close();
  }
});

test('POST /api/console/memory/work/:id/undo forgets what a run learned; bad ids are refused', async () => {
  const auth = { v: true };
  const { url, close } = await boot(auth);
  try {
    const id = rememberFact({ kind: 'project', content: 'A memory the owner wants gone' }).id;
    await runMemoryJob('learn', {}, async () => 1, () => ({ outcome: 'ok', produced: { learned: 1 }, facts: { learned: [String(id)] } }));
    const snap = await (await fetch(`${url}/api/console/memory/work`)).json() as { recent: Array<{ id: string; undo: unknown }> };
    const event = snap.recent[0];
    assert.deepEqual(event.undo, { kind: 'forget', count: 1 });

    const undo = await fetch(`${url}/api/console/memory/work/${event.id}/undo`, { method: 'POST' });
    assert.equal(undo.status, 200);
    assert.deepEqual(await undo.json(), { ok: true, changed: 1 });
    assert.equal(getFact(id)?.active, false);

    const again = await fetch(`${url}/api/console/memory/work/${event.id}/undo`, { method: 'POST' });
    assert.deepEqual(await again.json(), { ok: false, reason: 'nothing_to_undo' });
    const missing = await fetch(`${url}/api/console/memory/work/not-a-real-event/undo`, { method: 'POST' });
    assert.deepEqual(await missing.json(), { ok: false, reason: 'not_found' });
    const bad = await fetch(`${url}/api/console/memory/work/${encodeURIComponent('bad id!')}/undo`, { method: 'POST' });
    assert.equal(bad.status, 400);

    auth.v = false;
    assert.equal((await fetch(`${url}/api/console/memory/work/${event.id}/undo`, { method: 'POST' })).status, 401);
  } finally {
    await close();
  }
});
