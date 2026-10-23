import assert from 'node:assert/strict';
import test from 'node:test';
import { answerTask } from './projects.js';

test('task answer transport binds the displayed question and leaves free text intact', async t => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __CLEM_BOOTSTRAP__: { token: 'synthetic-fixture' } } });
  t.after(() => { if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window'); });
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(url), init });
    return Response.json({ task: { taskId: 'bg-fixture', phase: 'queued' } });
  });
  await answerTask('bg-fixture', 'q-fixture-first', 'My own answer, outside the suggested choices.');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]!.path, 'https://fixture.invalid').pathname, '/api/console/delegated-tasks/bg-fixture/answer');
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { questionId: 'q-fixture-first', answer: 'My own answer, outside the suggested choices.' });
});
