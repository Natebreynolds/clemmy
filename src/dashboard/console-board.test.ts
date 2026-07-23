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
  markBackgroundTaskAwaitingApproval, markBackgroundTaskAwaitingInput, markBackgroundTaskAwaitingContinue,
  markBackgroundTaskBlocked, markBackgroundTaskFailed,
  getBackgroundTask,
  updateBackgroundTask,
} = await import('../execution/background-tasks.js');
const { startRun, finishRun } = await import('../runtime/run-events.js');
const { registerConsoleRoutes } = await import('./console-routes.js');
const { readWorkflow, writeWorkflow } = await import('../memory/workflow-store.js');
const { fireWorkflowSystemEvent } = await import('../execution/workflow-trigger-engine.js');
const { CRON_TRIGGERS_DIR, WORKFLOW_RUNS_DIR, updateEnvKey, clearWorkspaceProjectCache } = await import('../tools/shared.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { appendWorkflowEvent } = await import('../execution/workflow-events.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { queuePendingAction } = await import('../runtime/harness/pending-actions.js');
const {
  appendEvent: appendHarnessEvent,
  beginRunAttempt,
  createSession: createHarnessSession,
  finishRunAttempt,
  recordRunAttemptUserInput,
} = await import('../runtime/harness/eventlog.js');
const { listNotifications } = await import('../runtime/notifications.js');
const { saveUserMcpServers } = await import('../runtime/mcp-config.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

interface BoardCard {
  id: string;
  column: string;
  actions: string[];
  sourceKind: string;
  status: string;
  primaryAction?: string;
  nextSafeAction?: string;
  approvalId?: string;
  attemptId?: string;
  runScopeId?: string;
  sourceUserSeq?: number;
  cancelEndpoint?: string;
  failureSummary?: { failedItems: number; retryable: boolean; reason: string };
  raw?: Record<string, unknown>;
}

async function boot(authorized = { v: true }) {
  const app = express();
  app.use(express.json());
  // The board route uses only isAuthorized + the background-task store; the
  // assistant is touched only by the `promote` action (not exercised here).
  const assistant = {
    getRuntime: () => ({
      listPendingApprovals: () => [],
    }),
  };
  registerConsoleRoutes(app, () => authorized.v, assistant as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function workflowRunRecords(workflowName: string): Array<Record<string, unknown>> {
  let files: string[] = [];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((file) => {
      try {
        return JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((record): record is Record<string, unknown> => Boolean(record) && record.workflow === workflowName);
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

  const awaitingInput = createBackgroundTask({ title: 'input task', prompt: 'p', originSessionId: 'console:input' });
  markBackgroundTaskRunning(awaitingInput.id);
  markBackgroundTaskAwaitingInput(awaitingInput.id, 'question-board-1', 'What should I do next?');

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
    expect(awaitingInput.id, 'needs_you', ['cancel']);
    // Terminal tasks now also offer `archive` (declutter the Done column).
    expect(done.id, 'done', ['archive']);
    expect(interrupted.id, 'done', ['resume', 'archive']);
    assert.equal(byId.get(awaiting.id)?.primaryAction, 'approve');
    assert.equal(byId.get(awaiting.id)?.approvalId, 'appr-1');
    assert.equal(byId.get(awaitingContinue.id)?.primaryAction, 'continue');
    assert.equal(byId.get(awaitingInput.id)?.primaryAction, 'none');
    assert.match(byId.get(awaitingInput.id)?.nextSafeAction ?? '', /originating chat/i);
  } finally {
    await h.close();
  }
});

test('GET /api/console/board represents canonical harness attempts with exact identity and fresh terminal controls', async () => {
  const session = createHarnessSession({
    id: 'sess-board-canonical-attempt',
    kind: 'chat',
    channel: 'desktop',
    title: 'Create the canonical document',
  });
  const legacy = startRun({
    id: 'run-board-canonical-attempt',
    sessionId: session.id,
    channel: 'desktop',
    source: 'desktop',
    title: 'Create the canonical document',
    message: 'Create the canonical document',
  });
  const attempt = beginRunAttempt(session.id, { runId: legacy.id });
  const sourceInput = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Create the canonical document' },
  });

  const h = await boot();
  try {
    const activeRes = await fetch(`${h.url}/api/console/board`);
    assert.equal(activeRes.status, 200);
    const activeBody = await activeRes.json() as { cards: BoardCard[] };
    const active = activeBody.cards.find((candidate) => candidate.attemptId === attempt.attemptId);
    assert.ok(active, 'latest canonical attempt is represented');
    assert.equal(active!.id, `harness:${attempt.attemptId}`);
    assert.equal(active!.sessionId, session.id);
    assert.equal(active!.runScopeId, `${session.id}::brain:${legacy.id}`);
    assert.equal(active!.sourceUserSeq, sourceInput.seq);
    assert.match(active!.cancelEndpoint ?? '', /attemptId=/);
    assert.deepEqual(active!.actions, ['cancel']);
    assert.equal(activeBody.cards.some((candidate) => candidate.id === legacy.id), false, 'legacy mirror is deduplicated');

    finishRunAttempt(attempt, 'completed');
    const terminalRes = await fetch(`${h.url}/api/console/board`);
    assert.equal(terminalRes.status, 200);
    const terminalBody = await terminalRes.json() as { cards: BoardCard[] };
    const terminal = terminalBody.cards.find((candidate) => candidate.attemptId === attempt.attemptId);
    assert.ok(terminal, 'terminal canonical attempt remains available for drawer reconciliation');
    assert.equal(terminal!.column, 'done');
    assert.equal(terminal!.status, 'completed');
    assert.deepEqual(terminal!.actions, []);
    assert.equal(terminal!.cancelEndpoint, undefined);
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

test('GET /api/console/approvals/list joins queued pending-action payloads', async () => {
  createHarnessSession({ id: 'sess-pending-action-approval', kind: 'chat', channel: 'desktop' });
  const payload = {
    tool_slug: 'GMAIL_SEND_EMAIL',
    arguments: { to: 'proof@example.com', subject: 'Ready', body: 'Queued only' },
  };
  const action = queuePendingAction({
    title: 'Send queued proof email',
    summary: 'Prepared Gmail send; waiting for the final human execute gate.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload,
    targetSummary: 'proof@example.com',
    preview: 'Subject: Ready',
    risk: 'Would send one email.',
    rollback: 'Cannot unsend.',
    sessionId: 'sess-pending-action-approval',
  });
  const approval = approvalRegistry.register({
    sessionId: 'sess-pending-action-approval',
    channel: 'desktop',
    subject: 'Execute queued proof email?',
    tool: 'request_approval',
    args: { pendingActionId: action.id, preview: 'Subject: Ready' },
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/approvals/list`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      approvals: Array<{
        approvalId: string;
        pendingAction?: {
          id: string;
          title: string;
          toolName: string;
          targetSummary: string;
          payloadHash: string;
          payload: unknown;
        };
      }>;
    };
    const row = body.approvals.find((a) => a.approvalId === approval.approvalId);
    assert.ok(row, 'approval row returned');
    assert.equal(row!.pendingAction?.id, action.id);
    assert.equal(row!.pendingAction?.title, 'Send queued proof email');
    assert.equal(row!.pendingAction?.toolName, 'composio_execute_tool');
    assert.equal(row!.pendingAction?.targetSummary, 'proof@example.com');
    assert.equal(row!.pendingAction?.payloadHash, action.payloadHash);
    assert.deepEqual(row!.pendingAction?.payload, payload);
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

test('background task cockpit routes save report-back target and repost result', async () => {
  const task = createBackgroundTask({ title: 'share report', prompt: 'p' });
  markBackgroundTaskRunning(task.id);
  markBackgroundTaskDone(task.id, 'Final report body');
  const h = await boot();
  try {
    const targetRes = await fetch(`${h.url}/api/console/background-tasks/${task.id}/report-back-target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'slack_channel', channel_id: 'C123', thread_ts: '1700000000.000100' }),
    });
    assert.equal(targetRes.status, 200);
    const targetBody = await targetRes.json() as { ok: boolean; task?: { reportBackTarget?: unknown } };
    assert.equal(targetBody.ok, true);
    assert.deepEqual(getBackgroundTask(task.id)?.reportBackTarget, {
      type: 'slack_channel',
      channelId: 'C123',
      threadTs: '1700000000.000100',
    });

    const repostRes = await fetch(`${h.url}/api/console/background-tasks/${task.id}/repost-result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'discord_channel', channel_id: 'D456' }),
    });
    assert.equal(repostRes.status, 200);
    const repostBody = await repostRes.json() as { ok: boolean; notificationId?: string };
    assert.equal(repostBody.ok, true);
    assert.ok(repostBody.notificationId);
    assert.deepEqual(getBackgroundTask(task.id)?.reportBackTarget, { type: 'discord_channel', channelId: 'D456' });

    const notification = listNotifications(20).find((item) => item.id === repostBody.notificationId);
    assert.ok(notification, 'repost notification is queued');
    assert.equal(notification?.metadata?.backgroundTaskId, task.id);
    assert.equal(notification?.metadata?.reportBackTargetType, 'discord_channel');
    assert.equal(notification?.metadata?.reportBackTargetId, 'D456');
    assert.equal(notification?.metadata?.discordChannelId, 'D456');
  } finally {
    await h.close();
  }
});

test('GET /api/console/startup-doctor is auth gated and returns runtime/native status', async () => {
  const authorized = { v: false };
  const h = await boot(authorized);
  try {
    const denied = await fetch(`${h.url}/api/console/startup-doctor`);
    assert.equal(denied.status, 401);

    authorized.v = true;
    const res = await fetch(`${h.url}/api/console/startup-doctor`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      status: string;
      runtime?: { node?: string; nodeModuleVersion?: string };
      nativeDependencies?: Array<{ name: string; status: string }>;
    };
    assert.ok(['ok', 'warning', 'error'].includes(body.status));
    assert.ok(body.runtime?.node);
    assert.ok(body.runtime?.nodeModuleVersion);
    assert.ok(body.nativeDependencies?.some((dep) => dep.name === 'better-sqlite3'));
  } finally {
    await h.close();
  }
});

test('POST /api/console/demo/agentic-flow seeds an inspectable completed task', async () => {
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/demo/agentic-flow`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      ok: boolean;
      task?: { id: string; title: string; status: string };
      detail?: { notifications: Array<{ id: string }> };
    };
    assert.equal(body.ok, true);
    assert.equal(body.task?.status, 'done');
    assert.match(body.task?.title ?? '', /agentic delivery loop/i);
    const stored = getBackgroundTask(body.task!.id);
    assert.equal(stored?.status, 'done');
    assert.ok(stored?.result?.includes('Demo: Agentic Delivery Loop'));
    assert.ok(body.detail?.notifications.length, 'demo task detail includes the completion notification');

    const notification = listNotifications(50).find((item) => item.metadata?.backgroundTaskId === body.task!.id);
    assert.ok(notification, 'completion notification is queued for the demo task');
    assert.equal(notification?.metadata?.runSessionId, stored?.runSessionId);
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
    // Needs-attention cards must never be action-less dead ends — archive
    // lets the user clear the column once they've reviewed.
    assert.deepEqual(card!.actions, ['archive']);
    assert.equal(card!.raw?.needsAttention, true);
    assert.match(card!.progressHint ?? '', /target was not confirmed/);
  } finally {
    await h.close();
  }
});

test('a newer run supersedes a needs-attention card into Done; archive clears it; live runs refuse archive', async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const title = 'Workflow: supersede me';
  const stale = startRun({
    id: 'wf-supersede-old',
    sessionId: 'workflow:wf-supersede-old',
    channel: 'workflow',
    source: 'workflow',
    title,
    message: 'first attempt',
  });
  finishRun(stale.id, { status: 'completed', message: 'needs review', needsAttention: true });
  await sleep(10); // distinct updatedAt so newest-first ordering is deterministic
  const fresh = startRun({
    id: 'wf-supersede-new',
    sessionId: 'workflow:wf-supersede-new',
    channel: 'workflow',
    source: 'workflow',
    title,
    message: 'second attempt',
  });
  finishRun(fresh.id, { status: 'completed', message: 'clean run' });
  const live = startRun({
    id: 'wf-supersede-live',
    sessionId: 'workflow:wf-supersede-live',
    channel: 'workflow',
    source: 'workflow',
    title: 'Workflow: still going',
    message: 'in flight',
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board`);
    const body = await res.json() as { cards: Array<BoardCard> };
    const staleCard = body.cards.find((c) => c.id === stale.id);
    assert.ok(staleCard, 'superseded card still visible');
    assert.equal(staleCard!.column, 'done', 'a newer run supersedes needs_you → done');
    assert.equal(staleCard!.status, 'needs_attention', 'amber status is preserved');
    assert.ok(staleCard!.actions.includes('archive'));

    // A live run refuses archive (cancel is the right verb there).
    const liveRes = await fetch(`${h.url}/api/console/board/run/${live.id}/archive`, { method: 'POST' });
    assert.equal(liveRes.status, 409);

    // Archiving the reviewed card drops it from the board; the record survives.
    const archiveRes = await fetch(`${h.url}/api/console/board/run/${stale.id}/archive`, { method: 'POST' });
    assert.equal(archiveRes.status, 200);
    const after = await fetch(`${h.url}/api/console/board`);
    const afterBody = await after.json() as { cards: Array<BoardCard> };
    assert.equal(afterBody.cards.find((c) => c.id === stale.id), undefined, 'archived card is off the board');
    assert.ok(afterBody.cards.find((c) => c.id === fresh.id), 'the fresh run is unaffected');
  } finally {
    finishRun(live.id, { status: 'cancelled', message: 'test cleanup' });
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

test('GET /api/console/workflows exposes workflow lifecycle proof states', async () => {
  const liveName = 'Proof Live Flow';
  writeWorkflow('proof-live-flow', {
    name: liveName,
    description: 'live proof state',
    enabled: true,
    trigger: { manual: true, events: [{ type: 'proof.live.created' }] },
    inputs: { leadId: { type: 'string', description: 'Lead id' } },
    allowedTools: ['composio_salesforce_get_record'],
    steps: [{ id: 'fetch', prompt: 'Fetch {{input.leadId}} from Salesforce.', allowedTools: ['composio_salesforce_get_record'] }],
  });
  const needsInfoName = 'Proof Needs Info Flow';
  writeWorkflow('proof-needs-info-flow', {
    name: needsInfoName,
    description: 'needs info proof state',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'send', prompt: 'Send the emails to the outside prospect list.' }],
  });
  const testingName = 'Proof Testing Flow';
  writeWorkflow('proof-testing-flow', {
    name: testingName,
    description: 'testing proof state',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'draft', prompt: 'Draft an internal note.' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'proof-live-run.json'), JSON.stringify({
    id: 'proof-live-run',
    workflow: 'proof-live-flow',
    status: 'completed',
    createdAt: '2026-07-01T12:00:00.000Z',
    finishedAt: '2026-07-01T12:01:00.000Z',
  }, null, 2), 'utf-8');
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'proof-testing-run.json'), JSON.stringify({
    id: 'proof-testing-run',
    workflow: 'proof-testing-flow',
    status: 'creation_test',
    createdAt: '2026-07-01T13:00:00.000Z',
  }, null, 2), 'utf-8');

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      workflows: Array<{
        name: string;
        proof?: {
          lifecycle: string;
          label: string;
          canRun: boolean;
          inputKeys: string[];
          requiredInputKeys: string[];
          toolNames: string[];
          triggerSummary: string[];
          sideEffects: { read: number; write: number; send: number; unknown: number };
          readinessGaps: unknown[];
          evidence: { latestRun?: { id: string } | null; latestSuccessfulRun?: { id: string } | null };
        };
      }>;
    };
    const live = body.workflows.find((item) => item.name === liveName);
    const needsInfo = body.workflows.find((item) => item.name === needsInfoName);
    const testing = body.workflows.find((item) => item.name === testingName);
    assert.equal(live?.proof?.lifecycle, 'live');
    assert.equal(live?.proof?.label, 'LIVE');
    assert.equal(live?.proof?.canRun, true);
    assert.deepEqual(live?.proof?.inputKeys, ['leadId']);
    assert.deepEqual(live?.proof?.requiredInputKeys, ['leadId']);
    assert.ok(live?.proof?.toolNames.includes('composio_salesforce_get_record'));
    assert.ok(live?.proof?.triggerSummary.includes('event: proof.live.created'));
    assert.equal(live?.proof?.sideEffects.read, 1);
    assert.equal(live?.proof?.evidence.latestSuccessfulRun?.id, 'proof-live-run');
    assert.equal(needsInfo?.proof?.lifecycle, 'needs_info');
    assert.equal(needsInfo?.proof?.label, 'NEEDS INFO');
    assert.ok((needsInfo?.proof?.readinessGaps.length ?? 0) > 0);
    assert.equal(needsInfo?.proof?.sideEffects.send, 1);
    assert.equal(testing?.proof?.lifecycle, 'testing');
    assert.equal(testing?.proof?.label, 'TESTING');
    assert.equal(testing?.proof?.canRun, false);
    assert.equal(testing?.proof?.evidence.latestRun?.id, 'proof-testing-run');

    const detail = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(liveName)}`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { proof?: { lifecycle: string; evidence: { latestSuccessfulRun?: { id: string } | null } } };
    assert.equal(detailBody.proof?.lifecycle, 'live');
    assert.equal(detailBody.proof?.evidence.latestSuccessfulRun?.id, 'proof-live-run');
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows/from-session saves a chat trace as a disabled draft with proof', async () => {
  const sessionId = 'sess-console-promote-workflow';
  const workflowName = 'Saved Chat Promote Flow';
  createHarnessSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Promote this chat' });
  appendHarnessEvent({
    sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'composio_execute_tool',
      callId: 'call-salesforce',
      arguments: JSON.stringify({
        tool: 'SALESFORCE_GET_RECORDS',
        arguments: { objectName: 'Account', limit: 5 },
      }),
    },
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/from-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: workflowName, sessionId }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as {
      created: boolean;
      name: string;
      enabled: boolean;
      toolCallCount: number;
      stepCount: number;
      proof?: { lifecycle: string; canRun: boolean; toolNames: string[] };
    };
    assert.equal(body.created, true);
    assert.equal(body.name, workflowName);
    assert.equal(body.enabled, false);
    assert.equal(body.toolCallCount, 1);
    assert.equal(body.stepCount, 1);
    assert.equal(body.proof?.canRun, false);
    assert.notEqual(body.proof?.lifecycle, 'live');
    assert.ok(body.proof?.toolNames.includes('SALESFORCE_GET_RECORDS'));

    const saved = readWorkflow('saved-chat-promote-flow')?.data;
    assert.ok(saved, 'workflow was persisted');
    assert.equal(saved!.enabled, false);
    assert.equal(saved!.trigger.manual, true);
    assert.equal(saved!.steps[0].call?.tool, 'SALESFORCE_GET_RECORDS');
    assert.deepEqual(saved!.steps[0].call?.args, { objectName: 'Account', limit: 5 });

    const list = await fetch(`${h.url}/api/console/workflows`);
    assert.equal(list.status, 200);
    const listBody = await list.json() as { workflows: Array<{ name: string; enabled: boolean; proof?: { canRun: boolean } }> };
    const row = listBody.workflows.find((item) => item.name === workflowName);
    assert.ok(row, 'promoted workflow appears in Workflow Studio list');
    assert.equal(row!.enabled, false);
    assert.equal(row!.proof?.canRun, false);

    const detail = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as {
      graph?: {
        nodes: Array<{
          id: string;
          meta?: { executor?: string; sideEffect?: string; tools?: string[]; callTool?: string | null };
        }>;
      };
    };
    const graphNode = detailBody.graph?.nodes.find((node) => node.id === 'salesforce-get-records');
    assert.equal(graphNode?.meta?.executor, 'call');
    assert.equal(graphNode?.meta?.sideEffect, 'read');
    assert.equal(graphNode?.meta?.callTool, 'SALESFORCE_GET_RECORDS');
    assert.ok(graphNode?.meta?.tools?.includes('SALESFORCE_GET_RECORDS'));
  } finally {
    await h.close();
  }
});

test('GET /api/console/workflows returns execution plans for parallel, fanout, gated workflows', async () => {
  const workflowName = 'Execution Plan Flow';
  writeWorkflow('execution-plan-flow', {
    name: workflowName,
    description: 'execution plan route test',
    enabled: true,
    trigger: { manual: true },
    goal: {
      objective: 'Deliver the merged CRM report and prepare the outbound send.',
      successCriteria: ['CRM records were fetched.', 'Merged report is ready.', 'Send step is approval-gated.'],
      maxAttempts: 3,
    },
    steps: [
      { id: 'fetch_crm', prompt: 'Fetch CRM records.', call: { tool: 'SALESFORCE_GET_RECORDS', args: {} }, sideEffect: 'read', output: { type: 'array' } },
      { id: 'fetch_docs', prompt: 'Read notes.', allowedTools: ['read_file'], sideEffect: 'read' },
      { id: 'process_each', prompt: 'Process each CRM record.', dependsOn: ['fetch_crm'], forEach: 'fetch_crm', forEachNewOnly: true, model: 'gpt-5-codex', output: { type: 'object' } },
      { id: 'merge', prompt: 'Merge evidence.', dependsOn: ['fetch_docs', 'process_each'], deterministic: { runner: 'merge.py' } },
      { id: 'send', prompt: 'Send report.', dependsOn: ['merge'], allowedTools: ['GMAIL_SEND_EMAIL'], sideEffect: 'send', requiresApproval: true, approvalPreview: 'Send report' },
    ],
  });
  const scriptsDir = path.join(WORKFLOWS_DIR, 'execution-plan-flow', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, 'merge.py'), '#!/usr/bin/env python3\nprint("ok")\n');

  const h = await boot();
  try {
    const list = await fetch(`${h.url}/api/console/workflows`);
    assert.equal(list.status, 200);
    const listBody = await list.json() as { workflows: Array<{ name: string; goal?: { objective?: string } | null; executionPlan?: { maxParallelWidth: number; fanout: unknown[]; gates?: Array<{ kind: string }>; visualContract?: { status: string } } }> };
    const row = listBody.workflows.find((item) => item.name === workflowName);
    assert.equal(row?.goal?.objective, 'Deliver the merged CRM report and prepare the outbound send.');
    assert.equal(row?.executionPlan?.maxParallelWidth, 2);
    assert.equal(row?.executionPlan?.fanout.length, 1);
    assert.ok(row?.executionPlan?.gates?.some((gate) => gate.kind === 'run_goal_judge'));
    assert.equal(row?.executionPlan?.visualContract?.status, 'attention');

    const detail = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}`);
    assert.equal(detail.status, 200);
    const body = await detail.json() as {
      goal?: { objective?: string; successCriteria?: string[]; maxAttempts?: number } | null;
      executionPlan?: {
        estimatedRounds: number;
        sequentialRounds: number;
        parallelSavings: number;
        criticalPath: string[];
        levels: Array<{ stepIds: string[]; parallel: boolean }>;
        fanout: Array<{ stepId: string; concurrency: number; batchSize: number; workerModel: string | null; safeToResume: boolean }>;
        gates: Array<{ stepId: string; kind: string; severity?: string; label?: string }>;
        toolSurface: { composioTools: string[]; localTools: string[]; deterministicRunners: string[] };
        modelSurface: {
          portability: string;
          portable: boolean;
          modelSteps: number;
          nonModelSteps: number;
          explicitModels: string[];
          warnings: string[];
        };
        visualContract: {
          status: string;
          warningCount: number;
          blockedCount: number;
          checks: Array<{ kind: string; status: string; stepIds: string[]; detail: string }>;
        };
        toolReadiness: {
          ready: boolean;
          missingCount: number;
          unknownCount: number;
          items: Array<{
            name: string;
            kind: string;
            status: string;
            stepIds: string[];
            sources?: string[];
            evidence?: Array<{ kind: string; name: string; status: string; detail?: string }>;
          }>;
        };
      };
      graph?: {
        nodes: Array<{
          id: string;
          readiness?: {
            status: string;
            readyCount: number;
            missingCount: number;
            unknownCount: number;
            items: Array<{
              name: string;
              kind: string;
              status: string;
              stepIds: string[];
              sources?: string[];
              evidence?: Array<{ kind: string; name: string; status: string; detail?: string }>;
            }>;
          };
        }>;
      };
    };
    assert.equal(body.goal?.objective, 'Deliver the merged CRM report and prepare the outbound send.');
    assert.deepEqual(body.goal?.successCriteria, ['CRM records were fetched.', 'Merged report is ready.', 'Send step is approval-gated.']);
    assert.equal(body.goal?.maxAttempts, 3);
    assert.equal(body.executionPlan?.estimatedRounds, 4);
    assert.equal(body.executionPlan?.sequentialRounds, 5);
    assert.equal(body.executionPlan?.parallelSavings, 1);
    assert.deepEqual(body.executionPlan?.levels[0]?.stepIds, ['fetch_crm', 'fetch_docs']);
    assert.equal(body.executionPlan?.levels[0]?.parallel, true);
    assert.deepEqual(body.executionPlan?.criticalPath, ['fetch_crm', 'process_each', 'merge', 'send']);
    assert.deepEqual(body.executionPlan?.fanout.map((fanout) => ({
      stepId: fanout.stepId,
      workerModel: fanout.workerModel,
      safeToResume: fanout.safeToResume,
    })), [{ stepId: 'process_each', workerModel: 'gpt-5-codex', safeToResume: true }]);
    assert.ok(body.executionPlan?.gates.some((gate) => gate.stepId === 'send' && gate.kind === 'approval'));
    assert.ok(body.executionPlan?.gates.some((gate) => gate.stepId === 'send' && gate.kind === 'grounding_judge'));
    assert.ok(body.executionPlan?.gates.some((gate) => gate.stepId === '(run goal)' && gate.kind === 'run_goal_judge' && gate.severity === 'block'));
    assert.ok(body.executionPlan?.toolSurface.composioTools.includes('SALESFORCE_GET_RECORDS'));
    assert.ok(body.executionPlan?.toolSurface.composioTools.includes('GMAIL_SEND_EMAIL'));
    assert.deepEqual(body.executionPlan?.toolSurface.localTools, ['read_file']);
    assert.deepEqual(body.executionPlan?.toolSurface.deterministicRunners, ['merge.py']);
    assert.equal(body.executionPlan?.modelSurface.portability, 'mixed');
    assert.equal(body.executionPlan?.modelSurface.portable, false);
    assert.equal(body.executionPlan?.modelSurface.modelSteps, 3);
    assert.equal(body.executionPlan?.modelSurface.nonModelSteps, 2);
    assert.deepEqual(body.executionPlan?.modelSurface.explicitModels, ['gpt-5-codex']);
    assert.ok(body.executionPlan?.modelSurface.warnings.some((warning) => warning.includes('process_each')));
    assert.equal(body.executionPlan?.visualContract.status, 'attention');
    assert.equal(body.executionPlan?.visualContract.blockedCount, 0);
    assert.ok(body.executionPlan?.visualContract.warningCount >= 2);
    const contractByKind = new Map(body.executionPlan?.visualContract.checks.map((check) => [check.kind, check]));
    assert.equal(contractByKind.get('structure')?.status, 'pass');
    assert.equal(contractByKind.get('fanout')?.status, 'pass');
    assert.equal(contractByKind.get('judges')?.status, 'pass');
    assert.equal(contractByKind.get('tool_readiness')?.status, 'warn');
    assert.equal(contractByKind.get('model_portability')?.status, 'warn');
    assert.ok(contractByKind.get('tool_readiness')?.stepIds.includes('fetch_crm'));
    assert.equal(body.executionPlan?.toolReadiness.ready, false);
    assert.equal(body.executionPlan?.toolReadiness.missingCount, 0);
    assert.equal(body.executionPlan?.toolReadiness.unknownCount, 2);
    const readinessByName = new Map(body.executionPlan?.toolReadiness.items.map((item) => [item.name, item]));
    assert.equal(readinessByName.get('read_file')?.status, 'ready');
    assert.equal(readinessByName.get('merge.py')?.status, 'ready');
    assert.equal(readinessByName.get('SALESFORCE_GET_RECORDS')?.status, 'unknown');
    assert.equal(readinessByName.get('GMAIL_SEND_EMAIL')?.status, 'unknown');
    assert.deepEqual(readinessByName.get('SALESFORCE_GET_RECORDS')?.sources, ['step_call']);
    assert.ok(readinessByName.get('SALESFORCE_GET_RECORDS')?.evidence?.some((entry) => entry.kind === 'composio_broker' && entry.name === 'composio_execute_tool' && entry.status === 'ready'));
    assert.deepEqual(readinessByName.get('merge.py')?.sources, ['deterministic_runner']);
    assert.ok(readinessByName.get('merge.py')?.evidence?.some((entry) => entry.kind === 'script' && entry.status === 'ready'));
    const graphReadinessByStep = new Map(body.graph?.nodes.map((node) => [node.id, node.readiness]));
    assert.equal(graphReadinessByStep.get('fetch_crm')?.status, 'unknown');
    assert.equal(graphReadinessByStep.get('fetch_crm')?.unknownCount, 1);
    assert.deepEqual(graphReadinessByStep.get('fetch_crm')?.items[0]?.sources, ['step_call']);
    assert.equal(graphReadinessByStep.get('fetch_docs')?.status, 'ready');
    assert.equal(graphReadinessByStep.get('merge')?.status, 'ready');
    assert.equal(graphReadinessByStep.get('merge')?.readyCount, 1);
    assert.equal(graphReadinessByStep.get('send')?.status, 'unknown');
    assert.equal(graphReadinessByStep.get('send')?.items[0]?.name, 'GMAIL_SEND_EMAIL');
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows accepts nested event/webhook triggers and syncs them', async () => {
  const workflowName = 'Dashboard Trigger Create Flow';
  const h = await boot();
  try {
    const create = await fetch(`${h.url}/api/console/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: workflowName,
        description: 'Handle dashboard-created lead events.',
        trigger: {
          webhookPath: 'dashboard-lead-created',
          events: [{ type: 'dashboard.lead.created', dedupeKey: 'lead-{{payload.id}}' }],
        },
        goal: {
          objective: 'Handle every incoming lead event.',
          success_criteria: ['Lead payload is processed.'],
          max_attempts: 3,
        },
        steps: [{ id: 'handle', prompt: 'Handle the lead event.' }],
      }),
    });
    assert.equal(create.status, 200);
    const created = await create.json() as { enabled: boolean; readinessGaps: unknown[] };
    assert.equal(created.enabled, true);
    assert.deepEqual(created.readinessGaps, []);

    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      trigger: { webhookPath?: string; events?: Array<{ type: string; dedupeKey?: string }> };
      goal?: { objective?: string; successCriteria?: string[]; maxAttempts?: number } | null;
      executionPlan?: { gates?: Array<{ kind: string; stepId: string }> };
    };
    assert.equal(body.trigger.webhookPath, 'dashboard-lead-created');
    assert.deepEqual(body.trigger.events, [{ type: 'dashboard.lead.created', dedupeKey: 'lead-{{payload.id}}' }]);
	    assert.equal(body.goal?.objective, 'Handle every incoming lead event.');
	    assert.deepEqual(body.goal?.successCriteria, ['Lead payload is processed.']);
	    assert.equal(body.goal?.maxAttempts, 3);
	    assert.ok(body.executionPlan?.gates?.some((gate) => gate.kind === 'run_goal_judge' && gate.stepId === '(run goal)'));

	    const clearGoal = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}`, {
	      method: 'PATCH',
	      headers: { 'Content-Type': 'application/json' },
	      body: JSON.stringify({ clearGoal: true }),
	    });
	    assert.equal(clearGoal.status, 200);
	    const afterClear = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}`);
	    assert.equal(afterClear.status, 200);
	    const cleared = await afterClear.json() as {
	      goal?: { objective?: string } | null;
	      executionPlan?: { gates?: Array<{ kind: string; stepId: string }> };
	    };
	    assert.equal(cleared.goal, null);
	    assert.ok(!cleared.executionPlan?.gates?.some((gate) => gate.kind === 'run_goal_judge' && gate.stepId === '(run goal)'));

	    const fired = fireWorkflowSystemEvent('dashboard.lead.created', { id: 'L-42' })
	      .filter((result) => result.workflowName === 'dashboard-trigger-create-flow');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].status, 'queued');
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows keeps external-read creates disabled when smoke inputs are missing', async () => {
  const workflowName = 'Dashboard Create Missing Smoke Flow';
  const workflowSlug = 'dashboard-create-missing-smoke-flow';
  const h = await boot();
  try {
    const create = await fetch(`${h.url}/api/console/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: workflowName,
        description: 'Fetch a supplied URL with Apify.',
        inputs: { url: { type: 'string', description: 'URL to fetch' } },
        steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}} with Apify.', allowedTools: ['composio_apify_*'] }],
      }),
    });
    assert.equal(create.status, 202);
    const body = await create.json() as { enabled?: boolean; missingSmokeInputs?: string[] };
    assert.equal(body.enabled, false);
    assert.deepEqual(body.missingSmokeInputs, ['url']);
    assert.equal(readWorkflow(workflowSlug)!.data.enabled, false);
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows can normalize exact model pins for portable workflows', async () => {
  const workflowName = 'Dashboard Portable Model Flow';
  const h = await boot();
  try {
    const create = await fetch(`${h.url}/api/console/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: workflowName,
        description: 'Portable model API test.',
        enabled: false,
        portable_models: true,
        steps: [
          { id: 'draft', prompt: 'Draft the memo.', model: 'claude-opus-4-8', intent: 'writing' },
        ],
      }),
    });
    assert.equal(create.status, 200);
    const createBody = await create.json() as { repairs?: string[] };
    assert.ok(createBody.repairs?.some((repair) => repair.includes('portable intent routing "writing"')));

    const detail = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}`);
    assert.equal(detail.status, 200);
    const body = await detail.json() as {
      steps?: Array<{ id: string; model?: string; intent?: string }>;
      executionPlan?: { modelSurface?: { portability: string; explicitModelSteps: number; intentRoutedSteps: number } };
    };
    assert.equal(body.steps?.[0]?.model, undefined);
    assert.equal(body.steps?.[0]?.intent, 'writing');
    assert.equal(body.executionPlan?.modelSurface?.portability, 'portable');
    assert.equal(body.executionPlan?.modelSurface?.explicitModelSteps, 0);
    assert.equal(body.executionPlan?.modelSurface?.intentRoutedSteps, 1);
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows/:name/contract-fixes applies visual contract fixes through the dashboard route', async () => {
  const workflowName = 'Dashboard Contract Fix Flow';
  const workflowSlug = 'dashboard-contract-fix-flow';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'Draft a weekly client memo.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'draft', prompt: 'Draft the weekly client memo.', model: 'claude-opus-4-8' }],
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/contract-fixes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixes: ['make_models_portable', 'add_judge_gate'], stepIds: ['draft'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      updated?: boolean;
      changes?: string[];
      steps?: Array<{ id: string; model?: string }>;
      goal?: { objective?: string } | null;
      executionPlan?: { visualContract?: { status?: string; remediations?: Array<{ kind: string }> }; graph?: unknown };
      graph?: { nodes?: Array<{ id: string }> };
    };
    assert.equal(body.updated, true);
    assert.ok(body.changes?.some((change) => change.includes('Replaced pinned model "claude-opus-4-8"')));
    assert.ok(body.changes?.some((change) => change.includes('Pinned workflow goal')));
    assert.equal(body.steps?.[0]?.model, undefined);
    assert.equal(body.goal?.objective, 'Draft a weekly client memo.');
    assert.equal(body.executionPlan?.visualContract?.status, 'trusted');
    assert.ok(Array.isArray(body.graph?.nodes));

    const saved = readWorkflow(workflowSlug)!.data;
    assert.equal(saved.steps[0].model, undefined);
    assert.equal(saved.goal?.objective, 'Draft a weekly client memo.');
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows/:name/contract-fixes reports manual-only remediations without mutating', async () => {
  const workflowName = 'Dashboard Manual Contract Fix Flow';
  const workflowSlug = 'dashboard-manual-contract-fix-flow';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'Render a report with a missing skill.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'render', prompt: 'Render the report.', usesSkill: 'missing-report-skill' }],
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/contract-fixes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixes: ['install_skill'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      updated?: boolean;
      changes?: string[];
      skipped?: string[];
      executionPlan?: { visualContract?: { status?: string } };
    };
    assert.equal(body.updated, false);
    assert.deepEqual(body.changes, []);
    assert.ok(body.skipped?.some((skip) => skip.includes('Missing skills must be installed locally')));
    assert.equal(body.executionPlan?.visualContract?.status, 'blocked');
    assert.equal(readWorkflow(workflowSlug)!.data.steps[0].usesSkill, 'missing-report-skill');
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows/:name/contract-actions binds a missing local project', async () => {
  const workspaceRoot = path.join(TMP_HOME, 'workspace-projects');
  const projectDir = path.join(workspaceRoot, 'client-portal');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'client-portal' }), 'utf-8');
  updateEnvKey('WORKSPACE_DIRS', workspaceRoot);

  const workflowName = 'Dashboard Project Contract Action Flow';
  const workflowSlug = 'dashboard-project-contract-action-flow';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'Patch a local client portal project.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'patch_repo', prompt: 'Patch the repo.', project: 'missing-project' }],
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/contract-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'select_local_project', stepIds: ['patch_repo'], project: 'client-portal' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      updated?: boolean;
      changes?: string[];
      steps?: Array<{ id: string; project?: string }>;
      executionPlan?: { visualContract?: { status?: string } };
      graph?: { nodes?: Array<{ id: string; contract?: { status?: string } }> };
    };
    assert.equal(body.updated, true);
    assert.ok(body.changes?.some((change) => change.includes('Bound 1 step')));
    assert.equal(body.steps?.find((step) => step.id === 'patch_repo')?.project, 'client-portal');
    assert.notEqual(body.executionPlan?.visualContract?.status, 'blocked');
    assert.notEqual(body.graph?.nodes?.find((node) => node.id === 'patch_repo')?.contract?.status, 'block');
    assert.equal(readWorkflow(workflowSlug)!.data.steps[0].project, 'client-portal');
  } finally {
    await h.close();
    updateEnvKey('WORKSPACE_DIRS', '');
    clearWorkspaceProjectCache();
  }
});

test('POST /api/console/workflows/:name/contract-actions creates and binds a deterministic workflow script', async () => {
  const workflowName = 'Dashboard Script Contract Action Flow';
  const workflowSlug = 'dashboard-script-contract-action-flow';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'Render a deterministic report.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'render', prompt: 'Render the report.', deterministic: { runner: 'missing.py' } }],
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/contract-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'add_workflow_script',
        stepIds: ['render'],
        runner: 'render.py',
        scriptContent: 'import json\nprint(json.dumps({"ok": True}))',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      updated?: boolean;
      changes?: string[];
      steps?: Array<{ id: string; deterministic?: { runner?: string } }>;
      executionPlan?: { visualContract?: { status?: string } };
      graph?: { nodes?: Array<{ id: string; contract?: { status?: string } }> };
    };
    assert.equal(body.updated, true);
    assert.ok(body.changes?.some((change) => change.includes('Created workflow script')));
    assert.ok(body.changes?.some((change) => change.includes('Bound 1 deterministic step')));
    assert.equal(body.steps?.find((step) => step.id === 'render')?.deterministic?.runner, 'render.py');
    assert.notEqual(body.executionPlan?.visualContract?.status, 'blocked');
    assert.notEqual(body.graph?.nodes?.find((node) => node.id === 'render')?.contract?.status, 'block');
    assert.match(readFileSync(path.join(WORKFLOWS_DIR, workflowSlug, 'scripts', 'render.py'), 'utf-8'), /"ok": True/);
    assert.equal(readWorkflow(workflowSlug)!.data.steps[0].deterministic?.runner, 'render.py');
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows/:name/contract-actions saves a selected CLI requirement to readiness inventory', async () => {
  updateEnvKey('CLEMMY_SAVED_CLIS', '');
  const workflowName = 'Dashboard CLI Contract Action Flow';
  const workflowSlug = 'dashboard-cli-contract-action-flow';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'Ship through a user-confirmed local CLI.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'ship', prompt: 'Ship the change.', allowedTools: ['cli:clemflow'] }],
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/contract-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'confirm_tool_connection', stepIds: ['ship'], command: 'clemflow' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      updated?: boolean;
      changes?: string[];
      connectionReady?: boolean;
      savedCli?: string;
      savedClis?: string[];
      executionPlan?: { toolReadiness?: { items?: Array<{ kind: string; name: string; status: string }> }; visualContract?: { status?: string } };
      graph?: { nodes?: Array<{ id: string; contract?: { status?: string } }> };
    };
    assert.equal(body.updated, true);
    assert.equal(body.savedCli, 'clemflow');
    assert.ok(body.savedClis?.includes('clemflow'));
    assert.ok(body.changes?.some((change) => change.includes('Saved CLI "clemflow"')));
    const cliItem = body.executionPlan?.toolReadiness?.items?.find((item) => item.kind === 'cli' && item.name === 'cli:clemflow');
    assert.equal(cliItem?.status, 'ready');
    assert.equal(body.connectionReady, true);
    assert.notEqual(body.executionPlan?.visualContract?.status, 'blocked');
    assert.notEqual(body.graph?.nodes?.find((node) => node.id === 'ship')?.contract?.status, 'block');

    const savedRes = await fetch(`${h.url}/api/console/clis/saved`);
    assert.equal(savedRes.status, 200);
    const savedBody = await savedRes.json() as { saved?: string[] };
    assert.ok(savedBody.saved?.includes('clemflow'));
    assert.equal(readWorkflow(workflowSlug)!.data.steps[0].allowedTools?.[0], 'cli:clemflow');
  } finally {
    await h.close();
    updateEnvKey('CLEMMY_SAVED_CLIS', '');
  }
});

test('POST /api/console/workflows/:name/contract-actions audits missing Composio connection next actions', async () => {
  const previousKey = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  const workflowName = 'Dashboard Composio Contract Action Flow';
  writeWorkflow('dashboard-composio-contract-action-flow', {
    name: workflowName,
    description: 'Send through a Composio-connected app.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'send', prompt: 'Send the email.', allowedTools: ['GMAIL_SEND_EMAIL'] }],
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/contract-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'confirm_tool_connection', stepIds: ['send'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      updated?: boolean;
      connectionReady?: boolean;
      skipped?: string[];
      toolConnectionChecks?: Array<{
        runtime: string;
        name: string;
        status: string;
        toolkitSlug?: string;
        nextActions: Array<{ kind: string; endpoint?: string; command?: string }>;
      }>;
    };
    assert.equal(body.updated, false);
    assert.equal(body.connectionReady, false);
    const check = body.toolConnectionChecks?.find((item) => item.runtime === 'composio' && item.name === 'GMAIL_SEND_EMAIL');
    assert.equal(check?.status, 'missing');
    assert.equal(check?.toolkitSlug, 'gmail');
    assert.ok(check?.nextActions.some((action) => action.kind === 'set_composio_api_key' && action.endpoint === '/api/composio/api-key'));
    assert.ok(check?.nextActions.some((action) => action.kind === 'search_composio_schema' && action.command?.includes('composio_search_tools')));
    assert.ok(body.skipped?.some((line) => line.includes('POST /api/composio/api-key')));
  } finally {
    await h.close();
    if (previousKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
  }
});

test('POST /api/console/workflows/:name/contract-actions audits runtime failed tool names', async () => {
  const previousKey = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  const workflowName = 'Dashboard Runtime Tool Repair Flow';
  writeWorkflow('dashboard-runtime-tool-repair-flow', {
    name: workflowName,
    description: 'Runtime failure evidence can repair a concrete tool.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'send', prompt: 'Draft and send a message if requested.' }],
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/contract-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'confirm_tool_connection', stepIds: ['send'], tools: ['GMAIL_SEND_EMAIL'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      connectionReady?: boolean;
      checkedItems?: Array<{ kind: string; name: string; reason: string }>;
      toolConnectionChecks?: Array<{
        runtime: string;
        name: string;
        status: string;
        toolkitSlug?: string;
        evidence?: string[];
        nextActions: Array<{ kind: string; endpoint?: string; command?: string }>;
      }>;
    };
    assert.equal(body.connectionReady, false);
    assert.ok(body.checkedItems?.some((item) =>
      item.kind === 'composio'
      && item.name === 'GMAIL_SEND_EMAIL'
      && /Runtime run evidence/.test(item.reason)));
    const check = body.toolConnectionChecks?.find((item) => item.runtime === 'composio' && item.name === 'GMAIL_SEND_EMAIL');
    assert.equal(check?.status, 'missing');
    assert.equal(check?.toolkitSlug, 'gmail');
    assert.ok(check?.evidence?.some((line) => line.includes('COMPOSIO_API_KEY is not configured')));
    assert.ok(check?.nextActions.some((action) => action.kind === 'set_composio_api_key' && action.endpoint === '/api/composio/api-key'));
  } finally {
    await h.close();
    if (previousKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
  }
});

test('POST /api/console/workflows/:name/contract-actions audits MCP credential and reconnect next actions', async () => {
  const previousKey = process.env.CLEMFLOW_MCP_TOKEN;
  delete process.env.CLEMFLOW_MCP_TOKEN;
  saveUserMcpServers({
    'clemflow-mcp': {
      name: 'clemflow-mcp',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'clemflow-mcp-server'],
      env: { CLEMFLOW_MCP_TOKEN: '' },
      enabled: true,
      description: 'Clemflow test MCP server',
    },
  });
  const workflowName = 'Dashboard MCP Contract Action Flow';
  writeWorkflow('dashboard-mcp-contract-action-flow', {
    name: workflowName,
    description: 'Search through a configured MCP server.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'search', prompt: 'Search the MCP source.', allowedTools: ['mcp__clemflow-mcp__search'] }],
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/contract-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'confirm_tool_connection', stepIds: ['search'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      updated?: boolean;
      connectionReady?: boolean;
      skipped?: string[];
      toolConnectionChecks?: Array<{
        runtime: string;
        name: string;
        status: string;
        serverName?: string;
        serverSlug?: string;
        evidence?: string[];
        nextActions: Array<{ kind: string; endpoint?: string; command?: string }>;
      }>;
    };
    assert.equal(body.updated, false);
    assert.equal(body.connectionReady, false);
    const check = body.toolConnectionChecks?.find((item) => item.runtime === 'mcp' && item.name === 'mcp__clemflow-mcp__search');
    assert.equal(check?.status, 'missing');
    assert.equal(check?.serverName, 'clemflow-mcp');
    assert.equal(check?.serverSlug, 'clemflow-mcp');
    assert.ok(check?.evidence?.some((entry) => entry.includes('unset credential keys: CLEMFLOW_MCP_TOKEN')));
    assert.ok(check?.nextActions.some((action) => action.kind === 'set_mcp_credentials' && action.endpoint === '/api/console/mcp-servers/clemflow-mcp/credential'));
    assert.ok(check?.nextActions.some((action) => action.kind === 'inspect_mcp_status' && action.command?.includes('mcp_status')));
    assert.ok(body.skipped?.some((line) => line.includes('mcp_status query="clemflow-mcp"')));
  } finally {
    await h.close();
    saveUserMcpServers({});
    if (previousKey === undefined) delete process.env.CLEMFLOW_MCP_TOKEN;
    else process.env.CLEMFLOW_MCP_TOKEN = previousKey;
  }
});

test('POST /api/console/mcp-servers/:name/reconnect clears MCP runtime connections for workflow repairs', async () => {
  saveUserMcpServers({
    'clemflow-mcp': {
      name: 'clemflow-mcp',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'clemflow-mcp-server'],
      enabled: true,
      description: 'Clemflow test MCP server',
    },
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/mcp-servers/${encodeURIComponent('clemflow-mcp')}/reconnect`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok?: boolean; server?: string; message?: string; servers?: unknown[] };
    assert.equal(body.ok, true);
    assert.equal(body.server, 'clemflow-mcp');
    assert.match(body.message || '', /will reconnect/);
    assert.ok(Array.isArray(body.servers));
  } finally {
    await h.close();
    saveUserMcpServers({});
  }
});

