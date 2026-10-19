import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-console-install-quiescence-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true' });
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('../runtime/harness/eventlog.js');
const { registerConsoleRoutes } = await import('./console-routes.js');
beforeEach(() => events.resetEventLog());
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

async function request(authorized = true) {
  const app = express();
  registerConsoleRoutes(app, () => authorized, {
    getRuntime: () => ({ listPendingApprovals: () => [] }),
  } as never, { serveLegacyAtRoot: false });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/active-work`);
    return { status: response.status, body: await response.json() };
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('the shipped native total/summary ignore302 historical rows while retained activity remains visible', async () => {
  for (let index = 0; index < 302; index++) {
    const session = events.createSession({ kind: 'workflow', metadata: { workflowRunId: `historical-${index}`,
      workflowName: 'historical-workflow', stepId: 'historical-step' } });
    if (index % 2) events.updateSession(session.id, { status: 'paused' });
  }
  const { status, body } = await request();
  assert.equal(status, 200);
  assert.equal(body.activeSessions, 302, 'legacy activity/history field is not rewritten');
  assert.equal(body.items.length, 302);
  assert.equal(body.total, 0, 'existing native main.ts reads current ownership through its unchanged contract');
  assert.equal(body.summary, 'no active work');
  assert.equal(body.currentWork.total, 0);
  assert.equal(body.quiescence.state, 'quiescent');
});

test('an unreadable activity store returns a200 unverified warning instead of native fail-open', async () => {
  const session = events.createSession({ kind: 'workflow' });
  events.openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run('{', session.id);
  const { status, body } = await request();
  assert.equal(status, 200);
  assert.ok(body.total > 0);
  assert.match(body.summary, /could not be fully verified/);
  assert.equal(body.quiescence.state, 'unverified');
  assert.equal(body.activityAvailable, false);
});

test('install quiescence remains authenticated', async () => {
  const { status } = await request(false);
  assert.equal(status, 401);
});

test('an unexpected snapshot exception is caught by the route before the native probe can fail open', () => {
  const app = express();
  registerConsoleRoutes(app, () => true, { getRuntime: () => ({ listPendingApprovals: () => [] }) } as never,
    { serveLegacyAtRoot: false });
  const layer = (app as unknown as { _router: { stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }> } })
    ._router.stack.find(candidate => candidate.route?.path === '/api/console/active-work');
  assert.ok(layer?.route);
  let body: any;
  const originalNow = Date.now;
  Date.now = () => { throw new Error('controlled unexpected clock failure'); };
  try {
    layer.route.stack[0]!.handle({}, { json: (value: unknown) => { body = value; } });
  } finally { Date.now = originalNow; }
  assert.ok(body.total > 0);
  assert.equal(body.quiescence.state, 'unverified');
  assert.ok(body.quiescence.issues.includes('install_inventory_unreadable'));
});
