import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrangeChatList, cleanChatTitle } from './chat-list.js';

const rows = [
  { id: 'a', title: 'Quick SEO audit', updatedAt: 3, pinned: false },
  { id: 'b', title: 'Mesa comparison', updatedAt: 5, pinned: true },
  { id: 'c', title: 'hey hows it going', updatedAt: 4, agentName: 'Instagram Manager' },
  { id: 'd', title: 'Old pinned', updatedAt: 1, pinned: true },
];

test('pinned first, then newest first; search narrows by title or agent', () => {
  const all = arrangeChatList(rows, '');
  assert.deepEqual(all.pinned.map((r) => r.id), ['b', 'd']);
  assert.deepEqual(all.rest.map((r) => r.id), ['c', 'a']);
  assert.deepEqual(arrangeChatList(rows, 'seo').rest.map((r) => r.id), ['a']);
  assert.deepEqual(arrangeChatList(rows, 'instagram').rest.map((r) => r.id), ['c']);
  assert.deepEqual(arrangeChatList(rows, 'zzz'), { pinned: [], rest: [] });
});

test('a rename is one line and never empty', () => {
  assert.equal(cleanChatTitle('  Mesa   firms\n  '), 'Mesa firms');
  assert.equal(cleanChatTitle('   '), null);
});
