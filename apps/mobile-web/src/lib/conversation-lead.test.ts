import test from 'node:test';
import assert from 'node:assert/strict';
import { orderRecentConversations, waitingAskIsFresh } from './conversation-lead';

const NOW = Date.parse('2026-10-30T18:00:00Z');
const hours = (n: number) => NOW - n * 60 * 60_000;

test("a fresh ask leads Clem's screen; one waiting for days is history", () => {
  const fresh = { id: 'a', waitingOnYou: { question: 'Which account?' }, updatedAt: hours(2) };
  const old = { id: 'b', waitingOnYou: { question: 'Draft it?' }, updatedAt: hours(3 * 24) };
  const plain = { id: 'c', waitingOnYou: null, updatedAt: hours(1) };
  assert.equal(waitingAskIsFresh(fresh, NOW), true);
  assert.equal(waitingAskIsFresh(old, NOW), false);
  assert.deepEqual(orderRecentConversations([plain, old, fresh], NOW).map((row) => row.id), ['a', 'c', 'b']);
});
