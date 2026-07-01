/**
 * Run: npx tsx --test src/runtime/harness/session-reconcile.test.ts
 *
 * Regression coverage for boot-time/dashboard reconciliation of non-chat
 * harness sessions. A row can be left status='active' after a restart even
 * though terminal events are already durable; those should stop counting as
 * active work. Parked states must remain visible.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-session-reconcile-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  appendEvent,
  createSession,
  getSession,
  resetEventLog,
} = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const {
  isIgnorableActiveWorkSession,
  isDormantTerminalWorkSession,
  reconcileDormantTerminalWorkSessions,
  terminalStatusForWorkLifecycleEvent,
} = await import('./session-reconcile.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('terminal event evidence reconciles stale active non-chat sessions', () => {
  resetEventLog();
  const done = createSession({ id: 'workflow:done-stale:s1', kind: 'workflow', channel: 'workflow' });
  appendEvent({ sessionId: done.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
  appendEvent({ sessionId: done.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'done' } });

  const failed = createSession({ id: 'execution:failed-stale', kind: 'execution', channel: 'background' });
  appendEvent({ sessionId: failed.id, turn: 1, role: 'system', type: 'run_failed', data: { error: 'provider failed' } });

  const chat = createSession({ id: 'chat-terminal-not-work', kind: 'chat', channel: 'desktop' });
  appendEvent({ sessionId: chat.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'done' } });

  assert.equal(isDormantTerminalWorkSession(done), true);
  assert.equal(isDormantTerminalWorkSession(failed), true);
  assert.equal(isDormantTerminalWorkSession(chat), false);

  const result = reconcileDormantTerminalWorkSessions();
  assert.deepEqual(new Set(result.ids), new Set([done.id, failed.id]));
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(getSession(done.id)?.status, 'completed');
  assert.equal(getSession(failed.id)?.status, 'failed');
  assert.equal(getSession(chat.id)?.status, 'active');
});

test('boot reconciliation scans beyond a single active session page', () => {
  resetEventLog();
  for (let i = 0; i < 505; i += 1) {
    const session = createSession({ id: `workflow:many-terminal:${i}:s1`, kind: 'workflow', channel: 'workflow' });
    appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
    appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'done' } });
  }

  const result = reconcileDormantTerminalWorkSessions();
  assert.equal(result.reconciled, 505);
  assert.equal(result.completed, 505);
  assert.equal(getSession('workflow:many-terminal:0:s1')?.status, 'completed');
  assert.equal(getSession('workflow:many-terminal:504:s1')?.status, 'completed');
});

test('parked awaiting states and pending approvals are not reconciled away', () => {
  resetEventLog();
  const awaitingInput = createSession({ id: 'workflow:awaiting-input:s1', kind: 'workflow', channel: 'workflow' });
  appendEvent({
    sessionId: awaitingInput.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'awaiting_user_input', reply: 'Which segment should I use?' },
  });

  const awaitingContinue = createSession({ id: 'execution:awaiting-continue', kind: 'execution', channel: 'background' });
  appendEvent({ sessionId: awaitingContinue.id, turn: 1, role: 'system', type: 'conversation_limit_exceeded', data: { reason: 'max_steps' } });
  appendEvent({
    sessionId: awaitingContinue.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'awaiting_continue', reply: 'Reply continue to keep going.' },
  });

  const pendingApproval = createSession({ id: 'workflow:pending-approval:s1', kind: 'workflow', channel: 'workflow' });
  approvalRegistry.register({
    sessionId: pendingApproval.id,
    subject: 'Approve send',
    tool: 'send_email',
  });
  appendEvent({ sessionId: pendingApproval.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'ready after approval' } });

  const result = reconcileDormantTerminalWorkSessions();
  assert.equal(result.reconciled, 0);
  assert.equal(getSession(awaitingInput.id)?.status, 'active');
  assert.equal(getSession(awaitingContinue.id)?.status, 'active');
  assert.equal(getSession(pendingApproval.id)?.status, 'active');
});

test('Claude SDK workflow-step route telemetry closes historical active step sessions', () => {
  resetEventLog();
  const sdkStep = createSession({ id: 'workflow:sdk-route-complete:step', kind: 'workflow', channel: 'workflow' });
  appendEvent({
    sessionId: sdkStep.id,
    turn: 0,
    role: 'system',
    type: 'worker_model_routed',
    data: {
      transport: 'claude_agent_sdk_workflow_step',
      modelId: 'claude-opus-4-8',
      sdkSessionId: 'sdk-session',
      toolUses: ['StructuredOutput'],
      structured: true,
    },
  });

  const genericRoute = createSession({ id: 'workflow:generic-route-active:step', kind: 'workflow', channel: 'workflow' });
  appendEvent({
    sessionId: genericRoute.id,
    turn: 0,
    role: 'system',
    type: 'worker_model_routed',
    data: { modelId: 'gpt-5.5', provider: 'openai' },
  });

  const result = reconcileDormantTerminalWorkSessions();
  assert.deepEqual(result.ids, [sdkStep.id]);
  assert.equal(getSession(sdkStep.id)?.status, 'completed');
  assert.equal(getSession(genericRoute.id)?.status, 'active');
});

test('active-work visibility ignores empty and stale orphan sessions without mutating them', () => {
  resetEventLog();
  const empty = createSession({ id: 'workflow:empty-orphan', kind: 'workflow', channel: 'workflow' });
  appendEvent({ sessionId: empty.id, turn: 0, role: 'system', type: 'session_started', data: {} });

  const pending = createSession({ id: 'workflow:empty-pending-approval', kind: 'workflow', channel: 'workflow' });
  approvalRegistry.register({ sessionId: pending.id, subject: 'Approve pending gate', tool: 'workflow_approval_gate' });

  const staleTool = createSession({ id: 'workflow:stale-tool-orphan', kind: 'workflow', channel: 'workflow' });
  appendEvent({ sessionId: staleTool.id, turn: 1, role: 'system', type: 'tool_returned', data: { tool: 'read_file', ok: true } });

  const pendingIds = new Set([pending.id]);
  assert.equal(isIgnorableActiveWorkSession(empty, { pendingSessionIds: pendingIds }), true);
  assert.equal(isIgnorableActiveWorkSession(pending, { pendingSessionIds: pendingIds }), false);
  assert.equal(isIgnorableActiveWorkSession(staleTool, { pendingSessionIds: pendingIds, nowMs: Date.now() + 10_000, staleMs: 1 }), true);
  assert.equal(getSession(empty.id)?.status, 'active', 'visibility filtering does not rewrite history');
  assert.equal(getSession(staleTool.id)?.status, 'active', 'stale orphan filtering does not rewrite history');
});

test('terminal detector treats only plain completions and run terminal events as terminal', () => {
  assert.equal(
    terminalStatusForWorkLifecycleEvent({ type: 'conversation_completed', data: { reason: 'awaiting_continue' } }),
    null,
  );
  assert.equal(
    terminalStatusForWorkLifecycleEvent({ type: 'conversation_completed', data: { reason: 'awaiting_user_input' } }),
    null,
  );
  assert.equal(
    terminalStatusForWorkLifecycleEvent({ type: 'conversation_completed', data: { reason: 'claude_agent_sdk_brain' } }),
    'completed',
  );
  assert.equal(terminalStatusForWorkLifecycleEvent({ type: 'run_completed', data: {} }), 'completed');
  assert.equal(terminalStatusForWorkLifecycleEvent({ type: 'run_failed', data: {} }), 'failed');
  assert.equal(
    terminalStatusForWorkLifecycleEvent({ type: 'worker_model_routed', data: { transport: 'claude_agent_sdk_workflow_step' } }),
    'completed',
  );
  assert.equal(
    terminalStatusForWorkLifecycleEvent({ type: 'worker_model_routed', data: { transport: 'openai_agents_harness' } }),
    null,
  );
  assert.equal(terminalStatusForWorkLifecycleEvent({ type: 'awaiting_user_input', data: {} }), null);
});
