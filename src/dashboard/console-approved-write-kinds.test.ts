/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/console-approved-write-kinds.test.ts
 *
 * What Ask mode learned is visible and forgettable from the desktop: the list
 * names each kind (operation on account) an approval taught, forgetting one
 * removes it, and the retired run-limits writer is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-kinds-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const scopes = await import('../agents/plan-scope.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

async function boot() {
  const app = express();
  app.use(express.json());
  const assistant = { getRuntime: () => ({ listPendingApprovals: () => [] }) };
  registerConsoleRoutes(app, () => true, assistant as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('approved kinds are listed and can be forgotten; run limits cannot be written', async () => {
  scopes.recordApprovedWriteKind({ operationId: 'EXAMPLE_CREATE_ROW', accountId: 'account:owner', approvalId: 'apr-1' });
  const h = await boot();
  try {
    const listed = await (await fetch(`${h.url}/api/console/approved-write-kinds`)).json() as { kinds: Array<{ operationId: string; accountId: string | null }> };
    assert.deepEqual(listed.kinds.map((k) => [k.operationId, k.accountId]), [['EXAMPLE_CREATE_ROW', 'account:owner']]);

    const forgotten = await fetch(`${h.url}/api/console/approved-write-kinds`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'EXAMPLE_CREATE_ROW', accountId: 'account:owner' }),
    });
    assert.equal(forgotten.status, 200);
    assert.equal(scopes.listApprovedWriteKinds().length, 0);

    const again = await fetch(`${h.url}/api/console/approved-write-kinds`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'EXAMPLE_CREATE_ROW', accountId: 'account:owner' }),
    });
    assert.equal(again.status, 404);

    const budget = await fetch(`${h.url}/api/console/settings/runtime-budget`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxTurns: 3 }),
    });
    assert.equal(budget.status, 410, 'run limits are not the owner\'s to tune');
  } finally {
    await h.close();
  }
});
