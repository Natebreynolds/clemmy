/**
 * Run: npx tsx --test src/assistant/core.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const { _setUnifiedTurnPrimerRecallForTest } = await import('../memory/turn-primer.js');
const { reindexVault } = await import('../memory/indexer.js');
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

test.afterEach(() => _setUnifiedTurnPrimerRecallForTest(null));

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

test('legacy assistant fallback uses unified evidence recall for local in-person meetings', async () => {
  resetEventLog();
  const sourceUri = 'meeting://local/live-2026-07-15';
  _setUnifiedTurnPrimerRecallForTest(async (query) => ({
    objective: query,
    answerability: 'supported',
    diagnostics: { candidates: 17, stores: ['episode', 'entity'], elapsedMs: 3 },
    perStore: { episode: 1 },
    hits: [{
      type: 'episode',
      ref: 'live-2026-07-15',
      title: 'In-person revenue review',
      snippet: 'Reviewed the revenue dashboard and legal-data integration gaps.',
      score: 0.99,
      confidence: 0.96,
      whyRecalled: ['exact temporal match', 'in-person capture match'],
      evidence: [{ episodeId: 'live-2026-07-15', excerpt: 'Reviewed the revenue dashboard.', sourceUri }],
    }],
  }));
  const runtime = new CapturingRuntime();
  const assistant = new ClementineAssistant(runtime as never);

  await assistant.respond({
    sessionId: 'assistant-core-local-meeting',
    userId: 'core-user',
    channel: 'desktop',
    message: 'What was the in-person meeting I had today about?',
  });

  assert.ok(runtime.request);
  assert.match(runtime.request!.prompt, /Relevant memory context:/);
  assert.match(runtime.request!.prompt, /\[EPISODE\].*In-person revenue review/);
  assert.match(runtime.request!.prompt, /meeting:\/\/local\/live-2026-07-15/);
  assert.match(runtime.request!.prompt, /answerability: supported/);
  assert.doesNotMatch(runtime.request!.prompt, /Relevant vault context:/);
});

test('legacy assistant keeps a labeled local-recording fallback when unified recall fails', async () => {
  resetEventLog();
  const vault = path.join(TMP_HOME, 'vault');
  const meetings = path.join(vault, '04-Meetings');
  mkdirSync(meetings, { recursive: true });
  const meetingPath = path.join(meetings, '2026-07-15-in-person-orchid-review.md');
  writeFileSync(meetingPath, [
    '---',
    'type: meeting-transcript',
    'occurred_at: 2026-07-15T10:00:00-07:00',
    'source: in-person recording',
    '---',
    '# In-person Orchid review',
    'Summary: The in-person meeting reviewed Orchid launch readiness and the customer migration timeline.',
  ].join('\n'));
  reindexVault(vault);
  _setUnifiedTurnPrimerRecallForTest(async () => { throw new Error('simulated unified recall outage'); });
  const runtime = new CapturingRuntime();
  const assistant = new ClementineAssistant(runtime as never);

  await assistant.respond({
    sessionId: 'assistant-core-degraded-meeting',
    userId: 'core-user',
    channel: 'desktop',
    message: 'What was the in-person Orchid meeting about?',
  });

  assert.ok(runtime.request);
  assert.match(runtime.request!.prompt, /MEMORY PRIMER DEGRADED/);
  assert.match(runtime.request!.prompt, /vault-only lexical fallback/);
  assert.match(runtime.request!.prompt, /launch/, 'the recorded meeting summary survives the degraded primer');
  assert.ok(runtime.request!.prompt.includes(meetingPath));
});