test('POST /api/console/workflows queues verification for external-read creates with smoke inputs', async () => {
  const workflowName = 'Dashboard Create Smoke Flow';
  const workflowSlug = 'dashboard-create-smoke-flow';
  const h = await boot();
  try {
    const create = await fetch(`${h.url}/api/console/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: workflowName,
        description: 'Fetch a supplied URL with Apify.',
        inputs: { url: { type: 'string', description: 'URL to fetch' } },
        testInputs: { url: 'https://example.com/create' },
        steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}} with Apify.', allowedTools: ['composio_apify_*'] }],
      }),
    });
    assert.equal(create.status, 202);
    const body = await create.json() as { enabled?: boolean; verificationQueued?: boolean; runId?: string };
    assert.equal(body.enabled, false);
    assert.equal(body.verificationQueued, true);
    assert.equal(readWorkflow(workflowSlug)!.data.enabled, false);

    const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${body.runId}.json`), 'utf-8')) as {
      workflow: string;
      status: string;
      inputs: Record<string, string>;
    };
    assert.equal(run.workflow, workflowName);
    assert.equal(run.status, 'creation_test');
    assert.equal(run.inputs.url, 'https://example.com/create');
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows/:name/set-enabled queues verification for external-read workflows', async () => {
  const workflowName = 'Dashboard Enable Smoke Flow';
  const workflowSlug = 'dashboard-enable-smoke-flow';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'Fetch a supplied URL with Apify.',
    enabled: false,
    trigger: { manual: true },
    inputs: { url: { type: 'string', description: 'URL to fetch' } },
    steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}} with Apify.', allowedTools: ['composio_apify_*'] }],
  });

  const h = await boot();
  try {
    const missing = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/set-enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(missing.status, 409);
    const missingBody = await missing.json() as { missingSmokeInputs?: string[]; enabled?: boolean };
    assert.deepEqual(missingBody.missingSmokeInputs, ['url']);
    assert.equal(readWorkflow(workflowSlug)!.data.enabled, false);

    const queued = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/set-enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, testInputs: { url: 'https://example.com' } }),
    });
    assert.equal(queued.status, 202);
    const queuedBody = await queued.json() as { verificationQueued?: boolean; enabled?: boolean; runId?: string };
    assert.equal(queuedBody.verificationQueued, true);
    assert.equal(queuedBody.enabled, false);
    assert.equal(readWorkflow(workflowSlug)!.data.enabled, false);

    const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${queuedBody.runId}.json`), 'utf-8')) as {
      workflow: string;
      status: string;
      inputs: Record<string, string>;
    };
    assert.equal(run.workflow, workflowSlug);
    assert.equal(run.status, 'creation_test');
    assert.equal(run.inputs.url, 'https://example.com');
  } finally {
    await h.close();
  }
});

test('PATCH /api/console/workflows enabling an external-read draft queues verification', async () => {
  const workflowName = 'Dashboard Patch Smoke Flow';
  const workflowSlug = 'dashboard-patch-smoke-flow';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'Fetch a supplied URL with Apify.',
    enabled: false,
    trigger: { manual: true },
    inputs: { url: { type: 'string', description: 'URL to fetch' } },
    steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}} with Apify.', allowedTools: ['composio_apify_*'] }],
  });

  const h = await boot();
  try {
    const patch = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, testInputs: { url: 'https://example.com/patch' } }),
    });
    assert.equal(patch.status, 202);
    const body = await patch.json() as { verificationQueued?: boolean; enabled?: boolean; runId?: string };
    assert.equal(body.verificationQueued, true);
    assert.equal(body.enabled, false);
    assert.equal(readWorkflow(workflowSlug)!.data.enabled, false);

    const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${body.runId}.json`), 'utf-8')) as {
      workflow: string;
      status: string;
      inputs: Record<string, string>;
    };
    assert.equal(run.workflow, workflowSlug);
    assert.equal(run.status, 'creation_test');
    assert.equal(run.inputs.url, 'https://example.com/patch');
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows/:name/run rejects missing inputs and dedupes full runs through the shared queue', async () => {
  const workflowName = 'Dashboard Run Queue Parity Flow';
  const workflowSlug = 'dashboard-run-queue-parity-flow';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'Run queue parity test.',
    enabled: true,
    trigger: { manual: true },
    inputs: { url: { type: 'string', description: 'URL to fetch' } },
    steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}}.' }],
  });

  const h = await boot();
  try {
    const missing = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: {} }),
    });
    assert.equal(missing.status, 400);
    const missingBody = await missing.json() as { missingInputs?: string[] };
    assert.deepEqual(missingBody.missingInputs, ['url']);
    assert.equal(workflowRunRecords(workflowName).length, 0, 'missing-input dashboard runs are not queued');

    const first = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: { website: 'https://example.com' } }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { id?: string; queued?: boolean; duplicate?: boolean };
    assert.equal(firstBody.queued, true);
    assert.equal(firstBody.duplicate, false);
    assert.ok(firstBody.id);

    const second = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: { url: 'https://example.com' } }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { id?: string; queued?: boolean; duplicate?: boolean };
    assert.equal(secondBody.queued, false);
    assert.equal(secondBody.duplicate, true);
    assert.equal(secondBody.id, firstBody.id);

    const records = workflowRunRecords(workflowName);
    assert.equal(records.length, 1);
    assert.equal(records[0].source, 'console');
    assert.equal(records[0].status, 'queued');
    assert.deepEqual(records[0].inputs, { website: 'https://example.com', url: 'https://example.com' });
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows/:name/run blocks missing required workflow capabilities before queueing', async () => {
  const workflowName = 'Dashboard Run Readiness Block Flow';
  writeWorkflow('dashboard-run-readiness-block-flow', {
    name: workflowName,
    description: 'Run readiness block test.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'merge', prompt: 'Merge evidence.', deterministic: { runner: 'missing.py' } }],
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: {} }),
    });
    assert.equal(res.status, 409);
    const body = await res.json() as {
      status?: string;
      readiness?: { blockers?: Array<{ kind: string; name: string; status: string; stepIds: string[] }> };
      executionPlan?: { toolReadiness?: { missingCount: number } };
    };
    assert.equal(body.status, 'blocked_readiness');
    assert.equal(body.readiness?.blockers?.[0]?.kind, 'script');
    assert.equal(body.readiness?.blockers?.[0]?.name, 'missing.py');
    assert.deepEqual(body.readiness?.blockers?.[0]?.stepIds, ['merge']);
    assert.equal(body.executionPlan?.toolReadiness?.missingCount, 1);
    assert.equal(workflowRunRecords(workflowName).length, 0, 'readiness-blocked dashboard runs are not queued');
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows/:name/run blocks missing local project requirements before queueing', async () => {
  const workflowName = 'Dashboard Run Project Readiness Block Flow';
  writeWorkflow('dashboard-run-project-readiness-block-flow', {
    name: workflowName,
    description: 'Run project readiness block test.',
    project: 'definitely-missing-project-for-readiness-test-0001',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'inspect', prompt: 'Inspect the local project.' }],
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: {} }),
    });
    assert.equal(res.status, 409);
    const body = await res.json() as {
      status?: string;
      readiness?: { blockers?: Array<{ kind: string; name: string; status: string; stepIds: string[] }> };
      executionPlan?: { toolReadiness?: { missingCount: number } };
    };
    assert.equal(body.status, 'blocked_readiness');
    assert.equal(body.readiness?.blockers?.[0]?.kind, 'project');
    assert.equal(body.readiness?.blockers?.[0]?.name, 'definitely-missing-project-for-readiness-test-0001');
    assert.deepEqual(body.readiness?.blockers?.[0]?.stepIds, ['inspect']);
    assert.equal(body.executionPlan?.toolReadiness?.missingCount, 1);
    assert.equal(workflowRunRecords(workflowName).length, 0, 'project-readiness-blocked dashboard runs are not queued');
  } finally {
    await h.close();
  }
});

