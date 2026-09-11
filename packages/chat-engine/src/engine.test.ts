import { createPendingMessageStore } from './pending-request.js';
import { needsBindingPass, readTaskMode, checkedPlanArtifactResponse, canExecuteReviewedPlan, type TaskMode } from './task-mode.js';
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
  live: { onReplay(p: ReplayPayload): void; onEvent(e: HarnessEvent): void; onError(): void } | null = null;
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
    this.live = { onReplay: opts.onReplay, onEvent: opts.onEvent, onError: opts.onError };
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

test('approval consent facts survive both live delivery and transcript replay verbatim', async () => {
  const transport = new FakeTransport();
  const engine = new ChatEngine({ transport, api: {
    send: async () => ({ sessionId: 'consent-card', accepted: true }),
    loadSession: async () => ({ events: [], latestSeq: 0 }),
  } });
  const consentCall = { effect: 'external_write', accountId: 'account:exact-owner',
    risk: { reversibility: 'irreversible', consequence: 'send', destructive: false } };
  const approval = ev(2, 'approval_requested', { approvalId: 'apr-exact', subject: 'Send the exact message.', consentCall });
  try {
    await engine.send('Send the message');
    await wait(10);
    transport.live!.onEvent(approval);
    assert.deepEqual(engine.snapshot().messages.find(message => message.approval)?.approval?.consentCall, consentCall);
    assert.deepEqual(foldTranscript([approval])[0]?.approval?.consentCall, consentCall);
    assert.equal(engine.snapshot().busy, false);
  } finally { engine.dispose(); }
});

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

test('awaiting_user_input renders the question and releases mobile immediately', async () => {
  const transport = new FakeTransport();
  const engine = new ChatEngine({
    transport,
    api: {
      send: async () => ({ sessionId: 's-needs-input', accepted: true }),
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    },
  });
  await engine.send('Use whichever connected account I choose.');
  await wait(10);
  transport.live!.onEvent(ev(2, 'tool_called', { tool: 'tool_search', callId: 'search-1' }));
  transport.live!.onEvent(ev(3, 'awaiting_user_input', {
    question: 'Which connected account should I use?',
    options: ['work@example.com', 'personal@example.com'],
  }));

  const snap = engine.snapshot();
  const reply = snap.messages.find((message) => message.role === 'assistant');
  assert.equal(reply?.text, 'Which connected account should I use?');
  assert.equal(reply?.status, 'awaiting-reply');
  assert.equal(snap.busy, false, 'the composer must return to ordinary send mode');
  assert.equal(snap.cancelKey, null, 'Stop ownership ends at the user-input pause');
  engine.dispose();
});

