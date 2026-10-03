import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserbaseApiClient, BrowserbaseClientError } from './browserbase-client.js';

const project = 'project-1';
const sid = 'session-1';
const secret = 'private-fixture-api-key';
const connection = `wss://connect.browserbase.com/?apiKey=${secret}&sessionId=${sid}`;
const session = { id: sid, projectId: project, status: 'RUNNING', connectUrl: connection,
  createdAt: '2026-10-02T00:00:00Z', expiresAt: '2026-10-02T00:15:00Z' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function client(fetcher: typeof fetch, extra: { timeoutMs?: number; now?: () => number } = {}) {
  return new BrowserbaseApiClient({ getApiKey: async () => secret, fetch: fetcher, ...extra });
}
function safeError(code: string, dispatched: boolean) {
  return (error: unknown) => {
    assert.ok(error instanceof BrowserbaseClientError);
    assert.equal(error.code, code); assert.equal(error.dispatched, dispatched);
    assert.doesNotMatch(error.message + JSON.stringify(error), /private-fixture|wss:|https:|provider-private/);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('create uses exact documented endpoint, privacy defaults, bounded lifetime and sealed provider identity', async () => {
  let calls = 0;
  const api = client(async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.browserbase.com/v1/sessions');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('X-BB-API-Key'), secret);
    assert.deepEqual(JSON.parse(String(init?.body)), { projectId: project, keepAlive: true, timeout: 900,
      browserSettings: { logSession: false, recordSession: false } });
    return json(session, 201);
  });
  assert.deepEqual(await api.create({ projectId: project }), { sessionId: sid, projectId: project, status: 'RUNNING', connectUrl: connection,
    createdAt: session.createdAt, expiresAt: session.expiresAt });
  assert.equal(calls, 1);
});

test('retrieve permits documented optional connection URL while release validates the project before POST', async () => {
  const calls: string[] = [];
  const api = client(async (url, init) => {
    calls.push(`${init?.method} ${url}`);
    assert.equal(url, `https://api.browserbase.com/v1/sessions/${sid}`);
    if (init?.method === 'POST') assert.deepEqual(JSON.parse(String(init.body)), { status: 'REQUEST_RELEASE' });
    return json({ ...session, connectUrl: undefined });
  });
  assert.equal((await api.retrieve(sid, project)).connectUrl, undefined);
  await api.release(sid, project);
  assert.deepEqual(calls, [`GET https://api.browserbase.com/v1/sessions/${sid}`, `GET https://api.browserbase.com/v1/sessions/${sid}`, `POST https://api.browserbase.com/v1/sessions/${sid}`]);
  let writes = 0;
  const foreign = client(async (_url, init) => { if (init?.method === 'POST') writes++; return json({ ...session, projectId: 'foreign-project' }); });
  await assert.rejects(foreign.release(sid, project), safeError('identity_mismatch', false));
  assert.equal(writes, 0);
  const terminal = client(async () => json({ ...session, status: 'COMPLETED', connectUrl: undefined }));
  await terminal.release(sid, project);
});

test('release attributes uncertain effect only after its POST, never its failed read prerequisite', async () => {
  for (const failure of [
    async () => { throw new Error(connection); },
    async () => json({ error: secret }, 429),
    async () => new Response('{'),
  ] as Array<() => Promise<Response>>) {
    const methods: string[] = [];
    const api = client(async (_url, init) => { methods.push(String(init?.method)); return failure(); });
    await assert.rejects(api.release(sid, project), error => error instanceof BrowserbaseClientError && !error.dispatched);
    assert.deepEqual(methods, ['GET']);
  }
  const methods: string[] = [];
  const api = client(async (_url, init) => {
    methods.push(String(init?.method));
    if (init?.method === 'GET') return json(session);
    throw new Error(connection);
  });
  await assert.rejects(api.release(sid, project), safeError('transport_failed', true));
  assert.deepEqual(methods, ['GET', 'POST']);
});

test('provider identity, CDP host, session and URL credentials cannot drift', async () => {
  for (const patch of [
    { projectId: 'another-project' }, { id: 'another-session' }, { status: 'UNRECOGNIZED' },
    { connectUrl: connection.replace('connect.browserbase.com', 'connect.browserbase.com.evil.example') },
    { connectUrl: connection.replace('wss:', 'ws:') }, { connectUrl: `wss://user:pass@connect.browserbase.com/?sessionId=${sid}` },
    { connectUrl: 'wss://connect.browserbase.com/?sessionId=wrong' }, { connectUrl: connection + '&sessionId=' + sid },
  ]) {
    await assert.rejects(client(async () => json({ ...session, ...patch })).retrieve(sid, project), error => error instanceof BrowserbaseClientError && error.dispatched);
  }
  await assert.rejects(client(async () => json({ ...session, connectUrl: undefined })).create({ projectId: project }), safeError('invalid_response', true));
});

test('live URL minting has bounded TTL, trusted HTTPS origin and no key in the request URL', async () => {
  const api = client(async (url, init) => {
    assert.equal(url, `https://api.browserbase.com/v1/sessions/${sid}/debug?expiresIn=120`);
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'manual');
    assert.doesNotMatch(String(url), /private-fixture/);
    return json({ debuggerFullscreenUrl: 'https://www.browserbase.com/devtools-fullscreen/?token=synthetic-private-viewer' });
  }, { now: () => Date.parse('2026-10-02T00:00:00Z') });
  assert.deepEqual(await api.liveView(sid, { expiresIn: 120 }), {
    url: 'https://www.browserbase.com/devtools-fullscreen/?token=synthetic-private-viewer', expiresAt: '2026-10-02T00:02:00.000Z' });
  for (const url of ['http://www.browserbase.com/view', 'https://browserbase.com.evil.example/view', 'https://user:placeholder@www.browserbase.com/view']) {
    await assert.rejects(client(async () => json({ debuggerFullscreenUrl: url })).liveView(sid), safeError('invalid_response', true));
  }
});

test('a page-specific live view joins exactly one provider id, with no top-level, URL or title fallback', async () => {
  const top = 'https://www.browserbase.com/live?token=synthetic-top-level';
  const exact = 'https://www.browserbase.com/live?token=synthetic-page-b';
  const rows = [{ id: 'page-a', title: 'Identical title', url: 'https://example.com/', debuggerFullscreenUrl: top },
    { id: 'page-b', title: 'Identical title', url: 'https://example.com/', debuggerFullscreenUrl: exact }];
  const api = client(async () => json({ debuggerFullscreenUrl: top, pages: rows }));
  const bound = await api.liveView(sid, { targetId: 'page-b' });
  assert.equal(bound.url, exact); assert.equal(bound.targetId, 'page-b');
  assert.equal((await api.liveView(sid)).targetId, undefined);
  for (const pages of [undefined, [], [rows[0]], [rows[1], rows[1]]]) {
    await assert.rejects(client(async () => json({ debuggerFullscreenUrl: top, pages })).liveView(sid, { targetId: 'page-b' }), safeError('identity_mismatch', true));
  }
  await assert.rejects(client(async () => json({ debuggerFullscreenUrl: top, pages: [{ id: 'page-b' }] })).liveView(sid, { targetId: 'page-b' }), safeError('invalid_response', true));
  await assert.rejects(client(async () => json({ pages: [{ id: 'page-b', debuggerFullscreenUrl: 'https://evil.example/view' }] })).liveView(sid, { targetId: 'page-b' }), safeError('invalid_response', true));
});

test('bad input and absent or failed credentials stay before HTTP; credential lookup has a deadline', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return json(session); };
  const api = client(fetcher);
  for (const timeoutSeconds of [59, 21601, 60.5]) await assert.rejects(api.create({ projectId: project, timeoutSeconds }), safeError('invalid_request', false));
  await assert.rejects(api.retrieve('../session', project), safeError('invalid_request', false));
  await assert.rejects(api.liveView(sid, { expiresIn: 59 }), safeError('invalid_request', false));
  await assert.rejects(api.liveView(sid, { targetId: '../target' }), safeError('invalid_request', false));
  await assert.rejects(new BrowserbaseApiClient({ getApiKey: async () => undefined, fetch: fetcher }).create({ projectId: project }), safeError('not_configured', false));
  await assert.rejects(new BrowserbaseApiClient({ getApiKey: async () => { throw new Error(secret); }, fetch: fetcher }).create({ projectId: project }), safeError('not_configured', false));
  await assert.rejects(new BrowserbaseApiClient({ getApiKey: () => new Promise(() => {}), fetch: fetcher, timeoutMs: 10 }).create({ projectId: project }), safeError('timeout', false));
  assert.equal(calls, 0);
});

test('redirects, raw errors, provider refusals and uncertain timeout never leak secrets or retry', async () => {
  for (const [fetcher, code] of [
    [async () => new Response(secret, { status: 302, headers: { Location: 'https://evil.example/' + secret } }), 'redirect_refused'],
    [async () => json({ error: 'provider-private ' + secret }, 429), 'provider_refused'],
    [async () => { throw new Error('provider-private ' + connection); }, 'transport_failed'],
    [async () => new Response('{ provider-private ' + secret), 'invalid_response'],
    [async () => new Response('x'.repeat(512 * 1024 + 1)), 'invalid_response'],
  ] as Array<[typeof fetch, string]>) {
    let calls = 0;
    await assert.rejects(client(async (...args) => { calls++; return fetcher(...args); }).create({ projectId: project }), safeError(code, true));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(client(async (_url, init) => { calls++; return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error(connection)), { once: true })); }, { timeoutMs: 10 }).create({ projectId: project }), safeError('timeout', true));
  assert.equal(calls, 1);
});
