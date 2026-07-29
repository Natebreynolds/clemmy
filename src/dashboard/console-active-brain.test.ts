/**
 * Run: npx tsx --test src/dashboard/console-active-brain.test.ts
 *
 * The active-brain picker is a second write path into all-in BYO mode. Keep its
 * legacy worker slot in lockstep with the older model-backend form so a stale
 * gpt-* value cannot cold-probe the BYO endpoint on the next fan-out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-active-brain-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.BYO_MODEL_BASE_URL = 'https://api.z.ai/api/paas/v4';
process.env.BYO_MODEL_API_KEY = 'test-only-key';
process.env.BYO_MODEL_ID = 'glm-5.2';
process.env.OPENAI_MODEL_WORKER = 'gpt-5.4';
process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
  { role: 'worker', modelId: 'gpt-5.6-luna', scope: 'durable', source: 'settings' },
]);
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot() {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('switching to the BYO brain syncs the all-in worker slot without rewriting durable bindings', async () => {
  const durableBindings = process.env.CLEMMY_MODEL_ROLES;
  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/console/settings/active-brain`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brain: 'api_key' }),
    });
    const body = await response.json() as { activeBrain?: string; error?: string };
    assert.equal(response.status, 200, body.error);
    assert.equal(body.activeBrain, 'api_key');
    assert.equal(process.env.MODEL_ROUTING_MODE, 'all_in');
    assert.equal(process.env.OPENAI_MODEL_WORKER, 'glm-5.2');
    assert.equal(
      process.env.CLEMMY_MODEL_ROLES,
      durableBindings,
      'switching the brain changes the fallback slot, not the user-owned role binding',
    );

    const persisted = readFileSync(path.join(TMP_HOME, '.env'), 'utf8');
    assert.match(persisted, /^OPENAI_MODEL_WORKER=glm-5\.2$/m);
    assert.match(persisted, /^MODEL_ROUTING_MODE=all_in$/m);
  } finally {
    await harness.close();
  }
});