test('a trailing completion for a prior awaiting source cannot settle the next mobile turn', async () => {
  const transport = new FakeTransport();
  const sessionId = 'sess-mob-3cd5b791c813490fcd61c65095ff87a5';
  const engine = new ChatEngine({
    transport,
    sessionId,
    api: {
      send: async () => ({ sessionId, accepted: true }),
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    },
  });

  await engine.send('Run my platform 59 flow please');
  await wait(10);
  transport.live!.onEvent(ev(100903, 'user_input_received', {
    text: 'Run my platform 59 flow please',
  }));
  const question = 'Which Platform flow do you want me to run?';
  transport.live!.onEvent(ev(100930, 'awaiting_user_input', {
    sourceUserSeq: 100903,
    question,
    options: ['platform-49-slack-channel-review', 'Skip'],
  }));
  assert.equal(engine.snapshot().busy, false, 'the first question releases the composer immediately');
  assert.equal(transport.live, null, 'awaiting_user_input still closes its completed live turn');

  await engine.send('Sorry platform 49');
  await wait(10);
  assert.equal(engine.snapshot().busy, true);

  // This is the canonical terminal paired with the prior awaiting event. It
  // was appended after the cursor where mobile stopped and therefore arrives
  // first on the new turn's replay.
  transport.live!.onReplay({ events: [
    ev(100934, 'conversation_completed', {
      sourceUserSeq: 100903,
      reason: 'awaiting_user_input',
      awaitingUser: true,
      reply: question,
    }),
  ] });
  let snap = engine.snapshot();
  assert.equal(snap.busy, true, 'the prior source terminal cannot stop the correction');
  assert.ok(transport.live, 'the stream drains through the prior terminal');
  assert.deepEqual(
    snap.messages.filter((message) => message.role === 'assistant').map((message) => message.text),
    [question, ''],
    'the prior terminal cannot rewrite the new assistant placeholder',
  );

  transport.live!.onReplay({ events: [
    ev(100935, 'user_input_received', {
      text: 'Sorry platform 49',
    }),
    ev(100940, 'conversation_completed', {
      sourceUserSeq: 100935,
      reply: 'I found platform-49-slack-channel-review and queued it.',
      reason: 'success',
    }),
  ] });

  snap = engine.snapshot();
  assert.equal(snap.busy, false);
  assert.deepEqual(snap.messages.map((message) => [message.role, message.text]), [
    ['user', 'Run my platform 59 flow please'],
    ['assistant', question],
    ['user', 'Sorry platform 49'],
    ['assistant', 'I found platform-49-slack-channel-review and queued it.'],
  ]);
  assert.equal(
    snap.messages.filter((message) => message.text === question).length,
    1,
    'the prior clarification renders exactly once',
  );
  assert.equal(
    snap.messages.filter((message) => message.text.includes('queued it')).length,
    1,
    'the new source terminal renders exactly once',
  );
  engine.dispose();
});

