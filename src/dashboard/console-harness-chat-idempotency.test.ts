/**
 * Run: npx tsx --test src/dashboard/console-harness-chat-idempotency.test.ts
 *
 * Regression for a lost-202 / daemon-restart replay: the desktop client owns
 * one request id before POST, the route persists its session+run before 202,
 * and every replay rejoins that run instead of scheduling another brain loop.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-chat-idempotency-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
process.env.CLEMMY_CONFIRM_BEAT = 'off';
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
const {
  claimHarnessChatRequest,
  claimRunAttemptLease,
  beginRunAttempt,
  createSession,
  finishRunAttempt,
  getSession,
  getActiveRunAttempt,
  getHarnessChatCancellation,
  getHarnessChatRequestReceipt,
  getLatestRunAttemptByRunId,
  isKillRequested,
  listEvents,
  recordRunAttemptUserInput,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { getBackgroundTask, listBackgroundTasks } = await import('../execution/background-tasks.js');
const { getRun, startRun } = await import('../runtime/run-events.js');

after(() => {
  _setBridgeImplsForTests({});
  resetHarnessRuntimeConfig();
  resetEventLog();
  delete process.env.AUTH_MODE;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  delete process.env.CLEMMY_CONFIRM_BEAT;
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

test('Stop before chat acceptance persists a tombstone and the request can never execute later', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  let brainCalls = 0;
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async () => {
      brainCalls += 1;
      return { text: 'must not run', sessionId: 'none', stoppedReason: 'success' };
    }) as never,
  });
  const harness = await boot();
  const clientRequestId = 'desktop-request-cancel-before-acceptance';
  try {
    const cancelled = await fetch(`${harness.url}/api/harness/chat/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientRequestId }),
    });
    assert.equal(cancelled.status, 200);
    const cancellationBody = await cancelled.json() as {
      ok: boolean;
      clientRequestId: string;
      pendingAcceptance: boolean;
    };
    assert.equal(cancellationBody.ok, true);
    assert.equal(cancellationBody.clientRequestId, clientRequestId);
    assert.equal(cancellationBody.pendingAcceptance, true);
    assert.equal(getHarnessChatCancellation(clientRequestId)?.requestId, clientRequestId);

    const latePost = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Create the document.', clientRequestId }),
    });
    assert.equal(latePost.status, 409);
    assert.equal((await latePost.json() as { code?: string }).code, 'CHAT_REQUEST_CANCELLED');
    assert.equal(getHarnessChatRequestReceipt(clientRequestId), null);
    assert.equal(brainCalls, 0);
  } finally {
    await harness.close();
  }
});

test('pre-ack Stop finds and kills the exact attempt when acceptance won the SQLite race', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  let enterBrain!: () => void;
  let releaseBrain!: () => void;
  const brainEntered = new Promise<void>((resolve) => { enterBrain = resolve; });
  const brainReleased = new Promise<void>((resolve) => { releaseBrain = resolve; });
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async (_surface: string, request: { sessionId: string }) => {
      enterBrain();
      await brainReleased;
      return { text: 'Stopped.', sessionId: request.sessionId, stoppedReason: 'cancelled' };
    }) as never,
  });
  const harness = await boot();
  const clientRequestId = 'desktop-request-accepted-before-cancel';
  try {
    const accepted = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Research the firm and create the document.', clientRequestId }),
    });
    assert.equal(accepted.status, 202);
    await brainEntered;
    const receipt = getHarnessChatRequestReceipt(clientRequestId);
    assert.ok(receipt);
    const attempt = getLatestRunAttemptByRunId(receipt!.sessionId, receipt!.runId);
    assert.ok(attempt);

    const stopped = await fetch(`${harness.url}/api/harness/chat/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientRequestId }),
    });
    assert.equal(stopped.status, 200);
    const stoppedBody = await stopped.json() as {
      sessionId: string;
      runId: string;
      attemptId: string;
      runScopeId: string;
    };
    assert.equal(stoppedBody.sessionId, receipt!.sessionId);
    assert.equal(stoppedBody.runId, receipt!.runId);
    assert.equal(stoppedBody.attemptId, attempt!.attemptId);
    assert.equal(stoppedBody.runScopeId, runScopeId(receipt!.sessionId, attempt!));
    assert.equal(isKillRequested(receipt!.sessionId, attempt!), true);

    releaseBrain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(getLatestRunAttemptByRunId(receipt!.sessionId, receipt!.runId)?.status, 'cancelled');
  } finally {
    releaseBrain?.();
    await harness.close();
  }
});

test('desktop chat replay reuses the pre-202 session/run and schedules the brain once', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  const capturedRunIds: string[] = [];
  let enterBrain!: () => void;
  let releaseBrain!: () => void;
  const brainEntered = new Promise<void>((resolve) => { enterBrain = resolve; });
  const brainReleased = new Promise<void>((resolve) => { releaseBrain = resolve; });
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async (_surface: string, request: { sessionId: string; runId?: string }) => {
      capturedRunIds.push(request.runId ?? '');
      enterBrain();
      await brainReleased;
      return { text: 'Current status ready.', sessionId: request.sessionId, stoppedReason: 'success' };
    }) as never,
  });

  const harness = await boot();
  const clientRequestId = 'desktop-request-replay-0001';
  const requestBody = { input: 'Tell me the current status.', clientRequestId };
  try {
    const firstResponse = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    assert.equal(firstResponse.status, 202);
    const first = await firstResponse.json() as {
      sessionId: string;
      runId: string;
      clientRequestId: string;
      sinceSeq: number;
      replayed: boolean;
      attemptId: string;
      runScopeId: string;
      cancelEndpoint: string;
      backgroundEndpoint: string;
    };
    assert.equal(first.clientRequestId, clientRequestId);
    assert.equal(first.replayed, false);
    const activeAttempt = getActiveRunAttempt(first.sessionId);
    assert.equal(activeAttempt?.runId, first.runId, 'attempt is durable before the 202 is consumed');
    assert.equal(first.attemptId, activeAttempt?.attemptId);
    assert.equal(first.runScopeId, activeAttempt ? runScopeId(first.sessionId, activeAttempt) : '');
    assert.equal(
      first.cancelEndpoint,
      activeAttempt ? attemptCancelUrl('', first.sessionId, activeAttempt) : '',
      'the 202 gives the chat client an exact-attempt Stop endpoint',
    );
    assert.equal(
      first.backgroundEndpoint,
      activeAttempt ? attemptBackgroundUrl('', first.sessionId, activeAttempt) : '',
      'the 202 gives the chat client an exact-attempt background endpoint',
    );
    const acceptedInputs = listEvents(first.sessionId, { types: ['user_input_received'] });
    assert.equal(acceptedInputs.length, 1, 'the accepted turn is durable before any early-return branch or brain work');
    assert.equal(acceptedInputs[0].data.runId, first.runId);
    assert.equal(acceptedInputs[0].data.attemptId, activeAttempt?.attemptId);
    assert.equal(
      getLatestRunAttemptByRunId(first.sessionId, first.runId)?.sourceUserSeq,
      acceptedInputs[0].seq,
      'the attempt is bound to the exact accepted user event',
    );

    await brainEntered;
    const replayResponse = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientRequestId },
      body: JSON.stringify({ input: requestBody.input }),
    });
    assert.equal(replayResponse.status, 202);
    const replay = await replayResponse.json() as typeof first;
    assert.equal(replay.sessionId, first.sessionId, 'lost first response can recover the server-created session');
    assert.equal(replay.runId, first.runId);
    assert.equal(replay.attemptId, first.attemptId);
    assert.equal(replay.cancelEndpoint, first.cancelEndpoint);
    assert.equal(replay.backgroundEndpoint, first.backgroundEndpoint);
    assert.equal(replay.sinceSeq, first.sinceSeq, 'replay rejoins the original SSE cursor');
    assert.equal(replay.replayed, true);
    assert.deepEqual(capturedRunIds, [first.runId], 'active replay never schedules a second brain loop');

    releaseBrain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(getLatestRunAttemptByRunId(first.sessionId, first.runId)?.status, 'completed');

    const completedReplayResponse = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    assert.equal(completedReplayResponse.status, 202);
    const completedReplay = await completedReplayResponse.json() as typeof first;
    assert.equal(completedReplay.runId, first.runId);
    assert.equal(completedReplay.replayed, true);
    assert.deepEqual(capturedRunIds, [first.runId], 'completed replay is also side-effect free');
    assert.equal(listEvents(first.sessionId, { types: ['user_input_received'] }).length, 1, 'replay never duplicates the user turn');
    assert.equal(getHarnessChatRequestReceipt(clientRequestId)?.runId, first.runId);

    const conflict = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Do something different.', clientRequestId }),
    });
    assert.equal(conflict.status, 409, 'one id cannot be rebound to different work');
  } finally {
    releaseBrain?.();
    await harness.close();
  }
});

test('route startup interrupts a prior-process lease and replay resumes the same durable run', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  const clientRequestId = 'desktop-request-crash-replay-0002';
  const input = 'What is the current status?';
  const session = createSession({ id: 'sess-crash-replay', kind: 'chat', channel: 'desktop' });
  const runId = 'desktop:crash-replay-stable-run';
  claimHarnessChatRequest({
    requestId: clientRequestId,
    sessionId: session.id,
    runId,
    inputHash: createHash('sha256').update(JSON.stringify({ input, attachmentIds: [] })).digest('hex'),
    sinceSeq: 0,
  });
  const abandoned = claimRunAttemptLease({
    sessionId: session.id,
    runId,
    ownerId: 'dead-daemon-process',
    leaseMs: 60_000,
  });
  assert.equal(abandoned.claimed, true);

  const capturedRunIds: string[] = [];
  let brainEntered!: () => void;
  const entered = new Promise<void>((resolve) => { brainEntered = resolve; });
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async (_surface: string, request: { sessionId: string; runId?: string }) => {
      capturedRunIds.push(request.runId ?? '');
      brainEntered();
      return { text: 'Recovered.', sessionId: request.sessionId, stoppedReason: 'success' };
    }) as never,
  });

  // registerConsoleRoutes represents daemon startup and immediately retires
  // the foreign-owner attempt before the browser needs to wait for its TTL.
  const harness = await boot();
  try {
    assert.equal(
      getLatestRunAttemptByRunId(session.id, runId)?.status,
      'interrupted',
      'startup identifies the old process owner as abandoned',
    );
    const response = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, clientRequestId }),
    });
    assert.equal(response.status, 202);
    const replay = await response.json() as { sessionId: string; runId: string; replayed: boolean };
    assert.equal(replay.sessionId, session.id);
    assert.equal(replay.runId, runId);
    assert.equal(replay.replayed, true);
    await entered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(capturedRunIds, [runId], 'crash replay schedules exactly one replacement executor');
    assert.equal(getLatestRunAttemptByRunId(session.id, runId)?.status, 'completed');
    assert.notEqual(
      getLatestRunAttemptByRunId(session.id, runId)?.attemptId,
      abandoned.attempt?.attemptId,
      'historical abandoned attempt is never reopened in place',
    );
  } finally {
    await harness.close();
  }
});

function runScopeId(
  sessionId: string,
  attempt: { attemptId: string; runId: string | null },
): string {
  return `${sessionId}::brain:${attempt.runId ?? attempt.attemptId}`;
}

function attemptCancelUrl(
  baseUrl: string,
  sessionId: string,
  attempt: { attemptId: string; runId: string | null },
): string {
  const query = new URLSearchParams({
    attemptId: attempt.attemptId,
    runScopeId: runScopeId(sessionId, attempt),
  });
  return `${baseUrl}/api/console/harness-sessions/${encodeURIComponent(sessionId)}/cancel?${query}`;
}

function attemptBackgroundUrl(
  baseUrl: string,
  sessionId: string,
  attempt: { attemptId: string; runId: string | null },
): string {
  const query = new URLSearchParams({
    attemptId: attempt.attemptId,
    runScopeId: runScopeId(sessionId, attempt),
  });
  return `${baseUrl}/api/console/harness-sessions/${encodeURIComponent(sessionId)}/background?${query}`;
}

test('Move to background requires exact attempt ownership and replays one durable handoff', async () => {
  resetEventLog();
  const harness = await boot();
  try {
    const session = createSession({ id: 'sess-route-background-once', kind: 'chat', channel: 'desktop' });
    const attemptA = beginRunAttempt(session.id, { runId: 'desktop:background-a' });
    recordRunAttemptUserInput(attemptA, {
      turn: 0,
      role: 'user',
      data: { text: 'prepare the first client brief' },
    });
    finishRunAttempt(attemptA, 'completed');
    const attemptB = beginRunAttempt(session.id, { runId: 'desktop:background-b' });
    recordRunAttemptUserInput(attemptB, {
      turn: 1,
      role: 'user',
      data: { text: 'prepare the second client brief' },
    });
    const before = listBackgroundTasks({ includeArchived: true }).length;

    const missing = await fetch(
      `${harness.url}/api/console/harness-sessions/${encodeURIComponent(session.id)}/background`,
      { method: 'POST' },
    );
    assert.equal(missing.status, 400);

    const stale = await fetch(attemptBackgroundUrl(harness.url, session.id, attemptA), { method: 'POST' });
    assert.equal(stale.status, 409);
    assert.equal(getActiveRunAttempt(session.id)?.attemptId, attemptB.attemptId);
    assert.equal(isKillRequested(session.id, attemptB), false, 'stale A never stops B');
    assert.equal(listBackgroundTasks({ includeArchived: true }).length, before);

    const accepted = await fetch(attemptBackgroundUrl(harness.url, session.id, attemptB), { method: 'POST' });
    assert.equal(accepted.status, 200);
    const first = await accepted.json() as { taskId: string; attemptId: string; replayed: boolean };
    assert.equal(first.attemptId, attemptB.attemptId);
    assert.equal(first.replayed, false);
    assert.equal(isKillRequested(session.id, attemptB), true);
    assert.equal(getBackgroundTask(first.taskId)?.foregroundHandoff?.attemptId, attemptB.attemptId);

    const replayResponse = await fetch(attemptBackgroundUrl(harness.url, session.id, attemptB), { method: 'POST' });
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json() as typeof first;
    assert.equal(replay.replayed, true);
    assert.equal(replay.taskId, first.taskId);
    assert.equal(listBackgroundTasks({ includeArchived: true }).length, before + 1);
  } finally {
    await harness.close();
  }
});

test('Tasks-board run cancellation never widens a stale run card into a newer session attempt', async () => {
  resetEventLog();
  const harness = await boot();
  try {
    const session = createSession({ id: 'sess-board-exact-cancel', kind: 'chat', channel: 'desktop' });
    const runA = startRun({
      id: 'run-board-stale-a',
      sessionId: session.id,
      source: 'desktop',
      message: 'old card work',
    });
    const attemptA = beginRunAttempt(session.id, { runId: runA.id });
    finishRunAttempt(attemptA, 'completed');
    const attemptB = beginRunAttempt(session.id, { runId: 'run-board-newer-b' });

    const stale = await fetch(`${harness.url}/api/console/board/run/${encodeURIComponent(runA.id)}/cancel`, { method: 'POST' });
    assert.equal(stale.status, 409);
    assert.equal(isKillRequested(session.id, attemptB), false, 'newer B is untouched');
    assert.equal(getRun(runA.id)?.status, 'running', 'stale card is left for authoritative reconciliation');

    const runC = startRun({
      id: 'run-board-exact-c',
      sessionId: session.id,
      source: 'desktop',
      message: 'current owned work',
    });
    finishRunAttempt(attemptB, 'superseded');
    const attemptC = beginRunAttempt(session.id, { runId: runC.id });
    const exact = await fetch(`${harness.url}/api/console/board/run/${encodeURIComponent(runC.id)}/cancel`, { method: 'POST' });
    assert.equal(exact.status, 200);
    assert.equal(isKillRequested(session.id, attemptC), true);
    assert.equal(getRun(runC.id)?.status, 'cancelled');
  } finally {
    await harness.close();
  }
});

test('stale Stop for finished attempt A leaves the newer retry attempt B alive', async () => {
  resetEventLog();
  const harness = await boot();
  try {
    const session = createSession({ id: 'sess-route-stale-stop', kind: 'chat', channel: 'desktop' });
    const attemptA = beginRunAttempt(session.id, { runId: 'desktop:same-logical-run' });
    finishRunAttempt(attemptA, 'completed');
    const attemptB = beginRunAttempt(session.id, { runId: 'desktop:same-logical-run' });
    assert.notEqual(attemptB.attemptId, attemptA.attemptId, 'a retry has a fresh attempt identity');
    assert.equal(
      runScopeId(session.id, attemptB),
      runScopeId(session.id, attemptA),
      'run scope alone cannot distinguish retries, so attemptId must be required',
    );

    const response = await fetch(attemptCancelUrl(harness.url, session.id, attemptA), { method: 'POST' });
    assert.equal(response.status, 409);
    const body = await response.json() as { code?: string; currentAttemptId?: string };
    assert.equal(body.code, 'STALE_RUN_ATTEMPT');
    assert.equal(body.currentAttemptId, attemptB.attemptId);
    assert.equal(getActiveRunAttempt(session.id)?.attemptId, attemptB.attemptId);
    assert.equal(isKillRequested(session.id, attemptB), false, 'stale Stop cannot latch the newer attempt');
    assert.equal(getSession(session.id)?.status, 'active');
  } finally {
    await harness.close();
  }
});

test('Stop for an already-terminal attempt returns 409 without creating a kill latch', async () => {
  resetEventLog();
  const harness = await boot();
  try {
    const session = createSession({ id: 'sess-route-terminal-stop', kind: 'chat', channel: 'desktop' });
    const attempt = beginRunAttempt(session.id, { runId: 'desktop:terminal-stop' });
    finishRunAttempt(attempt, 'completed');

    const response = await fetch(attemptCancelUrl(harness.url, session.id, attempt), { method: 'POST' });
    assert.equal(response.status, 409);
    const body = await response.json() as { code?: string; currentAttemptId?: string | null };
    assert.equal(body.code, 'STALE_RUN_ATTEMPT');
    assert.equal(body.currentAttemptId, null);
    assert.equal(isKillRequested(session.id, attempt), false);
    assert.equal(getSession(session.id)?.status, 'active', 'Stop never rewrites the reusable session status');
  } finally {
    await harness.close();
  }
});

test('desktop Stop requires and latches only the exact active attempt', async () => {
  resetEventLog();
  const harness = await boot();
  try {
    const session = createSession({ id: 'sess-route-cancel-once', kind: 'chat', channel: 'desktop' });
    const attempt = beginRunAttempt(session.id, { runId: 'desktop:cancel-once' });
    const unrelatedSession = createSession({ id: 'sess-route-cancel-unrelated', kind: 'chat', channel: 'desktop' });
    const unrelatedAttempt = beginRunAttempt(unrelatedSession.id, { runId: 'desktop:unrelated' });

    const missingIdentity = await fetch(
      `${harness.url}/api/console/harness-sessions/${encodeURIComponent(session.id)}/cancel`,
      { method: 'POST' },
    );
    assert.equal(missingIdentity.status, 400);
    assert.equal(isKillRequested(session.id, attempt), false);

    const response = await fetch(
      `${harness.url}/api/console/harness-sessions/${encodeURIComponent(session.id)}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attemptId: attempt.attemptId,
          runScopeId: runScopeId(session.id, attempt),
        }),
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as {
      attemptId?: string;
      runScopeId?: string;
      cancelledTasks?: number;
    };
    assert.equal(body.attemptId, attempt.attemptId);
    assert.equal(body.runScopeId, runScopeId(session.id, attempt));
    assert.equal(body.cancelledTasks, 0, 'harness Stop never cascades to background tasks');
    assert.equal(isKillRequested(session.id, attempt), true);
    assert.equal(isKillRequested(unrelatedSession.id, unrelatedAttempt), false);
    assert.equal(getSession(session.id)?.status, 'active', 'the reusable chat is not globally cancelled');
    assert.equal(
      listEvents(session.id, { types: ['conversation_completed'] }).length,
      0,
      'the route must not race the executor with a second terminal event',
    );
    assert.equal(
      listEvents(session.id, { types: ['run_resumed'] }).length,
      0,
      'clearing parked state during Stop must not emit a false resume',
    );
  } finally {
    await harness.close();
  }
});

test('conversation reply while ONE background task is parked routes as its answer — no model turn, no duplicate task', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  let brainCalls = 0;
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async () => {
      brainCalls += 1;
      return { text: 'model must not run for a parked-task answer', sessionId: 'none', stoppedReason: 'success' };
    }) as never,
  });
  const { createBackgroundTask, markBackgroundTaskAwaitingInput } = await import('../execution/background-tasks.js');
  const harness = await boot();
  try {
    const session = createSession({ id: 'sess-desktop-bridge-answer', kind: 'chat' });
    const task = createBackgroundTask({
      title: 'Pipeline needing a workspace id',
      prompt: 'Build the Airtable base.',
      originSessionId: session.id,
    });
    markBackgroundTaskAwaitingInput(task.id, 'q-workspace-1', 'Which Airtable workspace should I use?');

    const res = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Use workspace wspTEST123 please.',
        sessionId: session.id,
        clientRequestId: 'bridge-answer-request-1',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string; routedToBackgroundTask?: string; reply?: string };
    assert.equal(body.routedToBackgroundTask, task.id, 'the reply routed to the parked task, not the model');
    assert.match(body.reply ?? '', /Answer sent to .+ resuming now/i);
    assert.equal(brainCalls, 0, 'no orchestrator turn ran (the improvise-then-duplicate path is closed)');

    const resumed = getBackgroundTask(task.id);
    assert.equal(resumed?.status, 'pending', 'the task left awaiting_input and queued its continuation');
    assert.equal(resumed?.inputResolution?.answer, 'Use workspace wspTEST123 please.');
    assert.equal(
      listBackgroundTasks().filter((t) => t.originSessionId === session.id).length,
      1,
      'no duplicate task was created for this conversation',
    );

    // The conversation renders the round-trip: the user's answer + the ack.
    const events = listEvents(session.id);
    assert.ok(events.some((e) => e.type === 'user_input_received' && String((e.data as { text?: string }).text).includes('wspTEST123')));
    assert.ok(events.some((e) => e.type === 'conversation_completed'));
  } finally {
    await harness.close();
  }
});