test('POST /api/console/workflows/:name/run uses explicit queue helpers for dry-run and step TRY records', async () => {
  const workflowName = 'Dashboard Run Special Records Flow';
  const workflowSlug = 'dashboard-run-special-records-flow';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'Special run queue records.',
    enabled: false,
    trigger: { manual: true },
    inputs: { url: { type: 'string', description: 'URL to fetch' } },
    steps: [
      { id: 'fetch', prompt: 'Fetch {{input.url}}.' },
      { id: 'summarize', prompt: 'Summarize the fetch.', dependsOn: ['fetch'] },
    ],
  });

  const h = await boot();
  try {
    const dryRun = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true, inputs: { url: 'https://example.com/dry' } }),
    });
    assert.equal(dryRun.status, 200);
    const dryBody = await dryRun.json() as { id?: string; queued?: boolean; dryRun?: boolean };
    assert.equal(dryBody.queued, false);
    assert.equal(dryBody.dryRun, true);

    const stepTry = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetStepId: 'summarize', inputs: { url: 'https://example.com/try' } }),
    });
    assert.equal(stepTry.status, 200);
    const tryBody = await stepTry.json() as { id?: string; queued?: boolean; targetStepId?: string };
    assert.equal(tryBody.queued, true);
    assert.equal(tryBody.targetStepId, 'summarize');

    const dryRecord = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${dryBody.id}.json`), 'utf-8')) as Record<string, unknown>;
    assert.equal(dryRecord.workflow, workflowName);
    assert.equal(dryRecord.status, 'dry_run');
    assert.equal(dryRecord.source, 'console');

    const tryRecord = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${tryBody.id}.json`), 'utf-8')) as Record<string, unknown>;
    assert.equal(tryRecord.workflow, workflowName);
    assert.equal(tryRecord.status, 'queued');
    assert.equal(tryRecord.source, 'console');
    assert.equal(tryRecord.targetStepId, 'summarize');
    assert.deepEqual(tryRecord.recoveryIntent, {
      kind: 'step_try',
      createdAt: tryRecord.createdAt,
      sourceStepId: 'summarize',
      requestedFrom: 'console',
      reason: 'single-step try run',
    });
  } finally {
    await h.close();
  }
});

