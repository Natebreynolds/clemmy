import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import express from 'express';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-console-approval-stop-'));
Object.assign(process.env, { CLEMENTINE_HOME: fixtureHome, AUTH_MODE: 'claude_oauth',
  CLEMMY_CLAUDE_AGENT_SDK_BRAIN: 'read_only', CLEMMY_DEBATE_MODE: 'off', MCP_AUTO_IMPORT_ENABLED: 'false' });
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(fixtureHome, 'state', 'claude-auth.json'), JSON.stringify({ accessToken: 'sk-ant-oat01-route-fixture-token',
  refreshToken: 'route-fixture-refresh', expiresAt: Date.now() + 3600000, scopes: ['user:inference'] }));
const { registerConsoleRoutes } = await import('./console-routes.js');
const events = await import('../runtime/harness/eventlog.js');
const registry = await import('../runtime/harness/approval-registry.js');
const pending = await import('../runtime/harness/pending-actions.js');
const { pendingActionApprovalView } = await import('../runtime/harness/pending-action-view.js');
const resumes = await import('../runtime/harness/chat-approval-resume.js');
const { _setApprovedCallDispatchForTests } = await import('../execution/pending-action-executor.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const { currentToolAbortSignal } = await import('../runtime/tool-abort-context.js');
const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
const { HarnessSession } = await import('../runtime/harness/session.js');

after(() => { _setApprovedCallDispatchForTests(null); _setBridgeImplsForTests({});
  resumes._resetChatApprovalResumeForTest(); events.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

async function boot() {
  const app = express(); app.use(express.json());
  registerConsoleRoutes(app, () => true, { respond: async () => { throw new Error('No legacy model'); },
    getRuntime: () => ({ listPendingApprovals: () => [] }) } as never, { serveLegacyAtRoot: false });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { post: (endpoint: string, data: unknown) => fetch(`${url}${endpoint}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function eventually(check: () => boolean) {
  for (let n = 0; n < 250; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Controlled lifecycle condition did not settle');
}

for (const stop of [false, true]) test(`desktop approval responds immediately and ${stop ? 'exact Stop reaches its action owner' : 'retains its attempt until success'}`, async () => {
  resumes._resetChatApprovalResumeForTest();
  let modelCalls = 0;
  _setBridgeImplsForTests({ configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async () => { modelCalls++; throw new Error('Approval must not call a model'); }) as never });
  resumes.startChatApprovalResume(async () => { modelCalls++; throw new Error('No model resume'); });
  let release!: (value: string) => void;
  let entered = false;
  let signal: AbortSignal | undefined;
  const body = new Promise<string>(resolve => { release = resolve; });
  _setApprovedCallDispatchForTests(async () => { entered = true; signal = currentToolAbortSignal(); return body; });
  const harness = await boot();
  try {
    const session = events.createSession({ kind: 'chat', channel: 'desktop', metadata: { source: 'desktop' } });
    const action = pending.queuePendingAction({ title: 'Controlled approved command', kind: 'shell_command',
      toolName: 'run_shell_command', payload: { command: 'git push origin fixture', cwd: '/tmp', timeout_ms: 20000 }, sessionId: session.id });
    const card = registry.register({ sessionId: session.id, subject: action.title, tool: 'request_approval',
      args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) } });
    events.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'approval_parked',
      data: { approvalId: card.approvalId, tool: card.tool, pendingActionId: action.id } });
    const request = { input: `approve ${card.approvalId}`, sessionId: session.id, clientRequestId: `approval-route-${session.id}` };
    const accepted = await harness.post('/api/harness/chat', request);
    assert.equal(accepted.status, 202, 'HTTP returns while controlled action is unresolved');
    await accepted.json();
    await eventually(() => entered || pending.getPendingAction(action.id)?.status === 'failed');
    assert.equal(entered, true, pending.getPendingAction(action.id)?.resultSummary);
    const attempt = events.getActiveRunAttempt(session.id);
    assert.ok(attempt, 'route finally must retain the exact executing attempt');
    const source = events.listEvents(session.id, { types: ['user_input_received'] })
      .find(event => event.data.clientRequestId === request.clientRequestId);
    assert.ok(source, 'the route durably accepted this exact request');
    assert.equal(source.data.approvalId, card.approvalId);
    assert.equal(events.getRunAttemptSourceUserEvent(attempt)?.seq, source.seq);
    const flight = resumes.approvalResumeInFlight(card.approvalId);
    assert.ok(flight);
    assert.equal(signal?.aborted, false);
    assert.equal(events.listEvents(session.id, { types: ['conversation_completed'] }).length, 0);
    const stale = await harness.post(`/api/console/harness-sessions/${session.id}/cancel`, { attemptId: 'stale-attempt' });
    assert.equal(stale.status, 409, 'strict stale Stop is preserved');
    assert.equal(signal?.aborted, false);
    if (stop) {
      const stopped = await harness.post(`/api/console/harness-sessions/${session.id}/cancel`, { attemptId: attempt.attemptId });
      assert.equal(stopped.status, 200, 'the accepted owner stays immediately stoppable');
      await flight;
      assert.equal(signal?.aborted, true);
      assert.equal(pending.getPendingAction(action.id)?.status, 'failed', 'interrupted mutation remains uncertain and cannot replay');
    } else { release('exit_code: 0\nstdout: controlled\nstderr:'); await flight;
      assert.equal(pending.getPendingAction(action.id)?.status, 'executed'); }
    assert.equal(events.getActiveRunAttempt(session.id), null);
    const terminal = events.listEvents(session.id, { types: ['conversation_completed'] })
      .filter(event => event.data.sourceUserSeq === source.seq);
    assert.equal(terminal.length, 1);
    assert.equal((terminal[0].data.turnOutcome as { status: string }).status, stop ? 'cancelled' : 'done');
    if (stop) { release('Late successful output'); await new Promise(resolve => setImmediate(resolve));
      assert.equal(events.listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
      assert.equal(pending.getPendingAction(action.id)?.status, 'failed'); }
    assert.equal((await harness.post('/api/harness/chat', request)).status, 202);
    assert.equal(modelCalls, 0);
  } finally { release('Fixture cleanup'); _setApprovedCallDispatchForTests(null);
    resumes._resetChatApprovalResumeForTest(); _setBridgeImplsForTests({}); await harness.close(); }
});

test('a cancelled approval ending cannot finish or clear a successor attempt', async () => {
  resumes._resetChatApprovalResumeForTest();
  const session = events.createSession({ kind: 'chat', channel: 'desktop' });
  const action = pending.queuePendingAction({ title: 'Controlled prior action', kind: 'shell_command',
    toolName: 'run_shell_command', payload: { command: 'git push origin fixture', cwd: '/tmp' }, sessionId: session.id });
  const card = registry.register({ sessionId: session.id, subject: action.title, tool: 'request_approval',
    args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) } });
  events.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'approval_parked', data: { approvalId: card.approvalId } });
  const old = events.beginRunAttempt(session.id, { runId: `prior:${session.id}` });
  const source = events.recordRunAttemptUserInput(old, { turn: 1, role: 'user',
    data: { text: `approve ${card.approvalId}`, source: 'desktop_approval', decision: 'approve', approvalId: card.approvalId } }, { armRunInFlight: true });
  const resolved = registry.resolve(card.approvalId, 'approved', 'fixture').row!;
  let entered = false, release!: (value: string) => void;
  const body = new Promise<string>(resolve => { release = resolve; });
  _setApprovedCallDispatchForTests(async () => { entered = true; return body; });
  const flight = resumes.handleResolvedApprovalForChatResume(resolved, async () => { throw new Error('No model'); });
  try {
    await eventually(() => entered || pending.getPendingAction(action.id)?.status === 'failed');
    assert.equal(entered, true, pending.getPendingAction(action.id)?.resultSummary);
    const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
    commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'cancelled', resumable: false,
      presentation: { kind: 'stopped', text: 'Stopped the controlled prior action.' } });
    events.finishRunAttempt(old, 'cancelled');
    const successor = events.beginRunAttempt(session.id, { runId: `successor:${session.id}` });
    events.recordRunAttemptUserInput(successor, { turn: 2, role: 'user', data: { text: 'A separate current request' } }, { armRunInFlight: true });
    const marker = HarnessSession.load(session.id)?.runInFlightSince();
    release('Late successful output'); await flight;
    assert.equal(events.getActiveRunAttempt(session.id)?.attemptId, successor.attemptId);
    assert.equal(HarnessSession.load(session.id)?.runInFlightSince(), marker);
    const terminal = events.listEvents(session.id, { types: ['conversation_completed'] }).filter(event => event.data.sourceUserSeq === source.seq);
    assert.equal(terminal.length, 1);
    assert.equal((terminal[0].data.turnOutcome as { status: string }).status, 'cancelled');
  } finally { release('Fixture cleanup'); _setApprovedCallDispatchForTests(null); resumes._resetChatApprovalResumeForTest(); }
});
