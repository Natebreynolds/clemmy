import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-learned-effect-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const store = await import('./learned-operation-effect-store.js');
const { learnComposioOperationEffects } = await import('./learned-operation-effect.js');
const { classifyComposioSlugEffect, composioSlugEffectEvidence } = await import('./slug-effect.js');
after(() => rmSync(HOME, { recursive: true, force: true }));

const boards = { slug: 'MONDAY_BOARDS', description: 'Tool to retrieve board data via the Monday.com API. Returns core metadata about one or multiple boards with filtering options.', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, state: { type: 'string' } } } };

test('a noun-shaped operation is a conservative write until a model reads its definition as read-only', async () => {
  store._resetLearnedComposioOperationEffectsForTests();
  assert.equal(composioSlugEffectEvidence('MONDAY_BOARDS'), 'unknown');
  assert.equal(classifyComposioSlugEffect('MONDAY_BOARDS'), 'external_write', 'unknown stays write by default');
  const asked: string[] = [];
  const learned = await learnComposioOperationEffects([boards, { slug: 'MONDAY_CREATE_ITEM', description: 'Create an item', inputSchema: {} }, { slug: 'MONDAY_GET_BOARDS', description: 'x' }], {
    evaluate: async ({ slug, description }) => { asked.push(slug); assert.match(description, /retrieve board data/); return { ok: true, readOnly: 0.97, model: 'jev-fixture' }; },
  });
  assert.deepEqual(asked, ['MONDAY_BOARDS'], 'only verb-less slugs are asked; CREATE and GET already carry their evidence');
  assert.deepEqual(learned, ['MONDAY_BOARDS']);
  assert.equal(classifyComposioSlugEffect('MONDAY_BOARDS'), 'read', 'the classifier every site calls now sees the learned read');
  assert.equal(classifyComposioSlugEffect('monday_boards'), 'read');
  const record = store.learnedComposioOperationEffect('MONDAY_BOARDS');
  assert.equal(record?.source, 'model');
  assert.equal(record?.confidence, 0.97);
  // Same definition again: no second question.
  const again: string[] = [];
  await learnComposioOperationEffects([boards], { evaluate: async ({ slug }) => { again.push(slug); return { ok: true, readOnly: 1, model: 'x' }; } });
  assert.deepEqual(again, []);
  // A changed definition is asked again and can flip the verdict.
  const changed = { ...boards, description: 'Archive one or more boards.' };
  await learnComposioOperationEffects([changed], { evaluate: async () => ({ ok: true, readOnly: 0.05, model: 'jev-fixture' }) });
  assert.equal(classifyComposioSlugEffect('MONDAY_BOARDS'), 'external_write');
});

test('an unsure or unavailable model leaves the write default and writes nothing', async () => {
  store._resetLearnedComposioOperationEffectsForTests();
  await learnComposioOperationEffects([{ slug: 'SLACK_CONVERSATIONS_HISTORY', description: 'Fetches a conversation history.', inputSchema: {} }], { evaluate: async () => ({ ok: true, readOnly: 0.6, model: 'x' }) });
  assert.equal(store.learnedComposioOperationEffect('SLACK_CONVERSATIONS_HISTORY'), null);
  await learnComposioOperationEffects([{ slug: 'SLACK_CONVERSATIONS_HISTORY', description: 'Fetches a conversation history.', inputSchema: {} }], { evaluate: async () => ({ ok: false }) });
  assert.equal(store.learnedComposioOperationEffect('SLACK_CONVERSATIONS_HISTORY'), null);
  await learnComposioOperationEffects([{ slug: 'SLACK_CONVERSATIONS_HISTORY', description: 'Fetches a conversation history.', inputSchema: {} }], { evaluate: async () => { throw new Error('down'); } });
  assert.equal(classifyComposioSlugEffect('SLACK_CONVERSATIONS_HISTORY'), 'external_write');
  // No description: nothing to reason from, nothing written.
  await learnComposioOperationEffects([{ slug: 'SLACK_CONVERSATIONS_HISTORY' }], { evaluate: async () => ({ ok: true, readOnly: 1, model: 'x' }) });
  assert.equal(store.learnedComposioOperationEffect('SLACK_CONVERSATIONS_HISTORY'), null);
});