test('OPEN-THE-GATES 4.2: a send while busy steers the live turn instead of no-oping', async () => {
  const transport = new FakeTransport();
  const sent: Array<{ message: string; steerOnly?: boolean }> = [];
  const engine = new ChatEngine({
    transport,
    sessionId: 's-live',
    api: {
      send: async (input) => {
        sent.push({ message: input.message, steerOnly: input.steerOnly });
        return input.steerOnly
          ? { sessionId: 's-live', accepted: false, steered: true }
          : { sessionId: 's-live', accepted: true };
      },
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    },
    streamTimings: { reconnectBaseDelayMs: 5 },
  });
  await engine.send('first');
  await wait(10);
  assert.equal(engine.snapshot().busy, true);
  await engine.send('nudge while working');
  const snap = engine.snapshot();
  assert.equal(snap.busy, true, 'steer must not clear the live turn');
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.steerOnly, true);
  assert.equal(sent[1]?.message, 'nudge while working');
  const steer = snap.messages.find((m) => m.steer);
  assert.equal(steer?.steer, 'delivered');
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

test('a host conversation_preamble is the visible opening, not an internal event', async () => {
  const transport = new FakeTransport();
  const engine = new ChatEngine({
    transport,
    api: {
      send: async () => ({ sessionId: 'sess-preamble', accepted: true }),
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    },
  });
  const pending = engine.send('how many deals does Tim have');
  await wait(10);
  transport.live!.onEvent(ev(1, 'user_input_received', { text: 'how many deals does Tim have' }));
  transport.live!.onEvent(ev(2, 'tool_called', { tool: 'tool_search', callId: 'c-search' }));
  transport.live!.onEvent(ev(3, 'tool_returned', { tool: 'tool_search', callId: 'c-search' }));
  transport.live!.onEvent(ev(4, 'conversation_preamble', {
    text: "I'll pull Tim's open Salesforce deals with a close date this month.",
  }));
  const live = engine.snapshot().messages.find((m) => m.role === 'assistant');
  assert.equal(
    live?.text,
    "I'll pull Tim's open Salesforce deals with a close date this month.",
  );
  assert.equal(live?.status, 'thinking');
  engine.dispose();
  await pending.catch(() => undefined);
});

test('foldTranscript keeps a host preamble when the terminal has no other reply', () => {
  const messages = foldTranscript([
    ev(1, 'user_input_received', { text: 'how many deals' }),
    ev(2, 'conversation_preamble', { text: "I'll pull Tim's open deals." }),
    ev(3, 'conversation_completed', { reply: '' }),
  ]);
  const assistant = messages.find((m) => m.role === 'assistant');
  assert.equal(assistant?.text, "I'll pull Tim's open deals.");
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

test('foldTranscript keeps one canonical bubble for awaiting event plus completion', () => {
  const question = 'Which connected account should I use?';
  const messages = foldTranscript([
    ev(1, 'user_input_received', { text: 'Use my connected account.' }),
    ev(2, 'awaiting_user_input', { question }),
    ev(3, 'conversation_completed', {
      reason: 'awaiting_user_input',
      awaitingUser: true,
      reply: question,
    }),
  ]);
  assert.deepEqual(messages.map((message) => [message.role, message.text, message.status]), [
    ['user', 'Use my connected account.', undefined],
    ['assistant', question, 'awaiting-reply'],
  ]);
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
  activity = reduceActivity(activity, ev(5, 'external_write', { callId: 'mail-write', shapeKey: 'GMAIL_SEND_EMAIL', targets: ['a@b.co'], irreversible: true }));
  assert.ok(activity.some((a) => a.label === 'Sending a message to a@b.co' && a.status === 'running'));
  activity = reduceActivity(activity, ev(6, 'external_write_succeeded', { callId: 'mail-write', targets: ['a@b.co'] }));
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

test('renderMarkdown activates only the exact validated mobile Workspace handoff', () => {
  const good = renderMarkdown('[Open on mobile](/m/?tab=spaces&workspace=local-llm-content)');
  assert.match(good, /<a href="\/m\/\?tab=spaces&amp;workspace=local-llm-content"/);
  assert.doesNotMatch(good, /target="_blank"/, 'same-origin handoff stays in the paired WKWebView');
  for (const unsafe of [
    '[bad](/m/?tab=spaces&workspace=../secrets)',
    '[bad](/m/?tab=settings&workspace=local-llm-content)',
    '[bad](/api/console/spaces/local-llm-content/data)',
  ]) {
    assert.doesNotMatch(renderMarkdown(unsafe), /<a /);
  }
});


test('typed Plan and Execute modes preserve exact request bytes, reject mode-changing steering, and survive replay', async () => {
  const transport = new FakeTransport();
  const sent: unknown[] = [];
  const mode: TaskMode = { version: 1, kind: 'plan' };
  const ref = { planId: 'plan-review', revision: 2, digest: 'a'.repeat(64) };
  const engine = new ChatEngine({ transport, newIdempotencyKey: () => 'same-plan-key', api: {
    send: async input => { sent.push(structuredClone(input)); return { sessionId: 'plan-session', accepted: true }; },
    loadSession: async () => ({ events: [], latestSeq: 0 }),
  } });
  try {
    await engine.send('Investigate the workflow and workspace edits.', mode);
    await wait(10);
    assert.deepEqual(engine.snapshot().activeTaskMode, mode);
    await assert.rejects(engine.send('Execute', { version: 1, kind: 'execute', executeRef: ref }), /current turn/);
    await assert.rejects(engine.send('Change mode', { version: 1, kind: 'normal' }), /current turn/);
    assert.equal(sent.length, 1, 'Execute cannot become steering or a second active request');
    transport.live!.onEvent(ev(10, 'user_input_received', { text: 'Investigate the workflow and workspace edits.', taskMode: mode }));
    transport.live!.onEvent(ev(11, 'plan_revision_published', { artifact: { ...ref, sourceUserSeq: 10 } }));
    assert.deepEqual(engine.snapshot().messages.find(message => message.role === 'assistant')?.planArtifactRef, ref);
    transport.live!.onEvent(ev(12, 'conversation_completed', { sourceUserSeq: 10, reply: 'Review the full plan before Execute.', planArtifactRef: ref }));
    assert.equal(engine.snapshot().busy, false);
    await engine.send('Execute reviewed revision 2', { version: 1, kind: 'execute', executeRef: ref });
    ref.revision = 99;
    assert.equal((sent[1] as { taskMode: { executeRef: { revision: number } } }).taskMode.executeRef.revision, 2, 'request owns a copied exact revision');
    assert.equal(engine.snapshot().activeTaskMode?.kind, 'execute');
  } finally { engine.dispose(); }
  const exact = { ...ref, revision: 2 };
  const reopened = foldTranscript([
    ev(10, 'user_input_received', { text: 'Investigate.', taskMode: mode }),
    ev(11, 'plan_revision_published', { artifact: { ...exact, sourceUserSeq: 10 } }),
    ev(12, 'conversation_completed', { sourceUserSeq: 10, reply: 'Full plan ready to review.' }),
  ]);
  assert.deepEqual(reopened.at(-1)?.planArtifactRef, exact);
  assert.deepEqual(reopened.at(-1)?.taskMode, mode);
});

test('offline Execute survives storage and reopen with original session, key, and revision', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const store = createPendingMessageStore(storage, 'pending');
  const mode: TaskMode = { version: 1, kind: 'execute', executeRef: { planId: 'plan-1', revision: 4, digest: 'b'.repeat(64) } };
  store.save([{ id: 'pending-exact', role: 'user', text: 'Execute this reviewed revision', taskMode: mode,
    pending: 'sending', idempotencyKey: 'uncertain-202', requestSessionId: null }]);
  const sent: unknown[] = [];
  const engine = new ChatEngine({ transport: new FakeTransport(), pendingStore: store, sessionId: 'reopened-conversation', api: {
    send: async input => { sent.push(input); return { sessionId: 'accepted-branch', accepted: true }; },
    loadSession: async () => ({ events: [ev(1, 'user_input_received', { text: 'Earlier turn' }), ev(2, 'conversation_completed', { reply: 'Earlier answer' })], latestSeq: 2 }),
  } });
  try {
    await engine.open();
    assert.equal(engine.snapshot().messages.find(message => message.id === 'pending-exact')?.pending, 'failed');
    await engine.retry('pending-exact');
    assert.deepEqual(sent, [{ message: 'Execute this reviewed revision', sessionId: null, idempotencyKey: 'uncertain-202', taskMode: mode }]);
    assert.equal(values.has('pending'), false, 'observed acceptance removes the outbox identity');
  } finally { engine.dispose(); }
});

test('a reopened active Plan retains its mode and failed steering never creates another turn', async () => {
  const transport = new FakeTransport();
  const sent: unknown[] = [];
  const engine = new ChatEngine({ transport, sessionId: 'plan-running', pendingStore: {
    load: () => [{ id: 'steer', role: 'user', text: 'Add the dependency check', pending: 'failed', steer: 'failed', requestSessionId: 'plan-running', idempotencyKey: 'steer-key' }], save: () => {},
  }, api: {
    send: async input => { sent.push(input); return { sessionId: 'plan-running', accepted: false, steered: true }; },
    loadSession: async () => ({ events: [ev(3, 'user_input_received', { text: 'Investigate', taskMode: { version: 1, kind: 'plan' } })], latestSeq: 3 }),
  } });
  try {
    await engine.open();
    assert.equal(engine.snapshot().activeTaskMode?.kind, 'plan');
    const before = engine.snapshot().messages.filter(message => message.role === 'assistant').length;
    await engine.retry('steer');
    assert.equal((sent[0] as { steerOnly: boolean }).steerOnly, true);
    assert.equal('taskMode' in (sent[0] as object), false, 'steering inherits accepted mode without sending another mode declaration');
    assert.equal(engine.snapshot().messages.filter(message => message.role === 'assistant').length, before);
    assert.equal(engine.snapshot().busy, true);
    await engine.send('Keep the workspace edits in scope', { version: 1, kind: 'plan' });
    assert.equal('taskMode' in (sent[1] as object), false);
    assert.equal(engine.snapshot().activeTaskMode?.kind, 'plan');
  } finally { engine.dispose(); }
});

test('review requires complete exact artifact; stale revision stays explicit and malformed modes fail closed', () => {
  const ref = { planId: 'plan-full', revision: 1, digest: 'c'.repeat(64) };
  const fullText = 'Step and dependency detail. '.repeat(1000) + 'EXACT END';
  const artifact = { ...ref, version: 1, sessionId: 's', fullText, readiness: 'ready', missingPrerequisites: [], createdAt: 'now' };
  const checked = checkedPlanArtifactResponse({ artifact, latest: { ...ref, revision: 2, digest: 'd'.repeat(64) } }, ref);
  assert.equal(checked.artifact.fullText, fullText, 'no preview truncation');
  assert.equal(checked.latest.revision, 2, 'newer revision is disclosed, never substituted for reviewed content');
  assert.equal(canExecuteReviewedPlan(checked, ref), false, 'stale reviewed revision cannot execute');
  assert.equal(canExecuteReviewedPlan(checked, checked.latest), false, 'new selection cannot borrow the previously loaded full text');
  const current = { ...checked, latest: ref };
  assert.equal(canExecuteReviewedPlan(current, ref), true);
  assert.equal(canExecuteReviewedPlan({ ...current, artifact: { ...current.artifact, readiness: 'needs_input' } }, ref), false);
  assert.equal(canExecuteReviewedPlan({ ...current, execution: { executionRunId: 'already-claimed' } }, ref), false);
  assert.throws(() => checkedPlanArtifactResponse({ artifact: { ...artifact, revision: 2 }, latest: ref }, ref), /could not be verified/);
  assert.throws(() => checkedPlanArtifactResponse({ artifact: { ...artifact, fullText: '' }, latest: ref }, ref));
  assert.equal(readTaskMode({ version: 1, kind: 'execute', executeRef: { ...ref, grant: 'all' } }), undefined);
  assert.equal(readTaskMode({ version: 1, kind: 'plan', approved: true }), undefined);
  assert.equal(readTaskMode('plan'), undefined);
});

// A plan the owner can READ but not RUN needs a way to say "the shape is right".
// Live 2026-09-10: Plan mode now publishes the shape first, deliberately
// unbound — so Execute is correctly hidden, and without this predicate there is
// no button that means approval, leaving the readable plan and the runnable
// plan as two different artifacts.
test('an unbound plan offers a binding pass, and a ready one does not', () => {
  const shapeRef = { planId: 'plan-shape', revision: 1, digest: 'a'.repeat(64) };
  const shape = checkedPlanArtifactResponse({
    artifact: {
      ...shapeRef, version: 1, sessionId: 's',
      fullText: 'Read the brief, then fan out four research legs.',
      readiness: 'needs_input', missingPrerequisites: ['Which region leads?'], createdAt: 'now',
    },
    latest: shapeRef,
  }, shapeRef);
  assert.equal(canExecuteReviewedPlan(shape, shapeRef), false, 'a shape-only plan cannot execute');
  assert.equal(needsBindingPass(shape, shapeRef), true, 'so it offers the approval that binds it');

  const boundRef = { planId: 'plan-shape', revision: 2, digest: 'b'.repeat(64) };
  const bound = checkedPlanArtifactResponse({
    artifact: {
      ...boundRef, version: 1, sessionId: 's',
      fullText: 'Read the brief, then fan out four research legs.',
      readiness: 'ready', missingPrerequisites: [], createdAt: 'now',
    },
    latest: boundRef,
  }, boundRef);
  assert.equal(needsBindingPass(bound, boundRef), false, 'a bound plan needs no second approval');
  assert.equal(canExecuteReviewedPlan(bound, boundRef), true, 'it executes instead');

  // A ready plan that still carries prerequisites is not runnable either, and
  // asking for the binding pass is the honest offer.
  const withGaps = { ...bound, artifact: { ...bound.artifact, missingPrerequisites: ['Confirm the mailbox'] } };
  assert.equal(canExecuteReviewedPlan(withGaps, boundRef), false);
  assert.equal(needsBindingPass(withGaps, boundRef), true);

  // A plan already being executed never re-offers either action.
  const running = { ...bound, execution: { executionRunId: 'run-1' } };
  assert.equal(needsBindingPass(running, boundRef), false);
  assert.equal(canExecuteReviewedPlan(running, boundRef), false);
});
