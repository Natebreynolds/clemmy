import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatPendingStorageKey } from './chat-pending-scope.js';
import { readComposerDraft, writeComposerDraft } from './composer-drafts.js';
import { captureMemoryAssistantSubmission, handoffMemoryAssistantDraft, memoryAssistantMessage, settleMemoryAssistantRetry } from './memory-assistant-state.js';

test('auxiliary retries never read the primary new-chat or saved-chat receipt', () => {
  assert.equal(chatPendingStorageKey(undefined), 'clem.pending.console:new');
  assert.equal(chatPendingStorageKey(undefined, 'sess-123'), 'clem.pending.console:sess-123');
  assert.equal(chatPendingStorageKey('memory-one'), chatPendingStorageKey('memory-one', 'sess-123'));
  assert.notEqual(chatPendingStorageKey('memory-one'), chatPendingStorageKey());
  assert.notEqual(chatPendingStorageKey('memory-one'), chatPendingStorageKey('memory-two'));
});

test('selection adds only a quoted exact reference and can be removed', () => {
  const ref = { type: 'note' as const, id: 'notes/a\n"quoted".md' };
  const selected = { ref, text: 'Private memory body', title: 'Private title' };
  const wire = memoryAssistantMessage('Where did this come from?', selected);
  assert.ok(wire.includes(JSON.stringify(ref)));
  assert.ok(!wire.includes(selected.text));
  assert.ok(!wire.includes(selected.title));
  assert.equal(memoryAssistantMessage('  My question  ', null), 'My question');
});

test('failed contextual send keeps the editable draft and exact retry acceptance clears it', () => {
  const key = 'memory-assistant-test:failed';
  writeComposerDraft(key, () => ({ text: '  Explain this  ', attachments: [{ localId: 'sent', id: 'a1', name: 'example.txt', status: 'ready' }] }));
  const wire = memoryAssistantMessage('Explain this', { ref: { type: 'fact', id: 7 } });
  const submission = captureMemoryAssistantSubmission(wire, 'Explain this', ['a1'], readComposerDraft(key));
  assert.equal(readComposerDraft(key).text, '  Explain this  ', 'capture/preparation does not consume a draft');
  settleMemoryAssistantRetry(key, 'a different pending request', submission);
  assert.equal(readComposerDraft(key).text, '  Explain this  ');
  settleMemoryAssistantRetry(key, wire, submission);
  assert.equal(readComposerDraft(key).text, '');
  assert.deepEqual(readComposerDraft(key).attachments, []);
});

test('old contextual retry acceptance preserves later text and uploads', () => {
  const key = 'memory-assistant-test:newer';
  writeComposerDraft(key, () => ({ text: 'Original question', attachments: [{ localId: 'old', id: 'a1', name: 'old.txt', status: 'ready' }] }));
  const submission = captureMemoryAssistantSubmission('original wire', 'Original question', ['a1'], readComposerDraft(key));
  writeComposerDraft(key, current => ({ ...current, text: 'A newer question', attachments: [...current.attachments, { localId: 'new', id: 'a2', name: 'new.txt', status: 'ready' }] }));
  settleMemoryAssistantRetry(key, 'original wire', submission);
  assert.equal(readComposerDraft(key).text, 'A newer question');
  assert.deepEqual(readComposerDraft(key).attachments.map(file => file.id), ['a2']);
});

test('editing during attachment preparation is not mistaken for the submitted question', () => {
  const key = 'memory-assistant-test:preparing';
  writeComposerDraft(key, () => ({ text: 'Edited while preparing', attachments: [] }));
  const submission = captureMemoryAssistantSubmission('original wire', 'Original question', [], readComposerDraft(key));
  settleMemoryAssistantRetry(key, 'original wire', submission);
  assert.equal(readComposerDraft(key).text, 'Edited while preparing');
});

test('Open chat carries the draft, visible selected reference, and late uploads to the real conversation', () => {
  const source = 'memory-assistant-test:handoff';
  const target = 'session:memory-assistant-test-real';
  writeComposerDraft(source, () => ({ text: 'Explain this', attachments: [{ localId: 'upload', name: 'example.txt', status: 'uploading' }] }));
  const context = { ref: { type: 'fact' as const, id: 42 } };
  assert.equal(handoffMemoryAssistantDraft(source, 'memory-assistant-test-real', false, context), 'moved');
  assert.equal(readComposerDraft(target).text, memoryAssistantMessage('Explain this', context));
  writeComposerDraft(source, current => ({ ...current, attachments: current.attachments.map(file => ({ ...file, status: 'ready', id: 'uploaded-id' })) }));
  assert.equal(readComposerDraft(target).attachments[0]?.id, 'uploaded-id');
});

test('Open chat refuses unconfirmed requests or a different destination draft without changing either draft', () => {
  const source = 'memory-assistant-test:conflict';
  const id = 'memory-assistant-test-other';
  writeComposerDraft(source, () => ({ text: 'Memory draft', attachments: [] }));
  writeComposerDraft(`session:${id}`, () => ({ text: 'Chat draft', attachments: [] }));
  assert.equal(handoffMemoryAssistantDraft(source, id, true, null), 'pending');
  assert.equal(handoffMemoryAssistantDraft(source, id, false, null), 'conflict');
  assert.equal(readComposerDraft(source).text, 'Memory draft');
  assert.equal(readComposerDraft(`session:${id}`).text, 'Chat draft');
});

test('an empty Memory draft may open an existing Chat draft without replacing it', () => {
  const source = 'memory-assistant-test:empty';
  const id = 'memory-assistant-test-existing';
  writeComposerDraft(`session:${id}`, () => ({ text: 'Keep this', attachments: [] }));
  assert.equal(handoffMemoryAssistantDraft(source, id, false, null), 'moved');
  assert.equal(readComposerDraft(`session:${id}`).text, 'Keep this');
});
