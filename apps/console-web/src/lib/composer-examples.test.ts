import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPOSER_EXAMPLES, seedComposerExample } from './composer-examples';
import { moveComposerDraft, readComposerDraft, writeComposerDraft } from './composer-drafts';

let sequence = 0;
const fresh = () => {
  const key = `new:example-control-${++sequence}`;
  return { id: 'plan', draftKey: key, routeDraftKey: key, activeDraftKey: key, allowed: true };
};

test('an example only fills the creation draft and preserves user edits', () => {
  const input = fresh();
  assert.equal(seedComposerExample(input), true);
  assert.equal(readComposerDraft(input.draftKey).text, COMPOSER_EXAMPLES[0].text);
  writeComposerDraft(input.draftKey, current => ({ ...current, text: 'My edited goal' }));
  assert.equal(seedComposerExample({ ...input, id: 'file' }), false);
  assert.equal(readComposerDraft(input.draftKey).text, 'My edited goal');
});

test('examples do not replace whitespace, files being uploaded, or selected artifacts', () => {
  const drafts = [
    { text: ' ', attachments: [] },
    { text: '', attachments: [{ localId: 'upload', name: 'notes.pdf', status: 'uploading' as const }] },
    { text: '', attachments: [], artifact: { ref: { name: 'selected.pdf' } } as any },
  ];
  for (const draft of drafts) {
    const input = fresh();
    writeComposerDraft(input.draftKey, () => draft);
    const before = readComposerDraft(input.draftKey);
    assert.equal(seedComposerExample(input), false);
    assert.equal(readComposerDraft(input.draftKey), before);
  }
});

test('a retired route, assigned conversation, or blocked composer cannot be seeded', () => {
  const overrides = [
    { activeDraftKey: 'new:another-route' }, { routeDraftKey: 'new:another-route' },
    { executionSessionId: 'execution' }, { conversationSessionId: 'visible-root' },
    { allowed: false }, { id: 'unknown-example' },
  ];
  for (const override of overrides) {
    const input = fresh();
    assert.equal(seedComposerExample({ ...input, ...override }), false);
    assert.equal(readComposerDraft(input.draftKey).text, '');
  }
  const input = fresh();
  moveComposerDraft(input.draftKey, 'session:example-owned');
  assert.equal(seedComposerExample(input), false);
  assert.equal(readComposerDraft('session:example-owned').text, '');
});

test('choosing a file example neither attaches a file nor changes another draft', () => {
  const other = fresh();
  writeComposerDraft(other.draftKey, current => ({ ...current, text: 'Unrelated task' }));
  const input = fresh();
  assert.equal(seedComposerExample({ ...input, id: 'file' }), true);
  assert.equal(readComposerDraft(input.draftKey).text, COMPOSER_EXAMPLES[1].text);
  assert.deepEqual(readComposerDraft(input.draftKey).attachments, []);
  assert.equal(readComposerDraft(other.draftKey).text, 'Unrelated task');
});
