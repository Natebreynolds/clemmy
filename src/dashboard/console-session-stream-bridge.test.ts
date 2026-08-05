/**
 * Run: npx tsx --test src/dashboard/console-session-stream-bridge.test.ts
 *
 * Pin for the promoted-work visibility bridge. When a chat turn promotes
 * heavy work to a background task, the work runs under its own session
 * (`background:<taskId>`), but the user keeps watching the ORIGIN chat
 * session's SSE stream. Without a bridge, that stream goes silent for the
 * entire run — the live 2026-08-04 "are you working on this?" defect: chat
 * shows nothing while the batch meter, tool frames, and worker tallies all
 * flow to a session nobody is subscribed to.
 *
 * Contract pinned here: the per-session stream forwards public events from
 * background tasks whose originSessionId is the subscribed chat session —
 * and ONLY those; unrelated background sessions must not leak.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-session-bridge-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { createBackgroundTask, markBackgroundTaskRunning } = await import('../execution/background-tasks.js');

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

/** Collect SSE frames from a response body until deadline or predicate hit. */
async function collectSse(
  res: Response,
  opts: { untilEventCount?: number; timeoutMs: number },
): Promise<Array<{ event: string; data: unknown }>> {
  const frames: Array<{ event: string; data: unknown }> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), remaining)),
    ]);
    if (!chunk || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const eventLine = raw.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      frames.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
    }
    const liveEvents = frames.filter((f) => f.event === 'event').length;
    if (opts.untilEventCount && liveEvents >= opts.untilEventCount) break;
  }
  void reader.cancel().catch(() => { /* stream teardown */ });
  return frames;
}

test('origin chat stream carries live public events from its promoted background task', async () => {
  resetEventLog();
  const originId = 'console:bridge-origin';
  createSession({ id: originId, kind: 'chat', title: 'origin chat' });

  const task = createBackgroundTask({
    title: 'Research 29 dormant accounts',
    prompt: 'research and draft',
    originSessionId: originId,
    source: 'chat',
  } as never);
  markBackgroundTaskRunning(task.id);

  // A second, UNRELATED background task — its events must never leak into
  // this chat stream.
  const stranger = createBackgroundTask({
    title: 'Unrelated maintenance',
    prompt: 'sweep',
    originSessionId: 'console:someone-else',
    source: 'chat',
  } as never);
  markBackgroundTaskRunning(stranger.id);

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/sessions/${encodeURIComponent(originId)}/events`, {
      headers: { accept: 'text/event-stream' },
    });
    assert.equal(res.status, 200);

    // Give the subscription a beat to attach, then emit run activity under
    // the task's own session — exactly what the harness does mid-run.
    setTimeout(() => {
      appendEvent({
        sessionId: task.runSessionId!,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'web_search', arguments: JSON.stringify({ query: 'firm digital footprint' }) },
      });
      appendEvent({
        sessionId: task.runSessionId!,
        turn: 1,
        role: 'agent',
        type: 'batch_progress',
        data: { batchId: 'accounts', done: 12, total: 29, failed: 0 },
      });
      // Leak check: activity from the unrelated task.
      appendEvent({
        sessionId: stranger.runSessionId!,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'memory_search', arguments: '{}' },
      });
    }, 150);

    const frames = await collectSse(res, { untilEventCount: 2, timeoutMs: 5_000 });

    const live = frames.filter((f) => f.event === 'event').map((f) => f.data as { type?: string; data?: Record<string, unknown> });
    const bridgedTool = live.find((e) => e.type === 'tool_called' && (e.data as { tool?: string } | undefined)?.tool === 'web_search');
    assert.ok(
      bridgedTool,
      'tool_called from the promoted task\'s run session reaches the origin chat stream (the silent-chat defect)',
    );
    const bridgedBatch = live.find((e) => e.type === 'batch_progress');
    assert.ok(bridgedBatch, 'batch_progress (12/29) from the promoted task reaches the origin chat stream');

    const leaked = live.find((e) => e.type === 'tool_called' && (e.data as { tool?: string } | undefined)?.tool === 'memory_search');
    assert.equal(leaked, undefined, 'events from an unrelated background task never leak into this chat stream');
  } finally {
    await h.close();
  }
});

test('chat session own events still stream unchanged alongside the bridge', async () => {
  resetEventLog();
  const originId = 'console:bridge-own-events';
  createSession({ id: originId, kind: 'chat', title: 'origin chat' });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/sessions/${encodeURIComponent(originId)}/events`, {
      headers: { accept: 'text/event-stream' },
    });
    assert.equal(res.status, 200);
    setTimeout(() => {
      appendEvent({
        sessionId: originId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'memory_search', arguments: '{}' },
      });
    }, 150);
    const frames = await collectSse(res, { untilEventCount: 1, timeoutMs: 5_000 });
    const live = frames.filter((f) => f.event === 'event').map((f) => f.data as { type?: string });
    assert.ok(live.some((e) => e.type === 'tool_called'), 'own-session events still arrive');
  } finally {
    await h.close();
  }
});

test('bridged tool events are canonical only — transport mirrors never double the strip rows', async () => {
  resetEventLog();
  const originId = 'console:bridge-mirror-dedup';
  createSession({ id: originId, kind: 'chat', title: 'origin chat' });
  const task = createBackgroundTask({
    title: 'Mirror dedup check',
    prompt: 'local work',
    originSessionId: originId,
    source: 'chat',
  } as never);
  markBackgroundTaskRunning(task.id);

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/sessions/${encodeURIComponent(originId)}/events`, {
      headers: { accept: 'text/event-stream' },
    });
    assert.equal(res.status, 200);
    setTimeout(() => {
      // The native lane logs each MCP call twice: canonical + transport mirror.
      appendEvent({
        sessionId: task.runSessionId!, turn: 1, role: 'agent', type: 'tool_called',
        data: { tool: 'run_shell_command', callId: 'toolu_canon', accounting: 'top_level', arguments: '{}' },
      });
      appendEvent({
        sessionId: task.runSessionId!, turn: 1, role: 'agent', type: 'tool_called',
        data: { tool: 'run_shell_command', callId: 'mcp-mirror', accounting: 'transport_mirror', arguments: '{}' },
      });
    }, 150);
    const frames = await collectSse(res, { untilEventCount: 1, timeoutMs: 5_000 });
    // Give the (unwanted) mirror a moment to arrive if it were going to.
    await new Promise((r) => setTimeout(r, 400));
    const live = frames.filter((f) => f.event === 'event').map((f) => f.data as { type?: string; data?: Record<string, unknown> });
    const toolRows = live.filter((e) => e.type === 'tool_called');
    assert.equal(toolRows.length, 1, 'one logical call bridges as ONE row');
    assert.equal((toolRows[0]?.data as { callId?: string } | undefined)?.callId, 'toolu_canon');
  } finally {
    await h.close();
  }
});
