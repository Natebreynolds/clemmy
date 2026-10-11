import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimArtifactDiscussionSeed, prepareArtifactDiscussion, readArtifactDiscussion, sameArtifactDiscussion } from './artifact-discussion';
import { acceptComposerDraft, composerDraftForRetry, handoffComposerDraft, readComposerDraft, writeComposerDraft } from './composer-drafts';

const artifact = { ref: { sessionId: 'discussion-fixture', fileId: 'file-a', name: 'analysis.csv', folder: 'results' }, revision: `sha256:${'a'.repeat(64)}` };

test('selected context requires a version and recorded file identity, and strips untrusted extra fields', () => {
  assert.deepEqual(readArtifactDiscussion({ ...artifact, path: '/unrelated', ref: { ...artifact.ref, path: '/other' } }), artifact);
  for (const value of [null, {}, { ...artifact, revision: 'latest' }, { ...artifact, ref: { ...artifact.ref, fileId: '' } }, { ...artifact, ref: { ...artifact.ref, sessionId: 'bad\nidentity' } }]) {
    assert.equal(readArtifactDiscussion(value), null);
  }
  assert.equal(sameArtifactDiscussion(artifact, { ...artifact, revision: `sha256:${'b'.repeat(64)}` }), false);
});

test('a route selection is consumed once so a removed or sent context cannot resurrect on remount', () => {
  assert.equal(claimArtifactDiscussionSeed('discussion-route-fixture'), true);
  assert.equal(claimArtifactDiscussionSeed('discussion-route-fixture'), false);
  assert.equal(claimArtifactDiscussionSeed('separate-discussion-route'), true);
});

test('selecting a result preserves the existing draft and never leaks into another conversation', () => {
  const original = { text: 'Keep my question', attachments: [{ localId: 'one', name: 'notes.txt', status: 'ready' as const, id: 'inbox-one' }] };
  writeComposerDraft('session:context-original', () => original);
  writeComposerDraft('session:context-original', current => ({ ...current, artifact }));
  assert.deepEqual(readComposerDraft('session:context-original'), { ...original, artifact });
  assert.equal(readComposerDraft('session:context-unrelated').artifact, undefined);
});

test('only an accepted exact draft clears; newer typing, uploads and selected version survive late acceptance', () => {
  const key = 'session:late-context-accept';
  const sent = { text: 'Analyze this', attachments: [{ localId: 'sent', name: 'notes.txt', status: 'ready' as const, id: 'inbox-sent' }], artifact };
  writeComposerDraft(key, () => sent);
  assert.deepEqual(readComposerDraft(key), sent, 'a failed preparation or rejected post never clears the draft');
  const newer = { ...artifact, revision: `sha256:${'b'.repeat(64)}` };
  writeComposerDraft(key, current => ({ ...current, text: 'And compare it with last month', artifact: newer, attachments: [...current.attachments, { localId: 'late', name: 'month.csv', status: 'uploading' }] }));
  acceptComposerDraft(key, sent);
  assert.deepEqual(readComposerDraft(key), { text: 'And compare it with last month', artifact: newer, attachments: [{ localId: 'late', name: 'month.csv', status: 'uploading' }] });
});

test('an accepted first message and its later draft remain owned by the assigned conversation', () => {
  const from = { draftKey: 'new:artifact-first', sessionId: undefined };
  const sent = { text: 'Review the assumptions', attachments: [], artifact };
  writeComposerDraft(from.draftKey, () => sent);
  const to = { ...from, sessionId: 'artifact-assigned' };
  handoffComposerDraft(from, to);
  acceptComposerDraft(from.draftKey, sent);
  assert.deepEqual(readComposerDraft('session:artifact-assigned'), { text: '', attachments: [], artifact: undefined });
  assert.equal(readComposerDraft('new:another-request').artifact, undefined);
});

test('an exact retry clears its selected file but preserves a different context chosen while awaiting acceptance', () => {
  const original = { text: 'Explain these numbers', attachments: [], artifact: { ...artifact, preparedAttachmentId: 'prepared-a' } };
  const pending = { input: original.text, attachments: ['prepared-a'] };
  const sent = composerDraftForRetry(original, pending);
  writeComposerDraft('session:retry-context', () => original);
  acceptComposerDraft('session:retry-context', sent);
  assert.equal(readComposerDraft('session:retry-context').artifact, undefined);
  const changed = { ...original, artifact: { ...artifact, revision: `sha256:${'b'.repeat(64)}`, preparedAttachmentId: 'prepared-b' } };
  writeComposerDraft('session:retry-context', () => changed);
  acceptComposerDraft('session:retry-context', composerDraftForRetry(changed, pending));
  assert.deepEqual(readComposerDraft('session:retry-context').artifact, changed.artifact);
});

test('switching conversations during file preparation cannot send its bytes into the new chat', async () => {
  let current = true;
  let complete!: (value: { id: string; name: string }) => void;
  const prepared = new Promise<{ id: string; name: string }>(resolve => { complete = resolve; });
  const pending = prepareArtifactDiscussion(artifact, () => prepared, () => current);
  current = false;
  complete({ id: 'frozen-attachment', name: artifact.ref.name });
  await assert.rejects(pending, /conversation changed/);
});
