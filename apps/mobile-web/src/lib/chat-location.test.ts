import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MobileChatLocationStore } from './chat-location';

test('leaving and returning to a conversation preserves its identity', () => {
  const store = new MobileChatLocationStore();
  store.save({ kind: 'chat', sessionId: 'chat-a', title: 'A conversation' });
  assert.deepEqual(store.resume(), { kind: 'chat', sessionId: 'chat-a', title: 'A conversation' });
});
test('an unsent chat resumes its same draft scope without replaying initial handoff instructions', () => {
  const store = new MobileChatLocationStore();
  const handoff = { kind: 'new' as const, scope: 'new:a', agentId: 'agent-a', draft: 'already sent once', autoSend: true, attachments: [{ id: 'file-a' }] };
  store.save(handoff);
  const restored = store.resume();
  assert.equal(restored?.kind, 'new');
  assert.equal(restored && 'scope' in restored ? restored.scope : null, 'new:a');
  assert.ok(restored && !('autoSend' in restored) && !('draft' in restored) && !('attachments' in restored));
});
test('a new draft that acquired a real conversation resumes its actual conversation', () => {
  const store = new MobileChatLocationStore();
  store.save({ kind: 'new', scope: 'new:a' });
  store.promote('new:a', 'chat-a');
  store.save({ kind: 'new', scope: 'new:a' });
  assert.deepEqual(store.resume(), { kind: 'chat', sessionId: 'chat-a' });
});
test('a late old handoff cannot change the currently selected draft', () => {
  const store = new MobileChatLocationStore();
  store.save({ kind: 'new', scope: 'new:a' });
  store.save({ kind: 'new', scope: 'new:b' });
  store.promote('new:a', 'chat-a');
  const current = store.resume();
  assert.equal(current?.kind, 'new');
  assert.equal(current && 'scope' in current ? current.scope : null, 'new:b');
});
test('explicit Back and confirmed sign out clear navigation state', () => {
  const store = new MobileChatLocationStore();
  store.save({ kind: 'chat', sessionId: 'chat-a' });
  store.save(null);
  assert.equal(store.resume(), null);
  store.save({ kind: 'new', scope: 'new:a' });
  store.promote('new:a', 'chat-a');
  store.clear();
  assert.equal(store.resume(), null);
  store.save({ kind: 'new', scope: 'new:a' });
  assert.equal(store.resume()?.kind, 'new');
});
