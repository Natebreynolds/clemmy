/**
 * Run: npx tsx --test src/dashboard/console-task-approval-settlement.test.ts
 *
 * Regression for the live 2026-08-04 desktop approval dead-end: a background
 * task spawned from a chat session parked awaiting approval, and every verbal
 * decision typed into that chat ("Approved", "approve apr-xxxx") fell through
 * to a fresh model turn — the session-scoped registry could not see the task
 * session's card, so six approvals in a row applied nothing. The chat route
 * must settle a spawned task's approval deterministically, exactly like the
 * Tasks-board button: queue the durable continuation, reply with what was
 * decided, and never wake the brain for it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-task-approval-settle-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
process.env.CLEMMY_DEBATE_MODE = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'claude-auth.json'), JSON.stringify({
  accessToken: 'sk-ant-oat01-route-test-token',
  refreshToken: 'route-test-refresh',
  expiresAt: Date.now() + 60 * 60 * 1000,
  scopes: ['user:inference'],
}), 'utf-8');

const { registerConsoleRoutes } = await import('./console-routes.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const { resetHarnessRuntimeConfig } = await import('../runtime/harness/codex-client.js');
const { createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const {
  createBackgroundTask,
  getBackgroundTask,
  markBackgroundTaskRunning,
  markBackgroundTaskAwaitingApproval,
} = await import('../execution/background-tasks.js');

let brainCalls = 0;
_setBridgeImplsForTests({
  configure: (async () => ({ ok: true })) as never,
  claudeAgentBrain: (async () => {
    brainCalls += 1;
    return { text: 'brain must not run for a deterministic settlement', sessionId: 'none', stoppedReason: 'success' };
  }) as never,
});

after(() => {
  _setBridgeImplsForTests({});
  resetHarnessRuntimeConfig();
  resetEventLog();
  delete process.env.AUTH_MODE;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  delete process.env.CLEMMY_DEBATE_MODE;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  const assistant = {
    respond: async () => { throw new Error('legacy assistant must not run'); },
    getRuntime: () => ({ listPendingApprovals: () => [] }),
  };
  registerConsoleRoutes(app, () => true, assistant as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function parkedTask(originSessionId: string, approvalId: string, title: string): string {
  const task = createBackgroundTask({
    title,
    prompt: 'draft outreach for the eligible accounts',
    originSessionId,
    source: 'desktop',
    channel: 'desktop',
  });
  markBackgroundTaskRunning(task.id);
  markBackgroundTaskAwaitingApproval(task.id, approvalId, 'Awaiting approval to research contacts.');
  const parked = getBackgroundTask(task.id);
  assert.equal(parked?.status, 'awaiting_approval', 'fixture failed to park the task');
  assert.equal(parked?.pendingApprovalId, approvalId);
  return task.id;
}

async function waitForTaskStatus(taskId: string, status: string, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (getBackgroundTask(taskId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(getBackgroundTask(taskId)?.status, status, `task never reached ${status}`);
}

test('a bare "Approved" typed in the origin chat queues the parked task continuation, no brain turn', async () => {
  resetEventLog();
  brainCalls = 0;
  const sess = createSession({ kind: 'chat' });
  const taskId = parkedTask(sess.id, 'apr-jz0h', 'CRM draft cleanup');
  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Approved', sessionId: sess.id, clientRequestId: 'settle-bare-1' }),
    });
    assert.equal(response.status, 202);
    await waitForTaskStatus(taskId, 'pending');
    const task = getBackgroundTask(taskId)!;
    assert.equal(task.approvalResolution?.approved, true, 'the durable continuation was not queued');
    assert.equal(task.approvalResolution?.approvalId, 'apr-jz0h');
    assert.equal(brainCalls, 0, 'a deterministic settlement woke the brain');
  } finally {
    await harness.close();
  }
});

test('an explicit "approve apr-xxxx" reaches the task even mid-conversation and rejection stands down', async () => {
  resetEventLog();
  brainCalls = 0;
  const sess = createSession({ kind: 'chat' });
  const taskId = parkedTask(sess.id, 'apr-kmaw', 'Oxendine draft removal');
  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'reject apr-kmaw', sessionId: sess.id, clientRequestId: 'settle-explicit-1' }),
    });
    assert.equal(response.status, 202);
    await waitForTaskStatus(taskId, 'pending');
    assert.equal(getBackgroundTask(taskId)!.approvalResolution?.approved, false);
    assert.equal(brainCalls, 0);
  } finally {
    await harness.close();
  }
});

test('two parked tasks and a bare decision asks for the exact card instead of guessing', async () => {
  resetEventLog();
  brainCalls = 0;
  const sess = createSession({ kind: 'chat' });
  const taskA = parkedTask(sess.id, 'apr-aaaa', 'Draft sweep A');
  const taskB = parkedTask(sess.id, 'apr-bbbb', 'Draft sweep B');
  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Approved', sessionId: sess.id, clientRequestId: 'settle-ambiguous-1' }),
    });
    assert.equal(response.status, 202);
    // Give the executor time to settle, then assert NEITHER task moved.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(getBackgroundTask(taskA)?.status, 'awaiting_approval', 'ambiguity guessed task A');
    assert.equal(getBackgroundTask(taskB)?.status, 'awaiting_approval', 'ambiguity guessed task B');
    assert.equal(brainCalls, 0, 'ambiguity should ask deterministically, not wake the brain');
  } finally {
    await harness.close();
  }
});
