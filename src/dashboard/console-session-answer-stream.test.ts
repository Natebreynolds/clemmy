/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/console-session-answer-stream.test.ts
 *
 * The desktop chat stream carries the live answer draft (answer-stream.ts):
 * a viewer that attaches mid-draft receives the text so far as one offset-0
 * frame after the replay, then each new piece, then the retraction. Frames
 * are unsequenced and never appear in the durable replay.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-answer-stream-route-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { beginAnswerDraft, resetAnswerStreamForTests } = await import('../runtime/harness/answer-stream.js');

after(() => {
  resetAnswerStreamForTests();
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

type Frame = { event: string; id?: string; data: Record<string, unknown> };
/** Read SSE frames until `count` live events arrive or the deadline passes. */
async function readFrames(reader: ReadableStreamDefaultReader<Uint8Array>, count: number, timeoutMs = 2_000): Promise<Frame[]> {
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && frames.filter((f) => f.event === 'event').length < count) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now()))),
    ]);
    if (!chunk || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const lines = buffer.slice(0, sep).split('\n');
      buffer = buffer.slice(sep + 2);
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
      const id = lines.find((l) => l.startsWith('id: '))?.slice(4);
      if (event && data) frames.push({ event, ...(id ? { id } : {}), data: JSON.parse(data) });
    }
  }
  return frames;
}

const ANSWER = 'Thursday has three meetings: the design review at 9:00, lunch with the vendor at 12:30, '
  + 'and quarterly planning at 3:00 in the large room.';

test('the desktop chat stream delivers the live draft after the replay, then its pieces and retraction', async () => {
  resetEventLog();
  const sessionId = 'console:answer-stream';
  createSession({ id: sessionId, kind: 'chat', title: 'answer stream' });
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'what is on thursday' } });
  const draft = beginAnswerDraft({ sessionId, sourceUserSeq: source.seq, mode: 'live' });
  draft.text(`${ANSWER.slice(0, 130)}`);

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/sessions/${encodeURIComponent(sessionId)}/events`);
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const first = await readFrames(reader, 1);
    assert.equal(first[0]?.event, 'replay');
    const replayed = (first[0]!.data.events as Array<{ type: string }>).map((e) => e.type);
    assert.ok(!replayed.includes('stream_token'), 'the draft is never part of the durable replay');
    const snapshot = first.find((f) => f.event === 'event')!;
    assert.equal(snapshot.data.type, 'stream_token');
    assert.equal(snapshot.data.seq, 0);
    const snapshotData = snapshot.data.data as Record<string, unknown>;
    assert.equal(snapshotData.offset, 0);
    assert.equal(snapshotData.sourceUserSeq, source.seq);
    const held = snapshotData.delta as string;
    assert.ok(ANSWER.startsWith(held) && held.length > 100);

    draft.text(ANSWER.slice(130));
    draft.complete(ANSWER);
    const piece = (await readFrames(reader, 1)).find((f) => f.event === 'event')!;
    assert.deepEqual(piece.data.data, {
      public: true, streamId: snapshotData.streamId, offset: held.length, delta: ANSWER.slice(held.length), sourceUserSeq: source.seq,
    });

    beginAnswerDraft({ sessionId, sourceUserSeq: source.seq, mode: 'live' });
    const retraction = (await readFrames(reader, 1)).find((f) => f.event === 'event')!;
    assert.deepEqual(retraction.data.data, { public: true, streamId: snapshotData.streamId, reset: true, sourceUserSeq: source.seq });
    await reader.cancel();
  } finally {
    await h.close();
  }
});
