import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-capability-route-'));
process.env.CLEMENTINE_HOME = testHome;

const { registerConsoleRoutes } = await import('./console-routes.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

test.after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(authorized = true): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized, {
    getRuntime: () => ({ listPendingApprovals: () => [] }),
  } as never, { serveLegacyAtRoot: false });
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

test('capability resume route re-admits the same run and is idempotent across a retry race', async () => {
  const slug = 'resume-capability-flow';
  const workflowName = 'Resume capability flow';
  const runId = 'capability-route-run';
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Resume after reconnecting.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'read', prompt: 'Read connected data.', sideEffect: 'read' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runPath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runPath, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'blocked_capability',
    createdAt: new Date().toISOString(),
    capabilityBlock: {
      state: 'blocked',
      stepId: 'read',
      tool: 'GOOGLEDRIVE_LIST_FILES',
      toolkit: 'googledrive',
      reason: 'not-connected',
      message: 'Connect Google Drive.',
      blockedAt: new Date().toISOString(),
      retryAt: new Date(Date.now() + 60_000).toISOString(),
      retryCount: 1,
      provenNoDispatch: true,
    },
  }), 'utf-8');

  const server = await boot();
  try {
    const endpoint = `${server.url}/api/console/workflows/${encodeURIComponent(slug)}/runs/${runId}/resume-capability`;
    const first = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      ok: true,
      runId,
      status: 'running',
      alreadyResumed: false,
    });
    const record = JSON.parse(readFileSync(runPath, 'utf-8')) as {
      status: string;
      capabilityBlock: { state: string; resumedAt?: string };
    };
    assert.equal(record.status, 'running');
    assert.equal(record.capabilityBlock.state, 'retrying');
    assert.ok(record.capabilityBlock.resumedAt);

    const second = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { alreadyResumed: boolean }).alreadyResumed, true);
  } finally {
    await server.close();
  }
});
