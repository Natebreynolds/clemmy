import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MobileDraftStore, mobileConversationDraftOwner, reconcileDraftChoice, settleDraftChoice, settledFileRequest, submitFileDraft, type DraftSendResult, type MobileDraftChoice, type MobileStagedAttachment, type SelectedFileContext } from './file-context';

const upload = (id: string): MobileStagedAttachment => ({ id, name: `${id}.png`, kind: 'image', previewUrl: `blob:${id}` });

test('late uploads follow a created conversation across drawer navigation and notify its restored composer', () => {
  const released: string[] = [];
  const store = new MobileDraftStore(url => released.push(url));
  const generation = store.generation;
  store.patch('new:one', { text: 'Keep this draft', stagedAttachments: [{ ...upload('local-one'), uploading: true }] });
  store.move('new:one', 'chat:assigned');
  let restored = store.read('chat:assigned');
  const unsubscribe = store.subscribe(() => { restored = store.read('chat:assigned'); });
  store.patchInGeneration('new:one', generation, {
    stagedAttachments: store.read('new:one').stagedAttachments!.map(file => ({ ...file, id: 'uploaded-one', uploading: false })),
  });
  assert.equal(restored.stagedAttachments?.[0]?.id, 'uploaded-one');
  assert.equal(restored.text, 'Keep this draft');
  assert.deepEqual(released, []);
  unsubscribe();
});

test('two Continue heads keep unsent text, context and late uploads on the stable visible root', () => {
  const store = new MobileDraftStore();
  const generation = store.generation;
  const context: SelectedFileContext = { ref: { sessionId: 'read-source', fileId: 'sf_notes', name: 'Notes.md', folder: 'Results' }, revision: `sha256:${'a'.repeat(64)}` };
  store.patch('new:continuing', { text: 'Next question', context, stagedAttachments: [{ ...upload('late-upload'), uploading: true }] });
  let owner = mobileConversationDraftOwner(null, 'root');
  store.move('new:continuing', owner.scope);
  for (const head of ['child-one', 'child-two']) {
    const next = mobileConversationDraftOwner(owner.conversationId, head);
    store.move(owner.scope, next.scope);
    owner = next;
    assert.equal(owner.scope, 'chat:root');
  }
  store.patchInGeneration('new:continuing', generation, { stagedAttachments: store.read('new:continuing').stagedAttachments!.map(file => ({ ...file, id: 'late-finished', uploading: false })) });
  const reopened = store.read(mobileConversationDraftOwner('root', 'child-two').scope);
  assert.equal(reopened.text, 'Next question');
  assert.equal(reopened.context, context);
  assert.equal(reopened.stagedAttachments?.[0]?.id, 'late-finished');
  assert.equal(store.read('chat:unrelated').text, '');
});

test('existing chained head aliases keep root callbacks and reopen bound to the final draft', () => {
  const released: string[] = [];
  const store = new MobileDraftStore(url => released.push(url));
  const generation = store.generation;
  store.patch('chat:historical-root', { text: 'Saved before Continue', stagedAttachments: [{ ...upload('old-owner-upload'), uploading: true }] });
  store.move('chat:historical-root', 'chat:historical-child-one');
  store.move('chat:historical-child-one', 'chat:historical-child-two');
  store.patchInGeneration('chat:historical-root', generation, { stagedAttachments: store.read('chat:historical-root').stagedAttachments!.map(file => ({ ...file, id: 'finished-after-Continue', uploading: false })) });
  assert.equal(store.read('chat:historical-root').text, 'Saved before Continue');
  assert.equal(store.read('chat:historical-child-two').stagedAttachments?.[0]?.id, 'finished-after-Continue');
  assert.deepEqual(released, []);
  store.move('chat:historical-child-two', 'chat:historical-root');
  assert.equal(store.read('chat:historical-root').stagedAttachments?.[0]?.id, 'finished-after-Continue');
  store.clear();
  assert.equal(store.patchInGeneration('chat:historical-root', generation, { text: 'Stale signed-out callback' }), null);
});

test('settling exact sent uploads preserves newer files and other conversations, releasing only removed previews', () => {
  const released: string[] = [];
  const store = new MobileDraftStore(url => released.push(url));
  const request = { messageId: 'request', text: 'Send this', attachmentIds: ['sent'] };
  store.patch('chat:a', { failed: request, stagedAttachments: [upload('sent'), upload('newer')] });
  store.patch('chat:b', { stagedAttachments: [upload('other')] });
  store.patch('chat:a', settledFileRequest(store.read('chat:a'), request));
  assert.deepEqual(store.read('chat:a').stagedAttachments?.map(file => file.id), ['newer']);
  assert.equal(store.read('chat:b').stagedAttachments?.[0]?.id, 'other');
  assert.deepEqual(released, ['blob:sent']);
  store.patch('chat:a', { text: 'Unrelated edit' });
  assert.deepEqual(released, ['blob:sent']);
});

