import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatPostCancelledError,
  postPendingChatWithRetry,
  reduceActivity,
  retainPendingChatPost,
  type ActivityItem,
} from './useChat';
import {
  cancelPendingChatRequest,
  cancelSession,
  chatBackgroundEndpoint,
  chatCancelEndpoint,
  moveSessionToBackground,
} from './chat';
import type { HarnessEvent } from './types';

let seq = 0;
function ev(type: string, data: Record<string, unknown>): HarnessEvent {
  seq += 1;
  return { seq, turn: 0, role: 'Clem', type, data };
}

test('chat Stop uses the exact accepted attempt instead of a reusable session id', () => {
  const projected = '/api/console/harness-sessions/sess-1/cancel?attemptId=attempt-1&runScopeId=scope-1';
  assert.equal(chatCancelEndpoint({ sessionId: 'sess-1', cancelEndpoint: projected }), projected);
  assert.equal(chatCancelEndpoint({
    sessionId: 'discord:channel:user',
    attemptId: 'attempt:desktop:abc',
    runScopeId: 'discord:channel:user::brain:desktop:abc',
  }), '/api/console/harness-sessions/discord%3Achannel%3Auser/cancel?attemptId=attempt%3Adesktop%3Aabc&runScopeId=discord%3Achannel%3Auser%3A%3Abrain%3Adesktop%3Aabc');
  assert.equal(chatCancelEndpoint({ sessionId: 'sess-1' }), null, 'session-only cancellation must fail closed');
});

test('pre-ack Stop persists the client request id and safely retries a lost response', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  let attempt = 0;
  const confirmed = await cancelPendingChatRequest('client-request-pre-ack-stop', {
    retryDelaysMs: [0],
    wait: async () => {},
    transport: async (path, body) => {
      calls.push({ path, body });
      attempt += 1;
      if (attempt === 1) throw Object.assign(new TypeError('response lost'), { status: 0 });
      return { ok: true };
    },
  });
  assert.equal(confirmed, true);
  assert.deepEqual(calls, [
    { path: '/api/harness/chat/cancel', body: { clientRequestId: 'client-request-pre-ack-stop' } },
    { path: '/api/harness/chat/cancel', body: { clientRequestId: 'client-request-pre-ack-stop' } },
  ]);
});

test('exact-attempt Stop retries a transient transport failure without changing authority', async () => {
  const endpoints: string[] = [];
  let attempt = 0;
  const confirmed = await cancelSession({
    sessionId: 'sess-exact-retry',
    attemptId: 'attempt-exact-retry',
    runScopeId: 'scope-exact-retry',
  }, {
    retryDelaysMs: [0],
    wait: async () => {},
    transport: async (path) => {
      endpoints.push(path);
      attempt += 1;
      if (attempt === 1) throw Object.assign(new TypeError('response lost'), { status: 0 });
      return { ok: true };
    },
  });
  assert.equal(confirmed, true);
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints[0], endpoints[1]);
  assert.match(endpoints[0], /attemptId=attempt-exact-retry/);
});

test('chat background handoff uses the exact accepted attempt and never a session-only fallback', () => {
  const projected = '/api/console/harness-sessions/sess-1/background?attemptId=attempt-1&runScopeId=scope-1';
  assert.equal(chatBackgroundEndpoint({ sessionId: 'sess-1', backgroundEndpoint: projected }), projected);
  assert.equal(chatBackgroundEndpoint({
    sessionId: 'space-client-project',
    attemptId: 'attempt:desktop:abc',
    runScopeId: 'space-client-project::brain:desktop:abc',
  }), '/api/console/harness-sessions/space-client-project/background?attemptId=attempt%3Adesktop%3Aabc&runScopeId=space-client-project%3A%3Abrain%3Adesktop%3Aabc');
  assert.equal(chatBackgroundEndpoint({ sessionId: 'sess-1' }), null, 'session-only handoff must fail closed');
});

