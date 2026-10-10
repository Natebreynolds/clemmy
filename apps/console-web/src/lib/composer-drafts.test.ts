import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffComposerDraft, moveComposerDraft, readComposerDraft, writeComposerDraft } from './composer-drafts';

test('switching conversations restores their separate text and attachments', () => {
  writeComposerDraft('session:a', () => ({ text: 'Keep this draft', attachments: [{ localId: 'f1', name: 'brief.pdf', status: 'ready', id: 'attachment-1' }] }));
  writeComposerDraft('session:b', () => ({ text: 'Another task', attachments: [] }));
  assert.equal(readComposerDraft('session:a').text, 'Keep this draft');
  assert.equal(readComposerDraft('session:a').attachments[0]?.id, 'attachment-1');
  assert.equal(readComposerDraft('session:b').text, 'Another task');
  assert.equal(readComposerDraft('new:separate').text, '');
});

test('new-chat migration keeps late uploads in the assigned conversation', () => {
  writeComposerDraft('new:upload', () => ({ text: '', attachments: [{ localId: 'f2', name: 'notes.csv', status: 'uploading' }] }));
  moveComposerDraft('new:upload', 'session:assigned');
  writeComposerDraft('new:upload', current => ({ ...current, attachments: current.attachments.map(a => ({ ...a, status: 'ready', id: 'finished-upload' })) }));
  assert.equal(readComposerDraft('session:assigned').attachments[0]?.id, 'finished-upload');
  assert.equal(readComposerDraft('new:next-chat').attachments.length, 0);
  moveComposerDraft('new:upload', 'session:assigned');
  assert.equal(readComposerDraft('session:assigned').attachments.length, 1);
});

test('clearing a sent draft does not clear another conversation', () => {
  writeComposerDraft('session:send', () => ({ text: 'Send me', attachments: [] }));
  writeComposerDraft('session:keep', () => ({ text: 'Still thinking', attachments: [] }));
  writeComposerDraft('session:send', () => ({ text: '', attachments: [] }));
  assert.equal(readComposerDraft('session:send').text, '');
  assert.equal(readComposerDraft('session:keep').text, 'Still thinking');
});

test('New chat never aliases its draft to the previous chat before reset completes', () => {
  const old = { draftKey: 'new:route-old', sessionId: 'old-chat' };
  const transitioning = { draftKey: 'new:route-fresh', sessionId: 'old-chat' };
  const unassigned = { draftKey: 'new:route-fresh', sessionId: null };
  const assigned = { draftKey: 'new:route-fresh', sessionId: 'fresh-chat' };
  writeComposerDraft('session:old-chat', () => ({ text: 'Old unsent thought', attachments: [] }));
  handoffComposerDraft(old, transitioning);
  handoffComposerDraft(transitioning, unassigned);
  assert.equal(readComposerDraft(unassigned.draftKey).text, '');
  writeComposerDraft(unassigned.draftKey, () => ({ text: 'New follow-up while sending', attachments: [{ localId: 'fresh-upload', name: 'new.pdf', status: 'uploading' }] }));
  handoffComposerDraft(unassigned, assigned);
  writeComposerDraft(unassigned.draftKey, current => ({ ...current, attachments: current.attachments.map(file => ({ ...file, status: 'ready', id: 'new-attachment' })) }));
  assert.equal(readComposerDraft('session:old-chat').text, 'Old unsent thought');
  assert.equal(readComposerDraft('session:fresh-chat').text, 'New follow-up while sending');
  assert.equal(readComposerDraft('session:fresh-chat').attachments[0]?.id, 'new-attachment');
  assert.equal(readComposerDraft('session:old-chat').attachments.length, 0);
});

test('an assigned creation draft cannot be rebound to a different conversation', () => {
  writeComposerDraft('new:once-only', () => ({ text: 'Original thought', attachments: [] }));
  moveComposerDraft('new:once-only', 'session:first-owner');
  moveComposerDraft('new:once-only', 'session:second-owner');
  writeComposerDraft('new:once-only', current => ({ ...current, text: 'Late update' }));
  assert.equal(readComposerDraft('session:first-owner').text, 'Late update');
  assert.equal(readComposerDraft('session:second-owner').text, '');
});
