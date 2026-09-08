import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Composio as RawComposio, APIConnectionTimeoutError, APIUserAbortError, type ClientOptions } from '@composio/client';

// Runtime imports happen only after the test owns its home. The only HTTP
// transport below is a mocked fetch passed to the actual installed raw SDK.
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-composio-host-deadline-'));
const previous = new Map(['CLEMENTINE_HOME', 'CLEMMY_TEST_ISOLATED_HOME', 'MCP_AUTO_IMPORT_ENABLED', 'COMPOSIO_BACKEND']
  .map(key => [key, process.env[key]]));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.COMPOSIO_BACKEND = 'sdk';
const client = await import('./client.js');
const abortContext = await import('../../runtime/tool-abort-context.js');
const asyncJobs = await import('./async-job.js');
const retry = await import('../../runtime/harness/retry-handler.js');

test.after(() => {
  client.__test__.setComposioApiKeyOverride(null);
  client.resetComposioClient();
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function fixture(options: { sdkTimeoutMs: number; wireDelayMs: number; throwOnWire?: boolean }) {
  let calls = 0;
  let aborts = 0;
  let body: unknown;
  let requestUrl = '';
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const sdkDeadlines: number[] = [];
  const inputSignals: Array<AbortSignal | null | undefined> = [];
  const transportOptions: Array<Partial<ClientOptions>> = [];
  class ObservedRawClient extends RawComposio {
    override withOptions(overrides: Partial<ClientOptions>): this {
      transportOptions.push(overrides);
      return super.withOptions(overrides);
    }
    override async fetchWithTimeout(...args: Parameters<RawComposio['fetchWithTimeout']>): Promise<Response> {
      sdkDeadlines.push(args[2]);
      inputSignals.push(args[1]?.signal);
      return super.fetchWithTimeout(...args);
    }
  }
  const fetchWire: typeof fetch = async (input, init) => {
    calls += 1;
    requestUrl = String(input);
    body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    markStarted();
    if (options.throwOnWire) throw new TypeError('mock connection reset after request admission');
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const onAbort = () => { aborts += 1; cleanup(); reject(new DOMException('mock wire aborted', 'AbortError')); };
      const timer = setTimeout(() => {
        cleanup();
        resolve(new Response(JSON.stringify({ data: { items: [{ id: 'current-result' }] }, successful: true, error: null }),
          { status: 200, headers: { 'content-type': 'application/json' } }));
      }, options.wireDelayMs);
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
  const raw = new ObservedRawClient({
    apiKey: 'test-only-key', baseURL: 'https://provider.test.invalid',
    timeout: options.sdkTimeoutMs, maxRetries: 2, fetch: fetchWire, logLevel: 'off',
  });
  client.__test__.setComposioApiKeyOverride('test-only-key');
  client.__test__.setComposioClient({ getClient: () => raw });
  const prepare = (slug = 'ACME_READ_RECORDS') => client.prepareComposioOneShotDispatch({
    toolSlug: slug,
    // Deliberately unrelated values: transport never interprets business keys.
    args: { timeout: 0, waitForFinish: 1, query: 'exact source' },
    providerOperationVersion: '20260907_01',
  });
  return { prepare, started, sdkDeadlines, inputSignals, transportOptions,
    calls: () => calls, aborts: () => aborts, body: () => body, url: () => requestUrl };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('prepared SDK wire uses the remaining owner window beyond its shorter default, not actor arguments', async () => {
  const f = fixture({ sdkTimeoutMs: 20, wireDelayMs: 70 });
  const controller = new AbortController();
  const deadlineAt = Date.now() + 120_000;
  const prepared = f.prepare();
  const result = await abortContext.runWithToolAbortSignal(controller.signal, async () => {
    await sleep(35); // Time spent after preparation cannot restart the window.
    return client.executePreparedComposioTool(prepared);
  }, deadlineAt);
  assert.equal((result as { successful: boolean }).successful, true);
  assert.deepEqual((result as { data: unknown }).data, { items: [{ id: 'current-result' }] });
  assert.equal(f.calls(), 1);
  assert.equal(f.aborts(), 0);
  assert.deepEqual(f.transportOptions, [{ maxRetries: 0 }]);
  assert.equal(f.inputSignals[0], controller.signal);
  assert.ok(f.sdkDeadlines[0]! > 60_000 && f.sdkDeadlines[0]! <= 119_970, 'uses remaining invocation time at dispatch');
  assert.equal(f.url(), 'https://provider.test.invalid/api/v3.1/tools/execute/ACME_READ_RECORDS');
  assert.deepEqual((f.body() as { arguments: unknown }).arguments, { timeout: 0, waitForFinish: 1, query: 'exact source' });
  await assert.rejects(client.executePreparedComposioTool(prepared), client.ComposioPreDispatchError);
  assert.equal(f.calls(), 1, 'opaque preparation cannot be replayed');
});

test('an owner deadline shorter than the SDK default ends exactly one pending wire request', async () => {
  const f = fixture({ sdkTimeoutMs: 500, wireDelayMs: 100 });
  const controller = new AbortController();
  await assert.rejects(abortContext.runWithToolAbortSignal(controller.signal,
    () => client.executePreparedComposioTool(f.prepare()), Date.now() + 30), APIConnectionTimeoutError);
  assert.ok(f.sdkDeadlines[0]! > 0 && f.sdkDeadlines[0]! <= 30);
  assert.equal(f.calls(), 1);
  assert.equal(f.aborts(), 1);
  assert.deepEqual(f.transportOptions, [{ maxRetries: 0 }]);
});

for (const withSignal of [false, true]) {
  test(`no owner deadline preserves the SDK timeout (${withSignal ? 'signal only' : 'no context'})`, async () => {
    const f = fixture({ sdkTimeoutMs: 20, wireDelayMs: 80 });
    const invoke = () => client.executePreparedComposioTool(f.prepare());
    const controller = new AbortController();
    await assert.rejects(withSignal ? abortContext.runWithToolAbortSignal(controller.signal, invoke) : invoke(), APIConnectionTimeoutError);
    assert.deepEqual(f.sdkDeadlines, [20]);
    assert.equal(f.calls(), 1);
    assert.equal(f.aborts(), 1);
    if (withSignal) assert.equal(f.inputSignals[0], controller.signal);
  });
}

test('an already elapsed owner deadline is refused before any HTTP request and consumes the one-shot', async () => {
  const f = fixture({ sdkTimeoutMs: 20, wireDelayMs: 0 });
  const controller = new AbortController();
  const prepared = f.prepare();
  await assert.rejects(abortContext.runWithToolAbortSignal(controller.signal,
    () => client.executePreparedComposioTool(prepared), Date.now() - 1),
  (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError');
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.sdkDeadlines, []);
  await assert.rejects(client.executePreparedComposioTool(prepared), client.ComposioPreDispatchError);
  assert.equal(f.calls(), 0);
});

test('already cancelled invocation preserves its exact reason and makes zero HTTP requests', async () => {
  const f = fixture({ sdkTimeoutMs: 20, wireDelayMs: 0 });
  const controller = new AbortController();
  const reason = new Error('owner cancelled before dispatch');
  controller.abort(reason);
  await assert.rejects(abortContext.runWithToolAbortSignal(controller.signal,
    () => client.executePreparedComposioTool(f.prepare()), Date.now() + 120_000),
  (error: unknown) => error === reason);
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.sdkDeadlines, []);
});

test('owner cancellation reaches a pending write; it throws without replay or fabricated success', async () => {
  const f = fixture({ sdkTimeoutMs: 20, wireDelayMs: 500 });
  const controller = new AbortController();
  const prepared = f.prepare('ACME_CREATE_RECORD');
  const pending = abortContext.runWithToolAbortSignal(controller.signal,
    () => client.executePreparedComposioTool(prepared), Date.now() + 120_000);
  const rejected = assert.rejects(pending, APIUserAbortError);
  await f.started;
  controller.abort(new Error('owner stopped this exact invocation'));
  await rejected;
  assert.equal(f.calls(), 1);
  assert.equal(f.aborts(), 1);
  assert.equal(f.inputSignals[0], controller.signal);
  assert.deepEqual(f.transportOptions, [{ maxRetries: 0 }]);
  await assert.rejects(client.executePreparedComposioTool(prepared), client.ComposioPreDispatchError);
  assert.equal(f.calls(), 1);
});

test('a pending transport error still crosses only once despite the raw SDK default retry policy', async () => {
  const f = fixture({ sdkTimeoutMs: 20, wireDelayMs: 0, throwOnWire: true });
  await assert.rejects(abortContext.runWithToolAbortSignal(new AbortController().signal,
    () => client.executePreparedComposioTool(f.prepare('ACME_CREATE_RECORD')), Date.now() + 120_000));
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.transportOptions, [{ maxRetries: 0 }]);
});

test('foreground queued receipt preserves its exact IDs and calls for separately admitted reads', () => {
  const receipt = asyncJobs.detectJobReceipt('APIFY_RUN_ACTOR', {
    successful: true, data: { id: 'run-exact', defaultDatasetId: 'dataset-exact', actId: 'actor-exact', status: 'RUNNING', finishedAt: null },
  });
  assert.ok(receipt);
  assert.equal(receipt.jobId, 'run-exact');
  assert.equal(receipt.datasetId, 'dataset-exact');
  const text = asyncJobs.asyncReceiptBanner(receipt);
  assert.match(text, /run-exact/);
  assert.match(text, /dataset-exact/);
  assert.match(text, /receipt, not the final result/);
  assert.match(text, /separately admitted tool calls/);
  assert.match(text, /does not automatically poll or background/);
  assert.match(text, /Do not start a replacement/);
});

test('long ambiguous timeout still forbids repeating or replacing the remote start', () => {
  const result = retry.shouldRetryToolCall(new APIConnectionTimeoutError(), 1, [], 60_008);
  assert.equal(result.shouldRetry, false);
  assert.equal(result.remoteMayStillBeRunning, true);
  assert.match(result.reason, /outcome is unknown/);
  assert.match(result.reason, /exact returned handle/);
  assert.match(result.reason, /reconcile the original attempt/);
  assert.doesNotMatch(result.reason, /or use an asynchronous start/);
});
