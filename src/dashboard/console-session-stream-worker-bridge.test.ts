/**
 * Run: npx tsx --test src/dashboard/console-session-stream-worker-bridge.test.ts
 *
 * Pin for helper visibility. A turn that spawns a helper (run_worker) emits
 * `worker_started` on the PARENT session, but the helper's own tool frames
 * land under its worker session (`sess-worker-<sha>`), whose metadata carries
 * the lineage. Before 2026-09-08 the per-session stream forwarded only
 * `background:` and `workflow:` sessions, so the chat showed "1 agent working"
 * and never a single step the helper took. Owner: "seeing what Clem is doing
 * while she's doing it is key."
 *
 * Contract pinned here: a worker session whose metadata.parentSessionId is the
 * subscribed chat bridges its canonical activity into that stream, tagged with
 * `worker: { sessionId, item }` so the client can nest the steps under the
 * helper row — and a worker of some OTHER parent never leaks.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-worker-bridge-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');

after(() => {
  resetEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot() {
  const app = express();
  app.use(express.json());
  const assistant = { getRuntime: () => ({ listPendingApprovals: () => [] }) };
  registerConsoleRoutes(app, () => true, assistant as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function collectSse(res: Response, opts: { untilEventCount: number; timeoutMs: number }): Promise<Array<{ event: string; data: unknown }>> {
  const frames: Array<{ event: string; data: unknown }> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), remaining)),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
      const ev = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      frames.push({ event: ev, data: data ? JSON.parse(data) : undefined });
    }
    if (frames.filter((f) => f.event === 'event').length >= opts.untilEventCount) break;
  }
  try { await reader.cancel(); } catch { /* closing */ }
  return frames;
}

test('a helper’s own steps bridge into the parent chat stream, tagged with the helper', async () => {
  resetEventLog();
  const parentId = 'console:worker-parent';
  createSession({ id: parentId, kind: 'chat', title: 'parent chat' });
  const workerId = 'sess-worker-0123456789abcdef0123456789abcdef01234567';
  createSession({
    id: workerId, kind: 'agent', title: 'Worker: prospects',
    metadata: { source: 'delegated_worker', workerScope: true, parentSessionId: parentId, item: 'prospects', packetKey: 'pk' },
  });
  // A helper of a DIFFERENT parent — must never leak.
  const strangerId = 'sess-worker-ffffffffffffffffffffffffffffffffffffffff';
  createSession({
    id: strangerId, kind: 'agent', title: 'Worker: elsewhere',
    metadata: { source: 'delegated_worker', workerScope: true, parentSessionId: 'console:someone-else', item: 'elsewhere' },
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/sessions/${encodeURIComponent(parentId)}/events`, { headers: { accept: 'text/event-stream' } });
    assert.equal(res.status, 200);
    setTimeout(() => {
      appendEvent({ sessionId: workerId, turn: 1, role: 'agent', type: 'tool_called', data: { tool: 'web_search', callId: 'c1', arguments: JSON.stringify({ query: 'law firms in Boise' }) } });
      appendEvent({ sessionId: workerId, turn: 1, role: 'agent', type: 'tool_returned', data: { tool: 'web_search', callId: 'c1', ok: true } });
      appendEvent({ sessionId: strangerId, turn: 1, role: 'agent', type: 'tool_called', data: { tool: 'memory_search', callId: 'c9', arguments: '{}' } });
    }, 150);
    const frames = await collectSse(res, { untilEventCount: 2, timeoutMs: 5_000 });
    const live = frames.filter((f) => f.event === 'event').map((f) => f.data as { type?: string; data?: Record<string, unknown>; worker?: { sessionId?: string; item?: string } });
    const called = live.find((e) => e.type === 'tool_called' && e.data?.tool === 'web_search');
    assert.ok(called, 'the helper’s tool_called reaches the parent chat stream');
    assert.deepEqual(called.worker, { sessionId: workerId, item: 'prospects' }, 'the frame names the helper it belongs to');
    const returned = live.find((e) => e.type === 'tool_returned');
    assert.equal(returned?.worker?.item, 'prospects');
    assert.equal(live.find((e) => e.data?.tool === 'memory_search'), undefined, 'another parent’s helper never leaks');
  } finally {
    await h.close();
  }
});
