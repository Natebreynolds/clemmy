/**
 * Run: npx tsx --test src/gateway/router.test.ts
 *
 * Focused tests for the cross-channel gateway wrapper. The harness bridge is
 * kill-switched here so the assistant stub captures the exact message that
 * would be sent to either legacy or the harness fallback path.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-gateway-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_WEBHOOK = 'off';

const { ClementineGateway } = await import('./router.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { getRun } = await import('../runtime/run-events.js');
const { getBackgroundTask } = await import('../execution/background-tasks.js');

afterEach(() => {
  resetEventLog();
  process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
});

test.after(() => {
  resetEventLog();
  delete process.env.CLEMMY_HARNESS_WEBHOOK;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('bare continue after an awaiting_continue completion is rewritten with prior summary context', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Mobile loop' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reason: 'awaiting_continue',
      lastDecisionSummary: 'Finished discovery; keep working until the final outreach list is drafted.',
      reply: 'Reply `continue` to keep going.',
    },
  });

  let capturedMessage = '';
  const gateway = new ClementineGateway({
    respond: async (req: { message: string; sessionId: string }) => {
      capturedMessage = req.message;
      return { text: 'continued', sessionId: req.sessionId };
    },
  } as never);

  const response = await gateway.handleMessage({
    message: 'continue',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
  });

  assert.equal(response.text, 'continued');
  assert.equal(response.queuedTaskId, undefined, 'synthetic continuation prompt must not be promoted to background');
  assert.match(capturedMessage, /previous turn/);
  assert.match(capturedMessage, /do not restart/i);
  assert.match(capturedMessage, /Finished discovery; keep working until/);
});

test('bare continue without a limit completion remains a normal user message', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Mobile loop' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'success', reply: 'All done.' },
  });

  let capturedMessage = '';
  const gateway = new ClementineGateway({
    respond: async (req: { message: string; sessionId: string }) => {
      capturedMessage = req.message;
      return { text: 'normal', sessionId: req.sessionId };
    },
  } as never);

  await gateway.handleMessage({
    message: 'continue',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
  });

  assert.equal(capturedMessage, 'continue');
});

test('gateway auto-promotes broad multi-system data pipelines to background', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'CRM enrichment' });
  let respondCalled = false;
  const gateway = new ClementineGateway({
    respond: async (req: { sessionId: string }) => {
      respondCalled = true;
      return { text: 'foreground', sessionId: req.sessionId };
    },
  } as never);

  const response = await gateway.handleMessage({
    message: 'Pull full data from Salesforce via the CLI, then scrape all of it with Apify MCP, run subagents for 5 different actors including Google reviews, SEO data, and lead info, then add the results to my Airtable CRM via MCP.',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
  });

  assert.equal(respondCalled, false, 'foreground chat run should be skipped');
  assert.ok(response.queuedTaskId, 'a durable background task should be queued');
  assert.match(response.text, /background task/i);

  const task = getBackgroundTask(response.queuedTaskId!);
  assert.ok(task, 'queued task should be persisted');
  assert.equal(task!.originSessionId, session.id);
  assert.equal(task!.source, 'mobile');
  assert.match(task!.prompt, /Salesforce/);
  assert.match(task!.prompt, /Airtable CRM/);
});

test('gateway records max-turns-with-grace as a non-completed run', async () => {
  const gateway = new ClementineGateway({
    respond: async (req: { sessionId: string }) => ({
      text: 'I hit the run budget before finishing — say "continue" to keep going.',
      sessionId: req.sessionId,
      stoppedReason: 'max-turns-with-grace',
    }),
  } as never);

  const response = await gateway.handleMessage({
    message: 'research every account and finish the report',
    sessionId: 'sess-gateway-limit',
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-limit',
  });

  assert.equal(response.stoppedReason, 'max-turns-with-grace');
  const run = getRun('run-gateway-limit');
  assert.equal(run?.status, 'failed');
  assert.match(run?.error ?? '', /continue|budget/i);
});
