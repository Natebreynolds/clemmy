/**
 * Run: npx tsx --test src/journeys/journey-smoke.test.ts
 *
 * JOURNEY SMOKE SUITE — the pre-tag gate born from the 2026-07-21/22 live
 * optimization program. Unit tests kept passing while three user-facing
 * journeys were broken, because every defect lived BETWEEN units: across
 * surfaces (desktop vs Home vs Discord), across lanes (chat vs background vs
 * workflow), or across time (approve → re-admit → re-compose). These journeys
 * walk the seams end to end, deterministically (injected brains, temp home,
 * zero live providers), so this class of break can never again ship blind.
 *
 *  J1 — a parked background task is answered IN THE CONVERSATION, resumes,
 *       completes, and reports back to its origin chat.
 *  J2 — an approved workflow payload replays VERBATIM on re-admission; a
 *       racing duplicate re-admission cannot double-execute.
 *  J3 — a run whose data source is dead gets the empty-result advisory, then
 *       the data-quality checkpoint intercepts its first external write.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-journey-smoke-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
process.env.CLEMMY_CONFIRM_BEAT = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'claude-auth.json'), JSON.stringify({
  accessToken: 'sk-ant-oat01-journey-token',
  refreshToken: 'journey-refresh',
  expiresAt: Date.now() + 60 * 60 * 1000,
  scopes: ['user:inference'],
}), 'utf-8');

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { registerConsoleRoutes } = await import('../dashboard/console-routes.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const { resetHarnessRuntimeConfig } = await import('../runtime/harness/codex-client.js');
const { createSession, listEvents, resetEventLog } = await import('../runtime/harness/eventlog.js');
const {
  createBackgroundTask,
  markBackgroundTaskAwaitingInput,
  getBackgroundTask,
  processBackgroundTasks,
} = await import('../execution/background-tasks.js');
const reg = await import('../runtime/harness/approval-registry.js');
const {
  replayApprovedActionForSession,
  renderApprovedReplayNote,
  setApprovalReplayDispatchForTest,
} = await import('../execution/approval-replay.js');
const {
  runComposioExecuteForTestInSession,
  resetDataQualityForTest,
} = await import('../tools/composio-tools.js');
const { listNotifications } = await import('../runtime/notifications.js');

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

test('J1: parked task → answered in the conversation → resumes → completes → reports back to origin', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  const brainReplies: string[] = [];
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    claudeAgentBrain: (async (_surface: unknown, request: unknown) => {
      brainReplies.push(JSON.stringify(request ?? {}));
      return {
        text: 'All five firms compiled into the base. Task complete.',
        sessionId: 'ignored',
        stoppedReason: 'success',
      };
    }) as never,
  });
  const harness = await boot();
  try {
    const origin = createSession({ id: 'sess-desktop-journey-j1', kind: 'chat' });
    const task = createBackgroundTask({
      title: 'J1 pipeline needing a workspace id',
      prompt: 'Build the intel base.',
      originSessionId: origin.id,
    });
    markBackgroundTaskAwaitingInput(task.id, 'j1-question', 'Which workspace should I use?');

    // The user answers IN THE CONVERSATION (the previously-broken seam).
    const res = await fetch(`${harness.url}/api/harness/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Use workspace wspJOURNEY1.', sessionId: origin.id, clientRequestId: 'journey-j1-answer-01' }),
    });
    const body = await res.json() as { routedToBackgroundTask?: string };
    assert.equal(body.routedToBackgroundTask, task.id, 'the reply routed to the parked task');
    assert.equal(getBackgroundTask(task.id)?.status, 'pending', 'the task queued its continuation');

    // The drain resumes it with the injected brain and it completes.
    const assistant = { respond: async () => { throw new Error('legacy path must not run'); } };
    await processBackgroundTasks(assistant as never, 3);
    const finished = getBackgroundTask(task.id);
    assert.equal(finished?.status, 'done', `task finished (status=${finished?.status})`);
    assert.ok(brainReplies.length > 0, 'the injected brain ran the resumed continuation');
    // The user's answer is threaded into the resume prompt the brain receives.
    assert.ok(
      brainReplies.some((r) => r.includes('wspJOURNEY1')),
      `the resumed run carried the user answer (saw: ${brainReplies.map((r) => r.slice(0, 120)).join(' | ')})`,
    );

    // Report-back reached the origin chat (staged outcome turn) + a terminal notification exists.
    const originEvents = listEvents(origin.id);
    const outcomeTurn = originEvents.find((e) =>
      e.type === 'user_input_received'
      && (e.data as { source?: string }).source === 'outcome'
      && String((e.data as { text?: string }).text ?? '').includes(`[background task ${task.id} completed]`));
    assert.ok(outcomeTurn, 'origin chat carries the completion report-back');
    assert.ok(
      listNotifications().some((n) => n.id.includes(task.id) && n.id.includes('done')),
      'terminal completion notification exists',
    );
  } finally {
    await harness.close();
    _setBridgeImplsForTests({});
  }
});

test('J2: an approved workflow payload replays VERBATIM on re-admission; racing duplicates cannot double-send', async () => {
  const session = createSession({ id: 'workflow:journey-j2:post_slack', kind: 'workflow' });
  const row = reg.register({
    sessionId: session.id,
    subject: 'Run SLACK_SEND_MESSAGE?',
    tool: 'composio_execute_tool',
    args: {
      tool_slug: 'SLACK_SEND_MESSAGE',
      arguments: '{"channel":"C0JOURNEY","markdown_text":"*Team Activity — EOD*"}',
    },
  });
  reg.resolve(row.approvalId, 'approved', 'journey-user');

  const dispatched: Array<Record<string, unknown>> = [];
  setApprovalReplayDispatchForTest(async (slug, args) => {
    dispatched.push({ slug, ...args });
    return { ok: true, result: { ts: 'sent-1' } };
  });
  try {
    // Two racing re-admissions claim concurrently — exactly one may execute.
    const [a, b] = await Promise.all([
      replayApprovedActionForSession(session.id),
      replayApprovedActionForSession(session.id),
    ]);
    const outcomes = [a, b].filter(Boolean);
    assert.equal(outcomes.length, 1, 'exactly one re-admission won the claim');
    assert.equal(dispatched.length, 1, 'the approved payload executed exactly once');
    assert.equal(dispatched[0].slug, 'SLACK_SEND_MESSAGE');
    assert.equal(dispatched[0].channel, 'C0JOURNEY');
    assert.equal(dispatched[0].markdown_text, '*Team Activity — EOD*');
    const note = renderApprovedReplayNote(outcomes[0]!);
    assert.match(note, /ALREADY EXECUTED/);

    // The grant is consumed — a later re-admission replays nothing and the
    // registry can never mint a fresh card from this decision.
    assert.equal(await replayApprovedActionForSession(session.id), null);
    assert.ok(reg.get(row.approvalId)?.consumedAt, 'grant durably consumed');
  } finally {
    setApprovalReplayDispatchForTest(null);
  }
});

test('J3: dead data source → empty-result advisory → data-quality checkpoint intercepts the first write', async () => {
  resetDataQualityForTest();
  try {
    const sid = 'background:bg-journey-j3';
    const deadSource = (async () => ({ data: { items: [] }, error: null, successful: true })) as never;
    const writeExec = (async () => ({ data: { id: 'appJ3' }, error: null, successful: true })) as never;

    let advisorySeen = '';
    for (const firm of ['firm-1', 'firm-2', 'firm-3', 'firm-4']) {
      advisorySeen = await runComposioExecuteForTestInSession('APIFY_GET_DATASET_ITEMS', { q: firm }, deadSource, sid);
    }
    assert.match(advisorySeen, /empty-result advisory/, 'the model was steered before the write');

    const intercepted = await runComposioExecuteForTestInSession('AIRTABLE_CREATE_BASE', { name: 'J3 Intel' }, writeExec, sid);
    assert.match(intercepted, /DATA-QUALITY CHECKPOINT/);
    assert.match(intercepted, /4\/4 reads returned empty/);
    assert.match(intercepted, /ask_user_question/, 'the check-in fork is offered');

    // A deliberate second attempt proceeds — autonomy redirected, never dead-ended.
    const proceeded = await runComposioExecuteForTestInSession('AIRTABLE_CREATE_BASE', { name: 'J3 Intel' }, writeExec, sid);
    assert.doesNotMatch(proceeded, /DATA-QUALITY CHECKPOINT/);
    assert.match(proceeded, /appJ3/);
  } finally {
    resetDataQualityForTest();
  }
});

test('J1b: a parked task can be answered directly from its Tasks-board drawer', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  _setBridgeImplsForTests({ configure: (async () => ({ ok: true })) as never });
  const harness = await boot();
  try {
    const origin = createSession({ id: 'sess-desktop-journey-j1b', kind: 'chat' });
    const task = createBackgroundTask({
      title: 'J1b board-answer task',
      prompt: 'Do the thing.',
      originSessionId: origin.id,
    });
    markBackgroundTaskAwaitingInput(task.id, 'j1b-question', 'Which region?');

    const res = await fetch(`${harness.url}/api/console/board/background/${task.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: 'US-West please.' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; task?: { status?: string } };
    assert.equal(body.ok, true);
    assert.equal(body.task?.status, 'pending', 'the board answer queued the continuation');
    assert.equal(getBackgroundTask(task.id)?.inputResolution?.answer, 'US-West please.');

    // A second answer is refused honestly — the question was consumed.
    const again = await fetch(`${harness.url}/api/console/board/background/${task.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: 'EU instead.' }),
    });
    assert.equal(again.status, 409);
  } finally {
    await harness.close();
    _setBridgeImplsForTests({});
  }
});
