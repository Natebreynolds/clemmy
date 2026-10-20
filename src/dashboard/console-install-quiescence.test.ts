import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-console-install-quiescence-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true' });
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('../runtime/harness/eventlog.js');
const { registerConsoleRoutes } = await import('./console-routes.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
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
    return { status: response.status, cacheControl: response.headers.get('cache-control'), body: await response.json() };
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('the shipped native total/summary ignore302 historical rows while retained activity remains visible', async () => {
  for (let index = 0; index < 302; index++) {
    const session = events.createSession({ kind: 'workflow', metadata: { workflowRunId: `historical-${index}`,
      workflowName: 'historical-workflow', stepId: 'historical-step' } });
    if (index % 2) events.updateSession(session.id, { status: 'paused' });
  }
  const { status, cacheControl, body } = await request();
  assert.equal(status, 200);
  assert.equal(cacheControl, 'no-store');
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

test('the actual active-work HTTP route leaves the event loop available during its worker observation', async () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  for (let index = 0; index < 600; index++) writeFileSync(path.join(WORKFLOW_RUNS_DIR, `http-closed-${index}.json`), JSON.stringify({
    id: `http-closed-${index}`, workflow: 'controlled-http-fixture', status: 'completed',
    stepOutputs: { controlled: 'x'.repeat(2_000) }, finishedAt: '2026-01-01T00:00:00Z' }));
  const app = express(); let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  app.use((req, _res, next) => { next(); if (req.path === '/api/console/active-work') entered(); });
  app.get('/controlled-ping', (_req, res) => { res.json({ alive: true }); });
  registerConsoleRoutes(app, () => true, { getRuntime: () => ({ listPendingApprovals: () => [] }) } as never,
    { serveLegacyAtRoot: false });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let finished = false;
  try {
    const observation = fetch(base + '/api/console/active-work').then(async response => {
      const body = await response.json(); finished = true; return { response, body };
    });
    await started;
    const ping = await fetch(base + '/controlled-ping');
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { alive: true });
    assert.equal(finished, false, 'the registered route is awaiting its worker while another HTTP request completes');
    const { response, body } = await observation;
    assert.equal(response.status, 200); assert.equal(body.quiescence.state, 'quiescent');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  }
});

test('an unexpected observer exception is caught by the async route before the native probe can fail open', async () => {
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
    await layer.route.stack[0]!.handle({}, { set: () => {}, json: (value: unknown) => { body = value; } });
  } finally { Date.now = originalNow; }
  assert.ok(body.total > 0);
  assert.equal(body.quiescence.state, 'unverified');
  assert.ok(body.quiescence.issues.includes('active_work_observation_unverified'));
});
