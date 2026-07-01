/**
 * Run: npx tsx --test src/integrations/composio/abort-aware-fetch.test.ts
 *
 * installAbortAwareFetch wraps the underlying @composio/client's mutable `fetch`
 * property so a per-tool-call AbortSignal (carried on the harness ALS) is merged
 * into each request. Contract:
 *   - no ALS signal  ⇒ the init passed to the original fetch is UNTOUCHED
 *   - an ALS signal  ⇒ the merged signal aborts when the ALS controller fires
 *   - the wrapper is installed at most once per client
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installAbortAwareFetch } from './client.js';
import { runWithToolAbortSignal } from '../../runtime/tool-abort-context.js';

/** A fake Composio (@composio/core) whose getClient() returns a Stainless-like
 *  object with a mutable `fetch` property, exactly the shape the wrapper targets. */
function fakeComposio(recorded: { init?: Record<string, unknown> }): {
  getClient: () => { fetch: (url: unknown, init?: Record<string, unknown>) => Promise<unknown> };
} {
  const client = {
    fetch: async (_url: unknown, init?: Record<string, unknown>): Promise<unknown> => {
      recorded.init = init;
      return { ok: true };
    },
  };
  return { getClient: () => client };
}

test('no ALS signal ⇒ original init is passed through untouched', async () => {
  const recorded: { init?: Record<string, unknown> } = {};
  const composio = fakeComposio(recorded);
  installAbortAwareFetch(composio as never);
  const original = new AbortController().signal;
  await composio.getClient().fetch('https://x', { signal: original, method: 'GET' });
  assert.equal(recorded.init?.signal, original, 'signal unchanged when no ALS signal is present');
  assert.equal(recorded.init?.method, 'GET');
});

test('an ALS signal is merged and the merged signal aborts when the controller fires', async () => {
  const recorded: { init?: Record<string, unknown> } = {};
  const composio = fakeComposio(recorded);
  installAbortAwareFetch(composio as never);
  const existing = new AbortController();
  const alsAc = new AbortController();
  await runWithToolAbortSignal(alsAc.signal, async () => {
    await composio.getClient().fetch('https://x', { signal: existing.signal });
  });
  const merged = recorded.init?.signal as AbortSignal | undefined;
  assert.ok(merged, 'a signal was passed');
  assert.equal(merged!.aborted, false, 'not aborted yet');
  alsAc.abort(new Error('tool timed out'));
  assert.equal(merged!.aborted, true, 'ALS abort propagates to the merged signal');
});

test('an ALS signal merges even when the request had no prior signal', async () => {
  const recorded: { init?: Record<string, unknown> } = {};
  const composio = fakeComposio(recorded);
  installAbortAwareFetch(composio as never);
  const alsAc = new AbortController();
  await runWithToolAbortSignal(alsAc.signal, async () => {
    await composio.getClient().fetch('https://x', { method: 'POST' });
  });
  const merged = recorded.init?.signal as AbortSignal | undefined;
  assert.ok(merged, 'a signal was injected');
  alsAc.abort();
  assert.equal(merged!.aborted, true);
});

test('installAbortAwareFetch is idempotent (does not double-wrap)', async () => {
  const recorded: { init?: Record<string, unknown> } = {};
  const composio = fakeComposio(recorded);
  const client = composio.getClient();
  installAbortAwareFetch(composio as never);
  const afterFirst = client.fetch;
  installAbortAwareFetch(composio as never);
  assert.equal(client.fetch, afterFirst, 'second install is a no-op');
});
