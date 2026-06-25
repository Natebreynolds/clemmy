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
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');

test.after(() => {
  delete process.env.CLEMMY_HARNESS_HOME;
  resetEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot() {
  const app = express();
  app.use(express.json());
  const assistant = {
    respond: async (req: { sessionId: string; onReasoning?: (text: string) => void }) => {
      req.onReasoning?.('Clementine is recovering from a stalled step.');
      return { text: 'done', sessionId: req.sessionId };
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

test('home chat stream forwards specific progress text', async () => {
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/home/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: 'console:test-stream' }),
    });
    assert.equal(res.status, 200);
    const events = (await res.text())
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; text?: string });

    assert.ok(events.some((event) =>
      event.type === 'status' && event.text === 'Clementine is recovering from a stalled step.',
    ), 'stream preserves non-generic progress text');
    assert.ok(events.some((event) => event.type === 'done' && event.text === 'done'), 'stream ends with done event');
  } finally {
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
