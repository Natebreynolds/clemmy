/**
 * Run: npx tsx --test src/assistant/core.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-assistant-core-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ApprovalResolutionResult, PendingApproval, RunRequest, RunResult } from '../types.js';

const { ClementineAssistant } = await import('./core.js');
const { SessionStore } = await import('../memory/session-store.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');

class CapturingRuntime {
  request: RunRequest | null = null;

  async run(request: RunRequest): Promise<RunResult> {
    this.request = request;
    return { text: 'captured', stoppedReason: 'success' };
  }

  listPendingApprovals(): PendingApproval[] {
    return [];
  }

  async resolveApproval(): Promise<ApprovalResolutionResult> {
    return { ok: false };
  }
}

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('legacy assistant prompt prefers canonical harness transcript over same-id desktop ghost', async () => {
  resetEventLog();
  const sessionId = 'assistant-core-harness-canonical';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', userId: 'core-user', title: 'Core canonical' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Use assistant core canonical source CORE-HARNESS-626.' },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'CORE-HARNESS-626 is the accepted source.' },
  });
  new SessionStore().appendTurn(sessionId, {
    role: 'user',
    text: '[background task core-ghost completed] synthetic report-back only',
    createdAt: new Date().toISOString(),
  }, 'core-user', 'desktop');
  const runtime = new CapturingRuntime();
  const assistant = new ClementineAssistant(runtime as never);

  await assistant.respond({
    sessionId,
    userId: 'core-user',
    channel: 'desktop',
    message: 'continue',
  });

  assert.ok(runtime.request);
  assert.match(runtime.request!.prompt, /CORE-HARNESS-626/);
  assert.match(runtime.request!.prompt, /USER: Use assistant core canonical source/);
  assert.match(runtime.request!.prompt, /YOU: CORE-HARNESS-626 is the accepted source/);
  assert.doesNotMatch(runtime.request!.prompt, /core-ghost/);
});
