/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/byo-grok-conversation.test.ts
 *
 * xAI routes a call's prompt cache by `x-grok-conv-id`: every call of one Clem
 * conversation carries the same id, two conversations carry different ids, a
 * call outside any conversation carries none, and other providers never see it.
 */
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { getByoModel, grokConversationId, resetByoModelCache } from './byo-model.js';
import { harnessRunContextStorage } from './brackets.js';

const request = { input: 'Reply ready.', modelSettings: {}, tools: [], outputType: 'text', handoffs: [], tracing: false } as never;
const xai = { configured: true, baseURL: 'https://conv-fixture.invalid/v1', apiKey: 'fixture-key', primaryId: 'grok-4.6', judgeId: 'grok-4.6', providerLabel: 'xAI', providerId: 'xai' };

function observe() {
  const ids: Array<string | null> = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url, init);
    ids.push(req.headers.get('x-grok-conv-id'));
    const body = await req.json() as { stream?: boolean };
    const base = { id: `fixture-${ids.length}`, created: 1, model: 'grok-4.6', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    if (body.stream) return new Response(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  });
  return ids;
}
const inConversation = <T>(sessionId: string, fn: () => Promise<T>) => harnessRunContextStorage.run({ sessionId } as never, fn);
afterEach(() => { mock.restoreAll(); resetByoModelCache(); });

test('every call of one conversation carries one xAI conversation id; another conversation carries its own', async () => {
  const ids = observe();
  const model = getByoModel('grok-4.6', xai);
  await inConversation('sess-desktop-a', () => model.getResponse(request));
  await inConversation('sess-desktop-a', () => model.getResponse(request));
  await inConversation('sess-desktop-b', () => model.getResponse(request));
  const a = grokConversationId('sess-desktop-a');
  assert.match(a ?? '', /^clem:[0-9a-f]{16}$/);
  assert.deepEqual(ids, [a, a, grokConversationId('sess-desktop-b')]);
  assert.notEqual(ids[0], ids[2]);
  assert.ok(!ids[0]!.includes('sess-desktop'), 'the session id itself never leaves the machine');
});

test('a call outside a conversation, or to another provider, carries no xAI conversation id', async () => {
  const ids = observe();
  await getByoModel('grok-4.6', xai).getResponse(request);
  await inConversation('sess-desktop-a', () => getByoModel('glm-5.2', { ...xai, baseURL: 'https://other-fixture.invalid/v1', providerId: 'default' }).getResponse(request));
  assert.deepEqual(ids, [null, null]);
});
