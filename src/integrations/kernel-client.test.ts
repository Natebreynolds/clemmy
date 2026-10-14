/**
 * Run: node scripts/run-tests-isolated.mjs src/integrations/kernel-client.test.ts
 *
 * The Kernel client speaks the cloud browser service's session contract:
 * a headful browser with the saved profile, retrieve, release, a live view
 * with a read-only watch mode, the running list, a profile. Every provider
 * answer is bounded and verified; a refusal keeps its HTTP status.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { KernelApiClient, KERNEL_DEFAULT_PROJECT, kernelConnectUrlFor, kernelLiveViewUrlFor } = await import('./kernel-client.js');
const { BrowserbaseClientError } = await import('./browserbase-client.js');

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown };
function fakeFetch(routes: Array<{ match: (call: Call) => boolean; status?: number; json?: unknown; text?: string }>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: Call = { method: init?.method ?? 'GET', url, headers, body };
    calls.push(call);
    const route = routes.find((candidate) => candidate.match(call));
    if (!route) return new Response('{"code":"not_found","message":"no route"}', { status: 404, headers: { 'content-type': 'application/json' } });
    const status = route.status ?? 200;
    const text = route.text ?? (route.json === undefined ? '' : JSON.stringify(route.json));
    return new Response(status === 204 ? null : text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetcher, calls };
}

const session = {
  session_id: 'cmh3k2j9a0001abc',
  cdp_ws_url: 'wss://abc.onkernel.com:8443/cdp?token=never-public',
  browser_live_view_url: 'https://abc.kernel.sh:8443/live?token=never-public',
  created_at: '2026-10-14T00:00:00.000Z',
  headless: false,
  tags: { createdBy: 'clementine' },
};

test('create asks for a headful browser with the saved profile, tagged as Clem\'s, and maps the answer to the session contract', async () => {
  const { fetcher, calls } = fakeFetch([{ match: (c) => c.method === 'POST' && c.url.endsWith('/browsers'), json: session }]);
  const client = new KernelApiClient({ getApiKey: async () => 'kernel-test-key', fetcher, now: () => 1_000 });
  const created = await client.create({ projectId: KERNEL_DEFAULT_PROJECT, timeoutSeconds: 7200, contextId: 'prof_123' });
  assert.equal(calls[0]?.headers.Authorization, 'Bearer kernel-test-key');
  assert.deepEqual(calls[0]?.body, { headless: false, stealth: false, timeout_seconds: 7200, profile: { id: 'prof_123', save_changes: true }, tags: { createdBy: 'clementine' } });
  assert.deepEqual(created, { sessionId: session.session_id, projectId: KERNEL_DEFAULT_PROJECT, status: 'RUNNING', connectUrl: session.cdp_ws_url, createdAt: session.created_at });
  const view = await client.liveView(session.session_id, { mode: 'watch' });
  assert.equal(view.url, `${session.browser_live_view_url}&readOnly=true`, 'the watch view is read-only, from the create answer, with no second request');
  assert.equal(calls.length, 1);
});

test('retrieve reads the browser; a deleted browser is a completed session, not an error', async () => {
  const { fetcher } = fakeFetch([
    { match: (c) => c.method === 'GET' && c.url.endsWith(`/browsers/${session.session_id}`), json: session },
    { match: (c) => c.method === 'GET' && c.url.endsWith('/browsers/gone'), status: 404, json: { code: 'not_found', message: 'gone' } },
  ]);
  const client = new KernelApiClient({ getApiKey: async () => 'k', fetcher });
  const live = await client.retrieve(session.session_id, KERNEL_DEFAULT_PROJECT);
  assert.equal(live.status, 'RUNNING'); assert.equal(live.connectUrl, session.cdp_ws_url);
  const gone = await client.retrieve('gone', KERNEL_DEFAULT_PROJECT);
  assert.deepEqual(gone, { sessionId: 'gone', projectId: KERNEL_DEFAULT_PROJECT, status: 'COMPLETED' });
});

test('release deletes the browser and treats an already-deleted one as released', async () => {
  const { fetcher, calls } = fakeFetch([
    { match: (c) => c.method === 'DELETE' && c.url.endsWith(`/browsers/${session.session_id}`), status: 204 },
    { match: (c) => c.method === 'DELETE' && c.url.endsWith('/browsers/gone'), status: 404, json: { code: 'not_found', message: 'gone' } },
  ]);
  const client = new KernelApiClient({ getApiKey: async () => 'k', fetcher });
  await client.release(session.session_id, KERNEL_DEFAULT_PROJECT);
  await client.release('gone', KERNEL_DEFAULT_PROJECT);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 2);
});

test('the running list marks the browsers Clem started, and a profile is created once by name', async () => {
  const { fetcher, calls } = fakeFetch([
    { match: (c) => c.method === 'GET' && c.url.includes('/browsers?status=active'), json: { items: [session, { ...session, session_id: 'other', tags: {} }] } },
    { match: (c) => c.method === 'POST' && c.url.endsWith('/profiles'), status: 201, json: { id: 'prof_new', name: 'clem-x' } },
  ]);
  const client = new KernelApiClient({ getApiKey: async () => 'k', fetcher, now: () => 42 });
  const running = await client.listRunning(KERNEL_DEFAULT_PROJECT);
  assert.deepEqual(running.map((row) => [row.sessionId, row.startedByClem]), [[session.session_id, true], ['other', false]]);
  assert.equal(await client.createContext(KERNEL_DEFAULT_PROJECT), 'prof_new');
  assert.match(String(calls.at(-1)?.body && (calls.at(-1)!.body as { name: string }).name), /^clem-/);
});

test('a refusal keeps the provider\'s status: 401 and 403 reject the key, 402 and 429 are the limit, a missing key never leaves the machine', async () => {
  for (const [status, code] of [[401, 'credential_rejected'], [403, 'credential_rejected'], [402, 'provider_limit'], [429, 'provider_limit'], [500, 'provider_refused']] as const) {
    const { fetcher } = fakeFetch([{ match: () => true, status, json: { code: 'x', message: 'y' } }]);
    const client = new KernelApiClient({ getApiKey: async () => 'k', fetcher });
    await assert.rejects(client.verifyProject(KERNEL_DEFAULT_PROJECT), (error) => error instanceof BrowserbaseClientError && error.code === code && error.httpStatus === status);
  }
  const { fetcher, calls } = fakeFetch([{ match: () => true, json: session }]);
  const client = new KernelApiClient({ getApiKey: async () => undefined, fetcher });
  await assert.rejects(client.verifyProject(KERNEL_DEFAULT_PROJECT), (error) => error instanceof BrowserbaseClientError && error.code === 'not_configured');
  assert.equal(calls.length, 0);
});

test('only Kernel\'s own secure endpoints are accepted for the connection and the live view', () => {
  assert.equal(kernelConnectUrlFor('wss://abc.onkernel.com:8443/cdp?x=1'), 'wss://abc.onkernel.com:8443/cdp?x=1');
  assert.equal(kernelConnectUrlFor('ws://abc.onkernel.com:8443/cdp'), null, 'plain websocket');
  assert.equal(kernelConnectUrlFor('wss://evil.example.com/cdp'), null, 'another host');
  assert.equal(kernelConnectUrlFor('wss://user:pw@abc.onkernel.com:8443/cdp'), null, 'credentials in the url');
  assert.equal(kernelLiveViewUrlFor('https://abc.kernel.sh:8443/live', 'watch'), 'https://abc.kernel.sh:8443/live?readOnly=true');
  assert.equal(kernelLiveViewUrlFor('https://abc.kernel.sh:8443/live#frag'), null, 'a fragment is not a view');
  assert.equal(kernelLiveViewUrlFor('http://abc.kernel.sh/live'), null, 'plain http');
});
