import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import {
  buildSystemOneRequest, postSystemOne, TYPESAFE_MODEL, TYPESAFE_SYSTEMONE_URL,
  type SystemOneFetch,
} from './system-one.js';

const request = buildSystemOneRequest('Exact fixture evidence.', {
  delivered: { type: 'noul', instructions: 'Was the requested result delivered?' },
});
const recorded = { model: TYPESAFE_MODEL, answers: { delivered: { type: 'noul', noul: 0.93 } },
  usage: { input_tokens: 173, output_tokens: 11 } };
const response = () => ({ status: 200, ok: true, text: async () => JSON.stringify(recorded) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('deadline settles and aborts a fetch that ignores cancellation forever', { timeout: 2_000 }, async () => {
  let signal: AbortSignal | undefined;
  const pending = deferred<Awaited<ReturnType<SystemOneFetch>>>();
  const started = performance.now();
  const result = await postSystemOne({ apiKey: 'inert-key', request, timeoutMs: 250,
    fetchImpl: async (_url, init) => { signal = init.signal; return pending.promise; } });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.equal(signal?.aborted, true);
  assert.ok(performance.now() - started < 1_500, 'do not await noncooperative transport settlement');
});

test('late headers cannot start a body read or become a successful decision', { timeout: 2_000 }, async () => {
  const pending = deferred<Awaited<ReturnType<SystemOneFetch>>>();
  let bodyReads = 0;
  const result = await postSystemOne({ apiKey: 'inert-key', request, timeoutMs: 250,
    fetchImpl: async () => pending.promise });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  pending.resolve({ status: 200, ok: true, text: async () => { bodyReads += 1; return JSON.stringify(recorded); } });
  await nextTurn();
  assert.equal(bodyReads, 0, 'the response already missed the absolute deadline');
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
});

test('a pending body is bounded independently of headers and cannot mutate its settled timeout', { timeout: 2_000 }, async () => {
  const body = deferred<string>();
  let signal: AbortSignal | undefined;
  let bodyReads = 0;
  const result = await postSystemOne({ apiKey: 'inert-key', request, timeoutMs: 250,
    fetchImpl: async (_url, init) => { signal = init.signal; return {
      status: 200, ok: true, text: async () => { bodyReads += 1; return body.promise; },
    }; } });
  assert.equal(bodyReads, 1);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  body.resolve(JSON.stringify(recorded));
  await nextTurn();
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
});

for (const phase of ['headers', 'body'] as const) {
  test(`a late ${phase} rejection is observed after timeout without an unhandled failure`, { timeout: 2_000 }, async () => {
    const pending = deferred<any>();
    const unhandled: unknown[] = [];
    const observe = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', observe);
    try {
      const result = await postSystemOne({ apiKey: 'inert-key', request, timeoutMs: 250,
        fetchImpl: phase === 'headers' ? async () => pending.promise
          : async () => ({ status: 200, ok: true, text: async () => pending.promise }) });
      assert.deepEqual(result, { ok: false, reason: 'timeout' });
      pending.reject(new Error(`inert late ${phase} failure`));
      await nextTurn();
      await nextTurn();
      assert.deepEqual(unhandled, []);
    } finally { process.off('unhandledRejection', observe); }
  });
}

test('monotonic deadline refuses a valid body when synchronous work delays the timer', { timeout: 2_000 }, async () => {
  let signal: AbortSignal | undefined;
  const started = performance.now();
  const result = await postSystemOne({ apiKey: 'inert-key', request, timeoutMs: 250,
    fetchImpl: async (_url, init) => { signal = init.signal; return {
      status: 200, ok: true, text: async () => {
        // No asynchronous handle: the deadline timer cannot run until this
        // inert body returns, so only the absolute elapsed check rejects it.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        return JSON.stringify(recorded);
      },
    }; } });
  assert.ok(performance.now() - started >= 250);
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.equal(signal?.aborted, true);
});

test('synchronous request serialization past the deadline does not dispatch a transport', { timeout: 2_000 }, async () => {
  let calls = 0;
  const slow = buildSystemOneRequest({ toJSON() {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    return 'Serialized fixture';
  } }, request.questions);
  const result = await postSystemOne({ apiKey: 'inert-key', request: slow, timeoutMs: 250,
    fetchImpl: async () => { calls += 1; return response(); } });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.equal(calls, 0);
});

test('fast success preserves exact request, pinned model and observed usage and clears its timer', { timeout: 2_000 }, async () => {
  let signal: AbortSignal | undefined;
  const result = await postSystemOne({ apiKey: ' inert-key ', request, timeoutMs: 250,
    fetchImpl: async (url, init) => {
      assert.equal(url, TYPESAFE_SYSTEMONE_URL);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer inert-key');
      assert.equal(init.body, JSON.stringify(request));
      signal = init.signal;
      return response();
    } });
  assert.deepEqual(result, { ok: true, model: TYPESAFE_MODEL,
    answers: { delivered: { type: 'noul', noul: 0.93 } }, usage: recorded.usage, status: 200 });
  await delay(300);
  assert.equal(signal?.aborted, false, 'cleared timer cannot abort a completed request later');
});

test('fast HTTP and parse failures keep existing classification and clear their timers', { timeout: 2_000 }, async () => {
  for (const [status, body, reason] of [[401, 'denied', 'unauthorized'], [503, 'busy', 'http_error'], [200, 'not-json', 'malformed']] as const) {
    let signal: AbortSignal | undefined;
    const result = await postSystemOne({ apiKey: 'inert-key', request, timeoutMs: 250,
      fetchImpl: async (_url, init) => { signal = init.signal; return {
        status, ok: status === 200, text: async () => body,
      }; } });
    assert.equal(result.ok, false);
    if (result.ok) throw Error('failure became success');
    assert.equal(result.reason, reason);
    assert.equal(result.status, status);
    assert.equal(result.body, body);
    await delay(300);
    assert.equal(signal?.aborted, false);
  }
});
