import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationSendScope } from './conversation-send-scope';

test('unchanged conversation can finish asynchronous agent/project preparation', async () => {
  const owner = createConversationSendScope('chat-a');
  const send = owner.capture(() => 'session-a');
  await Promise.all([Promise.resolve({ agentId: 'agent-a' }), Promise.resolve({ projectId: 'project-a' })]);
  assert.doesNotThrow(send.assertCurrent);
});

test('new chat invalidates pending preparation even when both session IDs are null', async () => {
  const owner = createConversationSendScope('new:chat:one');
  const send = owner.capture(() => null);
  let dispatched = false;
  const pending = Promise.resolve().then(() => { send.assertCurrent(); dispatched = true; });
  owner.update('new:chat:two');
  await assert.rejects(pending, /conversation changed/);
  assert.equal(dispatched, false);
});

test('leaving and returning to the same route never revives a previous send', () => {
  const owner = createConversationSendScope('chat-a');
  const send = owner.capture(() => 'session-a');
  owner.update('chat-b');
  owner.update('chat-a');
  assert.throws(send.assertCurrent, /conversation changed/);
  assert.doesNotThrow(owner.capture(() => 'session-a').assertCurrent);
});

test('unmount cancels pending preparation, including a later strict-mode setup', () => {
  const owner = createConversationSendScope('chat-a');
  const send = owner.capture(() => 'session-a');
  owner.dispose();
  owner.activate();
  assert.throws(send.assertCurrent, /conversation changed/);
  assert.equal(send.isCurrentRoute(), false);
  assert.doesNotThrow(owner.capture(() => 'session-a').assertCurrent);
});

test('a changed server session is caught without waiting for a component render', () => {
  const owner = createConversationSendScope('chat-a');
  let session: string | null = 'session-a';
  const send = owner.capture(() => session);
  session = null;
  assert.throws(send.assertCurrent, /conversation changed/);
});

test('first acceptance may navigate its owning route after assigning a server ID', () => {
  const owner = createConversationSendScope('home-a');
  let session: string | null = null;
  const send = owner.capture(() => session);
  send.assertCurrent();
  session = 'assigned-session';
  assert.equal(send.isCurrentRoute(), true);
  owner.dispose();
  assert.equal(send.isCurrentRoute(), false, 'late acceptance may save its draft but cannot navigate away from another screen');
});
