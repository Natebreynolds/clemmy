/**
 * An approval given in the chat runs the REAL stored shell command and ends
 * as done. No stand-in dispatch: the shell tool's own bracket reports its
 * observation exactly as it does live. A command that leaves the machine
 * (ssh) is the shape that broke live on 2026-10-08: the command ran, then the
 * approved-action invocation refused its own observation and the owner was
 * told it could not tell whether the command went through.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import express from 'express';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-console-approved-shell-'));
Object.assign(process.env, { CLEMENTINE_HOME: fixtureHome, AUTH_MODE: 'claude_oauth',
  CLEMMY_CLAUDE_AGENT_SDK_BRAIN: 'read_only', CLEMMY_DEBATE_MODE: 'off', MCP_AUTO_IMPORT_ENABLED: 'false',
  CLEMMY_TEST_ISOLATED_HOME: '1', CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', EMBEDDINGS_DISABLED: 'true' });
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(fixtureHome, 'state', 'claude-auth.json'), JSON.stringify({ accessToken: 'sk-ant-oat01-route-fixture-token',
  refreshToken: 'route-fixture-refresh', expiresAt: Date.now() + 3600000, scopes: ['user:inference'] }));
const WORK = path.join(fixtureHome, 'work');
mkdirSync(WORK, { recursive: true });
const { registerConsoleRoutes } = await import('./console-routes.js');
const events = await import('../runtime/harness/eventlog.js');
const registry = await import('../runtime/harness/approval-registry.js');
const pending = await import('../runtime/harness/pending-actions.js');
const { pendingActionApprovalView } = await import('../runtime/harness/pending-action-view.js');
const resumes = await import('../runtime/harness/chat-approval-resume.js');
const { classifyRuntimeToolEffect } = await import('../runtime/harness/tool-effect.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');

after(() => { _setBridgeImplsForTests({}); resumes._resetChatApprovalResumeForTest();
  events.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

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
  for (let n = 0; n < 1500; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('The approved action did not settle');
}

const hasSsh = spawnSync('ssh', ['-V'], { stdio: 'ignore' }).status === 0;

test('a desktop approval of a real off-machine shell command runs it once and ends done', { skip: !hasSsh && 'ssh is not installed' }, async () => {
  resumes._resetChatApprovalResumeForTest();
  let modelCalls = 0;
  _setBridgeImplsForTests({ configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async () => { modelCalls++; throw new Error('Approval must not call a model'); }) as never });
  resumes.startChatApprovalResume(async () => { modelCalls++; throw new Error('No model resume'); });
  // `ssh -G` prints the resolved client configuration and opens no connection.
  const payload = { command: "ssh -G localhost | grep -m1 '^hostname '", cwd: WORK, timeout_ms: 20000 };
  assert.equal(classifyRuntimeToolEffect('run_shell_command', payload).effect, 'external_write',
    'the pinned shape is a command the host books as leaving the machine');
  const harness = await boot();
  try {
    const session = events.createSession({ kind: 'chat', channel: 'desktop', metadata: { source: 'desktop' } });
    const action = pending.queuePendingAction({ title: 'Show the resolved ssh host', kind: 'shell_command',
      toolName: 'run_shell_command', payload, sessionId: session.id });
    const card = registry.register({ sessionId: session.id, subject: action.title, tool: 'request_approval',
      args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) } });
    events.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'approval_parked',
      data: { approvalId: card.approvalId, tool: card.tool, pendingActionId: action.id } });
    const request = { input: `approve ${card.approvalId}`, sessionId: session.id, clientRequestId: `approved-shell-${session.id}` };
    const accepted = await harness.post('/api/harness/chat', request);
    assert.equal(accepted.status, 202);
    await accepted.json();
    await eventually(() => ['executed', 'failed'].includes(pending.getPendingAction(action.id)?.status ?? ''));
    const settled = pending.getPendingAction(action.id);
    assert.equal(settled?.status, 'executed', settled?.resultSummary);
    assert.match(settled?.resultSummary ?? '', /hostname localhost/);
    const source = events.listEvents(session.id, { types: ['user_input_received'] })
      .find(event => event.data.clientRequestId === request.clientRequestId);
    assert.ok(source);
    await eventually(() => events.listEvents(session.id, { types: ['conversation_completed'] })
      .some(event => event.data.sourceUserSeq === source.seq));
    const terminal = events.listEvents(session.id, { types: ['conversation_completed'] })
      .filter(event => event.data.sourceUserSeq === source.seq);
    assert.equal(terminal.length, 1);
    const told = JSON.stringify(terminal[0].data);
    assert.equal((terminal[0].data.turnOutcome as { status: string }).status, 'done', told);
    assert.match(told, /Done — I ran it/, told);
    assert.doesNotMatch(told, /can't tell whether/, told);
    assert.equal(modelCalls, 0);
  } finally {
    resumes._resetChatApprovalResumeForTest(); _setBridgeImplsForTests({}); await harness.close();
  }
});
