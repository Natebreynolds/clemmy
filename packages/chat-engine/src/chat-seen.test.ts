/**
 * Run: node scripts/run-tests-isolated.mjs packages/chat-engine/src/chat-seen.test.ts
 *
 * The conversation list marks a reply that finished while the owner was
 * somewhere else, and only that: never what was already there when the phone
 * first looked, never a conversation still running, never one they have read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatHasNews, chatSeenBaseline, markChatSeen, readChatSeen, type ChatSeenStorage } from './chat-seen.js';

function memoryStore(): ChatSeenStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

test('the first list is the baseline: nothing already there has news', () => {
  const store = memoryStore();
  const rows = [{ id: 'a', updatedAt: 100 }, { id: 'b', updatedAt: 300 }];
  const state = chatSeenBaseline(rows, store);
  assert.equal(state?.since, 300);
  assert.equal(rows.some((row) => chatHasNews(row, state)), false);
  assert.equal(chatSeenBaseline([{ id: 'c', updatedAt: 999 }], store)?.since, 300, 'the baseline is made once');
});

test('a reply after the owner last looked has news until it is opened', () => {
  const store = memoryStore();
  chatSeenBaseline([{ id: 'a', updatedAt: 100 }], store);
  const finished = { id: 'a', updatedAt: 250 };
  assert.equal(chatHasNews(finished, readChatSeen(store)), true);
  assert.equal(chatHasNews({ ...finished, running: true }, readChatSeen(store)), false, 'running is shown as running, not as news');
  markChatSeen('a', 250, store);
  assert.equal(chatHasNews(finished, readChatSeen(store)), false);
  markChatSeen('a', 200, store);
  assert.equal(readChatSeen(store)?.seen.a, 250, 'an older mark never rewinds');
});

test('a conversation started elsewhere after the baseline has news', () => {
  const store = memoryStore();
  chatSeenBaseline([{ id: 'a', updatedAt: 100 }], store);
  assert.equal(chatHasNews({ id: 'new', updatedAt: 150 }, readChatSeen(store)), true);
});

test('without storage nothing is marked and nothing breaks', () => {
  assert.equal(chatSeenBaseline([{ id: 'a', updatedAt: 1 }], null), null);
  assert.equal(chatHasNews({ id: 'a', updatedAt: 5 }, null), false);
  markChatSeen('a', 5, null);
});