test('PATCH /api/console/workflows preserves step contracts when client sends partial step shapes', async () => {
  const workflowName = 'Patch Metadata Flow';
  writeWorkflow('patch-metadata-flow', {
    name: workflowName,
    description: 'partial patch metadata preservation',
    enabled: false,
    trigger: { manual: true },
    steps: [
      {
        id: 'research',
        prompt: 'Pull source-grounded metrics.',
        allowedTools: ['mcp'],
        usesSkill: 'client-seo-report',
        sideEffect: 'read',
        output: {
          required_keys: ['domain', 'sources'],
          non_empty: ['domain', 'sources'],
        },
      },
      {
        id: 'deliver',
        prompt: 'Send the verified audit.',
        dependsOn: ['research'],
        sideEffect: 'send',
        requiresApproval: true,
        approvalPreview: 'Send the audit to the client',
      },
    ],
  });

  const h = await boot();
  try {
    const patch = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        steps: [
          { id: 'research', prompt: 'Pull source-grounded metrics with fallback evidence.', dependsOn: [], allowedTools: ['mcp'] },
          { id: 'deliver', prompt: 'Verify the file and return delivery breadcrumbs.', dependsOn: ['research'] },
        ],
      }),
    });
    assert.equal(patch.status, 200);

    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { steps: Array<Record<string, unknown>> };
    const byId = Object.fromEntries(body.steps.map((step) => [step.id, step]));
    assert.equal(byId.research?.prompt, 'Pull source-grounded metrics with fallback evidence.');
    assert.deepEqual(byId.research?.output, {
      required_keys: ['domain', 'sources'],
      non_empty: ['domain', 'sources'],
    });
    assert.equal(byId.research?.sideEffect, 'read');
    assert.equal(byId.research?.usesSkill, 'client-seo-report');
    assert.equal(byId.deliver?.sideEffect, 'send');
    assert.equal(byId.deliver?.requiresApproval, true);
    assert.equal(byId.deliver?.approvalPreview, 'Send the audit to the client');
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

