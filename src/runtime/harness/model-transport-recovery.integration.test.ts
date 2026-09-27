/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/model-transport-recovery.integration.test.ts
 *
 * A brain whose provider gives no answer before any output — a connection or
 * credential refresh that times out, a reset socket — must not end the turn.
 * These pins drive the production path end to end: the real BYO client (the
 * openai SDK with its own retries off), the resilience wrapper, the
 * single-target fallback graph the router builds when fallover is off, the
 * route recorder, and the host turn runner inside runTurn. Only `fetch` and
 * the bearer refresh are fakes.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-model-transport-recovery-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
delete process.env.OPENAI_API_KEY;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-transport-recovery\n', 'utf8');

const { hostRunRunner } = await import('./host-turn-runner.js');
const { runTurn } = await import('./loop.js');
const { HarnessSession } = await import('./session.js');
const eventlog = await import('./eventlog.js');
const { getByoModel, resetByoModelCache } = await import('./byo-model.js');
const { withModelFallback } = await import('./fallback-model.js');
const { withModelRouteMetrics } = await import('../model-route-metrics.js');

const MODEL_ID = 'fixture-brain';
const BASE_URL = 'https://transport-recovery-fixture.invalid/v1';

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('Runner.run must not own the turn');
  };
  return runner;
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function answer(text: string): Response {
  const usage = `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: MODEL_ID,
    choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`;
  return new Response(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + usage + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A body that streams some reply text and then loses its connection. */
function answerThenDrop(text: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(chunk({ role: 'assistant', content: text })));
      setTimeout(() => controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } })), 5);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** undici's shape for a connect timeout: the SDK recasts it into its
 * cause-less "Request timed out." connection error. */
function connectTimeout(): never {
  const cause = Object.assign(new Error('Connect Timeout Error (timeout: 10000ms)'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' });
  throw Object.assign(new TypeError('fetch failed'), { cause });
}

let wire: string[] = [];
function fakeWire(respond: (attempt: number) => Response | Promise<Response>) {
  wire = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init);
    assert.equal(request.url, `${BASE_URL}/chat/completions`);
    wire.push(request.headers.get('authorization') ?? '');
    return respond(wire.length);
  });
}

afterEach(() => { mock.restoreAll(); resetByoModelCache(); });

/** The brain the router builds for an explicit BYO model with fallover off. */
function productionBrain(sessionId: string, refreshBearer?: () => Promise<string | null>) {
  const backend = { configured: true, baseURL: BASE_URL, apiKey: 'static-access', primaryId: MODEL_ID, judgeId: MODEL_ID,
    providerLabel: 'Fixture provider', ...(refreshBearer ? { refreshBearer } : {}) };
  return withModelFallback([{
    label: MODEL_ID,
    provider: 'byo',
    model: MODEL_ID,
    getModel: () => withModelRouteMetrics(getByoModel(MODEL_ID, backend), {
      sessionId, role: 'brain', requestedModel: MODEL_ID, resolvedModel: MODEL_ID, provider: 'byo', source: 'explicit',
    } as never),
  }]);
}

async function runChatTurn(sessionId: string, model: unknown) {
  return runTurn({
    sessionId,
    input: 'Summarize what we found earlier in one line.',
    agent: { model, tools: [], instructions: 'Respond to the owner.' } as never,
    makeRunner: throwingRunner as never,
    runRunner: hostRunRunner,
    maxTurns: 3,
  });
}

test('a credential refresh that times out before the request is sent is retried on the same brain and the turn answers', async () => {
  const session = HarnessSession.create({ kind: 'chat', title: 'refresh timeout recovers' });
  let refreshes = 0;
  fakeWire(() => answer('Here is the one-line summary.'));
  const brain = productionBrain(session.id, async () => {
    refreshes += 1;
    // The refresh's own deadline fires on a stalled network; the SDK turns
    // this into its cause-less "Request timed out." error.
    if (refreshes === 1) throw new Error('token refresh timed out after 15s. Check your network connection and try again.');
    return 'fresh-access';
  });
  const result = await runChatTurn(session.id, brain);
  assert.equal(result.status, 'completed');
  assert.match(String(result.finalOutput), /one-line summary/);
  assert.equal(refreshes, 2, 'one failed refresh, then one that succeeds');
  assert.deepEqual(wire, ['Bearer fresh-access'], 'the failed attempt never reached the provider, so nothing was billed twice');
  assert.equal(eventlog.listEvents(session.id, { types: ['run_failed'] }).length, 0);
});

test('a credential refresh that takes longer than the retry window to time out is still retried once and the turn answers', async () => {
  const session = HarnessSession.create({ kind: 'chat', title: 'slow refresh timeout recovers' });
  // The first refresh hangs on the network for 25 s of wall time before its
  // own deadline fires; the clock moves instead of the test waiting.
  const realNow = Date.now.bind(Date);
  let skewMs = 0;
  mock.method(Date, 'now', () => realNow() + skewMs);
  let refreshes = 0;
  fakeWire(() => answer('Here is the one-line summary.'));
  const brain = productionBrain(session.id, async () => {
    refreshes += 1;
    if (refreshes === 1) {
      skewMs += 25_000;
      throw new Error('token refresh timed out after 25s. Check your network connection and try again.');
    }
    return 'fresh-access';
  });
  const result = await runChatTurn(session.id, brain);
  assert.equal(result.status, 'completed', 'one slow blip before any output must not end the turn');
  assert.match(String(result.finalOutput), /one-line summary/);
  assert.equal(refreshes, 2);
  assert.deepEqual(wire, ['Bearer fresh-access']);
  assert.equal(eventlog.listEvents(session.id, { types: ['awaiting_user_input'] }).length, 0, 'no continuation question for a single blip');
  assert.equal(eventlog.listEvents(session.id, { types: ['run_failed'] }).length, 0);
});

