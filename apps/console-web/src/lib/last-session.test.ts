/**
 * Run: npx tsx --test apps/console-web/src/lib/last-session.test.ts
 *
 * Pins the durable active-conversation pointer (2026-08-04 static window):
 * the id survives navigation via localStorage, clears on release, and the
 * unified form is what the /chat/:sessionId route accepts — including raw
 * ids that themselves contain colons (console:…), which a naive
 * "already has a colon" check mis-classified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  },
};

const { lastChatSession, rememberLastChatSession, unifiedChatSessionId } = await import('./last-session');

test('the active conversation pointer round-trips and releases', () => {
  assert.equal(lastChatSession(), null);
  rememberLastChatSession('harness:sess-desktop-abc');
  assert.equal(lastChatSession(), 'harness:sess-desktop-abc');
  rememberLastChatSession(null);
  assert.equal(lastChatSession(), null, 'New chat releases the pointer');
});

test('unified ids gain exactly one store prefix', () => {
  assert.equal(unifiedChatSessionId('sess-desktop-abc'), 'harness:sess-desktop-abc');
  assert.equal(unifiedChatSessionId('console:postfix-live-1'), 'harness:console:postfix-live-1',
    'a raw id containing colons still needs the store prefix');
  assert.equal(unifiedChatSessionId('harness:sess-desktop-abc'), 'harness:sess-desktop-abc', 'no double prefix');
  assert.equal(unifiedChatSessionId('desktop:legacy-1'), 'desktop:legacy-1');
});
