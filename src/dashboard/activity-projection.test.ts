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
const {
  projectActivitySnapshot,
  projectWorkflowRunActivity,
  shouldSurfaceInWorkingNow,
  WORKING_NOW_FOREGROUND_MS,
} = await import('./activity-projection.js');
const {
  appendEvent,
  beginRunAttempt,
  claimRunAttemptLease,
  closeEventLog,
  createSession,
  finishRunAttempt,
} = await import('../runtime/harness/eventlog.js');
const {
  createBackgroundTask,
  markBackgroundTaskFailed,
  markBackgroundTaskRunning,
} = await import('../execution/background-tasks.js');

type Entry = ReturnType<typeof projectActivitySnapshot>['entries'][number];

function entryFor(entries: Entry[], runKey: string): Entry {
  const found = entries.find((entry) => entry.runKey === runKey);
  assert.ok(found, `no projection entry for ${runKey}`);
  return found;
}

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

// ── the unified projection, black-box through the real stores ────────────────

test('chat, background, and workflow work all appear in ONE projection', () => {
  const session = createSession({ kind: 'chat', channel: 'discord', title: 'Pipeline review' });
  beginRunAttempt(session.id, { runId: 'unified-chat' });
  const task = createBackgroundTask({
    title: 'Segment the prospect list',
    prompt: 'segment the list',
    source: 'discord',
  });
  markBackgroundTaskRunning(task.id);

  const { entries } = projectActivitySnapshot();
  const kinds = new Set(entries.map((entry) => entry.kind));
  assert.ok(kinds.has('chat') && kinds.has('background') && kinds.has('workflow'),
    `the projection lost a kind: ${[...kinds].join(', ')}`);

  const chat = entryFor(entries, `chat:${session.id}`);
  assert.equal(chat.presentationLane, 'foreground');
  assert.equal(chat.lifecycle, 'reasoning', 'a live attempt is running');
  assert.equal(chat.terminal, undefined, 'an unsettled turn grew a terminal');

  const background = entryFor(entries, `background:${task.id}`);
  assert.equal(background.presentationLane, 'detached');
  assert.equal(background.lifecycle, 'reasoning');
  // No admitted denominator ⇒ no invented progress bar.
  assert.equal(background.progress, undefined);

  const queued = entryFor(entries, 'workflow:act-queued');
  assert.equal(queued.lifecycle, 'queued', 'queued is queued — never running');
});

test('revisions advance with durable evidence and never rewind', () => {
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  beginRunAttempt(session.id, { runId: 'unified-revision' });
  const before = entryFor(projectActivitySnapshot().entries, `chat:${session.id}`);

  appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
  const after = entryFor(projectActivitySnapshot().entries, `chat:${session.id}`);

  assert.ok(after.revision > before.revision,
    `revision did not advance with a new durable event (${before.revision} → ${after.revision})`);
});

test('a held lease keeps a quiet run live; an expired lease is stale and needs a person', () => {
  const live = createSession({ kind: 'chat', channel: 'desktop' });
  claimRunAttemptLease({
    sessionId: live.id,
    runId: 'lease-live',
    ownerId: 'daemon-under-test',
    leaseMs: 10 * 60_000,
  });
  const quiet = entryFor(projectActivitySnapshot().entries, `chat:${live.id}`);
  // The provider has said nothing since the attempt opened; the lease has.
  assert.equal(quiet.liveness, 'live', 'a leased run went stale on silence alone');
  assert.equal(quiet.needsAttention, false);

  const lost = createSession({ kind: 'chat', channel: 'desktop' });
  claimRunAttemptLease({
    sessionId: lost.id,
    runId: 'lease-expired',
    ownerId: 'daemon-that-died',
    leaseMs: 1_000,
    nowMs: Date.now() - 5 * 60_000,
  });
  const stale = entryFor(projectActivitySnapshot().entries, `chat:${lost.id}`);
  assert.equal(stale.liveness, 'stale', 'an expired lease still read as live');
  assert.equal(stale.needsAttention, true);
  assert.equal(stale.lifecycle, 'reasoning', 'a lost lease is not a terminal');
  assert.equal(stale.terminal, undefined, 'a lost lease was dressed as a settled run');
});

test('an unsettled or failed run cannot be served as a success by any field', () => {
  const failedTask = createBackgroundTask({ title: 'Nightly export', prompt: 'export', source: 'gateway' });
  markBackgroundTaskRunning(failedTask.id);
  markBackgroundTaskFailed(failedTask.id, 'the export endpoint refused');

  const interrupted = createSession({ kind: 'chat', channel: 'desktop' });
  const attempt = beginRunAttempt(interrupted.id, { runId: 'unified-interrupted' });
  finishRunAttempt(attempt, 'interrupted');

  const { entries } = projectActivitySnapshot();
  const failed = entryFor(entries, `background:${failedTask.id}`);
  assert.equal(failed.lifecycle, 'failed');
  assert.equal(failed.terminal?.status, 'failed');
  assert.equal(failed.needsAttention, true, 'a failed run asked nothing of the user');
  assert.equal(JSON.stringify(failed).includes('"status":"completed"'), false,
    'a failed run carries a completed status somewhere in its payload');

  const stopped = entryFor(entries, `chat:${interrupted.id}`);
  assert.equal(stopped.terminal?.status, 'failed', 'an interrupted attempt was promoted to success');
  assert.equal(stopped.terminal?.kind, 'interrupted', 'the interruption lost its identity');
  assert.equal(stopped.lifecycle, 'failed');
});

test('Working Now opens for detached work and for long chat, never for an ordinary turn', () => {
  const observedAtMs = Date.parse('2026-08-04T12:00:00.000Z');
  const fresh = {
    kind: 'chat', presentationLane: 'foreground', startedAt: '2026-08-04T11:59:50.000Z',
  } as unknown as Entry;
  const lingering = {
    kind: 'chat', presentationLane: 'foreground', startedAt: '2026-08-04T11:55:00.000Z',
  } as unknown as Entry;
  const detached = {
    kind: 'background', presentationLane: 'detached', startedAt: '2026-08-04T11:59:59.000Z',
  } as unknown as Entry;
  const settled = {
    kind: 'background', presentationLane: 'detached', startedAt: '2026-08-04T11:00:00.000Z',
    terminal: { status: 'completed', kind: 'done', text: 'Task completed.', resumable: false },
  } as unknown as Entry;

  assert.equal(shouldSurfaceInWorkingNow(fresh, observedAtMs), false,
    'an ordinary foreground turn opened a Working Now row');
  assert.equal(shouldSurfaceInWorkingNow(lingering, observedAtMs), true);
  assert.equal(shouldSurfaceInWorkingNow(detached, observedAtMs), true,
    'detached work must be visible the moment it starts');
  assert.equal(shouldSurfaceInWorkingNow(settled, observedAtMs), false,
    'a settled run is not working');
  assert.ok(WORKING_NOW_FOREGROUND_MS >= 60_000);
});

test('the projection reconstructs identically after a restart', () => {
  const observedAt = '2026-08-04T12:00:00.000Z';
  const before = projectActivitySnapshot({ observedAt });
  // Drop every open handle the way a daemon restart does; the next read must
  // rebuild the same entries from the durable stores alone.
  closeEventLog();
  const after = projectActivitySnapshot({ observedAt });
  assert.deepEqual(after.entries, before.entries,
    'the projection depends on process state, not on durable truth');
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