test('lost background response retries the same idempotent exact-attempt endpoint', async () => {
  const endpoints: string[] = [];
  let calls = 0;
  const result = await moveSessionToBackground({
    sessionId: 'sess-retry-background',
    attemptId: 'attempt-retry-background',
    runScopeId: 'sess-retry-background::brain:run-retry-background',
  }, {
    retryDelaysMs: [0],
    wait: async () => {},
    transport: async (endpoint) => {
      endpoints.push(endpoint);
      calls += 1;
      if (calls === 1) throw Object.assign(new TypeError('response lost'), { status: 0 });
      return {
        ok: true,
        sessionId: 'sess-retry-background',
        attemptId: 'attempt-retry-background',
        runScopeId: 'sess-retry-background::brain:run-retry-background',
        taskId: 'bg-one',
        replayed: true,
        text: 'Moved.',
      };
    },
  });
  assert.equal(result.taskId, 'bg-one');
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints[0], endpoints[1]);
});

test('chat request identity is retained for the exact failed payload and rotated for new work', () => {
  const first = retainPendingChatPost(null, {
    input: 'Build the brief',
    sessionId: null,
    attachments: ['att-1'],
  }, () => 'client-request-stable');
  const replay = retainPendingChatPost(first, {
    input: 'Build the brief',
    sessionId: null,
    attachments: ['att-1'],
  }, () => 'must-not-be-minted');
  assert.equal(replay, first);
  assert.equal(replay.clientRequestId, 'client-request-stable');

  const next = retainPendingChatPost(first, {
    input: 'Build a different brief',
    sessionId: null,
    attachments: ['att-1'],
  }, () => 'client-request-next');
  assert.equal(next.clientRequestId, 'client-request-next');
});

test('lost-response transport retry reuses one client request id', async () => {
  const pending = retainPendingChatPost(null, {
    input: 'Research the firm and create the document',
    sessionId: 'sess-1',
    attachments: [],
  }, () => 'client-request-retry');
  const calls: Array<{ input: string; sessionId: string | null; requestId: string }> = [];
  let attempts = 0;
  const result = await postPendingChatWithRetry(pending, {
    retryDelaysMs: [0],
    wait: async () => {},
    transport: async (input, sessionId, _attachments, requestId) => {
      calls.push({ input, sessionId, requestId });
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('response lost'), { status: 0 });
      return {
        sessionId: sessionId ?? 'sess-recovered',
        streamUrl: '/api/sessions/sess-1/events',
        status: 'started',
        mode: 'fresh',
        clientRequestId: requestId,
      };
    },
  });

  assert.equal(result.clientRequestId, 'client-request-retry');
  assert.deepEqual(calls.map((call) => call.requestId), ['client-request-retry', 'client-request-retry']);
});

test('stop during an in-flight POST cancels a late accepted session and never returns a streamable result', async () => {
  const pending = retainPendingChatPost(null, {
    input: 'Research the firm and create the document',
    sessionId: null,
    attachments: [],
  }, () => 'client-request-stop-late');
  const controller = new AbortController();
  let accept!: (result: {
    sessionId: string;
    streamUrl: string;
    status: string;
    mode: string;
    clientRequestId: string;
  }) => void;
  const transportResult = new Promise<Parameters<typeof accept>[0]>((resolve) => { accept = resolve; });
  const cancelledSessions: string[] = [];
  const post = postPendingChatWithRetry(pending, {
    signal: controller.signal,
    transport: async () => transportResult,
    onLateAccepted: async (result) => { cancelledSessions.push(result.sessionId); },
  });

  controller.abort();
  accept({
    sessionId: 'sess-accepted-after-stop',
    streamUrl: '/api/sessions/sess-accepted-after-stop/events',
    status: 'started',
    mode: 'fresh',
    clientRequestId: pending.clientRequestId,
  });

  await assert.rejects(post, (error: Error) => {
    assert.ok(error instanceof ChatPostCancelledError);
    assert.equal(error.name, 'AbortError');
    assert.equal((error as ChatPostCancelledError).acceptedLate, true);
    return true;
  });
  assert.deepEqual(cancelledSessions, ['sess-accepted-after-stop']);
});

