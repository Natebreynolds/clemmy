/**
 * Run: npx tsx --test src/dashboard/console-board.test.ts
 *
 * Functional smoke for the unified Tasks-board route (GET /api/console/board
 * + the background action route). Seeds background tasks across every status,
 * boots a tiny Express app with the REAL registerConsoleRoutes (stub assistant
 * — the board route never touches it), and asserts each task normalizes into
 * the right column with the right drag/button actions. Fills the gap that the
 * board route had no test. Offline, deterministic, per-test temp home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-board-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createBackgroundTask, markBackgroundTaskRunning, markBackgroundTaskDone,
  markBackgroundTaskAwaitingApproval, markBackgroundTaskAwaitingContinue, markBackgroundTaskBlocked, markBackgroundTaskFailed,
  getBackgroundTask,
  updateBackgroundTask,
} = await import('../execution/background-tasks.js');
const { startRun, finishRun } = await import('../runtime/run-events.js');
const { registerConsoleRoutes } = await import('./console-routes.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { CRON_TRIGGERS_DIR, WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { appendWorkflowEvent } = await import('../execution/workflow-events.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { appendEvent: appendHarnessEvent, createSession: createHarnessSession } = await import('../runtime/harness/eventlog.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

interface BoardCard {
  id: string;
  column: string;
  actions: string[];
  sourceKind: string;
  status: string;
  primaryAction?: string;
  approvalId?: string;
  failureSummary?: { failedItems: number; retryable: boolean; reason: string };
  raw?: Record<string, unknown>;
}

async function boot(authorized = { v: true }) {
  const app = express();
  app.use(express.json());
  // The board route uses only isAuthorized + the background-task store; the
  // assistant is touched only by the `promote` action (not exercised here).
  registerConsoleRoutes(app, () => authorized.v, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('GET /api/console/board normalizes every background-task status into the right column + actions', async () => {
  // Seed one task per status, driving each through the real state machine.
  const pending = createBackgroundTask({ title: 'queued task', prompt: 'p' });

  const running = createBackgroundTask({ title: 'running task', prompt: 'p' });
  markBackgroundTaskRunning(running.id);

  const awaiting = createBackgroundTask({ title: 'awaiting task', prompt: 'p' });
  markBackgroundTaskRunning(awaiting.id);
  markBackgroundTaskAwaitingApproval(awaiting.id, 'appr-1', 'need your ok');

  const blocked = createBackgroundTask({ title: 'blocked task', prompt: 'p' });
  markBackgroundTaskRunning(blocked.id);
  markBackgroundTaskBlocked(blocked.id, 'missing data', 'could not finish');

  const awaitingContinue = createBackgroundTask({ title: 'continue task', prompt: 'p' });
  markBackgroundTaskRunning(awaitingContinue.id);
  markBackgroundTaskAwaitingContinue(awaitingContinue.id, 'turn budget', 'partial result');

  const done = createBackgroundTask({ title: 'done task', prompt: 'p' });
  markBackgroundTaskRunning(done.id);
  markBackgroundTaskDone(done.id, 'finished');

  const interrupted = createBackgroundTask({ title: 'interrupted task', prompt: 'p' });
  markBackgroundTaskFailed(interrupted.id, 'daemon restarted', 'interrupted');

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board`);
    assert.equal(res.status, 200);
    const body = await res.json() as { cards: BoardCard[] };
    assert.ok(Array.isArray(body.cards), 'board returns a cards array');
    const byId = new Map(body.cards.map((c) => [c.id, c]));

    const expect = (id: string, column: string, actions: string[]) => {
      const card = byId.get(id);
      assert.ok(card, `card ${id} present on the board`);
      assert.equal(card!.sourceKind, 'background');
      assert.equal(card!.column, column, `${id} → column ${column} (got ${card!.column})`);
      assert.deepEqual([...card!.actions].sort(), [...actions].sort(), `${id} actions`);
    };
    expect(pending.id, 'queued', ['promote', 'cancel']);
    expect(running.id, 'running', ['cancel']);
    expect(awaiting.id, 'needs_you', ['approve', 'reject', 'cancel']);
    expect(blocked.id, 'needs_you', ['cancel']);
    expect(awaitingContinue.id, 'needs_you', ['resume', 'cancel']);
    // Terminal tasks now also offer `archive` (declutter the Done column).
    expect(done.id, 'done', ['archive']);
    expect(interrupted.id, 'done', ['resume', 'archive']);
    assert.equal(byId.get(awaiting.id)?.primaryAction, 'approve');
    assert.equal(byId.get(awaiting.id)?.approvalId, 'appr-1');
    assert.equal(byId.get(awaitingContinue.id)?.primaryAction, 'continue');
  } finally {
    await h.close();
  }
});

test('POST /api/console/crons/:name/trigger queues a JSON cron trigger without dashboard redirect HTML', async () => {
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/crons/nightly%20sync/trigger`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await res.json() as { ok: boolean; jobName: string; file: string };
    assert.equal(body.ok, true);
    assert.equal(body.jobName, 'nightly sync');
    assert.ok(body.file.endsWith('-nightly_sync.json'), body.file);

    const files = readdirSync(CRON_TRIGGERS_DIR).filter((name) => name.endsWith('-nightly_sync.json'));
    assert.equal(files.length, 1);
    const trigger = JSON.parse(readFileSync(path.join(CRON_TRIGGERS_DIR, files[0]), 'utf-8')) as {
      jobName: string;
      triggeredAt: string;
    };
    assert.equal(trigger.jobName, 'nightly sync');
    assert.ok(Number.isFinite(Date.parse(trigger.triggeredAt)));
  } finally {
    await h.close();
  }
});

test('GET /api/console/board surfaces standalone pending approvals as actionable cards', async () => {
  createHarnessSession({ id: 'sess-standalone-approval', kind: 'chat', channel: 'desktop' });
  const approval = approvalRegistry.register({
    sessionId: 'sess-standalone-approval',
    channel: 'desktop',
    subject: 'Send social calendar draft',
    tool: 'composio_execute_tool',
    args: { reason: 'Publish to the review channel first.' },
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board`);
    assert.equal(res.status, 200);
    const body = await res.json() as { cards: BoardCard[] };
    const card = body.cards.find((c) => c.id === `approval:${approval.approvalId}`);
    assert.ok(card, 'standalone approval card is present');
    assert.equal(card!.sourceKind, 'approval');
    assert.equal(card!.column, 'needs_you');
    assert.equal(card!.primaryAction, 'approve');
    assert.equal(card!.approvalId, approval.approvalId);
    assert.deepEqual(card!.actions, ['approve', 'reject']);
  } finally {
    await h.close();
  }
});

test('board approval action queues a parked background task continuation', async () => {
  const task = createBackgroundTask({ title: 'approve from board', prompt: 'p' });
  markBackgroundTaskRunning(task.id);
  markBackgroundTaskAwaitingApproval(task.id, 'appr-board-bg', 'needs approval');

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board/approval/appr-board-bg/approve`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; queuedTaskId?: string; status?: string };
    assert.equal(body.ok, true);
    assert.equal(body.queuedTaskId, task.id);
    assert.equal(body.status, 'approved');
    const after = getBackgroundTask(task.id);
    assert.equal(after?.status, 'pending');
    assert.equal(after?.approvalResolution?.approved, true);
  } finally {
    await h.close();
  }
});

test('board archive → drops the task off the board; ?includeArchived restores it', async () => {
  const task = createBackgroundTask({ title: 'to archive', prompt: 'p' });
  markBackgroundTaskRunning(task.id);
  markBackgroundTaskDone(task.id, 'finished');
  const authorized = { v: true };
  const h = await boot(authorized);
  try {
    // Archive → 200, task soft-deleted.
    const arch = await fetch(`${h.url}/api/console/board/background/${task.id}/archive`, { method: 'POST' });
    assert.equal(arch.status, 200);
    assert.equal((await arch.json() as { ok: boolean }).ok, true);
    assert.equal(getBackgroundTask(task.id)!.archived, true, 'record marked archived (kept on disk)');

    // Default board hides it.
    const board = await (await fetch(`${h.url}/api/console/board`)).json() as { cards: BoardCard[] };
    assert.equal(board.cards.some((c) => c.id === task.id), false, 'archived task hidden from the default board');

    // ?includeArchived=1 surfaces it with a restore-only action.
    const withArchived = await (await fetch(`${h.url}/api/console/board?includeArchived=1`)).json() as { cards: BoardCard[] };
    const card = withArchived.cards.find((c) => c.id === task.id);
    assert.ok(card, 'archived task visible when explicitly requested');
    assert.deepEqual(card!.actions, ['restore']);

    // Restore → back on the default board.
    const rest = await fetch(`${h.url}/api/console/board/background/${task.id}/restore`, { method: 'POST' });
    assert.equal(rest.status, 200);
    assert.equal(getBackgroundTask(task.id)!.archived, false, 'restored');
    const after = await (await fetch(`${h.url}/api/console/board`)).json() as { cards: BoardCard[] };
    assert.equal(after.cards.some((c) => c.id === task.id), true, 'restored task back on the default board');
  } finally {
    await h.close();
  }
});

test('board archive is rejected for an ACTIVE task (its worker is still live)', async () => {
  const task = createBackgroundTask({ title: 'still running', prompt: 'p' });
  markBackgroundTaskRunning(task.id);
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board/background/${task.id}/archive`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal((await res.json() as { ok: boolean }).ok, false);
    assert.notEqual(getBackgroundTask(task.id)!.archived, true, 'running task left un-archived');
  } finally {
    await h.close();
  }
});

test('GET /api/console/board exposes background model route diagnostics', async () => {
  const task = createBackgroundTask({ title: 'routed task', prompt: 'p', model: 'claude-sonnet-5' });
  updateBackgroundTask(task.id, {
    effectiveModel: 'claude-sonnet-5',
    modelProvider: 'claude',
    modelRouteKind: 'claude_agent_sdk_brain',
    modelTransport: 'sdk',
    modelRouteFalloverFrom: 'harness',
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board`);
    assert.equal(res.status, 200);
    const body = await res.json() as { cards: BoardCard[] };
    const card = body.cards.find((c) => c.id === task.id);
    assert.ok(card, 'routed background task card is present');
    assert.deepEqual(card!.raw?.modelRoute, {
      requestedModel: 'claude-sonnet-5',
      effectiveModel: 'claude-sonnet-5',
      provider: 'claude',
      routeKind: 'claude_agent_sdk_brain',
      transport: 'sdk',
      falloverFrom: 'harness',
    });
  } finally {
    await h.close();
  }
});

test('GET /api/console/active-work ignores stale terminal workflow sessions', async () => {
  const stale = createHarnessSession({
    id: 'workflow:terminal-stale:s1',
    kind: 'workflow',
    channel: 'workflow',
    title: 'terminal stale step',
  });
  appendHarnessEvent({ sessionId: stale.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
  appendHarnessEvent({ sessionId: stale.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'done' } });

  const live = createHarnessSession({
    id: 'workflow:still-live:s1',
    kind: 'workflow',
    channel: 'workflow',
    title: 'still live step',
  });
  appendHarnessEvent({ sessionId: live.id, turn: 1, role: 'system', type: 'turn_started', data: {} });

  const emptyOrphan = createHarnessSession({
    id: 'workflow:empty-orphan:s1',
    kind: 'workflow',
    channel: 'workflow',
    title: 'empty orphan step',
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/active-work`);
    assert.equal(res.status, 200);
    const body = await res.json() as { items: Array<{ id: string; type: string }> };
    const sessionIds = new Set(body.items.filter((item) => item.type === 'session').map((item) => item.id));
    assert.equal(sessionIds.has(stale.id), false, 'terminal workflow session is not active work');
    assert.equal(sessionIds.has(emptyOrphan.id), false, 'session-start-only orphan is not active work');
    assert.equal(sessionIds.has(live.id), true, 'non-terminal workflow session remains active work');
  } finally {
    await h.close();
  }
});

test('GET /api/console/active-work scans beyond filtered dormant session pages', async () => {
  const live = createHarnessSession({
    id: 'workflow:live-behind-dormant-page:s1',
    kind: 'workflow',
    channel: 'workflow',
    title: 'live behind dormant page',
  });
  appendHarnessEvent({ sessionId: live.id, turn: 1, role: 'system', type: 'turn_started', data: {} });

  await new Promise((resolve) => setTimeout(resolve, 5));

  for (let i = 0; i < 505; i += 1) {
    const dormant = createHarnessSession({
      id: `workflow:dormant-page-filter:${i}:s1`,
      kind: 'workflow',
      channel: 'workflow',
      title: `dormant filtered step ${i}`,
    });
    appendHarnessEvent({ sessionId: dormant.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
    appendHarnessEvent({
      sessionId: dormant.id,
      turn: 1,
      role: 'system',
      type: 'conversation_completed',
      data: { reply: 'done' },
    });
  }

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/active-work`);
    assert.equal(res.status, 200);
    const body = await res.json() as { items: Array<{ id: string; type: string }> };
    const sessionIds = new Set(body.items.filter((item) => item.type === 'session').map((item) => item.id));
    assert.equal(sessionIds.has(live.id), true, 'live session is still found after newer dormant rows are filtered');
    assert.equal(sessionIds.has('workflow:dormant-page-filter:0:s1'), false, 'terminal rows remain filtered');
  } finally {
    await h.close();
  }
});

test('board action route: resume re-queues an awaiting_continue background task', async () => {
  const task = createBackgroundTask({ title: 'needs continue', prompt: 'p' });
  markBackgroundTaskRunning(task.id);
  markBackgroundTaskAwaitingContinue(task.id, 'turn budget', 'partial');
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board/background/${task.id}/resume`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; task?: { id: string; status: string } };
    assert.equal(body.ok, true);
    assert.equal(body.task?.id, task.id);
    assert.equal(body.task?.status, 'pending');
    assert.equal(getBackgroundTask(task.id)?.status, 'pending');
    assert.ok(getBackgroundTask(task.id)?.continueResolution, 'continuation context is queued');
  } finally {
    await h.close();
  }
});

test('board action route: cancel is accepted and transitions the task; auth is gated', async () => {
  const task = createBackgroundTask({ title: 'to cancel', prompt: 'p' });
  markBackgroundTaskRunning(task.id);
  const authorized = { v: true };
  const h = await boot(authorized);
  try {
    // Unauthorized → 401, no state change.
    authorized.v = false;
    const denied = await fetch(`${h.url}/api/console/board/background/${task.id}/cancel`, { method: 'POST' });
    assert.equal(denied.status, 401);

    // Authorized cancel → 200 ok, task moves out of running.
    authorized.v = true;
    const res = await fetch(`${h.url}/api/console/board/background/${task.id}/cancel`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
    const after = getBackgroundTask(task.id);
    assert.ok(after && after.status !== 'running', `task left running (now ${after?.status})`);

    // 404 for an unknown id.
    const missing = await fetch(`${h.url}/api/console/board/background/does-not-exist/cancel`, { method: 'POST' });
    assert.equal(missing.status, 404);
  } finally {
    await h.close();
  }
});

test('GET /api/console/board keeps completed workflow runs that need attention in Needs you', async () => {
  const run = startRun({
    id: 'wf-attention-run',
    sessionId: 'workflow:wf-attention-run',
    channel: 'workflow',
    source: 'workflow',
    title: 'Workflow: review me',
    message: 'Running workflow "review me"',
  });
  finishRun(run.id, {
    status: 'completed',
    message: 'Needs attention — target not confirmed',
    outputPreview: 'The output was delivered, but the target was not confirmed.',
    needsAttention: true,
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board`);
    assert.equal(res.status, 200);
    const body = await res.json() as { cards: Array<BoardCard & { raw?: Record<string, unknown>; progressHint?: string }> };
    const card = body.cards.find((c) => c.id === run.id);
    assert.ok(card, 'workflow run card is present');
    assert.equal(card!.sourceKind, 'run');
    assert.equal(card!.column, 'needs_you');
    assert.equal(card!.status, 'needs_attention');
    assert.deepEqual(card!.actions, []);
    assert.equal(card!.raw?.needsAttention, true);
    assert.match(card!.progressHint ?? '', /target was not confirmed/);
  } finally {
    await h.close();
  }
});

test('GET /api/console/workflows exposes needs-attention last-run status', async () => {
  const workflowName = 'Workflow Attention List';
  writeWorkflow('workflow-attention-list', {
    name: workflowName,
    description: 'surfaces attention status',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'review', prompt: 'Review output.' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'wf-list-attn.json'), JSON.stringify({
    id: 'wf-list-attn',
    workflow: workflowName,
    status: 'completed',
    needsAttention: true,
    createdAt: '2026-06-24T12:00:00.000Z',
    finishedAt: '2026-06-24T12:01:00.000Z',
  }, null, 2), 'utf-8');

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows`);
    assert.equal(res.status, 200);
    const body = await res.json() as { workflows: Array<{ name: string; lastRunStatus?: string | null; lastRunNeedsAttention?: boolean }> };
    const row = body.workflows.find((item) => item.name === workflowName);
    assert.ok(row, 'workflow row is present');
    assert.equal(row!.lastRunStatus, 'needs_attention');
    assert.equal(row!.lastRunNeedsAttention, true);
  } finally {
    await h.close();
  }
});

test('GET /api/console/board/run/:slug/:runId/queue returns the workflow sub-task queue', async () => {
  const workflowSlug = 'board-queue-flow';
  const workflowName = 'Board Queue Flow';
  const runId = 'run-queue-visible';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'queue visibility test',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Pull campaign inputs.' },
      { id: 'draft', prompt: 'Draft each post.', dependsOn: ['pull'], forEach: 'pull' },
      { id: 'summary', prompt: 'Summarize the campaign.', dependsOn: ['draft'] },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'running',
    createdAt: '2026-06-24T14:00:00.000Z',
  }, null, 2), 'utf-8');
  appendWorkflowEvent(workflowSlug, runId, { kind: 'run_started' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'step_started', stepId: 'pull' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'step_completed', stepId: 'pull', output: ['a', 'b'] });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'step_started', stepId: 'draft' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'item_started', stepId: 'draft', itemKey: 'a' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'item_started', stepId: 'draft', itemKey: 'b' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'item_completed', stepId: 'draft', itemKey: 'a', output: 'done-a' });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board/run/${encodeURIComponent(workflowSlug)}/${runId}/queue`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      runId: string;
      steps: Array<{ stepId: string; status: string; itemsDone?: number; itemsTotal?: number; isNext: boolean }>;
      nextStepId: string | null;
    };
    assert.equal(body.runId, runId);
    assert.equal(body.nextStepId, null);
    const by = Object.fromEntries(body.steps.map((step) => [step.stepId, step]));
    assert.equal(by.pull.status, 'done');
    assert.equal(by.draft.status, 'running');
    assert.equal(by.draft.itemsDone, 1);
    assert.equal(by.draft.itemsTotal, 2);
    assert.equal(by.summary.status, 'blocked');
  } finally {
    await h.close();
  }
});

test('GET /api/console/board/run/:slug/:runId/queue rejects missing or mismatched run records', async () => {
  const workflowSlug = 'board-queue-mismatch';
  const workflowName = 'Board Queue Mismatch';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'queue mismatch test',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'one', prompt: 'Run one step.' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'run-other-workflow.json'), JSON.stringify({
    id: 'run-other-workflow',
    workflow: 'Different Workflow',
    status: 'running',
    createdAt: '2026-06-24T14:10:00.000Z',
  }, null, 2), 'utf-8');

  const h = await boot();
  try {
    const missing = await fetch(`${h.url}/api/console/board/run/${encodeURIComponent(workflowSlug)}/does-not-exist/queue`);
    assert.equal(missing.status, 404);
    const mismatch = await fetch(`${h.url}/api/console/board/run/${encodeURIComponent(workflowSlug)}/run-other-workflow/queue`);
    assert.equal(mismatch.status, 404);
  } finally {
    await h.close();
  }
});

test('GET /api/console/board/run/:slug/:runId/queue narrows TRY runs to the target step', async () => {
  const workflowSlug = 'board-queue-target-step';
  const workflowName = 'Board Queue Target Step';
  const runId = 'run-target-step';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'target-step queue test',
    enabled: false,
    trigger: { manual: true },
    steps: [
      { id: 'first', prompt: 'First step.' },
      { id: 'only_this', prompt: 'Try only this step.', dependsOn: ['first'] },
      { id: 'last', prompt: 'Last step.', dependsOn: ['only_this'] },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'running',
    targetStepId: 'only_this',
    createdAt: '2026-06-24T14:20:00.000Z',
  }, null, 2), 'utf-8');
  appendWorkflowEvent(workflowSlug, runId, { kind: 'run_started' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'step_started', stepId: 'only_this' });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board/run/${encodeURIComponent(workflowSlug)}/${runId}/queue`);
    assert.equal(res.status, 200);
    const body = await res.json() as { steps: Array<{ stepId: string; status: string }> };
    assert.deepEqual(body.steps.map((step) => step.stepId), ['only_this']);
    assert.equal(body.steps[0]?.status, 'running');
  } finally {
    await h.close();
  }
});

test('workflow failed-item recovery endpoints list and requeue only final failed forEach items', async () => {
  const workflowName = 'Failed Item Recovery';
  const workflowSlug = 'failed-item-recovery';
  const runId = 'wf-failed-items-1';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'failed item retry test',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Return records.' },
      { id: 'send', prompt: 'Process one record.', dependsOn: ['pull'], forEach: 'pull' },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'completed_with_errors',
    needsAttention: true,
    inputs: { list: 'A' },
    createdAt: '2026-06-24T13:00:00.000Z',
    finishedAt: '2026-06-24T13:02:00.000Z',
  }, null, 2), 'utf-8');
  appendWorkflowEvent(workflowSlug, runId, { kind: 'item_failed', stepId: 'send', itemKey: 'a', error: 'transient a failure' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'item_failed', stepId: 'send', itemKey: 'b', error: 'still failed' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'item_completed', stepId: 'send', itemKey: 'a', output: 'recovered' });

  const h = await boot();
  try {
    const board = await (await fetch(`${h.url}/api/console/board`)).json() as { cards: BoardCard[] };
    const wfCard = board.cards.find((c) => c.sourceKind === 'workflow' && c.raw?.runId === runId);
    assert.ok(wfCard, 'workflow run appears on the Tasks board');
    assert.equal(wfCard!.primaryAction, 'retry_failed_items');
    assert.equal(wfCard!.failureSummary?.failedItems, 1);
    assert.equal(wfCard!.failureSummary?.retryable, true);

    const listed = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/runs/${runId}/failed-items`);
    assert.equal(listed.status, 200);
    const listBody = await listed.json() as {
      count: number;
      ambiguous: boolean;
      stepIds: string[];
      failedItems: Array<{ stepId: string; itemKey: string; error: string }>;
    };
    assert.equal(listBody.count, 1);
    assert.equal(listBody.ambiguous, false);
    assert.deepEqual(listBody.stepIds, ['send']);
    assert.deepEqual(
      listBody.failedItems.map((item) => ({ stepId: item.stepId, itemKey: item.itemKey, error: item.error })),
      [{ stepId: 'send', itemKey: 'b', error: 'still failed' }],
    );

    const retry = await fetch(`${h.url}/api/console/board/workflow/${encodeURIComponent(workflowSlug)}/runs/${runId}/retry-failed-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stepId: 'send' }),
    });
    assert.equal(retry.status, 200);
    const retryBody = await retry.json() as { ok: boolean; status: string; id?: string; failedItems: Array<{ itemKey: string }> };
    assert.equal(retryBody.ok, true);
    assert.equal(retryBody.status, 'queued');
    assert.equal(retryBody.failedItems.length, 1);
    assert.equal(retryBody.failedItems[0]?.itemKey, 'b');
    assert.ok(retryBody.id, 'retry run id returned');

    const queued = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${retryBody.id}.json`), 'utf-8')) as Record<string, unknown>;
    assert.equal(queued.workflow, workflowName);
    assert.equal(queued.retryFailedItemsFromRunId, runId);
    assert.equal(queued.retryFailedItemsStepId, 'send');
    assert.deepEqual(queued.retryFailedItemKeys, ['b']);
  } finally {
    await h.close();
  }
});