test('GET /api/console/workflows/:name/runs/:runId/graph-overlay replays run evidence for the workflow map', async () => {
  const workflowSlug = 'graph-overlay-flow';
  const workflowName = 'Graph Overlay Flow';
  const runId = 'run-graph-overlay';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'graph overlay test',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Pull records.' },
      { id: 'send', prompt: 'Send updates.', dependsOn: ['pull'], forEach: 'pull' },
      { id: 'summary', prompt: 'Summarize run.', dependsOn: ['send'] },
    ],
  });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'run_started' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'step_started', stepId: 'pull' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'tool_called', stepId: 'pull', meta: { tool: 'SALESFORCE_GET_RECORDS' } });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'step_completed', stepId: 'pull', output: ['a', 'b'] });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'step_started', stepId: 'send' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'approval_requested', stepId: 'send' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'item_started', stepId: 'send', itemKey: 'a' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'item_failed', stepId: 'send', itemKey: 'a', error: 'temporary send failure' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'step_retry', stepId: 'send', error: 'temporary send failure' });
  appendWorkflowEvent(workflowSlug, runId, {
    kind: 'attempt_record',
    stepId: 'send',
    attempt: {
      attemptIndex: 1,
      maxAttempts: 2,
      failedProblems: ['temporary send failure'],
      changeSummary: 'will retry send',
      metrics: { toolCalls: 1, durationMs: 100 },
    },
	  });
	  appendWorkflowEvent(workflowSlug, runId, { kind: 'step_advisory', stepId: 'send', meta: { reason: 'goal_validation_unavailable', judge: 'offline' } });
  appendWorkflowEvent(workflowSlug, runId, {
    kind: 'attempt_record',
    attempt: {
      attemptIndex: 1,
      maxAttempts: 3,
      failedProblems: ['Outbound receipt is missing.'],
      changeSummary: 'run attempt 1: 50% (1/2 criteria met)',
      metrics: { tokens: 800 },
    },
  });
  appendWorkflowEvent(workflowSlug, runId, {
    kind: 'step_advisory',
    stepId: '(run goal)',
    meta: {
      goal: 'escalate',
      reason: 'goal unmet after 3/3 attempts',
      attempt: 3,
      max: 3,
      successRatePercent: 50,
      criteriaMet: 1,
      criteriaTotal: 2,
      failedCriteria: ['Outbound receipt is missing.'],
    },
  });
	  appendWorkflowEvent(workflowSlug, runId, { kind: 'step_failed', stepId: 'send', error: 'temporary send failure' });
  appendWorkflowEvent(workflowSlug, runId, { kind: 'run_failed' });
  const harnessSession = createHarnessSession({
    id: 'workflow:run-graph-overlay:send',
    kind: 'workflow',
    channel: 'workflow',
    title: `${workflowName}::send`,
    metadata: { source: 'workflow', workflowName, workflowRunId: runId, stepId: 'send' },
  });
  appendHarnessEvent({ sessionId: harnessSession.id, turn: 1, role: 'system', type: 'worker_model_routed', data: { modelId: 'claude-opus-4-8', provider: 'claude', routeKind: 'intent' } });
  appendHarnessEvent({ sessionId: harnessSession.id, turn: 1, role: 'Clem', type: 'tool_called', data: { tool: 'SLACK_SEND_MESSAGE' } });
  appendHarnessEvent({ sessionId: harnessSession.id, turn: 1, role: 'system', type: 'worker_result', data: { ok: true, model: 'claude-opus-4-8', toolUses: 1 } });
  appendHarnessEvent({ sessionId: harnessSession.id, turn: 1, role: 'system', type: 'external_write', data: { tool: 'SLACK_SEND_MESSAGE' } });
  appendHarnessEvent({ sessionId: harnessSession.id, turn: 1, role: 'system', type: 'goal_alignment_judged', data: { fulfills: true } });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'running',
    createdAt: '2026-07-04T09:59:59.000Z',
    recoveryIntent: {
      kind: 'safe_rerun',
      createdAt: '2026-07-04T10:01:00.000Z',
      sourceRunId: 'prior-run',
      sourceStepId: 'send',
      requestedFrom: 'graph',
      reason: 'graph node safe rerun',
    },
    readiness: {
      ok: true,
      checkedAt: '2026-07-04T09:59:58.000Z',
      scope: 'run',
      blockers: [],
      warnings: [{
        kind: 'composio',
        name: 'SALESFORCE_GET_RECORDS',
        status: 'unknown',
        reason: 'Composio broker is available; exact app slug and account connection still need runtime schema confirmation.',
        stepIds: ['pull'],
        sources: ['step_call'],
        evidence: [
          { kind: 'composio_broker', name: 'composio_execute_tool', status: 'ready', detail: 'broker can resolve app tools at runtime' },
        ],
      }],
      toolReadiness: {
        ready: false,
        readyCount: 0,
        missingCount: 0,
        unknownCount: 1,
        items: [{
          kind: 'composio',
          name: 'SALESFORCE_GET_RECORDS',
          status: 'unknown',
          reason: 'Composio broker is available; exact app slug and account connection still need runtime schema confirmation.',
          stepIds: ['pull'],
          sources: ['step_call'],
          evidence: [
            { kind: 'composio_broker', name: 'composio_execute_tool', status: 'ready', detail: 'broker can resolve app tools at runtime' },
          ],
        }],
      },
    },
  }, null, 2), 'utf-8');

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/runs/${runId}/graph-overlay`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      runId: string;
      workflow: string;
      overlay: {
        runStatus: string;
        terminal: boolean;
        summary: { attentionSteps: number; bottleneckStepId: string | null; bottleneck: string | null; toolCalls: number; workerBranches: number; externalWrites: number; judgeVerdicts: number; goalStatus?: string | null; goalSuccessRatePercent?: number; goalNeedsAttention?: boolean };
        goal: { status: string; reason?: string; attempt?: number; maxAttempts?: number; successRatePercent?: number; criteriaMet?: number; criteriaTotal?: number; failedCriteria: string[]; attempts: Array<{ changeSummary: string }> } | null;
        launchReadiness: {
          ok: boolean;
          checkedAt?: string;
          scope: string;
          warnings: Array<{ name: string; sources?: string[]; evidence?: Array<{ kind: string; name: string; status: string }> }>;
          toolReadiness?: { unknownCount?: number };
        } | null;
        launchComparison: {
          launchToolCount: number;
          launchIssueCount: number;
          runtimeToolCount: number;
          confirmedLaunchTools: string[];
          unconfirmedLaunchTools: string[];
          runtimeOnlyTools: string[];
          failedTools: string[];
          preflightRiskHits: string[];
          attentionLevel: string;
          notes: string[];
        } | null;
        executionEfficiency: {
          plannedMaxParallelWidth: number;
          runtimeMaxParallelWidth: number;
          plannedEstimatedRounds: number;
          plannedParallelSavings: number;
          fanoutStepCount: number;
          criticalPath: string[];
          attentionLevel: string;
          issues: Array<{ kind: string; stepId?: string; severity: string; message: string }>;
          notes: string[];
        } | null;
        recoveryIntent: {
          kind: string;
          createdAt?: string;
          sourceRunId?: string;
          sourceStepId?: string;
          requestedFrom?: string;
          reason?: string;
        } | null;
        recoveryLineage: Array<{
          runId: string;
          sourceRunId?: string;
          sourceStepId?: string;
          kind?: string;
          requestedFrom?: string;
          reason?: string;
          sourceMissing?: boolean;
          isCurrent: boolean;
        }>;
	        steps: Array<{
          stepId: string;
          status: string;
          sessionIds: string[];
          toolCalls: number;
          tools: string[];
          models: string[];
          routes: string[];
          retries: number;
          attempts: number;
          itemsFailed: number;
          approvalsRequested: number;
          advisories: number;
          judgeVerdicts: number;
          workerBranches: number;
          externalWrites: number;
          attentionLevel: string;
          attentionReasons: string[];
          bottleneck: string | null;
          riskSignals: string[];
          launchComparison?: {
            confirmedLaunchTools: string[];
            runtimeOnlyTools: string[];
            failedTools: string[];
            preflightRiskHits: string[];
            attentionLevel: string;
          } | null;
          executionEfficiency?: {
            plannedParallelWidth: number;
            plannedCritical: boolean;
            plannedFanoutConcurrency?: number;
            issueKinds: string[];
            attentionLevel: string;
            notes: string[];
          } | null;
        }>;
	      };
	    };
    assert.equal(body.runId, runId);
    assert.equal(body.workflow, workflowName);
    assert.equal(body.overlay.runStatus, 'failed');
    assert.equal(body.overlay.terminal, true);
    assert.equal(body.overlay.summary.attentionSteps, 1);
    assert.equal(body.overlay.summary.bottleneckStepId, 'send');
    assert.equal(body.overlay.summary.bottleneck, 'failed step');
    assert.equal(body.overlay.summary.toolCalls, 2);
    assert.equal(body.overlay.summary.workerBranches, 1);
    assert.equal(body.overlay.summary.externalWrites, 1);
	    assert.equal(body.overlay.summary.judgeVerdicts, 3);
    assert.equal(body.overlay.summary.goalStatus, 'escalate');
    assert.equal(body.overlay.summary.goalSuccessRatePercent, 50);
    assert.equal(body.overlay.summary.goalNeedsAttention, true);
    assert.equal(body.overlay.launchReadiness?.ok, true);
    assert.equal(body.overlay.launchReadiness?.checkedAt, '2026-07-04T09:59:58.000Z');
    assert.equal(body.overlay.launchReadiness?.scope, 'run');
    assert.equal(body.overlay.launchReadiness?.warnings[0]?.name, 'SALESFORCE_GET_RECORDS');
    assert.deepEqual(body.overlay.launchReadiness?.warnings[0]?.sources, ['step_call']);
    assert.ok(body.overlay.launchReadiness?.warnings[0]?.evidence?.some((entry) => entry.kind === 'composio_broker' && entry.name === 'composio_execute_tool' && entry.status === 'ready'));
    assert.equal(body.overlay.launchReadiness?.toolReadiness?.unknownCount, 1);
    assert.equal(body.overlay.launchComparison?.launchToolCount, 1);
    assert.equal(body.overlay.launchComparison?.launchIssueCount, 1);
    assert.equal(body.overlay.launchComparison?.runtimeToolCount, 2);
    assert.deepEqual(body.overlay.launchComparison?.confirmedLaunchTools, ['SALESFORCE_GET_RECORDS']);
    assert.deepEqual(body.overlay.launchComparison?.runtimeOnlyTools, ['SLACK_SEND_MESSAGE']);
    assert.equal(body.overlay.launchComparison?.attentionLevel, 'watch');
    assert.equal(body.overlay.executionEfficiency?.plannedMaxParallelWidth, 1);
    assert.equal(body.overlay.executionEfficiency?.fanoutStepCount, 1);
    assert.equal(body.overlay.executionEfficiency?.attentionLevel, 'failed');
    assert.ok(body.overlay.executionEfficiency?.issues.some((issue) => issue.kind === 'critical_path_blocked' && issue.stepId === 'send'));
    assert.equal(body.overlay.recoveryIntent?.kind, 'safe_rerun');
    assert.equal(body.overlay.recoveryIntent?.sourceRunId, 'prior-run');
    assert.equal(body.overlay.recoveryIntent?.sourceStepId, 'send');
    assert.equal(body.overlay.recoveryIntent?.requestedFrom, 'graph');
    assert.equal(body.overlay.recoveryIntent?.reason, 'graph node safe rerun');
    assert.deepEqual(body.overlay.recoveryLineage.map((entry) => entry.runId), ['prior-run', runId]);
    assert.equal(body.overlay.recoveryLineage[0]?.sourceMissing, true);
    assert.equal(body.overlay.recoveryLineage[1]?.isCurrent, true);
    assert.equal(body.overlay.recoveryLineage[1]?.kind, 'safe_rerun');
    assert.equal(body.overlay.recoveryLineage[1]?.sourceRunId, 'prior-run');
    assert.equal(body.overlay.recoveryLineage[1]?.sourceStepId, 'send');
    assert.equal(body.overlay.goal?.status, 'escalate');
    assert.equal(body.overlay.goal?.reason, 'goal unmet after 3/3 attempts');
    assert.equal(body.overlay.goal?.attempt, 3);
    assert.equal(body.overlay.goal?.maxAttempts, 3);
    assert.equal(body.overlay.goal?.criteriaMet, 1);
    assert.equal(body.overlay.goal?.criteriaTotal, 2);
    assert.deepEqual(body.overlay.goal?.failedCriteria, ['Outbound receipt is missing.']);
    assert.equal(body.overlay.goal?.attempts[0]?.changeSummary, 'run attempt 1: 50% (1/2 criteria met)');
	    const by = Object.fromEntries(body.overlay.steps.map((step) => [step.stepId, step]));
    assert.equal(by['(run goal)'], undefined);
    assert.equal(by.pull.status, 'done');
    assert.equal(by.pull.toolCalls, 1);
    assert.deepEqual(by.pull.launchComparison?.confirmedLaunchTools, ['SALESFORCE_GET_RECORDS']);
    assert.equal(by.pull.launchComparison?.attentionLevel, 'none');
    assert.equal(by.send.status, 'failed');
    assert.deepEqual(by.send.sessionIds, [harnessSession.id]);
    assert.equal(by.send.toolCalls, 1);
    assert.deepEqual(by.send.tools, ['SLACK_SEND_MESSAGE']);
    assert.deepEqual(by.send.launchComparison?.runtimeOnlyTools, ['SLACK_SEND_MESSAGE']);
    assert.equal(by.send.launchComparison?.attentionLevel, 'watch');
    assert.deepEqual(by.send.models, ['claude-opus-4-8']);
    assert.deepEqual(by.send.routes, ['intent:claude']);
    assert.equal(by.send.retries, 1);
    assert.equal(by.send.attempts, 1);
    assert.equal(by.send.itemsFailed, 1);
    assert.equal(by.send.approvalsRequested, 1);
    assert.equal(by.send.workerBranches, 1);
    assert.equal(by.send.externalWrites, 1);
    assert.equal(by.send.advisories, 1);
    assert.equal(by.send.judgeVerdicts, 2);
    assert.equal(by.send.attentionLevel, 'failed');
    assert.ok(by.send.attentionReasons.includes('failed: temporary send failure'));
    assert.ok(by.send.attentionReasons.includes('1 failed item'));
    assert.equal(by.send.bottleneck, 'failed step');
    assert.ok(by.send.riskSignals.includes('1 external write'));
    assert.equal(by.send.executionEfficiency?.plannedCritical, true);
    assert.equal(by.send.executionEfficiency?.plannedFanoutConcurrency, 5);
    assert.ok(by.send.executionEfficiency?.issueKinds.includes('critical_path_blocked'));
    assert.equal(by.send.executionEfficiency?.attentionLevel, 'failed');
    assert.equal(by.summary.status, 'pending');
  } finally {
    await h.close();
  }
});

test('GET /api/console/workflows/:name/runs/:runId/graph-overlay includes goal attempt lineage across requeued runs', async () => {
  const workflowSlug = 'goal-lineage-flow';
  const workflowName = 'Goal Lineage Flow';
  const firstRunId = 'goal-lineage-1';
  const secondRunId = 'goal-lineage-2';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'goal lineage overlay test',
    enabled: true,
    trigger: { manual: true },
    goal: {
      objective: 'Deliver a complete report.',
      successCriteria: ['Report includes receipt.', 'Report includes summary.'],
      maxAttempts: 3,
    },
    steps: [{ id: 'draft', prompt: 'Draft report.' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${firstRunId}.json`), JSON.stringify({
    id: firstRunId,
    workflow: workflowName,
    status: 'completed',
    createdAt: '2026-07-05T12:00:00.000Z',
    finishedAt: '2026-07-05T12:01:00.000Z',
  }, null, 2), 'utf-8');
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${secondRunId}.json`), JSON.stringify({
    id: secondRunId,
    workflow: workflowName,
    status: 'queued',
    createdAt: '2026-07-05T12:02:00.000Z',
    requeuedFromRunId: firstRunId,
    goalAttempt: 1,
    goalFeedback: '- UNMET: Report includes receipt.',
  }, null, 2), 'utf-8');
  appendWorkflowEvent(workflowSlug, firstRunId, { kind: 'run_started' });
  appendWorkflowEvent(workflowSlug, firstRunId, { kind: 'step_started', stepId: 'draft' });
  appendWorkflowEvent(workflowSlug, firstRunId, { kind: 'step_completed', stepId: 'draft', output: 'summary only' });
  appendWorkflowEvent(workflowSlug, firstRunId, {
    kind: 'attempt_record',
    attempt: {
      attemptIndex: 1,
      maxAttempts: 3,
      failedProblems: ['Report includes receipt.'],
      changeSummary: 'run attempt 1: 50% (1/2 criteria met)',
      metrics: { tokens: 300 },
    },
  });
  appendWorkflowEvent(workflowSlug, firstRunId, {
    kind: 'step_advisory',
    stepId: '(run goal)',
    meta: {
      goal: 'repursue',
      reason: 'goal unmet (attempt 1/3)',
      attempt: 1,
      max: 3,
      successRatePercent: 50,
      criteriaMet: 1,
      criteriaTotal: 2,
      failedCriteria: ['Report includes receipt.'],
      requeueRunId: secondRunId,
      feedbackPreview: '- UNMET: Report includes receipt.',
    },
  });
  appendWorkflowEvent(workflowSlug, firstRunId, { kind: 'run_completed' });

  const h = await boot();
  try {
    const first = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/runs/${firstRunId}/graph-overlay`);
    assert.equal(first.status, 200);
    const firstBody = await first.json() as {
      overlay: {
        goal: {
          status: string;
          requeueRunId?: string;
          lineage?: Array<{ runId: string; sourceRunId?: string; isCurrent: boolean; goalStatus: string | null; attempt?: number; successRatePercent?: number }>;
        } | null;
      };
    };
    assert.equal(firstBody.overlay.goal?.status, 'repursue');
    assert.equal(firstBody.overlay.goal?.requeueRunId, secondRunId);
    assert.deepEqual(firstBody.overlay.goal?.lineage?.map((entry) => entry.runId), [firstRunId, secondRunId]);
    assert.equal(firstBody.overlay.goal?.lineage?.[0]?.isCurrent, true);
    assert.equal(firstBody.overlay.goal?.lineage?.[0]?.goalStatus, 'repursue');
    assert.equal(firstBody.overlay.goal?.lineage?.[0]?.successRatePercent, 50);
    assert.equal(firstBody.overlay.goal?.lineage?.[1]?.sourceRunId, firstRunId);
    assert.equal(firstBody.overlay.goal?.lineage?.[1]?.attempt, 2);

    const second = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/runs/${secondRunId}/graph-overlay`);
    assert.equal(second.status, 200);
    const secondBody = await second.json() as {
      overlay: { goal: { status: string; lineage?: Array<{ runId: string; isCurrent: boolean; attempt?: number }> } | null };
    };
    assert.equal(secondBody.overlay.goal?.status, 'unknown');
    assert.deepEqual(secondBody.overlay.goal?.lineage?.map((entry) => entry.runId), [firstRunId, secondRunId]);
    assert.equal(secondBody.overlay.goal?.lineage?.[1]?.isCurrent, true);
    assert.equal(secondBody.overlay.goal?.lineage?.[1]?.attempt, 2);
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

test('board workflow resume-safe requeues whole runs but refuses failed fan-out items', async () => {
  const workflowSlug = 'board-resume-safe';
  const workflowName = 'Board Resume Safe';
  const runId = 'board-resume-safe-run';
  const failedRunId = 'board-resume-safe-failed-items';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'resume safe route test',
    enabled: true,
    trigger: { manual: true },
    inputs: { leadId: { type: 'string' } },
    steps: [
      { id: 'pull', prompt: 'Pull records.' },
      { id: 'send', prompt: 'Send each.', dependsOn: ['pull'], forEach: 'pull' },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'failed',
    inputs: { leadId: 'lead-1' },
    createdAt: '2026-07-05T11:00:00.000Z',
  }, null, 2), 'utf-8');
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${failedRunId}.json`), JSON.stringify({
    id: failedRunId,
    workflow: workflowName,
    status: 'completed_with_errors',
    inputs: { leadId: 'lead-2' },
    createdAt: '2026-07-05T11:05:00.000Z',
  }, null, 2), 'utf-8');
  appendWorkflowEvent(workflowSlug, failedRunId, { kind: 'item_failed', stepId: 'send', itemKey: 'a', error: 'send failed' });

  const h = await boot();
  try {
    const resume = await fetch(`${h.url}/api/console/board/workflow/${encodeURIComponent(workflowSlug)}/runs/${runId}/resume-safe`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        stepId: 'send',
        recoveryIntent: {
          kind: 'execution_optimize',
          requestedFrom: 'graph_execution_drift',
          reason: 'graph execution optimization rerun: critical_path_blocked',
        },
      }),
    });
    assert.equal(resume.status, 200);
    const body = await resume.json() as { ok: boolean; status: string; id?: string };
    assert.equal(body.ok, true);
    assert.equal(body.status, 'queued');
    assert.ok(body.id, 'safe re-run id returned');
    const queued = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${body.id}.json`), 'utf-8')) as Record<string, unknown>;
    assert.equal(queued.workflow, workflowName);
    assert.deepEqual(queued.inputs, { leadId: 'lead-1' });
    assert.deepEqual(queued.recoveryIntent, {
      kind: 'execution_optimize',
      createdAt: queued.createdAt,
      sourceRunId: runId,
      sourceStepId: 'send',
      requestedFrom: 'graph_execution_drift',
      reason: 'graph execution optimization rerun: critical_path_blocked',
    });

    const blocked = await fetch(`${h.url}/api/console/board/workflow/${encodeURIComponent(workflowSlug)}/runs/${failedRunId}/resume-safe`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    assert.equal(blocked.status, 409);
    const blockedBody = await blocked.json() as { ok: boolean; reason: string; failedItems: Array<{ itemKey: string }> };
    assert.equal(blockedBody.ok, false);
    assert.match(blockedBody.reason, /retry failed items only/i);
    assert.deepEqual(blockedBody.failedItems.map((item) => item.itemKey), ['a']);
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

    const retry = await fetch(`${h.url}/api/console/workflows/${encodeURIComponent(workflowName)}/runs/${runId}/retry-failed-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stepId: 'send',
        recoveryIntent: {
          requestedFrom: 'graph',
          reason: 'graph node retry failed forEach items',
        },
      }),
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
    assert.deepEqual(queued.recoveryIntent, {
      kind: 'failed_items',
      createdAt: queued.createdAt,
      sourceRunId: runId,
      sourceStepId: 'send',
      requestedFrom: 'graph',
      reason: 'graph node retry failed forEach items',
    });
  } finally {
    await h.close();
  }
});

