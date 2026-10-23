import assert from 'node:assert/strict';
import test from 'node:test';
import { answerDelegatedTask } from './project-api.js';

test('task answer transport binds the displayed question and leaves free text intact', async t => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(url), init });
    return Response.json({ task: { taskId: 'bg-fixture', phase: 'queued' } });
  });
  await answerDelegatedTask('bg-fixture', 'q-fixture-first', 'My own answer, outside the suggested choices.');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]!.path, 'https://fixture.invalid').pathname, '/m/api/delegated-tasks/bg-fixture/answer');
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { questionId: 'q-fixture-first', answer: 'My own answer, outside the suggested choices.' });
});
