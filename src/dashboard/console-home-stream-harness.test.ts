/**
 * Run: npx tsx --test src/dashboard/console-home-stream-harness.test.ts
 *
 * The HARNESS-path twin of console-home-stream.test.ts. That file pins the
 * home surface to the legacy break-glass to cover the old machinery; this one
 * covers the DEFAULT route every user actually gets: home chat rides
 * respondPreferHarness, and the route must still translate harness progress
 * into {type:'status'|'tool'} NDJSON frames and a harness failure into a
 * terminal {type:'error'} frame — the silent-hang class lives exactly here.
 * The bridge's model layers are injected via _setBridgeImplsForTests; the
 * stub assistant's legacy respond must never be called.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-home-stream-harness-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
// Default routing on purpose: no CLEMMY_HARNESS_HOME pin, no legacy fallback.
delete process.env.CLEMMY_HARNESS_HOME;
delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
process.env.AUTH_MODE = 'api_key';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const { appendEvent, resetEventLog } = await import('../runtime/harness/eventlog.js');

type StreamEvent = {
  type?: string;
  text?: string;
  error?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  stoppedReason?: string;
  route?: { routeKind?: string; surface?: string } | null;
};

const okConfigure = (async () => ({ ok: true })) as never;
const fakeAgentBuilder = (async () => ({})) as never;

after(() => {
  _setBridgeImplsForTests({});
  resetEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot() {
  const app = express();
  app.use(express.json());
  let legacyCalls = 0;
  const assistant = {
    respond: async () => {
      legacyCalls += 1;
      throw new Error('legacy respond must not run on the default route');
    },
    getRuntime: () => ({ listPendingApprovals: () => [] }),
  };
  registerConsoleRoutes(app, () => true, assistant as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    legacyCalls: () => legacyCalls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function parseNdjson(text: string): StreamEvent[] {
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
}

test('harness home stream forwards tool + progress frames and finishes with harness route diagnostics', async () => {
  resetEventLog();
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      // Events appended DURING the run fan out via the action bus to the
      // bridge's progress relay → the route's onReasoning/onToolActivity.
      appendEvent({ sessionId: opts.sessionId, turn: 1, role: 'agent', type: 'turn_started', data: {} });
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'memory_search', arguments: JSON.stringify({ query: 'status' }) },
      });
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 's', reply: 'The full report is ready.', done: true, nextAction: 'completed' },
      };
    }) as never,
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/home/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: 'console:harness-stream' }),
    });
    assert.equal(res.status, 200);
    const events = parseNdjson(await res.text());

    const tool = events.find((event) => event.type === 'tool');
    assert.equal(tool?.toolName, 'memory_search', 'harness tool_called reaches the stream as a tool frame');
    assert.deepEqual(tool?.input, { query: 'status' });
    assert.ok(
      events.some((event) => event.type === 'status' && /planning the next step/i.test(event.text ?? '')),
      'harness lifecycle progress reaches the stream as status frames',
    );
    const done = events.find((event) => event.type === 'done');
    assert.equal(done?.text, 'The full report is ready.', 'reply text survives to the done frame');
    assert.equal(done?.route?.routeKind, 'harness', 'terminal frame reports the harness route');
    assert.equal(done?.route?.surface, 'home');
    assert.equal(h.legacyCalls(), 0, 'legacy respond never ran');
  } finally {
    await h.close();
  }
});

test('harness home stream emits a terminal error frame when the run fails', async () => {
  resetEventLog();
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => ({
      sessionId: opts.sessionId,
      status: 'failed',
      steps: 1,
      lastTurn: 1,
      error: 'runtime exploded',
    })) as never,
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/home/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: 'console:harness-stream-error' }),
    });
    assert.equal(res.status, 200);
    const events = parseNdjson(await res.text());

    const error = events.find((event) => event.type === 'error');
    assert.match(error?.error ?? '', /runtime exploded/, 'harness failure surfaces in the stream');
    assert.equal(events.at(-1)?.type, 'error', 'stream closes on the terminal error frame — never a silent hang');
    assert.equal(h.legacyCalls(), 0, 'no silent legacy retry after a harness failure');
  } finally {
    await h.close();
  }
});
