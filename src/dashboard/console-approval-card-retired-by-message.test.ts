/**
 * Owner rule 2026-10-20: approval cards are always dynamic; if a card is not
 * approved and the owner sends a message instead, the card goes away. A card
 * left waiting after the owner moved on could later be tapped and run an
 * action from a request the owner had already moved past.
 *
 * An unrelated message retires the waiting card at acceptance, before any
 * model work: the registry row stops being pending, the stored action can
 * never run on its own, and nothing is dispatched.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import express from 'express';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-card-retired-by-message-'));
Object.assign(process.env, { CLEMENTINE_HOME: fixtureHome, AUTH_MODE: 'claude_oauth',
  CLEMMY_CLAUDE_AGENT_SDK_BRAIN: 'read_only', CLEMMY_DEBATE_MODE: 'off', MCP_AUTO_IMPORT_ENABLED: 'false',
  CLEMMY_TEST_ISOLATED_HOME: '1', CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', EMBEDDINGS_DISABLED: 'true' });
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

after(() => { _setBridgeImplsForTests({}); _setApprovedCallDispatchForTests(null); resumes._resetChatApprovalResumeForTest();
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

test('a message that does not answer a waiting card retires the card and its stored action', async () => {
  resumes._resetChatApprovalResumeForTest();
  const dispatched: unknown[] = [];
  _setApprovedCallDispatchForTests(async (_tool, payload) => { dispatched.push(payload); return 'ok'; });
  _setBridgeImplsForTests({ configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async () => { throw new Error('TEST FIXTURE: no model in this pin'); }) as never });
  resumes.startChatApprovalResume(async () => { throw new Error('No model resume'); });
  const harness = await boot();
  try {
    const session = events.createSession({ kind: 'chat', channel: 'desktop', metadata: { source: 'desktop' } });
    const action = pending.queuePendingAction({ title: 'TEST FIXTURE post one record', summary: 'One fixture POST.',
      kind: 'shell_command', toolName: 'run_shell_command',
      payload: { command: "curl -sS -X POST -d 'x=1' http://127.0.0.1:1/hook", cwd: fixtureHome }, sessionId: session.id });
    const card = registry.register({ sessionId: session.id, subject: action.title, tool: 'request_approval',
      args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) } });
    events.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'approval_parked',
      data: { approvalId: card.approvalId, tool: card.tool, pendingActionId: action.id } });
    assert.equal(registry.get(card.approvalId)?.status, 'pending');

    const accepted = await harness.post('/api/harness/chat', { input: 'TEST FIXTURE: different topic, what is on my calendar tomorrow?',
      sessionId: session.id, clientRequestId: `card-retire-${session.id}` });
    assert.ok([200, 202].includes(accepted.status), String(accepted.status));
    // The parked card keeps its session busy, so the new message may continue
    // in a successor session; the card it left behind is what must go away.
    await accepted.json();

    assert.notEqual(registry.get(card.approvalId)?.status, 'pending', 'the card the owner moved past is no longer waiting');
    assert.ok(['cancelled', 'expired', 'rejected'].includes(pending.getPendingAction(action.id)?.status ?? ''),
      `the stored action can never run on its own (was ${pending.getPendingAction(action.id)?.status})`);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(dispatched.length, 0, 'nothing ran');
  } finally {
    resumes._resetChatApprovalResumeForTest(); _setBridgeImplsForTests({}); _setApprovedCallDispatchForTests(null); await harness.close();
  }
});
