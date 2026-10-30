import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowConversationSessionId } from '@clem/chat-engine';
import { composerDraftKey, readComposerDraft, writeComposerDraft } from './composer-drafts';
import { prepareWorkflowQuestion, workflowSetupPrompt } from './workflow-conversation';
import type { WorkflowCertification } from './automate';

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

test('finish setup prepares exact missing context as editable text without posting or selecting an account', () => {
  const slug = 'controlled-business-setup';
  const certification: WorkflowCertification = {
    workflow:slug, enabled:false, state:'needs_creation_inputs', label:'Needs setup', summary:'Choose an account and the sample customer.',
    canRun:false, canEnableDirectly:false, canQueueCreationTest:false, needsCreationTest:true,
    missingRunInputs:['customer_email'], missingTestInputs:['sample_customer'], resourceGaps:['Email account'],
    readinessGaps:[{question:'Which inbox should send the brief?', why:'More than one account is connected.'}],
    blockingReasons:['No sending account is selected'], nextActions:['provide_test_inputs'],
  };
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = (() => { requests++; throw new Error('Setup navigation must never post or create a session'); }) as typeof fetch;
  try {
    const prompt = workflowSetupPrompt(slug, certification);
    assert.match(prompt, /workflow ID "controlled-business-setup"/);
    for (const text of ['sample_customer','customer_email','Email account','Which inbox','No sending account']) assert.ok(prompt.includes(text));
    assert.match(prompt, /one clear question at a time/);
    assert.match(prompt, /Do not enable or run/);
    assert.match(prompt, /Do not approve requests or choose an account/);
    assert.equal(prepareWorkflowQuestion(slug, {workflowSlug:slug,id:1,text:prompt}), 'prepared');
    assert.equal(requests, 0);
    assert.equal(readComposerDraft(key(slug)).text, prompt);
    writeComposerDraft(key(slug), draft => ({...draft, text:'My customer is Example Co. '+draft.text}));
    assert.match(readComposerDraft(key(slug)).text, /^My customer is Example Co/);
    assert.equal(prepareWorkflowQuestion(slug, {workflowSlug:slug,id:2,text:prompt}), 'draft-kept');
    assert.match(readComposerDraft(key(slug)).text, /^My customer is Example Co/);
  } finally { globalThis.fetch = originalFetch; }
});
