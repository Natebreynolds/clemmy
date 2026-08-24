/**
 * Run: npx tsx --test packages/chat-engine/src/engine.test.ts
 *
 * Pins the engine's survival properties — the exact classes that broke live:
 *  1. A dead stream is recovered by POLL first, so a terminal that landed
 *     during the outage is delivered (the "34s turn completed server-side,
 *     phone never rendered it" defect).
 *  2. Every reconnect attempt asks the transport for a FRESH connection
 *     (single-use stream tickets make URL-reuse retries permanently 401).
 *  3. resume() after a webview suspension catches up and re-attaches.
 *  4. Duplicate events across poll/replay overlap are inert; token deltas
 *     (seq 0) always pass through; bridged frames never advance the cursor.
 *  5. Markdown renders sanitized; reducer correlates tools by callId.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessEvent, ReplayPayload } from './types.js';
import { runChatStream, type StreamTransport, type StreamConnection } from './stream.js';
import { ChatEngine, foldTranscript, inFlightTurnSince } from './engine.js';
import { reduceActivity } from './reduce-activity.js';
import { renderMarkdown } from './markdown.js';

class FakeTransport implements StreamTransport {
  connectCalls = 0;
  failConnects = 0;
  recentPayloads: ReplayPayload[] = [];
  live: { onEvent(e: HarnessEvent): void; onError(): void } | null = null;
  fetchRecentCalls = 0;
  connectedSessionIds: string[] = [];

  async connect(opts: {
    sessionId: string; sinceSeq: number;
    onReplay(p: ReplayPayload): void; onEvent(e: HarnessEvent): void; onError(): void;
  }): Promise<StreamConnection> {
    this.connectCalls += 1;
    this.connectedSessionIds.push(opts.sessionId);
    if (this.failConnects > 0) {
      this.failConnects -= 1;
      throw new Error('connect refused');
    }
    this.live = { onEvent: opts.onEvent, onError: opts.onError };
    queueMicrotask(() => opts.onReplay({ sessionId: opts.sessionId, events: [] }));
    return { close: () => { if (this.live) this.live = null; } };
  }

  async fetchRecent(): Promise<ReplayPayload> {
    this.fetchRecentCalls += 1;
    return this.recentPayloads.shift() ?? { events: [] };
  }
}

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): HarnessEvent =>
  ({ seq, type, data });

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('stream death recovers by poll first and delivers the missed terminal', async () => {
  const transport = new FakeTransport();
  const delivered: HarnessEvent[] = [];
  let terminal = false;
  // The terminal landed while the stream was down — the poll must find it.
  transport.recentPayloads.push({ events: [ev(10, 'tool_called', { tool: 'run_shell_command' }), ev(12, 'conversation_completed', { reply: 'here' })] });
  const stream = runChatStream({
    sessionId: 's1',
    transport,
    sinceSeq: 5,
    onEvent: (e) => delivered.push(e),
    onTerminal: () => { terminal = true; },
    reconnectBaseDelayMs: 5,
    reconnectMaxDelayMs: 10,
  });
  await wait(10); // initial connect
  assert.equal(transport.connectCalls, 1);
  transport.live!.onError(); // the socket dies
  await wait(30);
  assert.equal(terminal, true, 'missed terminal must be delivered by the recovery poll');
  assert.deepEqual(delivered.map((e) => e.seq), [10, 12]);
  assert.equal(stream.cursor(), 12);
  stream.stop();
});

test('every reconnect attempt is a FRESH transport connect (single-use tickets)', async () => {
  const transport = new FakeTransport();
  transport.failConnects = 3; // first attempts all die
  const stream = runChatStream({
    sessionId: 's1',
    transport,
    onEvent: () => {},
    reconnectBaseDelayMs: 5,
    reconnectMaxDelayMs: 5,
  });
  await wait(80);
  assert.ok(transport.connectCalls >= 3, `expected fresh connects per attempt, saw ${transport.connectCalls}`);
  assert.ok(transport.live, 'eventually connected fresh');
  stream.stop();
});

test('resume() after suspension polls catch-up and re-attaches when the socket is gone', async () => {
  const transport = new FakeTransport();
  const delivered: HarnessEvent[] = [];
  const stream = runChatStream({
    sessionId: 's1',
    transport,
    onEvent: (e) => delivered.push(e),
    reconnectBaseDelayMs: 60_000, // recovery timer far away — resume() must not wait for it
    reconnectWindowMs: 100,
  });
  await wait(10);
  // Suspension: socket dies, outage exceeds the window, stream detaches.
  transport.recentPayloads.push({ events: [] });
  transport.live!.onError();
  await wait(10);
  // User returns: resume must poll (finding the missed reply) and reconnect.
  transport.recentPayloads.push({ events: [ev(30, 'user_input_received', { text: 'hi' })] });
  const before = transport.connectCalls;
  stream.resume();
  await wait(20);
  assert.ok(delivered.some((e) => e.seq === 30), 'resume() must deliver the missed events');
  assert.ok(transport.connectCalls > before, 'resume() must re-attach a fresh stream');
  stream.stop();
});

test('duplicates are inert, token deltas always pass, bridged frames never move the cursor', async () => {
  const transport = new FakeTransport();
  const delivered: HarnessEvent[] = [];
  const stream = runChatStream({ sessionId: 's1', transport, onEvent: (e) => delivered.push(e) });
  await wait(10);
  transport.live!.onEvent(ev(7, 'tool_called', { tool: 'x' }));
  transport.live!.onEvent(ev(7, 'tool_called', { tool: 'x' })); // replay duplicate
  transport.live!.onEvent({ seq: 0, type: 'stream_token', data: { delta: 'a' } });
  transport.live!.onEvent({ seq: 0, type: 'stream_token', data: { delta: 'b' } });
  transport.live!.onEvent({ seq: 999, type: 'tool_called', sessionId: 'workflow:r1:step', data: { tool: 'y' } });
  assert.equal(delivered.filter((e) => e.seq === 7).length, 1, 'durable duplicate dropped');
  assert.equal(delivered.filter((e) => e.type === 'stream_token').length, 2, 'deltas always pass');
  assert.equal(stream.cursor(), 7, 'foreign-session seq must not advance the cursor');
  stream.stop();
});

test('ChatEngine send → stream → terminal reconciliation, with streamed text fallback', async () => {
  const transport = new FakeTransport();
  const engine = new ChatEngine({
    transport,
    api: {
      send: async () => ({ sessionId: 's-new', accepted: true }),
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    },
    streamTimings: { reconnectBaseDelayMs: 5 },
  });
  await engine.send('hello there');
  await wait(10);
  let snap = engine.snapshot();
  assert.equal(snap.sessionId, 's-new');
  assert.equal(snap.busy, true);
  assert.equal(snap.messages.length, 2);
  assert.equal(snap.messages[0].pending, undefined, 'send resolved — echo confirmed');

  transport.live!.onEvent({ seq: 0, type: 'stream_token', data: { delta: 'Hi ' } });
  transport.live!.onEvent({ seq: 0, type: 'stream_token', data: { delta: 'Nathan' } });
  transport.live!.onEvent(ev(2, 'tool_called', { tool: 'web_search', callId: 'c1', args: '{"query":"x"}' }));
  transport.live!.onEvent(ev(3, 'tool_returned', { tool: 'web_search', callId: 'c1', ok: true }));
  snap = engine.snapshot();
  assert.equal(snap.messages[1].text, 'Hi Nathan', 'token deltas accumulate');
  assert.equal(snap.messages[1].activity?.length, 1);
  assert.equal(snap.messages[1].activity?.[0].status, 'done');

  // Terminal WITHOUT a reply body: the streamed text is the answer.
  transport.live!.onEvent(ev(4, 'conversation_completed', { reason: 'completed' }));
  snap = engine.snapshot();
  assert.equal(snap.busy, false);
  assert.equal(snap.messages[1].status, 'complete');
  assert.equal(snap.messages[1].text, 'Hi Nathan', 'streamed text survives an empty terminal');
  engine.dispose();
});

test('ChatEngine adopts a server-selected successor for an existing held session', async () => {
  const transport = new FakeTransport();
  const engine = new ChatEngine({
    transport,
    sessionId: 'held-parent-a',
    api: {
      send: async (input) => {
        assert.equal(input.sessionId, 'held-parent-a');
        return { sessionId: 'fresh-successor-b', accepted: true };
      },
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    },
  });
  await engine.send('unrelated fresh work');
  await wait(10);
  assert.equal(engine.snapshot().sessionId, 'fresh-successor-b');
  assert.equal(transport.connectedSessionIds.at(-1), 'fresh-successor-b');
  engine.dispose();
});

test('ChatEngine open() reattaches to an in-flight turn', async () => {
  const transport = new FakeTransport();
  const events: HarnessEvent[] = [
    ev(1, 'user_input_received', { text: 'earlier question' }),
    ev(2, 'conversation_completed', { reply: 'earlier answer' }),
    ev(3, 'user_input_received', { text: 'still running' }),
    ev(4, 'tool_called', { tool: 'run_shell_command', callId: 'c9' }),
  ];
  const engine = new ChatEngine({
    transport,
    sessionId: 'sess-live',
    api: {
      send: async () => ({ sessionId: 'sess-live', accepted: true }),
      loadSession: async () => ({ events, latestSeq: 4 }),
    },
  });
  await engine.open();
  await wait(10);
  const snap = engine.snapshot();
  assert.equal(snap.busy, true, 'unterminated user input means a live turn');
  assert.ok(transport.live, 'stream attached');
  // The finished turn folded into the transcript.
  assert.ok(snap.messages.some((m) => m.role === 'assistant' && m.text === 'earlier answer'));
  engine.dispose();
});

test('inFlightTurnSince and foldTranscript agree on turn boundaries', () => {
  const settled: HarnessEvent[] = [
    ev(1, 'user_input_received', { text: 'q' }),
    ev(2, 'conversation_completed', { reply: 'a' }),
  ];
  assert.equal(inFlightTurnSince(settled), null);
  const inflight = [...settled, ev(3, 'user_input_received', { text: 'q2' })];
  assert.equal(inFlightTurnSince(inflight), 2);
  const messages = foldTranscript(settled);
  assert.deepEqual(messages.map((m) => [m.role, m.text]), [['user', 'q'], ['assistant', 'a']]);
});

test('failed send keeps the echo retryable and drops the empty placeholder', async () => {
  const transport = new FakeTransport();
  let attempts = 0;
  const engine = new ChatEngine({
    transport,
    api: {
      send: async () => { attempts += 1; throw new Error('offline'); },
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    },
  });
  await engine.send('will fail');
  const snap = engine.snapshot();
  assert.ok(attempts >= 3, 'send retries before surfacing failure');
  assert.equal(snap.busy, false);
  assert.equal(snap.messages.length, 1, 'assistant placeholder dropped');
  assert.equal(snap.messages[0].pending, 'failed');
  engine.dispose();
});

test('reduceActivity: batch meter, deliverables roll-up, external write phrasing', () => {
  let activity = reduceActivity([], ev(1, 'batch_started', { batchId: 'b1', items: 3, slug: 'gmail_send_email', sideEffect: 'send' }));
  activity = reduceActivity(activity, ev(2, 'batch_progress', { batchId: 'b1', done: 2, total: 3, failed: 0 }));
  assert.equal(activity[0].batch?.done, 2);
  activity = reduceActivity(activity, ev(3, 'deliverable_saved', { name: 'brief.md' }));
  activity = reduceActivity(activity, ev(4, 'deliverable_saved', { name: 'notes.md' }));
  assert.ok(activity.some((a) => a.label === 'Saved 2 files · latest notes.md'));
  activity = reduceActivity(activity, ev(5, 'external_write', { shapeKey: 'GMAIL_SEND_EMAIL', targets: ['a@b.co'], irreversible: true }));
  assert.ok(activity.some((a) => a.label === 'Sent a message to a@b.co'));
});

test('renderMarkdown sanitizes and covers the reply structures', () => {
  const html = renderMarkdown('# Hi\n\n**bold** and *em* and `code`\n\n- one\n- two\n\n[link](https://x.co)\n\n<script>alert(1)</script>');
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>em</em>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<ul><li>one</li><li>two</li></ul>'));
  assert.ok(html.includes('href="https://x.co"'));
  assert.ok(!html.includes('<script>'), 'raw HTML must never survive');
  assert.ok(html.includes('&lt;script&gt;'));
  // javascript: links stay literal text.
  const bad = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!bad.includes('<a '), 'non-http(s) links must not become anchors');
});
