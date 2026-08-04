/**
 * Run: npx tsx --test src/dashboard/activity-projection.test.ts
 *
 * The server projector (U1's second half) against real route plumbing: durable
 * run records become shared snapshots with the truth rules intact, and the
 * privacy discipline of the runs-list projection is inherited — outputs,
 * inputs, and prompts never enter a snapshot.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-activity-v2-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(testHome, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { projectWorkflowRunActivity } = await import('./activity-projection.js');

test.after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, {
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

test('durable run records project to shared snapshots with truth rules and privacy intact', async () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'act-running.json'), JSON.stringify({
    id: 'act-running', workflow: 'Morning Digest', status: 'running',
    createdAt: '2026-08-04T10:00:00.000Z', startedAt: '2026-08-04T10:00:01.000Z',
    source: 'cron',
    inputs: { secretInput: 'NEVER-IN-A-SNAPSHOT' },
    stepOutputs: { pull: { privateRows: 'NEVER-IN-A-SNAPSHOT' } },
  }), 'utf-8');
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'act-blocked.json'), JSON.stringify({
    id: 'act-blocked', workflow: 'CRM Sync', status: 'blocked_capability',
    createdAt: '2026-08-04T10:01:00.000Z',
    capabilityBlock: {
      state: 'blocked', toolkit: 'salesforce',
      message: 'Reconnect Salesforce to resume.',
      privateEvidence: 'NEVER-IN-A-SNAPSHOT',
    },
  }), 'utf-8');
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'act-done.json'), JSON.stringify({
    id: 'act-done', workflow: 'Weekly Report', status: 'completed',
    createdAt: '2026-08-04T09:00:00.000Z', finishedAt: '2026-08-04T09:05:00.000Z',
    output: 'the full private report body NEVER-IN-A-SNAPSHOT',
  }), 'utf-8');
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'act-queued.json'), JSON.stringify({
    id: 'act-queued', workflow: 'Backlog Sweep', status: 'queued',
    createdAt: '2026-08-04T10:02:00.000Z',
  }), 'utf-8');

  const server = await boot();
  try {
    const response = await fetch(`${server.url}/api/console/activity/v2`);
    assert.equal(response.status, 200);
    const body = await response.json() as { schemaVersion: number; snapshots: Array<Record<string, unknown>> };
    assert.equal(body.schemaVersion, 1);
    const byKey = new Map(body.snapshots.map((s) => [s.runKey as string, s]));

    const running = byKey.get('workflow:act-running')!;
    assert.equal(running.lifecycle, 'reasoning');
    assert.equal(running.presentationLane, 'scheduled', 'a cron run is the scheduled lane');
    // No declared lease horizon → liveness is UNKNOWN, never silently live.
    assert.equal(running.liveness, 'unknown');
    assert.equal(running.terminal, undefined, 'a running run grew a terminal');
    assert.equal(running.lastEvidenceAt, '2026-08-04T10:00:01.000Z',
      'evidence time must be the durable record, never poll time');

    const blocked = byKey.get('workflow:act-blocked')!;
    assert.equal(blocked.lifecycle, 'blocked');
    assert.match(String(blocked.detail), /Reconnect Salesforce/);

    const done = byKey.get('workflow:act-done')!;
    assert.equal(done.lifecycle, 'completed');
    assert.equal((done.terminal as { status?: string }).status, 'completed');

    const queued = byKey.get('workflow:act-queued')!;
    assert.equal(queued.lifecycle, 'queued', 'queued is queued — never running');

    // The privacy inheritance, asserted at the byte level.
    assert.equal(JSON.stringify(body).includes('NEVER-IN-A-SNAPSHOT'), false,
      'a private field crossed into the activity projection');
  } finally {
    await server.close();
  }
});

test('the projector never invents identity and unknown statuses stay honest', () => {
  assert.equal(projectWorkflowRunActivity({ status: 'running' }, '2026-08-04T10:00:00Z'), null,
    'a record without identity was projected');
  const odd = projectWorkflowRunActivity(
    { id: 'x', workflow: 'W', status: 'some_future_status' },
    '2026-08-04T10:00:00Z',
  )!;
  assert.equal(odd.lifecycle, 'accepted', 'an unknown status was mapped to running or completed');
  assert.equal(odd.terminal, undefined);
});
