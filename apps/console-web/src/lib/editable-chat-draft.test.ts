import assert from 'node:assert/strict';
import test from 'node:test';
import { editableChatDraft } from './editable-chat-draft';
import { moveComposerDraft, newComposerDraftKey, readComposerDraft, writeComposerDraft } from './composer-drafts';

test('help and replay navigation prepares a new local draft without overwriting an existing or assigned draft', () => {
  const stamp = 1_900_000_000_000;
  const existingKey = newComposerDraftKey('/chat', '', stamp);
  writeComposerDraft(existingKey, current => ({ ...current, text: 'User-owned draft' }));
  const target = editableChatDraft('Help me find Projects.', stamp)!;
  assert.equal(target.pathname, '/chat'); assert.ok(target.state.newChat > stamp);
  assert.deepEqual(Object.keys(target.state), ['newChat'], 'no auto-send prompt or session identity');
  const key = newComposerDraftKey('/chat', 'any-navigation-key', target.state.newChat);
  assert.equal(readComposerDraft(key).text, 'Help me find Projects.');
  assert.equal(readComposerDraft(existingKey).text, 'User-owned draft');
  moveComposerDraft(key, 'session:FRAMEWORK-TEST-owned');
  const another = editableChatDraft('Replay as an editable draft.', target.state.newChat)!;
  assert.ok(another.state.newChat > target.state.newChat);
  assert.equal(readComposerDraft('session:FRAMEWORK-TEST-owned').text, 'Help me find Projects.');
});

test('empty text or invalid navigation stamps cannot create a draft', () => {
  assert.equal(editableChatDraft('   ', 123), null);
  for (const stamp of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) assert.equal(editableChatDraft('Help', stamp), null);
});