test('U1: a finished origin-chat attempt collapses into its background task card — one pipeline, one card', async () => {
  const { createSession, beginRunAttempt, finishRunAttempt } = await import('../runtime/harness/eventlog.js');
  // Origin chat session with a FINISHED attempt (the handoff turn)…
  createSession({ id: 'sess-origin-collapse', kind: 'chat', title: 'origin chat' });
  const att = beginRunAttempt('sess-origin-collapse', { runId: 'run-origin-1' });
  finishRunAttempt(att, 'completed');
  // …whose pipeline continued as a background task.
  const task = createBackgroundTask({ title: 'collapse pipeline task', prompt: 'p', originSessionId: 'sess-origin-collapse' });
  markBackgroundTaskRunning(task.id);
  // Control: a finished attempt on an UNRELATED session stays on the board.
  createSession({ id: 'sess-unrelated-chat', kind: 'chat', title: 'unrelated chat' });
  const att2 = beginRunAttempt('sess-unrelated-chat', { runId: 'run-unrelated-1' });
  finishRunAttempt(att2, 'completed');

  const { url, close } = await boot();
  try {
    const res = await fetch(`${url}/api/console/board`);
    const body = await res.json() as { cards: Array<{ id: string; sourceKind?: string; sessionId?: string }> };
    const ids = body.cards.map((c) => c.id);
    assert.ok(ids.includes(task.id), 'the background task card is present');
    assert.ok(!ids.includes(`harness:${att.attemptId}`), 'the finished origin attempt card is collapsed into the task');
    assert.ok(ids.includes(`harness:${att2.attemptId}`), 'an unrelated finished attempt still shows');
  } finally {
    await close();
  }
});
