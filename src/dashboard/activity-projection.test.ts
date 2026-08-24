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
  projectForegroundWorkingNowEntry,
  projectForegroundWorkingNowSnapshot,
  projectWorkingNowSnapshot,
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
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'act-mutation.json'), JSON.stringify({
    id: 'act-mutation', workflow: 'Team Update', status: 'blocked_mutation',
    createdAt: '2026-08-04T10:01:30.000Z',
    mutationBlock: {
      state: 'awaiting_reconciliation', stepId: 'send_update',
      fingerprint: 'a'.repeat(64), providerRedispatched: false,
      privateProviderResponse: 'NEVER-IN-A-SNAPSHOT',
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

    const mutationBlocked = byKey.get('workflow:act-mutation')!;
    assert.equal(mutationBlocked.lifecycle, 'blocked');
    assert.equal(mutationBlocked.needsAttention, true);
    assert.match(String(mutationBlocked.detail), /send_update/);
    assert.match(String(mutationBlocked.detail), /not sent again/i);

    const done = byKey.get('workflow:act-done')!;
    assert.equal(done.lifecycle, 'completed');
    assert.equal((done.terminal as { status?: string }).status, 'completed');

    const queued = byKey.get('workflow:act-queued')!;
    assert.equal(queued.lifecycle, 'queued', 'queued is queued — never running');

    // The privacy inheritance, asserted at the byte level.
    assert.equal(JSON.stringify(body).includes('NEVER-IN-A-SNAPSHOT'), false,
      'a private field crossed into the activity projection');

    const foregroundResponse = await fetch(
      `${server.url}/api/console/activity/v2?workingNow=1&surface=foreground-chat`,
    );
    assert.equal(foregroundResponse.status, 200);
    const foregroundBytes = await foregroundResponse.text();
    const foreground = JSON.parse(foregroundBytes) as { entries: Array<Record<string, unknown>> };
    assert.ok(foreground.entries.some((entry) => entry.runKey === 'workflow:act-blocked'));
    for (const canary of [
      'Reconnect Salesforce to resume.',
      'salesforce',
      'send_update',
      'not sent again',
    ]) {
      assert.equal(foregroundBytes.includes(canary), false, `foreground Activity leaked ${canary}`);
    }
    const foregroundBlocked = foreground.entries.find((entry) => entry.runKey === 'workflow:act-blocked')!;
    for (const forbiddenKey of ['detail', 'origin', 'owner', 'nextAction', 'terminal', 'presentationLane', 'connectivity']) {
      assert.equal(Object.hasOwn(foregroundBlocked, forbiddenKey), false, forbiddenKey);
    }
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

test('Working Now filters durable rows before its response cap', async () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const activeId = 'working-now-behind-terminals';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${activeId}.json`), JSON.stringify({
    id: activeId,
    workflow: 'Long-running audit',
    status: 'running',
    createdAt: '2026-08-01T00:00:00.000Z',
    startedAt: '2026-08-01T00:00:00.000Z',
  }), 'utf-8');
  const terminalBase = Date.parse('2026-08-29T00:00:00.000Z');
  for (let index = 0; index < 105; index += 1) {
    const id = `working-now-newer-terminal-${String(index).padStart(3, '0')}`;
    const startedAt = new Date(terminalBase + index * 1_000).toISOString();
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), JSON.stringify({
      id,
      workflow: 'Already settled audit',
      status: 'completed',
      createdAt: startedAt,
      startedAt,
      finishedAt: startedAt,
    }), 'utf-8');
  }

  const observedAt = '2026-08-30T00:00:00.000Z';
  const cappedBeforeMembership = projectActivitySnapshot({ observedAt, kinds: ['workflow'], limit: 100 });
  assert.equal(cappedBeforeMembership.entries.some((entry) => entry.runId === activeId), false,
    'the fixture did not place the live run behind the ordinary snapshot cap');
  const workingNow = projectWorkingNowSnapshot({ observedAt, kinds: ['workflow'], limit: 100 });
  assert.ok(workingNow.entries.some((entry) => entry.runId === activeId),
    'newer terminal history hid older durable work before Working Now membership was applied');
  assert.ok(workingNow.entries.every((entry) => !entry.terminal),
    'a terminal crossed the dedicated Working Now boundary');

  const server = await boot();
  try {
    const response = await fetch(`${server.url}/api/console/activity/v2?workingNow=1`);
    assert.equal(response.status, 200);
    const body = await response.json() as { entries: Entry[] };
    assert.ok(body.entries.some((entry) => entry.runId === activeId),
      'the console route reintroduced cap-before-membership');
    assert.ok(body.entries.length <= 100, 'the bounded route exceeded its response contract');
  } finally {
    await server.close();
  }
});

test('Working Now reads eligible active chat attempts past the historical session cap', () => {
  const oldStartedAt = Date.now() - 5 * 60_000;
  const oldLive = createSession({ kind: 'chat', channel: 'desktop', title: 'Older live turn' });
  const claim = claimRunAttemptLease({
    sessionId: oldLive.id,
    runId: 'working-now-old-live-chat',
    ownerId: 'working-now-query-test',
    leaseMs: 30 * 60_000,
    nowMs: oldStartedAt,
  });
  assert.equal(claim.claimed, true);

  for (let index = 0; index < 65; index += 1) {
    const newer = createSession({ kind: 'chat', channel: 'desktop', title: `Newer settled turn ${index}` });
    const attempt = beginRunAttempt(newer.id, { runId: `working-now-newer-${index}` });
    finishRunAttempt(attempt, 'completed');
  }

  const observedAt = new Date().toISOString();
  const ordinary = projectActivitySnapshot({ observedAt, kinds: ['chat'], sessionLimit: 60, limit: 100 });
  assert.equal(ordinary.entries.some((entry) => entry.sessionId === oldLive.id), false,
    'the fixture did not place the active chat behind newer session history');
  const workingNow = projectWorkingNowSnapshot({ observedAt, kinds: ['chat'], limit: 100 });
  const surfaced = workingNow.entries.find((entry) => entry.sessionId === oldLive.id);
  assert.ok(surfaced, 'the bounded active-attempt query lost an eligible older live chat');
  assert.equal(surfaced?.attemptId, claim.attempt?.attemptId,
    'Working Now did not rejoin the exact durable attempt');
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

test('canonical workflow terminal vocabulary has one truthful Working Now membership', () => {
  const observedAt = '2026-08-04T12:00:00.000Z';
  const observedAtMs = Date.parse(observedAt);
  const cases = [
    { status: 'completed', lifecycle: 'completed', terminal: 'succeeded', visible: false },
    { status: 'completed_with_errors', lifecycle: 'failed', terminal: 'partial', visible: false },
    { status: 'blocked', lifecycle: 'blocked', terminal: undefined, visible: true },
    { status: 'error', lifecycle: 'failed', terminal: 'failed', visible: false },
    { status: 'failed', lifecycle: 'failed', terminal: 'failed', visible: false },
    { status: 'cancelled', lifecycle: 'cancelled', terminal: 'cancelled', visible: false },
    { status: 'dry_run', lifecycle: 'completed', terminal: 'succeeded', visible: false },
    { status: 'creation_test', lifecycle: 'completed', terminal: 'succeeded', visible: false },
  ] as const;

  for (const [index, expected] of cases.entries()) {
    const projected = projectWorkflowRunActivity({
      id: `terminal-vocabulary-${index}`,
      workflow: 'Vocabulary workflow',
      status: expected.status,
      createdAt: '2026-08-04T10:00:00.000Z',
      finishedAt: '2026-08-04T10:05:00.000Z',
    }, observedAt)!;
    assert.equal(projected.lifecycle, expected.lifecycle, expected.status);
    assert.equal(projected.terminal?.kind, expected.terminal, expected.status);
    assert.equal(shouldSurfaceInWorkingNow(projected, observedAtMs), expected.visible, expected.status);
  }

  for (const status of ['dry_run', 'creation_test'] as const) {
    const unfinished = projectWorkflowRunActivity({
      id: `unfinished-${status}`,
      workflow: 'Unfinished test workflow',
      status,
      createdAt: '2026-08-04T10:00:00.000Z',
    }, observedAt)!;
    assert.equal(unfinished.lifecycle, 'accepted', `${status} was treated as final without finishedAt`);
    assert.equal(unfinished.terminal, undefined);
    assert.equal(shouldSurfaceInWorkingNow(unfinished, observedAtMs), true);

    const needsReview = projectWorkflowRunActivity({
      id: `needs-review-${status}`,
      workflow: 'Needs-review test workflow',
      status,
      needsAttention: true,
      createdAt: '2026-08-04T10:00:00.000Z',
      finishedAt: '2026-08-04T10:05:00.000Z',
    }, observedAt)!;
    assert.equal(needsReview.lifecycle, 'blocked');
    assert.equal(needsReview.terminal, undefined);
    assert.equal(needsReview.needsAttention, true);
    assert.equal(shouldSurfaceInWorkingNow(needsReview, observedAtMs), true);
  }

  for (const status of ['blocked_capability', 'blocked_mutation'] as const) {
    const activeBlock = projectWorkflowRunActivity({
      id: `active-${status}`,
      workflow: 'Active blocked workflow',
      status,
      createdAt: '2026-08-04T10:00:00.000Z',
    }, observedAt)!;
    assert.equal(activeBlock.lifecycle, 'blocked');
    assert.equal(activeBlock.terminal, undefined);
    assert.equal(shouldSurfaceInWorkingNow(activeBlock, observedAtMs), true);
  }

  const parked = projectWorkflowRunActivity({
    id: 'parked-terminal-vocabulary', workflow: 'Parked workflow', status: 'parked',
    createdAt: '2026-08-04T10:00:00.000Z',
  }, observedAt)!;
  assert.equal(parked.lifecycle, 'awaiting_approval');
  assert.equal(parked.terminal, undefined);
});

test('foreground Activity serialization is an exact prose-free whitelist', () => {
  const unsafe = {
    schemaVersion: 1,
    runKey: 'workflow:privacy-canary',
    attemptId: 'privacy-canary',
    kind: 'workflow',
    presentationLane: 'scheduled',
    lifecycle: 'blocked',
    liveness: 'unknown',
    connectivity: 'connected',
    needsAttention: true,
    headline: 'Safe workflow title',
    detail: 'PRIVATE-CAPABILITY-CANARY',
    origin: 'PRIVATE-ORIGIN-CANARY',
    owner: 'PRIVATE-OWNER-CANARY',
    nextAction: 'PRIVATE-NEXT-ACTION-CANARY',
    terminal: { status: 'failed', kind: 'failed', text: 'PRIVATE-TERMINAL-CANARY', resumable: true },
    activity: { phase: 'working_items', text: 'Working on 2 of 4', completed: 2, total: 4 },
    progress: { completed: 2, total: 4 },
    children: { running: 1, completed: 2, failed: 1, total: 4 },
    startedAt: '2026-08-04T10:00:00.000Z',
    lastEvidenceAt: '2026-08-04T10:05:00.000Z',
    revision: 7,
    runId: 'privacy-canary',
  } as Entry;
  const entry = projectForegroundWorkingNowEntry(unsafe);
  assert.deepEqual(Object.keys(entry), [
    'schemaVersion', 'runKey', 'attemptId', 'kind', 'lifecycle', 'liveness',
    'needsAttention', 'headline', 'activity', 'progress', 'children',
    'startedAt', 'lastEvidenceAt', 'revision', 'runId',
  ]);
  const snapshot = projectForegroundWorkingNowSnapshot({
    schemaVersion: 1,
    observedAt: '2026-08-04T12:00:00.000Z',
    entries: [unsafe],
  });
  const bytes = JSON.stringify(snapshot);
  for (const canary of ['PRIVATE-CAPABILITY-CANARY', 'PRIVATE-ORIGIN-CANARY', 'PRIVATE-OWNER-CANARY', 'PRIVATE-NEXT-ACTION-CANARY', 'PRIVATE-TERMINAL-CANARY']) {
    assert.equal(bytes.includes(canary), false, canary);
  }
  for (const forbiddenKey of ['detail', 'origin', 'owner', 'nextAction', 'terminal', 'presentationLane', 'connectivity']) {
    assert.equal(Object.hasOwn(entry, forbiddenKey), false, forbiddenKey);
  }
});

test('a canonical workflow clarification projects as awaiting_input and needs attention', () => {
  const paused = projectWorkflowRunActivity({
    id: 'workflow-input-pause',
    workflow: 'Account Scope Workflow',
    status: 'awaiting_input',
    createdAt: '2026-08-11T18:00:00.000Z',
    awaitingInput: {
      questionId: 'workflow-input:workflow-input-pause:choose_scope:q1',
      question: 'Should I use enterprise accounts or every account?',
      stepId: 'choose_scope',
    },
  }, '2026-08-11T18:01:00.000Z')!;

  assert.equal(paused.lifecycle, 'awaiting_input',
    'canonical awaiting_input fell through to the generic accepted lifecycle');
  assert.equal(paused.needsAttention, true);
  assert.equal(paused.terminal, undefined, 'a clarification pause became terminal');
});

// The live run view must show work IN FLIGHT, not only work you could have
// walked away from. Before this, a foreground turn had to survive a 90s dwell
// before any surface could render it — so on desktop the drawer never appeared
// at all (every chat canary finished inside the dwell), while mobile showed
// workflow rows fine because non-foreground lanes skip it entirely.
test('Working Now shows a foreground turn as soon as it has work to show', () => {
  const observedAtMs = Date.parse('2026-08-24T12:00:00.000Z');
  const justStarted = {
    kind: 'chat', presentationLane: 'foreground', startedAt: '2026-08-24T11:59:58.000Z',
  } as unknown as Entry;

  // Nothing to render yet — still deliberately quiet, so an ordinary reply
  // cannot flash a row.
  assert.equal(shouldSurfaceInWorkingNow(justStarted, observedAtMs), false);

  // Calling tools: an activity label is enough.
  assert.equal(
    shouldSurfaceInWorkingNow(
      { ...justStarted, activity: { phase: 'tool', text: 'Searching' } } as unknown as Entry,
      observedAtMs,
    ),
    true,
    'a turn already doing tool work must surface immediately',
  );

  // A declared denominator is work in flight.
  assert.equal(
    shouldSurfaceInWorkingNow(
      { ...justStarted, progress: { completed: 1, total: 4 } } as unknown as Entry,
      observedAtMs,
    ),
    true,
  );

  // So is fan-out.
  assert.equal(
    shouldSurfaceInWorkingNow(
      { ...justStarted, children: { running: 3, completed: 0, failed: 0, total: 3 } } as unknown as Entry,
      observedAtMs,
    ),
    true,
    'parallel fan-out is exactly what the live view exists to show',
  );

  // An empty denominator is not evidence of work.
  assert.equal(
    shouldSurfaceInWorkingNow(
      { ...justStarted, progress: { completed: 0, total: 0 } } as unknown as Entry,
      observedAtMs,
    ),
    false,
  );

  // A settled turn stays gone regardless of what it did.
  assert.equal(
    shouldSurfaceInWorkingNow(
      {
        ...justStarted,
        activity: { phase: 'tool', text: 'Searching' },
        terminal: { status: 'completed', kind: 'done', text: 'Done.', resumable: false },
      } as unknown as Entry,
      observedAtMs,
    ),
    false,
    'a settled run is not working, even with activity evidence',
  );
});
