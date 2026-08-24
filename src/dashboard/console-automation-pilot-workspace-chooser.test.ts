/** Run: node scripts/run-tests-isolated.mjs src/dashboard/console-automation-pilot-workspace-chooser.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-console-workspace-chooser-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const { registerConsoleRoutes } = await import('./console-routes.js');
const eventlog = await import('../runtime/harness/eventlog.js');

async function boot() {
  const authorized = { value: false };
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized.value, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    authorized,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('desktop Workspace chooser uses console auth and malformed decisions fail closed', async () => {
  const harness = await boot();
  try {
    const anonymous = await fetch(`${harness.url}/api/console/automation-pilot/workspace-choosers`);
    assert.equal(anonymous.status, 401);

    harness.authorized.value = true;
    const listed = await fetch(`${harness.url}/api/console/automation-pilot/workspace-choosers`);
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { choosers: [], count: 0 });

    const malformed = await fetch(
      `${harness.url}/api/console/automation-pilot/workspace-choosers/not-valid!/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chooserRevision: 1,
          chooserDigest: 'a'.repeat(64),
          choiceId: 'choice.valid',
          actorRef: 'model.must_not_choose',
        }),
      },
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { error: string }).error, 'workspace_chooser_request_invalid');
  } finally {
    await harness.close();
  }
});