test('stop during retry backoff prevents another POST attempt', async () => {
  const pending = retainPendingChatPost(null, {
    input: 'Build the brief',
    sessionId: null,
    attachments: [],
  }, () => 'client-request-stop-backoff');
  const controller = new AbortController();
  let calls = 0;
  const post = postPendingChatWithRetry(pending, {
    signal: controller.signal,
    retryDelaysMs: [10_000],
    transport: async () => {
      calls += 1;
      throw Object.assign(new Error('response lost'), { status: 0 });
    },
    wait: async () => { controller.abort(); },
  });

  await assert.rejects(post, (error: Error) => error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('reduceActivity pairs overlapping same-name tool calls by callId when present', () => {
  let activity: ActivityItem[] = [];
  activity = reduceActivity(activity, ev('tool_called', { tool: 'read_file', callId: 'toolu_a' }));
  activity = reduceActivity(activity, ev('tool_called', { tool: 'read_file', callId: 'toolu_b' }));
  activity = reduceActivity(activity, ev('tool_returned', { tool: 'read_file', callId: 'toolu_a', ok: true }));

  assert.deepEqual(
    activity.map((a) => ({ id: a.id, label: a.label, status: a.status })),
    [
      { id: 't-toolu_a', label: 'read file', status: 'done' },
      { id: 't-toolu_b', label: 'read file', status: 'running' },
    ],
  );
});

test('reduceActivity falls back to label matching for legacy tool return events without callId', () => {
  let activity: ActivityItem[] = [];
  activity = reduceActivity(activity, ev('tool_called', { tool: 'read_file' }));
  activity = reduceActivity(activity, ev('tool_returned', { tool: 'read_file', ok: false }));

  assert.equal(activity[0].status, 'failed');
});

test('reduceActivity: run_batch renders as ONE live meter row; per-item batchMode tool events are suppressed', () => {
  let a: ActivityItem[] = [];
  a = reduceActivity(a, ev('batch_started', { batchId: 'b1', items: 18, slug: 'OUTLOOK_SEND_EMAIL', sideEffect: 'send' }));
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'batch');
  assert.match(a[0].label, /Sending 18 × outlook send email/);
  assert.deepEqual(a[0].batch, { done: 0, total: 18, failed: 0 });

  // Per-item plumbing events must NOT add rows.
  a = reduceActivity(a, ev('tool_called', { tool: 'composio_execute_tool', callId: 'c1', batchMode: true, args: '{}' }));
  a = reduceActivity(a, ev('tool_returned', { tool: 'composio_execute_tool', callId: 'c1', batchMode: true, ok: true }));
  assert.equal(a.length, 1, 'batch item events must not create tool rows');

  a = reduceActivity(a, ev('batch_progress', { batchId: 'b1', done: 12, total: 18, failed: 1, itemId: 'pine-consulting.example', ok: true }));
  assert.deepEqual(a[0].batch, { done: 12, total: 18, failed: 1 });
  assert.equal(a[0].detail, 'pine-consulting.example');

  a = reduceActivity(a, ev('batch_completed', { batchId: 'b1', total: 18, succeeded: 17, failed: 1, halted: false }));
  assert.equal(a[0].status, 'failed', 'any failed item surfaces as a failed batch row');
  assert.equal(a[0].batch?.failed, 1);
});

test('reduceActivity: a throttled batch_progress flips the meter into backing-off; a normal update clears it', () => {
  let a: ActivityItem[] = [];
  a = reduceActivity(a, ev('batch_started', { batchId: 'b2', items: 10, slug: 'GMAIL_SEND_EMAIL', sideEffect: 'send' }));
  a = reduceActivity(a, ev('batch_progress', { batchId: 'b2', done: 4, total: 10, failed: 0, itemId: 'a@site.example', ok: true }));
  assert.equal(a[0].batch?.throttled, undefined, 'a normal update has no throttled flag');

  // Rate-limit back-off pause: counts unchanged, throttled flips on.
  a = reduceActivity(a, ev('batch_progress', { batchId: 'b2', done: 4, total: 10, failed: 0, throttled: true, backoffMs: 2000, backoffCount: 1, ok: true }));
  assert.deepEqual(a[0].batch, { done: 4, total: 10, failed: 0, throttled: true });

  // The next real item update clears the throttled flag.
  a = reduceActivity(a, ev('batch_progress', { batchId: 'b2', done: 5, total: 10, failed: 0, itemId: 'b@site.example', ok: true }));
  assert.deepEqual(a[0].batch, { done: 5, total: 10, failed: 0 });
});

test('reduceActivity: tool rows carry the salient target and a composio call reads as its slug', () => {
  let a: ActivityItem[] = [];
  a = reduceActivity(a, ev('tool_called', {
    tool: 'composio_execute_tool',
    callId: 'c9',
    args: JSON.stringify({ tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to: 'sam@pine-consulting.example', subject: 'Hi' }) }),
  }));
  assert.equal(a[0].label, 'outlook send email', 'composio calls read as their inner slug');
  assert.equal(a[0].detail, 'sam@pine-consulting.example', 'the salient target is narrated');
  assert.ok(typeof a[0].startedAt === 'number');

  a = reduceActivity(a, ev('tool_called', { tool: 'dataforseo__serp_organic_live_advanced', callId: 'c10', args: JSON.stringify({ keyword: 'executive coaching' }) }));
  assert.equal(a[1].label, 'dataforseo · serp organic live advanced', 'server__tool renders as server · tool');
  assert.equal(a[1].detail, 'executive coaching');
});

