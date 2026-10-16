import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowConversationSessionId } from '@clem/chat-engine';
import { composerDraftKey, readComposerDraft, writeComposerDraft } from './composer-drafts';
import { prepareWorkflowQuestion } from './workflow-conversation';

const key = (slug: string) => composerDraftKey('', undefined, workflowConversationSessionId(slug));

test('a step question prepares only its workflow draft and does not post or move another draft', () => {
  const a = 'conversation-fixture-a', b = 'conversation-fixture-b';
  const question = { workflowSlug: a, id: 1, text: 'Explain step "read" in this workflow.' };
  writeComposerDraft(key(b), () => ({ text: 'Keep this other workflow draft.', attachments: [] }));
  assert.equal(prepareWorkflowQuestion(b, question), 'wrong-workflow');
  assert.equal(prepareWorkflowQuestion(a, question), 'prepared');
  assert.equal(readComposerDraft(key(a)).text, question.text);
  assert.equal(readComposerDraft(key(b)).text, 'Keep this other workflow draft.');
});

test('a context shortcut preserves existing text and files until explicitly added to that draft', () => {
  const slug = 'conversation-fixture-draft';
  const original = { text: 'My unsent change', attachments: [{ localId: 'owned-file', name: 'notes.txt', status: 'ready' as const, id: 'upload-1' }] };
  writeComposerDraft(key(slug), () => original);
  const question = { workflowSlug: slug, id: 2, text: 'Explain the selected run.' };
  assert.equal(prepareWorkflowQuestion(slug, question), 'draft-kept');
  assert.deepEqual(readComposerDraft(key(slug)), original);
  assert.equal(prepareWorkflowQuestion(slug, question, true), 'prepared');
  assert.deepEqual(readComposerDraft(key(slug)), { ...original, text: `${original.text}\n\n${question.text}` });
});

test('invalid and cross-workflow seeds cannot alter an attachment-only draft', () => {
  const slug = 'conversation-fixture-files';
  const original = { text: '', attachments: [{ localId: 'uploading', name: 'plan.pdf', status: 'uploading' as const }] };
  writeComposerDraft(key(slug), () => original);
  assert.equal(prepareWorkflowQuestion(slug, { workflowSlug: slug, id: 3, text: 'Change the schedule.' }), 'draft-kept');
  assert.equal(prepareWorkflowQuestion(slug, { workflowSlug: slug, id: NaN, text: 'Bad seed' }, true), 'wrong-workflow');
  assert.equal(prepareWorkflowQuestion(slug, { workflowSlug: 'another-workflow', id: 4, text: 'Other task' }, true), 'wrong-workflow');
  assert.deepEqual(readComposerDraft(key(slug)), original);
});
