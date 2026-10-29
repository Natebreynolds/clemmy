import assert from 'node:assert/strict';
import test from 'node:test';
import { listQuestionPresentations, presentInboxQuestion } from './api.js';

test('question Undo forwards the exact mutation receipt and does not report a refused restore as success', async () => {
  const savedFetch = globalThis.fetch;
  const savedWindow = globalThis.window;
  const events: string[] = [];
  const requests: Array<{ path: string; method?: string; body: unknown }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: (event: Event) => { events.push(event.type); return true; } } });
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ path: String(input), method: init?.method, body });
    if (body.action === 'restore' && body.mutationToken === 'older-phone-mutation') {
      return Response.json({ error: 'The question changed after this Undo was created.' }, { status: 409 });
    }
    return Response.json({ ok: true, id: 'task:fixture', action: body.action, generation: 'generation-current', mutationToken: 'exact-hide-mutation' });
  };
  try {
    const receipt = await presentInboxQuestion('task:fixture', 'defer', 'generation-visible');
    assert.deepEqual(requests[0]?.body, { action: 'defer', generation: 'generation-visible' }, 'hiding is bound to the question the owner actually saw');
    assert.equal(receipt.mutationToken, 'exact-hide-mutation');
    await presentInboxQuestion('task:fixture', 'restore', receipt.generation, receipt.mutationToken);
    assert.deepEqual(requests[1], { path: '/m/api/inbox/questions/task%3Afixture/presentation', method: 'POST', body: { action: 'restore', generation: 'generation-current', mutationToken: 'exact-hide-mutation' } });
    assert.equal(events.filter(event => event === 'clem:needs-you-changed').length, 2);
    await assert.rejects(presentInboxQuestion('task:fixture', 'restore', 'generation-current', 'older-phone-mutation'), (error: unknown) => (error as { status: number }).status === 409);
    assert.equal(events.filter(event => event === 'clem:needs-you-changed').length, 2, 'a refused restore does not publish a successful change');
    const sent = requests.length;
    await assert.rejects(presentInboxQuestion('task:fixture', 'restore', 'generation-current'), /missing its exact receipt/);
    assert.equal(requests.length, sent, 'Undo without its exact mutation token fails closed before sending');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: savedWindow });
  }
});

test('durable recovery reads use the authenticated mobile endpoint without a cached list', async () => {
  const savedFetch = globalThis.fetch;
  let request: { path: string; cache?: RequestCache } | null = null;
  const stored = { id: 'question:fixture', action: 'dismiss', generation: 'exact-generation', mutationToken: 'exact-mutation', question: 'Which file?' };
  globalThis.fetch = async (input, init) => { request = { path: String(input), cache: init?.cache }; return Response.json({ questions: [stored], count: 1 }); };
  try {
    const result = await listQuestionPresentations();
    assert.deepEqual(request, { path: '/m/api/inbox/questions/presentation', cache: 'no-store' });
    assert.equal(result.questions[0]?.generation, stored.generation);
    assert.equal(result.questions[0]?.mutationToken, stored.mutationToken);
  } finally { globalThis.fetch = savedFetch; }
});
