/**
 * Run: npx tsx --test src/dashboard/console-home-stream.test.ts
 *
 * Functional smoke for the console home NDJSON chat stream. Uses the real
 * registerConsoleRoutes with a stub assistant so the test covers route-level
 * serialization without a model call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-home-stream-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_HOME = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { PUBLIC_RUN_FAILURE_TEXT } = await import('../runtime/harness/public-presentation.js');
const { appendEvent, createSession, listEvents, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { archiveBackgroundTask, listBackgroundTasks } = await import('../execution/background-tasks.js');

type StubAssistantRequest = { sessionId: string; onReasoning?: (text: string) => void };
type StreamEvent = { type?: string; text?: string; error?: string; route?: { routeKind?: string; surface?: string } | null };

test.after(() => {
  delete process.env.CLEMMY_HARNESS_HOME;
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  resetEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(respond?: (req: StubAssistantRequest) => Promise<{ text: string; sessionId: string }>) {
  const app = express();
  app.use(express.json());
  const assistant = {
    respond: respond ?? (async (req: StubAssistantRequest) => {
      req.onReasoning?.('Clementine is recovering from a stalled step.');
      return { text: 'done', sessionId: req.sessionId };
    }),
    getRuntime: () => ({
      listPendingApprovals: () => [],
    }),
  };
  registerConsoleRoutes(
    app,
    () => true,
    assistant as never,
    { serveLegacyAtRoot: false },
  );
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function parseNdjson(text: string): StreamEvent[] {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamEvent);
}

test('home chat stream does not forward raw model reasoning text', async () => {
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/home/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: 'console:test-stream' }),
    });
    assert.equal(res.status, 200);
    const events = parseNdjson(await res.text());

    assert.ok(
      events.some((event) => event.type === 'status' && event.text === 'Clementine run started.'),
      'the route still emits its own public lifecycle status',
    );
    assert.ok(
      !events.some((event) => event.text === 'Clementine is recovering from a stalled step.'),
      'executor/model reasoning stays private',
    );
    const done = events.find((event) => event.type === 'done');
    assert.equal(done?.text, 'done', 'stream ends with done event');
    assert.equal(done?.route?.routeKind, 'legacy', 'terminal frame includes model route diagnostics');
    assert.equal(done?.route?.surface, 'home');
  } finally {
    await h.close();
  }
});

test('home chat stream emits terminal error event when assistant throws', async () => {
  const h = await boot(async () => {
    throw new Error('simulated stream failure with private provider detail');
  });
  try {
    const res = await fetch(`${h.url}/api/console/home/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: 'console:test-stream-error' }),
    });
    assert.equal(res.status, 200);
    const events = parseNdjson(await res.text());

    const error = events.find((event) => event.type === 'error');
    assert.equal(error?.error, PUBLIC_RUN_FAILURE_TEXT);
    assert.doesNotMatch(JSON.stringify(events), /private provider detail/);
    assert.equal(events.at(-1)?.type, 'error', 'stream closes after a terminal error event');
  } finally {
    await h.close();
  }
});

test('explicit background commands create visible durable tasks without invoking the model', async () => {
  let assistantCalls = 0;
  const createdTaskIds: string[] = [];
  const h = await boot(async (req) => {
    assistantCalls += 1;
    return { text: 'model should not narrate this handoff', sessionId: req.sessionId };
  });
  try {
    const streamSession = 'console:explicit-background-stream';
    const streamRes = await fetch(`${h.url}/api/console/home/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '/background analyze these 12 fictional records', sessionId: streamSession }),
    });
    assert.equal(streamRes.status, 200);
    const streamEvents = parseNdjson(await streamRes.text());
    assert.match(streamEvents.find((event) => event.type === 'done')?.text ?? '', /background task/i);

    const jsonSession = 'console:explicit-background-json';
    const jsonRes = await fetch(`${h.url}/api/console/home/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '/background validate the same fictional records', sessionId: jsonSession }),
    });
    assert.equal(jsonRes.status, 200);
    assert.match((await jsonRes.json() as { text?: string }).text ?? '', /background task/i);

    const tasks = listBackgroundTasks();
    const created = tasks.filter((task) => (
      task.originSessionId === streamSession || task.originSessionId === jsonSession
    ));
    createdTaskIds.push(...created.map((task) => task.id));
    assert.ok(created.some((task) => task.originSessionId === streamSession));
    assert.ok(created.some((task) => task.originSessionId === jsonSession));
    const streamTerminal = listEvents(streamSession).find((event) => (
        event.type === 'conversation_completed'
        && event.data.queuedTaskId === created.find((task) => task.originSessionId === streamSession)?.id
      ));
    assert.ok(
      streamTerminal,
      'the model-free handoff still establishes a canonical origin transcript',
    );
    assert.equal(
      (streamTerminal?.data.turnOutcome as { status?: string } | undefined)?.status,
      'done',
      'the handoff acknowledgement crosses the typed delivery boundary',
    );
    assert.equal(
      (streamTerminal?.data.presentation as { identity?: { sourceUserSeq?: number } } | undefined)?.identity?.sourceUserSeq,
      listEvents(streamSession).find((event) => event.type === 'user_input_received')?.seq,
      'the handoff terminal belongs to the exact recorded command',
    );
    assert.equal(assistantCalls, 0, 'the explicit command bypasses plan-only model narration');
  } finally {
    for (const id of createdTaskIds) archiveBackgroundTask(id);
    await h.close();
  }
});

test('command center keeps limit-exceeded harness sessions working until completion', async () => {
  resetEventLog();
  const session = createSession({
    kind: 'chat',
    channel: 'desktop',
    title: 'Long research loop',
    metadata: { source: 'desktop' },
  });
  appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'turn_started', data: {} });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'conversation_limit_exceeded',
    data: { reason: 'turn_cap' },
  });

  const h = await boot();
  try {
    const first = await fetch(`${h.url}/api/console/home/command-center`);
    assert.equal(first.status, 200);
    const activeBody = await first.json() as {
      presence: { status: string };
      counts: { active: number };
      workingNow: Array<{ sessionId?: string }>;
    };
    assert.equal(activeBody.presence.status, 'working');
    assert.equal(activeBody.counts.active, 1);
    assert.ok(activeBody.workingNow.some((item) => item.sessionId === session.id));

    appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'system',
      type: 'conversation_completed',
      data: { summary: 'complete' },
    });
    const second = await fetch(`${h.url}/api/console/home/command-center`);
    assert.equal(second.status, 200);
    const completedBody = await second.json() as {
      counts: { active: number };
      workingNow: Array<{ sessionId?: string }>;
    };
    assert.equal(completedBody.counts.active, 0);
    assert.equal(completedBody.workingNow.some((item) => item.sessionId === session.id), false);
  } finally {
    await h.close();
  }
});
