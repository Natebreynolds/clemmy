/**
 * Run: npx tsx --test src/dashboard/console-workflow-run-activity-stream.test.ts
 *
 * Pin for workflow run visibility. A run's steps execute under their own
 * harness sessions (`workflow:<runId>:<step>`), and a step may spawn a helper
 * under `sess-worker-*`. Their public frames reached nobody unless the run had
 * an origin chat — a cron run or a Run-button run streamed into the void, and
 * Automate polled artifacts every 4s. Owner 2026-09-08: "similar pass with the
 * workflow section visibility".
 *
 * Contract: GET /api/console/workflows/runs/:runId/activity replays the run's
 * canonical activity and streams new frames, each tagged with its `step` (and
 * `worker` when a helper made it); frames from another run never leak.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-run-activity-'));
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

type Frame = { type?: string; step?: string; worker?: { sessionId: string; item: string }; data?: Record<string, unknown> };

test('a run’s step sessions and their helpers stream into one tagged feed; other runs never leak', async () => {
  resetEventLog();
  const runId = 'run-visible-1';
  const collect = `workflow:${runId}:collect`;
  const draft = `workflow:${runId}:draft`;
  createSession({ id: collect, kind: 'workflow', title: 'collect', metadata: { source: 'workflow', workflowRunId: runId, stepId: 'collect' } });
  createSession({ id: draft, kind: 'workflow', title: 'draft', metadata: { source: 'workflow', workflowRunId: runId, stepId: 'draft' } });
  const helper = 'sess-worker-1111111111111111111111111111111111111111';
  createSession({ id: helper, kind: 'agent', title: 'Worker: firm-a', metadata: { source: 'delegated_worker', parentSessionId: collect, item: 'firm-a' } });
  const otherRun = 'workflow:run-other:collect';
  createSession({ id: otherRun, kind: 'workflow', title: 'other', metadata: { source: 'workflow', workflowRunId: 'run-other', stepId: 'collect' } });

  // Already happened before the viewer opened the run.
  appendEvent({ sessionId: collect, turn: 1, role: 'agent', type: 'tool_called', data: { tool: 'salesforce_query', callId: 'c0', arguments: '{}' } });
  appendEvent({ sessionId: collect, turn: 1, role: 'agent', type: 'tool_returned', data: { tool: 'salesforce_query', callId: 'c0', ok: true } });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/runs/${runId}/activity`, { headers: { accept: 'text/event-stream' } });
    assert.equal(res.status, 200);
    setTimeout(() => {
      appendEvent({ sessionId: draft, turn: 1, role: 'agent', type: 'tool_called', data: { tool: 'outlook_create_draft', callId: 'c1', arguments: '{}' } });
      appendEvent({ sessionId: helper, turn: 1, role: 'agent', type: 'tool_called', data: { tool: 'web_search', callId: 'c2', arguments: '{}' } });
      appendEvent({ sessionId: otherRun, turn: 1, role: 'agent', type: 'tool_called', data: { tool: 'memory_search', callId: 'c9', arguments: '{}' } });
    }, 150);
    const frames = await collectSse(res, { untilEventCount: 2, timeoutMs: 5_000 });

    const replay = frames.find((f) => f.event === 'replay')?.data as { runId?: string; events?: Frame[] } | undefined;
    assert.equal(replay?.runId, runId);
    const replayed = replay?.events ?? [];
    assert.ok(replayed.some((e) => e.type === 'tool_called' && e.data?.tool === 'salesforce_query' && e.step === 'collect'), 'replay carries the earlier step activity, tagged with its step');

    const live = frames.filter((f) => f.event === 'event').map((f) => f.data as Frame);
    const stepFrame = live.find((e) => e.data?.tool === 'outlook_create_draft');
    assert.equal(stepFrame?.step, 'draft', 'a live step frame names its step');
    const helperFrame = live.find((e) => e.data?.tool === 'web_search');
    assert.equal(helperFrame?.step, 'collect', 'a helper’s step is attributed to the step that spawned it');
    assert.deepEqual(helperFrame?.worker, { sessionId: helper, item: 'firm-a' });
    assert.equal(live.find((e) => e.data?.tool === 'memory_search'), undefined, 'another run’s frames never leak');
  } finally {
    await h.close();
  }
});

test('a run id with a colon is refused, not searched', async () => {
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/workflows/runs/${encodeURIComponent('run:evil')}/activity`);
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});
