/**
 * Short and in-progress threads sit on the composer, not at the top of a
 * tall scroller with empty canvas underneath. The column is max-w-5xl so a
 * workstation doesn't leave a field of unused canvas around 760px.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAT_THREAD } from './lib/chatColumn';

const CHAT = readFileSync(new URL('../../screens/Chat.tsx', import.meta.url), 'utf8');
const THREAD = readFileSync(new URL('./chat/ConversationThread.tsx', import.meta.url), 'utf8');
const SHELL = readFileSync(new URL('../../components/AppShell.tsx', import.meta.url), 'utf8');

test('the live chat thread packs against the composer on a workstation column', () => {
  assert.match(CHAT_THREAD, /max-w-5xl/);
  assert.match(CHAT_THREAD, /justify-end/);
  assert.match(CHAT_THREAD, /gap-5/);
  assert.doesNotMatch(CHAT_THREAD, /space-y-/);
  assert.match(CHAT, /className=\{CHAT_THREAD\}/);
  assert.equal([...THREAD.matchAll(/className=\{CHAT_THREAD\}/g)].length, 2, 'continuable and read-only threads both sit on the composer');
});

test('the chat route owns its scroller so the shell does not leave a blank page under the thread', () => {
  assert.match(SHELL, /pathname === '\/chat' \|\| location\.pathname\.startsWith\('\/chat\/'\) \? 'overflow-hidden' : 'overflow-y-auto'/);
});
