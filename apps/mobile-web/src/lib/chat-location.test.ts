import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MobileChatLocationStore } from './chat-location';
import { MobileDraftStore } from './file-context';

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

test('opening the chat list keeps the exact active conversation available to return to', () => {
  const store = new MobileChatLocationStore();
  store.save({ kind: 'chat', sessionId: 'chat:active / one', title: 'The active conversation' });
  store.showList();
  assert.equal(store.showingList, true);
  assert.deepEqual(store.resume(), { kind: 'chat', sessionId: 'chat:active / one', title: 'The active conversation' });
  store.showConversation();
  assert.equal(store.showingList, false);
  assert.equal(store.resume()?.kind, 'chat');
});

test('list navigation retains an unfinished draft and attachment scope without replaying its first handoff', () => {
  const navigation = new MobileChatLocationStore();
  const drafts = new MobileDraftStore(() => {});
  const scope = 'new:unfinished';
  drafts.patch(scope, { text: 'Still writing this message', stagedAttachments: [{ id: 'file-one', name: 'notes.txt', kind: 'file' }] });
  const opened = { kind: 'new' as const, scope, projectId: 'project-one', autoSend: true, draft: 'Old handoff' };
  navigation.save(opened);
  navigation.showList();
  navigation.save(opened);
  assert.equal(navigation.showingList, true, 'a mounted chat snapshot cannot undo the deliberate list view');
  const resume = navigation.resume();
  assert.deepEqual(resume, { kind: 'new', scope, agentId: undefined, agentName: undefined, projectId: 'project-one', projectName: undefined });
  assert.equal(drafts.read(scope).text, 'Still writing this message');
  assert.equal(drafts.read(scope).stagedAttachments?.[0].id, 'file-one');
  assert.ok(resume && !('autoSend' in resume) && !('draft' in resume));
  navigation.promote(scope, 'chat-created-while-open');
  assert.deepEqual(navigation.resume(), { kind: 'chat', sessionId: 'chat-created-while-open' }, 'return uses the actual created conversation instead of starting another one');
});
