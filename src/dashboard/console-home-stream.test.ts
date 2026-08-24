/**
 * Run: npx tsx --test src/dashboard/console-home-stream.test.ts
 *
 * Functional smoke for the console home NDJSON chat stream. Uses the real
 * registerConsoleRoutes with the host bridge's test seam so the test covers
 * route-level serialization without a model call.
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
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const { PUBLIC_RUN_FAILURE_TEXT } = await import('../runtime/harness/public-presentation.js');
const {
  appendEvent,
  claimRunAttemptLease,
  createSession,
  finishRunAttempt,
  getSession,
  listEvents,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { archiveBackgroundTask, listBackgroundTasks } = await import('../execution/background-tasks.js');

type StubRunOptions = { sessionId: string; sourceUserSeq?: number };
type StreamEvent = { type?: string; sessionId?: string; clientRequestId?: string; text?: string; error?: string; route?: { routeKind?: string; surface?: string } | null };

const RAW_MODEL_REASONING = 'Clementine is recovering from a stalled step.';
const okConfigure = (async () => ({ ok: true })) as never;
const fakeAgentBuilder = (async () => ({})) as never;

test.after(() => {
  delete process.env.CLEMMY_TURN_ENGINE;
  _setBridgeImplsForTests({});
  resetEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(runConversation?: (opts: StubRunOptions) => Promise<unknown>) {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (runConversation ?? (async (opts: StubRunOptions) => {
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'turn_started',
        data: {},
      });
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        // This is private model-proposed text. Only publicPresentation may
        // become the terminal stream frame.
        lastDecision: {
          summary: RAW_MODEL_REASONING,
          reply: RAW_MODEL_REASONING,
          done: true,
          nextAction: 'completed',
        },
        publicPresentation: { kind: 'answer', text: 'done' },
      };
    })) as never,
  });
  const app = express();
  app.use(express.json());
  const assistant = {
    respond: async () => {
      throw new Error('legacy assistant must not own a fresh Home chat turn');
    },
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
      !events.some((event) => event.text === RAW_MODEL_REASONING),
      'executor/model reasoning stays private',
    );
    const done = events.find((event) => event.type === 'done');
    assert.equal(done?.text, 'done', 'stream ends with done event');
    assert.equal(done?.route?.routeKind, 'harness', 'terminal frame includes host route diagnostics');
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

test('Home stream and JSON ordinary requests branch held parents and replay the same child once', async () => {
  resetEventLog();
  const approvalRegistry = await import('../runtime/harness/approval-registry.js');
  const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
  const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
  const seenSessions: string[] = [];
  const h = await boot(async (opts) => {
    seenSessions.push(opts.sessionId);
    const source = listEvents(opts.sessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === opts.sourceUserSeq);
    assert.ok(source);
    const identity = { sessionId: opts.sessionId, turn: source!.turn, sourceUserSeq: source!.seq };
    commitTurnOutcome({
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'done',
      resumable: false,
      presentation: { kind: 'answer', text: 'Fresh Home work completed.' },
    });
    return {
      sessionId: opts.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: 1,
      lastDecision: {
        summary: 'Fresh Home work completed.',
        reply: 'Fresh Home work completed.',
        done: true,
        nextAction: 'completed',
      },
      publicPresentation: { kind: 'answer', text: 'Fresh Home work completed.' },
    };
  });
  try {
    const makeHeldParent = (id: string) => {
      const parent = createSession({
        id,
        kind: 'chat',
        channel: 'desktop',
        userId: 'desktop',
        metadata: {
          source: 'desktop',
          ingressProvider: 'desktop',
          channelId: id,
          userId: 'desktop',
        },
      });
      const approval = approvalRegistry.register({
        sessionId: parent.id,
        channel: 'desktop',
        subject: `Older request on ${id} remains pending`,
        tool: 'request_approval',
        args: { reason: 'hold A while unrelated B runs' },
      });
      return { parent, approval };
    };

    const streamHeld = makeHeldParent('console:home-held-stream-parent');
    const streamBody = {
      message: 'Start unrelated work from Home stream.',
      sessionId: streamHeld.parent.id,
      clientRequestId: 'home-held-stream-source',
    };
    const sendStream = () => fetch(`${h.url}/api/console/home/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(streamBody),
    });
    const firstStream = parseNdjson(await (await sendStream()).text());
    const firstStreamDone = firstStream.find((event) => event.type === 'done');
    assert.ok(firstStreamDone?.sessionId);
    assert.notEqual(firstStreamDone?.sessionId, streamHeld.parent.id);
    const firstStreamEvents = listEvents(firstStreamDone!.sessionId!);
    assert.equal(
      firstStreamEvents.filter((event) => event.type === 'conversation_completed').length,
      1,
      JSON.stringify(firstStreamEvents.map((event) => ({ seq: event.seq, type: event.type, data: event.data }))),
    );
    const replayStream = parseNdjson(await (await sendStream()).text());
    assert.equal(replayStream.find((event) => event.type === 'done')?.sessionId, firstStreamDone?.sessionId);
    assert.equal(listEvents(streamHeld.parent.id, { types: ['user_input_received'] }).length, 0);
    assert.equal(approvalRegistry.get(streamHeld.approval.approvalId)?.status, 'pending');

    const jsonHeld = makeHeldParent('console:home-held-json-parent');
    const jsonBody = {
      message: 'Start unrelated work from Home JSON.',
      sessionId: jsonHeld.parent.id,
      clientRequestId: 'home-held-json-source',
    };
    const sendJson = () => fetch(`${h.url}/api/console/home/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonBody),
    });
    const firstJsonResponse = await sendJson();
    assert.equal(firstJsonResponse.status, 200);
    const firstJson = await firstJsonResponse.json() as { sessionId: string; clientRequestId: string; text: string };
    assert.notEqual(firstJson.sessionId, jsonHeld.parent.id);
    const replayJsonResponse = await sendJson();
    assert.equal(replayJsonResponse.status, 200);
    const replayJson = await replayJsonResponse.json() as typeof firstJson;
    assert.equal(replayJson.sessionId, firstJson.sessionId);
    assert.equal(replayJson.text, firstJson.text);
    assert.deepEqual(seenSessions, [firstStreamDone!.sessionId!, firstJson.sessionId]);
    assert.equal(listEvents(firstJson.sessionId, { types: ['user_input_received'] }).length, 1);
    assert.equal(listEvents(jsonHeld.parent.id, { types: ['user_input_received'] }).length, 0);
    assert.equal(approvalRegistry.get(jsonHeld.approval.approvalId)?.status, 'pending');

    const legacy = createSession({
      id: 'console:home-legacy-control',
      kind: 'chat',
      channel: 'desktop',
      metadata: { source: 'desktop' },
    });
    const legacyNewBody = {
      message: '/new',
      sessionId: legacy.id,
      clientRequestId: 'home-legacy-new-control',
    };
    const sendLegacyNew = () => fetch(`${h.url}/api/console/home/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(legacyNewBody),
    });
    const legacyNewResponse = await sendLegacyNew();
    assert.equal(legacyNewResponse.status, 200);
    const legacyNew = await legacyNewResponse.json() as { sessionId: string; text: string };
    assert.notEqual(legacyNew.sessionId, legacy.id);
    assert.match(legacyNew.text, /Fresh conversation ready/);
    assert.equal(getSession(legacy.id)?.metadata.channelId, legacy.id);
    assert.equal(getSession(legacy.id)?.metadata.userId, 'desktop');
    const legacyNewReplay = await sendLegacyNew();
    assert.equal(legacyNewReplay.status, 200);
    assert.deepEqual(await legacyNewReplay.json(), legacyNew);
    assert.equal(listEvents(legacy.id, { types: ['user_input_received'] }).length, 1);
    assert.deepEqual(seenSessions, [firstStreamDone!.sessionId!, firstJson.sessionId]);
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
  // Working Now is fed by the durable attempt and its lease, not by how fresh
  // the last event looks: a long turn under a held lease stays live however
  // quiet the provider goes, and it leaves the panel when the attempt settles.
  const claim = claimRunAttemptLease({
    sessionId: session.id,
    runId: 'limit-loop',
    ownerId: 'test-daemon',
    leaseMs: 30 * 60_000,
    nowMs: Date.now() - 5 * 60_000,
  });
  assert.ok(claim.attempt, 'the fixture must own the run it claims to be executing');
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
    finishRunAttempt(claim.attempt!, 'completed');
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
