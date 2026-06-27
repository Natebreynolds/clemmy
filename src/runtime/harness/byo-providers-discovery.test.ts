import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProviderModels } from './byo-providers.js';

// discoverProviderModels is the pure core behind POST /api/console/settings/
// model-providers/models. We inject a fake fetch so it unit-tests without Express
// or a live provider, and assert the precise status mapping + that the key never
// leaks into the response body.
type FakeResp = { status: number; ok: boolean; json: () => Promise<unknown> };
function resp(status: number, body: unknown): FakeResp {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
const OK = { baseURL: 'https://api.together.ai/v1', apiKey: 'k-secret' };

test('discoverProviderModels: 200 {data:[…]} → normalized, sorted models', async () => {
  const fetchImpl = (async () => resp(200, { object: 'list', data: [{ id: 'b' }, { id: 'a', display_name: 'A' }] })) as unknown as typeof fetch;
  const r = await discoverProviderModels(OK, fetchImpl);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { models: [{ id: 'a', label: 'A' }, { id: 'b', label: undefined }] });
});

test('discoverProviderModels: 401/403 → 401 "rejected the API key"', async () => {
  for (const code of [401, 403]) {
    const r = await discoverProviderModels(OK, (async () => resp(code, {})) as unknown as typeof fetch);
    assert.equal(r.status, 401);
    assert.match((r.body as { error: string }).error, /rejected the API key/);
  }
});

test('discoverProviderModels: 404 → "no /models endpoint"', async () => {
  const r = await discoverProviderModels(OK, (async () => resp(404, {})) as unknown as typeof fetch);
  assert.equal(r.status, 404);
  assert.match((r.body as { error: string }).error, /no \/models endpoint/);
});

test('discoverProviderModels: other non-ok status → 502', async () => {
  const r = await discoverProviderModels(OK, (async () => resp(500, {})) as unknown as typeof fetch);
  assert.equal(r.status, 502);
});

test('discoverProviderModels: AbortError → 504 timed out', async () => {
  const fetchImpl = (async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }) as unknown as typeof fetch;
  const r = await discoverProviderModels(OK, fetchImpl);
  assert.equal(r.status, 504);
  assert.match((r.body as { error: string }).error, /timed out/);
});

test('discoverProviderModels: non-http URL → 400 and fetch is NEVER called', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return resp(200, {}); }) as unknown as typeof fetch;
  const r = await discoverProviderModels({ baseURL: 'ftp://nope', apiKey: 'k' }, fetchImpl);
  assert.equal(r.status, 400);
  assert.equal(calls, 0);
});

test('discoverProviderModels: missing key → 400 and fetch is NEVER called', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return resp(200, {}); }) as unknown as typeof fetch;
  const r = await discoverProviderModels({ baseURL: 'https://api.together.ai/v1', apiKey: '' }, fetchImpl);
  assert.equal(r.status, 400);
  assert.equal(calls, 0);
});

test('discoverProviderModels: the API key is never echoed in the response body', async () => {
  const r = await discoverProviderModels(OK, (async () => resp(401, {})) as unknown as typeof fetch);
  assert.equal(JSON.stringify(r.body).includes('k-secret'), false);
});