test('a rate-limited first request does not use up the retry a later slow refresh timeout is owed', async () => {
  const session = HarnessSession.create({ kind: 'chat', title: 'rate limit then slow refresh recovers' });
  const realNow = Date.now.bind(Date);
  let skewMs = 0;
  mock.method(Date, 'now', () => realNow() + skewMs);
  let refreshes = 0;
  fakeWire((attempt) => (attempt === 1 ? rateLimited() : answer('Here is the one-line summary.')));
  const brain = productionBrain(session.id, async () => {
    refreshes += 1;
    // The request after the rate limit waits 25 s on a stalled network
    // before its refresh deadline fires; the clock moves instead of the test.
    if (refreshes === 2) {
      skewMs += 25_000;
      throw new Error('token refresh timed out after 25s. Check your network connection and try again.');
    }
    return 'fresh-access';
  });
  const result = await runChatTurn(session.id, brain);
  assert.equal(result.status, 'completed', 'a rate-limit wait and one slow blip before any output must not end the turn');
  assert.match(String(result.finalOutput), /one-line summary/);
  assert.equal(refreshes, 3, 'rate-limited request, the slow failed refresh, then the one that answers');
  assert.equal(wire.length, 2, 'the slow refresh never reached the provider');
  assert.equal(eventlog.listEvents(session.id, { types: ['awaiting_user_input'] }).length, 0, 'no continuation question');
  assert.equal(eventlog.listEvents(session.id, { types: ['run_failed'] }).length, 0);
});

test('a provider that never answers ends in a resumable question after one bounded round, never a failed run', async () => {
  const session = HarnessSession.create({ kind: 'chat', title: 'provider unreachable' });
  fakeWire(() => connectTimeout());
  const startedAt = Date.now();
  const result = await runChatTurn(session.id, productionBrain(session.id));
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, 'awaiting_user_input');
  assert.match(String(result.finalOutput), /connection to my model/i);
  assert.match(String(result.finalOutput), /Would you like me to try continuing from here\?/);
  assert.equal(wire.length, 4, 'the model boundary spends its retries once; the host does not start a second round');
  assert.ok(elapsedMs < 15_000, `bounded wait (${elapsedMs} ms)`);
  const waiting = eventlog.listEvents(session.id, { types: ['awaiting_user_input'] });
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].data.reason, 'model_transport_unavailable');
  assert.equal(eventlog.listEvents(session.id, { types: ['run_failed'] }).length, 0, 'no generic failure');
  const completed = eventlog.listEvents(session.id, { types: ['conversation_completed'] });
  assert.ok(completed.every(event => event.data.status !== 'failed'), 'the turn is not recorded as failed');
});

function rateLimited(): Response {
  return new Response(JSON.stringify({ error: { message: 'Too many requests', type: 'rate_limit_error' } }),
    { status: 429, headers: { 'content-type': 'application/json' } });
}

test('a dropped connection after only rate-limit retries keeps the turn\'s own retry, and the turn answers', async () => {
  const session = HarnessSession.create({ kind: 'chat', title: 'rate limits then a drop recovers' });
  fakeWire((attempt) => {
    if (attempt <= 3) return rateLimited();
    if (attempt === 4) return connectTimeout();
    return answer('Here is the one-line summary.');
  });
  const result = await runChatTurn(session.id, productionBrain(session.id));
  assert.equal(result.status, 'completed', 'one dropped connection is not a provider that keeps dropping');
  assert.match(String(result.finalOutput), /one-line summary/);
  assert.equal(wire.length, 5, 'the model boundary spent its count on rate limits; the turn retried the drop once');
  assert.equal(eventlog.listEvents(session.id, { types: ['awaiting_user_input'] }).length, 0, 'no continuation question');
  assert.equal(eventlog.listEvents(session.id, { types: ['run_failed'] }).length, 0);
});

test('a connection lost after reply text streamed is never replayed at the model boundary', async () => {
  fakeWire(() => answerThenDrop('Partial reply'));
  const brain = productionBrain('sess-transport-after-output');
  const request = { input: 'hi', modelSettings: {}, tools: [], outputType: 'text', handoffs: [], tracing: false } as never;
  const deltas: string[] = [];
  await assert.rejects(async () => {
    for await (const event of brain.getStreamedResponse(request)) {
      const e = event as { type?: string; delta?: string };
      if (e.type === 'output_text_delta' && e.delta) deltas.push(e.delta);
    }
  });
  assert.equal(wire.length, 1, 'output was already shown, so the same request is not sent again');
  assert.equal(deltas.join(''), 'Partial reply', 'the streamed text appears exactly once');
});
