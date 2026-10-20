import assert from 'node:assert/strict';
import test from 'node:test';
import { getApprovalResult, setSessionFingerprint } from './api.js';

test('result transport is one exact-card read with raw owner, pinned revision and cancellation', async t => {
  setSessionFingerprint(null);
  const controller = new AbortController();
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (path: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(path), init });
    return Response.json({ marker: 'unvalidated response' });
  });
  const value = await getApprovalResult({ approvalId: 'apr-exact', sessionId: 'sess-raw-owner',
    pendingActionId: 'pa-exact', payloadHash: 'aabbccddeeff0011', recordUpdatedAt: '2026-10-19T20:00:00.000Z' }, controller.signal);
  assert.deepEqual(value, { marker: 'unvalidated response' }, 'shared projection owns response validation');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.path, 'https://fixture.invalid');
  assert.equal(url.pathname, '/m/api/approvals/apr-exact/result');
  assert.deepEqual(Object.fromEntries(url.searchParams), { sessionId: 'sess-raw-owner', pendingActionId: 'pa-exact',
    payloadHash: 'aabbccddeeff0011', recordUpdatedAt: '2026-10-19T20:00:00.000Z' });
  assert.equal(calls[0]!.init?.method ?? 'GET', 'GET');
  assert.equal(calls[0]!.init?.body, undefined);
  assert.equal(calls[0]!.init?.cache, 'no-store');
  assert.equal(calls[0]!.init?.signal, controller.signal);
});
