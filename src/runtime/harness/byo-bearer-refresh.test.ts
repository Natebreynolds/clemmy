import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { getByoModel, resetByoModelCache } from './byo-model.js';
const request = { input: 'Reply ready.', modelSettings: {}, tools: [], outputType: 'text', handoffs: [], tracing: false } as never;
const backend = { configured: true, baseURL: 'https://bearer-fixture.invalid/v1', apiKey: 'obsolete-access', primaryId: 'grok-4.6', judgeId: 'grok-4.6', providerLabel: 'xAI' };
function observe() {
  const headers: Array<string | null> = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url, init); assert.equal(req.url, `${backend.baseURL}/chat/completions`);
    headers.push(req.headers.get('authorization'));
    const body = await req.json() as { stream?: boolean };
    const base = { id: `fixture-${headers.length}`, created: 1, model: 'grok-4.6', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    if (body.stream) return new Response(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  });
  return headers;
}
afterEach(() => { mock.restoreAll(); resetByoModelCache(); });
test('a cached OAuth client uses the current bearer on every request', async () => {
  const headers = observe(); let token = 'current-access';
  const model = getByoModel('grok-4.6', { ...backend, refreshBearer: async () => token });
  await model.getResponse(request); token = 'rotated-access'; await model.getResponse(request);
  assert.deepEqual(headers, ['Bearer current-access', 'Bearer rotated-access']);
});
test('disconnect does not dispatch the cached bearer', async () => {
  const headers = observe();
  const model = getByoModel('grok-4.6', { ...backend, refreshBearer: async () => null });
  await assert.rejects(model.getResponse(request)); assert.equal(headers.length, 0);
});
test('refresh failure does not fall through to stale credentials; a later request can recover', async () => {
  const headers = observe(); let fail = true;
  const model = getByoModel('grok-4.6', { ...backend, refreshBearer: async () => { if (fail) throw Error('temporary refresh failure'); return 'recovered-access'; } });
  await assert.rejects(model.getResponse(request)); assert.equal(headers.length, 0);
  fail = false; await model.getResponse(request); assert.deepEqual(headers, ['Bearer recovered-access']);
});
test('explicit API keys retain the static credential path', async () => {
  const headers = observe(); await getByoModel('grok-4.6', backend).getResponse(request);
  assert.deepEqual(headers, ['Bearer obsolete-access']);
});
