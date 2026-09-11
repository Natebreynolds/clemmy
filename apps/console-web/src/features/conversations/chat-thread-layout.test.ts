/**
 * Short and in-progress threads sit on the composer, not at the top of a
 * tall scroller with empty canvas underneath.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CHAT = readFileSync(new URL('../../screens/Chat.tsx', import.meta.url), 'utf8');
const THREAD = readFileSync(new URL('./chat/ConversationThread.tsx', import.meta.url), 'utf8');

test('the live chat thread packs against the composer', () => {
  assert.match(CHAT, /flex min-h-full w-full max-w-\[760px\] flex-col justify-end/);
  const threadColumns = [...THREAD.matchAll(/flex min-h-full w-full max-w-3xl flex-col justify-end/g)];
  assert.equal(threadColumns.length, 2, 'continuable and read-only threads both sit on the composer');
});