test('sign-out releases staged previews and rejects late upload or send callbacks from the old account', () => {
  const released: string[] = [];
  const store = new MobileDraftStore(url => released.push(url));
  const generation = store.generation;
  store.patch('new:one', { stagedAttachments: [upload('one')] });
  store.move('new:one', 'chat:assigned');
  store.clear();
  assert.deepEqual(released, ['blob:one']);
  assert.equal(store.patchInGeneration('new:one', generation, { stagedAttachments: [upload('late')], text: 'Old account' }), null);
  assert.equal(store.patchInGeneration('chat:assigned', generation, { failed: { messageId: 'old-send', text: 'Old', attachmentIds: [] } }), null);
  assert.equal(store.read('chat:assigned').text, '');
  assert.equal(store.read('chat:assigned').failed, undefined);
  store.patch('new:one', { text: 'New account' });
  assert.equal(store.read('chat:assigned').text, '');
});

test('pending agent/project selection and Plan mode survive promotion, including intentional Clem and no project', () => {
  const store = new MobileDraftStore();
  store.patch('new:one', { agentChoice: { value: null, pending: true }, projectChoice: { value: null, pending: true }, composerMode: 'plan' });
  store.move('new:one', 'chat:assigned');
  const restored = store.read('chat:assigned');
  assert.equal(restored.composerMode, 'plan');
  const previous = { id: 'original', name: 'Original handoff' };
  assert.deepEqual(reconcileDraftChoice(restored.agentChoice, previous), { value: null, pending: true });
  assert.deepEqual(reconcileDraftChoice(restored.projectChoice, previous), { value: null, pending: true });
  assert.equal(store.read('new:other').composerMode, undefined);
});

test('a confirmed binding becomes server-owned while a later pending choice is retained', () => {
  const requested = { id: 'a', name: 'Agent A' };
  const later = { id: 'b', name: 'Agent B' };
  const pending: MobileDraftChoice = { value: requested, pending: true };
  assert.deepEqual(reconcileDraftChoice(pending, requested), { value: requested, pending: false });
  const settled = settleDraftChoice(pending, 'a', null);
  assert.deepEqual(settled, { value: null, pending: false });
  assert.deepEqual(reconcileDraftChoice(settled, later), { value: later, pending: false });
  assert.deepEqual(settleDraftChoice({ value: later, pending: true }, 'a', requested), { value: later, pending: true });
});

test('delayed acceptance settles exact selected context after navigation but preserves a deliberate same-file reselect', async () => {
  for (const scenario of ['navigated', 'reselected', 'signed-out']) {
    const store = new MobileDraftStore();
    const generation = store.generation;
    const context: SelectedFileContext = { ref: { sessionId: 'worker', name: 'Notes.md', folder: 'Results', fileId: 'sf_one' }, revision: `sha256:${'a'.repeat(64)}` };
    store.patch('chat:one', { text: 'Review this', context });
    let active = true;
    let accept!: (result: DraftSendResult) => void;
    let sending!: () => void;
    const started = new Promise<void>(resolve => { sending = resolve; });
    const submitted = submitFileDraft({
      draft: store.read('chat:one'), text: 'Review this', attachments: [], busy: () => false,
      current: () => active && generation === store.generation,
      latest: () => generation === store.generation ? store.read('chat:one') : null,
      prepare: async () => ({ id: 'exact-snapshot', name: 'Notes.md', kind: 'file' }),
      remember: patch => { store.patchInGeneration('chat:one', generation, patch); },
      send: () => { sending(); return new Promise<DraftSendResult>(resolve => { accept = resolve; }); },
      retry: async () => ({ accepted: true }),
    });
    await started;
    active = false;
    const selectedAgain = { ...context, ref: { ...context.ref } };
    if (scenario === 'reselected') store.select('chat:one', selectedAgain);
    if (scenario === 'signed-out') store.clear();
    accept({ accepted: true });
    assert.equal(await submitted, true);
    const saved = store.read('chat:one');
    assert.equal(saved.context, scenario === 'reselected' ? selectedAgain : null);
    if (scenario === 'navigated') assert.equal(saved.prepared, undefined);
    if (scenario === 'signed-out') assert.equal(saved.text, '');
  }
});
