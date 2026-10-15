import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptComposerDraft, composerDraftIsUnassigned, handoffComposerDraft, newComposerDraftKey, readComposerDraft, writeComposerDraft } from './composer-drafts';
import { projectToolsChatNavigation, readProjectToolsDraft, seedProjectToolsComposerDraft } from './project-tools-draft';

let sequence = 10_000;
function fixture() {
  const stamp = ++sequence;
  const target = projectToolsChatNavigation('project-fixture', 'Fixture Project', 'fixture-folder', stamp)!;
  const navigationKey = `project-tools-fixture-${stamp}`;
  const routeDraftKey = newComposerDraftKey(target.pathname, navigationKey, target.state.newChat);
  return { target, routeDraftKey, input: { pathname: target.pathname, navigationKey, state: target.state,
    routeDraftKey, draftKey: routeDraftKey, busy: false } };
}

test('setup navigation carries a fresh project address and editable request, never an auto-send query', () => {
  const { target } = fixture();
  assert.equal(target.pathname, '/chat');
  assert.deepEqual(target.state.project, { id: 'project-fixture', name: 'Fixture Project' });
  assert.equal('search' in target, false);
  assert.equal('prompt' in target.state, false);
  const request = readProjectToolsDraft(target.state)!;
  assert.match(request.text, /"fixture-folder" folder for this project/);
  assert.match(request.text, /Check existing connections and software/);
  assert.match(request.text, /Do not perform any business actions/);
  for (const state of [null, [], {}, { ...target.state, newChat: 0 }, { ...target.state, project: null },
    { ...target.state, projectToolsDraft: { folderName: 'invalid\nfolder' } }]) assert.equal(readProjectToolsDraft(state), null);
  assert.equal(projectToolsChatNavigation('', 'Fixture Project', 'folder'), null);
  assert.equal(projectToolsChatNavigation('project-fixture', '', 'folder'), null);
});

test('only a fresh empty route is seeded; text remains editable and no send is involved', () => {
  const { input, routeDraftKey } = fixture();
  assert.equal(seedProjectToolsComposerDraft(input), true);
  assert.equal(readComposerDraft(routeDraftKey).text, readProjectToolsDraft(input.state)!.text);
  writeComposerDraft(routeDraftKey, current => ({ ...current, text: 'My revised setup request' }));
  assert.equal(seedProjectToolsComposerDraft(input), false);
  assert.equal(readComposerDraft(routeDraftKey).text, 'My revised setup request');
});

test('assigned, busy, wrong-route and stale-owner drafts are never changed', () => {
  const { input, routeDraftKey } = fixture();
  const existing = `session:existing-${sequence}`;
  writeComposerDraft(existing, current => ({ ...current, text: 'Existing conversation text' }));
  for (const patch of [{ executionSessionId: 'existing' }, { conversationSessionId: 'existing' }, { busy: true },
    { pathname: '/chat/other' }, { draftKey: existing }, { routeDraftKey: 'new:stale-owner' }]) {
    assert.equal(seedProjectToolsComposerDraft({ ...input, ...patch }), false);
    assert.equal(readComposerDraft(routeDraftKey).text, '');
    assert.equal(readComposerDraft(existing).text, 'Existing conversation text');
  }
  assert.equal(seedProjectToolsComposerDraft(input), true, 'a later exact unassigned render can receive its draft');
});

test('existing text, uploads and selected file context are kept instead of replaced or appended', () => {
  for (const patch of [
    { text: 'Owner typed first' },
    { attachments: [{ localId: 'upload-fixture', name: 'fixture.txt', status: 'uploading' as const }] },
    { artifact: { ref: { sessionId: 'fixture-session', fileId: 'fixture-file', name: 'fixture.txt', folder: 'fixture' }, revision: `sha256:${'a'.repeat(64)}` } },
  ]) {
    const { input, routeDraftKey } = fixture();
    writeComposerDraft(routeDraftKey, current => ({ ...current, ...patch }));
    const before = readComposerDraft(routeDraftKey);
    assert.equal(seedProjectToolsComposerDraft(input), false);
    assert.equal(readComposerDraft(routeDraftKey), before);
    writeComposerDraft(routeDraftKey, () => ({ text: '', attachments: [] }));
    assert.equal(seedProjectToolsComposerDraft(input), false, 'clearing an owner draft does not resurrect the seed');
  }
});

test('an accepted or deliberately cleared seed does not return on route remount', () => {
  const { input, routeDraftKey } = fixture();
  assert.equal(seedProjectToolsComposerDraft(input), true);
  acceptComposerDraft(routeDraftKey, readComposerDraft(routeDraftKey));
  assert.equal(readComposerDraft(routeDraftKey).text, '');
  assert.equal(seedProjectToolsComposerDraft({ ...input }), false);
  const next = fixture();
  assert.equal(seedProjectToolsComposerDraft(next.input), true, 'an explicit new setup navigation has its own draft');
});

test('Back/remount cannot seed a creation route aliased to an assigned conversation', () => {
  const { input, routeDraftKey } = fixture();
  const sessionId = `assigned-fixture-${sequence}`;
  writeComposerDraft(routeDraftKey, current => ({ ...current, text: '' }));
  handoffComposerDraft({ draftKey: routeDraftKey, sessionId: null }, { draftKey: routeDraftKey, sessionId });
  const assignedKey = `session:${sessionId}`;
  assert.equal(composerDraftIsUnassigned(routeDraftKey), false);
  assert.equal(composerDraftIsUnassigned(assignedKey), false);
  const before = readComposerDraft(assignedKey);
  assert.equal(seedProjectToolsComposerDraft(input), false, 'even stale unassigned props cannot write through an alias');
  assert.equal(readComposerDraft(assignedKey), before);
  assert.equal(readComposerDraft(assignedKey).text, '');
});