// ─── Trust cockpit: verdict + watcher rows in the activity strip ─────────────

test('reduceActivity: verdict_recorded appends a check row with door, scorecard, and pass tone', () => {
  let a = reduceActivity([], ev('verdict_recorded', { door: 'goal_validation', pass: false, reason: 'criterion 2 unmet', criteriaMet: 1, criteriaTotal: 2 }));
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'check');
  assert.match(a[0].label, /goal validation 1\/2: not passed/);
  assert.equal(a[0].detail, 'criterion 2 unmet');
  assert.equal(a[0].status, 'failed');

  a = reduceActivity(a, ev('verdict_recorded', { door: 'completion', pass: true, failedOpen: true }));
  assert.match(a[1].label, /accepted \(judge unavailable\)/);
  assert.equal(a[1].status, 'failed', 'failed-open acceptance renders as attention, not a clean tick');

  a = reduceActivity(a, ev('verdict_recorded', { door: 'delivery', pass: true, reason: 'artifact delivered' }));
  assert.equal(a[2].status, 'done');
});

test('reduceActivity: watcher_steer heartbeat appends a check row; other heartbeats stay invisible', () => {
  let a = reduceActivity([], ev('heartbeat', { kind: 'progress_check_in', message: 'still going' }));
  assert.equal(a.length, 0, 'generic heartbeats never clutter the strip');
  a = reduceActivity(a, ev('heartbeat', { kind: 'watcher_steer', miss: 'criterion untouched', steer: 'address it before drafting' }));
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'check');
  assert.equal(a[0].label, 'Watcher steered');
  assert.equal(a[0].detail, 'criterion untouched → address it before drafting');
});

test('reduceActivity preserves explicit BYO identity for provider-shaped model IDs', () => {
  const gptShaped = reduceActivity([], ev('worker_started', {
    item: 'custom-openai-compatible',
    provider: 'byo',
    model: 'gpt-4o',
  }));
  assert.equal(gptShaped[0].provider, 'byo');

  const claudeShaped = reduceActivity([], ev('worker_started', {
    item: 'custom-anthropic-compatible',
    provider: 'byo',
    model: 'claude-3-7-sonnet',
  }));
  assert.equal(claudeShaped[0].provider, 'byo');
});
