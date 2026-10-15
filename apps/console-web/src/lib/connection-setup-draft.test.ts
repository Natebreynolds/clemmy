import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptComposerDraft, handoffComposerDraft, newComposerDraftKey, readComposerDraft, writeComposerDraft } from './composer-drafts';
import { connectionSetupChatNavigation, readConnectionSetupDraft, seedConnectionSetupComposerDraft, type ConnectionSetupKind } from './connection-setup-draft';

let sequence = 30_000;
function fixture(kind: ConnectionSetupKind = 'apps', detail?: string) {
  const target = connectionSetupChatNavigation(kind, detail, ++sequence)!;
  const navigationKey = `connection-setup-fixture-${sequence}`;
  const routeDraftKey = newComposerDraftKey(target.pathname, navigationKey, target.state.newChat);
  return { target, routeDraftKey, input: { pathname: target.pathname, navigationKey, state: target.state,
    routeDraftKey, draftKey: routeDraftKey, busy: false } };
}

test('each setup lane opens a fresh editable chat without a prompt query or inherited project', () => {
  for (const kind of ['apps', 'mcp', 'cli'] as const) {
    const { target, input, routeDraftKey } = fixture(kind, 'fixture tool');
    assert.equal(target.pathname, '/chat');
    assert.deepEqual(Object.keys(target).sort(), ['pathname', 'state']);
    assert.deepEqual(Object.keys(target.state).sort(), ['connectionSetupDraft', 'newChat']);
    assert.deepEqual(target.state.connectionSetupDraft, { kind, detail: 'fixture tool' });
    assert.equal(seedConnectionSetupComposerDraft(input), true);
    assert.match(readComposerDraft(routeDraftKey).text, /"fixture tool"/);
    assert.match(readComposerDraft(routeDraftKey).text, /Check existing connections and software first/);
    assert.match(readComposerDraft(routeDraftKey).text, /Do not perform any business actions/);
    writeComposerDraft(routeDraftKey, current => ({ ...current, text: 'My editable request' }));
    assert.equal(readComposerDraft(routeDraftKey).text, 'My editable request');
  }
  const first = connectionSetupChatNavigation('apps')!;
  const second = connectionSetupChatNavigation('apps')!;
  assert.ok(second.state.newChat > first.state.newChat);
});

test('optional blank detail opens general help and detail remains quoted data', () => {
  assert.deepEqual(connectionSetupChatNavigation('apps', '   ', ++sequence)!.state.connectionSetupDraft, { kind: 'apps' });
  for (const [kind, expected] of [['apps', 'an app'], ['mcp', 'an MCP tool server'], ['cli', 'a command-line tool']] as const) {
    assert.match(readConnectionSetupDraft(fixture(kind).target.state)!.text, new RegExp(`Help me connect ${expected}`));
  }
  const target = connectionSetupChatNavigation('apps', '  fixture "quoted" name  ', ++sequence)!;
  assert.equal(target.state.connectionSetupDraft.detail, 'fixture "quoted" name');
  assert.ok(readConnectionSetupDraft(target.state)!.text.includes(JSON.stringify('fixture "quoted" name')));
});

test('untrusted routes reject malformed kinds, detail, stamps and unrelated state', () => {
  const { target } = fixture();
  for (const detail of ['bad\nname', 'bad\0name', 'x'.repeat(201), 9, {}, []]) {
    assert.equal(connectionSetupChatNavigation('apps', detail as string, ++sequence), null);
    assert.equal(readConnectionSetupDraft({ ...target.state, connectionSetupDraft: { kind: 'apps', detail } }), null);
  }
  for (const kind of ['unknown', '', null, {}, ['apps']]) {
    assert.equal(connectionSetupChatNavigation(kind as ConnectionSetupKind), null);
    assert.equal(readConnectionSetupDraft({ ...target.state, connectionSetupDraft: { kind } }), null);
  }
  for (const stamp of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(connectionSetupChatNavigation('apps', undefined, stamp), null);
    assert.equal(readConnectionSetupDraft({ ...target.state, newChat: stamp }), null);
  }
  for (const state of [null, [], {}, { newChat: sequence }, { ...target.state, connectionSetupDraft: null },
    { newChat: sequence, projectToolsDraft: { folderName: 'fixture' } }]) assert.equal(readConnectionSetupDraft(state), null);
});

test('only the exact empty unassigned new-chat owner is seeded', () => {
  const { input, routeDraftKey } = fixture();
  const existing = `session:connection-existing-${sequence}`;
  writeComposerDraft(existing, current => ({ ...current, text: 'Existing conversation draft' }));
  for (const patch of [{ executionSessionId: 'existing' }, { conversationSessionId: 'existing' }, { busy: true },
    { pathname: '/chat/existing' }, { routeDraftKey: 'new:old-scope' }, { draftKey: existing }]) {
    assert.equal(seedConnectionSetupComposerDraft({ ...input, ...patch }), false);
    assert.equal(readComposerDraft(routeDraftKey).text, '');
    assert.equal(readComposerDraft(existing).text, 'Existing conversation draft');
  }
  assert.equal(seedConnectionSetupComposerDraft(input), true);
});

test('existing typed text, uploads and artifact selection survive without a later surprise seed', () => {
  for (const patch of [
    { text: 'User typed first' },
    { attachments: [{ localId: 'connection-fixture-upload', name: 'fixture.txt', status: 'uploading' as const }] },
    { artifact: { ref: { sessionId: 'fixture', fileId: 'fixture-file', name: 'fixture.txt', folder: 'fixture' }, revision: `sha256:${'c'.repeat(64)}` } },
  ]) {
    const { input, routeDraftKey } = fixture();
    writeComposerDraft(routeDraftKey, current => ({ ...current, ...patch }));
    const before = readComposerDraft(routeDraftKey);
    assert.equal(seedConnectionSetupComposerDraft(input), false);
    assert.equal(readComposerDraft(routeDraftKey), before);
    writeComposerDraft(routeDraftKey, () => ({ text: '', attachments: [] }));
    assert.equal(seedConnectionSetupComposerDraft(input), false);
  }
});

test('accepted or deliberately cleared seeds cannot return on Back or remount', () => {
  const { input, routeDraftKey } = fixture();
  assert.equal(seedConnectionSetupComposerDraft(input), true);
  acceptComposerDraft(routeDraftKey, readComposerDraft(routeDraftKey));
  assert.equal(seedConnectionSetupComposerDraft({ ...input }), false);
  assert.equal(seedConnectionSetupComposerDraft({ ...input, navigationKey: 'remounted-navigation-key' }), false);
  assert.equal(readComposerDraft(routeDraftKey).text, '');
  const next = fixture();
  assert.equal(seedConnectionSetupComposerDraft(next.input), true);
  writeComposerDraft(next.routeDraftKey, () => ({ text: '', attachments: [] }));
  assert.equal(seedConnectionSetupComposerDraft({ ...next.input }), false);
});

test('creation route aliases never write through to an assigned conversation', () => {
  const { input, routeDraftKey } = fixture();
  const sessionId = `connection-assigned-${sequence}`;
  handoffComposerDraft({ draftKey: routeDraftKey, sessionId: null }, { draftKey: routeDraftKey, sessionId });
  const assignedKey = `session:${sessionId}`;
  const before = readComposerDraft(assignedKey);
  assert.equal(seedConnectionSetupComposerDraft(input), false);
  assert.equal(readComposerDraft(assignedKey), before);
});
