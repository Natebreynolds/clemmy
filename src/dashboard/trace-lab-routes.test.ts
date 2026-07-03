/**
 * Run: npx tsx --test src/dashboard/trace-lab-routes.test.ts
 *
 * Route smoke for Trace Lab: list/detail/replay-preview are auth-gated and
 * backed by the canonical harness event log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-trace-routes-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { createSession, appendEvent } = await import('../runtime/harness/eventlog.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

async function boot(authorized = { v: true }) {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized.v, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('Trace Lab routes require authorization', async () => {
  const h = await boot({ v: false });
  try {
    const res = await fetch(`${h.url}/api/console/traces`);
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});

test('Trace Lab routes return summary, detail, and safe replay preview', async () => {
  const sess = createSession({ id: 'trace-route-demo', kind: 'chat', title: 'Trace Route Demo' });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Check the route.' } });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'orchestrator', type: 'tool_called', data: { tool: 'read_file', callId: 'call-read', arguments: '{"path":"x"}' } });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'orchestrator', type: 'tool_returned', data: { tool: 'read_file', callId: 'call-read', output: 'ok' } });

  const h = await boot();
  try {
    const list = await (await fetch(`${h.url}/api/console/traces?limit=5&status=any`)).json() as { traces: Array<{ sessionId: string; metrics: { toolCalls: number } }> };
    const row = list.traces.find((trace) => trace.sessionId === sess.id);
    assert.ok(row);
    assert.equal(row.metrics.toolCalls, 1);

    const detail = await (await fetch(`${h.url}/api/console/traces/${encodeURIComponent(sess.id)}`)).json() as { trace: { nodes: unknown[]; edges: Array<{ kind: string }> } };
    assert.equal(detail.trace.nodes.length, 3);
    assert.ok(detail.trace.edges.some((edge) => edge.kind === 'tool_result'));

    const replay = await (await fetch(`${h.url}/api/console/traces/${encodeURIComponent(sess.id)}/replay-preview`, { method: 'POST' })).json() as { replay: { mode: string; prompt: string } };
    assert.equal(replay.replay.mode, 'safe_prompt');
    assert.match(replay.replay.prompt, /SAFE regression\/debugging/);
  } finally {
    await h.close();
  }
});
