import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowConversationSessionId, workflowConversationSlugFromSessionId } from '@clem/chat-engine';
import { setSessionFingerprint } from './api';
import { loadMobileChatHistory } from './chat-history';
import { MobileDraftStore, mobileConversationDraftOwner } from './file-context';

const root = workflowConversationSessionId('controlled-workflow')!;

test('mobile scoped history treats only a missing valid root as an empty first conversation', async t => {
  setSessionFingerprint(null);
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return Response.json({ error: 'Not found' }, { status: 404 });
  });
  assert.equal(await loadMobileChatHistory(root), null);
  assert.equal(await loadMobileChatHistory('space-controlled'), null);
  for (const id of ['ordinary-missing', 'workflow-edit:%2f', 'workflow-edit:%63ontrolled-workflow']) {
    await assert.rejects(loadMobileChatHistory(id), { status: 404 });
  }
  assert.equal(requested[0], `/m/api/chat/sessions/${encodeURIComponent(root)}`);
});

test('mobile workflow history keeps permission and server failures visible instead of seeding an empty chat', async t => {
  setSessionFingerprint(null);
  let status = 403;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Controlled history unavailable' }, { status }));
  for (status of [403, 409, 500, 503]) {
    await assert.rejects(loadMobileChatHistory(root), { status });
  }
});

test('mobile workflow history does not erase an existing conversation when a later page is missing', async t => {
  setSessionFingerprint(null);
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    reads++;
    if (reads === 1) return Response.json({ session: { id: root }, events: [], latestSeq: 2,
      page: { version: 1, scannedThroughSeq: 1, snapshotSeq: 2, hasMore: true } });
    return Response.json({ error: 'Controlled page missing' }, { status: 404 });
  });
  await assert.rejects(loadMobileChatHistory(root), { status: 404 });
  assert.equal(reads, 2);
});

test('mobile workflow reopen reads fresh history and keeps the visible root separate from its execution head', async t => {
  setSessionFingerprint(null);
  let revision = 1;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    assert.equal(String(input), `/m/api/chat/sessions/${encodeURIComponent(root)}`);
    reads++;
    return Response.json({ session: { id: root, executionSessionId: 'controlled-successor' },
      events: [{ seq: revision, sessionId: 'controlled-successor', type: 'conversation_completed', data: { reply: `Saved revision ${revision}` } }],
      latestSeq: revision });
  });
  const first = await loadMobileChatHistory(root);
  revision = 2;
  const reopened = await loadMobileChatHistory(root);
  assert.equal(reads, 2);
  assert.equal(first?.events[0].data.reply, 'Saved revision 1');
  assert.equal(reopened?.events[0].data.reply, 'Saved revision 2');
  assert.equal(reopened?.session.id, root);
  assert.equal(reopened?.session.executionSessionId, 'controlled-successor');
  assert.equal(workflowConversationSlugFromSessionId(reopened!.session.id), 'controlled-workflow');
  assert.equal(workflowConversationSlugFromSessionId(reopened!.session.executionSessionId!), null);
});

test('mobile workflow drafts remain isolated through switching and physical successors', () => {
  const other = workflowConversationSessionId('another-controlled-workflow')!;
  const drafts = new MobileDraftStore();
  drafts.read(`chat:${root}`, 'Keep this unfinished edit');
  drafts.patch(`chat:${root}`, { stagedAttachments: [{ id: 'controlled-file', name: 'Notes.txt', kind: 'file' }] });
  drafts.read(`chat:${other}`, 'A different question');
  const owner = mobileConversationDraftOwner(root, 'controlled-successor');
  drafts.move(`chat:${root}`, owner.scope);
  assert.equal(owner.conversationId, root);
  assert.equal(drafts.read(owner.scope, 'Ask about a run').text, 'Keep this unfinished edit');
  assert.equal(drafts.read(owner.scope).stagedAttachments?.[0].id, 'controlled-file');
  assert.equal(drafts.read(`chat:${other}`).text, 'A different question');
  assert.equal(drafts.read(`chat:${other}`).stagedAttachments, undefined);
  assert.equal(drafts.read('chat:controlled-successor').text, '');
});
