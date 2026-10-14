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
const eventlog = await import('../../runtime/harness/eventlog.js');
const sourceContexts = await import('../../runtime/harness/source-session-context.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

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


const EXCLUDED_LEARNING = { version: 1, mode: 'exclude', reason: 'controlled_test' } as const;
let learningSourceSerial = 0;
function learningSource(policy?: unknown) {
  const session = eventlog.createSession({ id: `composio-learning-source-${++learningSourceSerial}`, kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Inspect the controlled operation.', ...(policy === undefined ? {} : { learningPolicy: policy }) } });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}
function replaceLearningPolicy(source: { sessionId: string; sourceUserSeq: number }, policy: unknown) {
  eventlog.openEventLog().prepare('UPDATE events SET data_json=? WHERE session_id=? AND seq=?')
    .run(JSON.stringify({ text: 'Inspect the controlled operation.', learningPolicy: policy }), source.sessionId, source.sourceUserSeq);
}

test('Composio learning requires the supplied exact source and leaves excluded siblings unreserved', async () => {
  store._resetLearnedComposioOperationEffectsForTests();
  const excluded = learningSource(EXCLUDED_LEARNING);
  let calls = 0;
  const evaluate = async () => { calls += 1; return { ok: true as const, readOnly: 1, model: 'fixture' }; };
  for (const scope of [excluded, { sessionId: excluded.sessionId }, { ...excluded, sourceUserSeq: 0 },
    { ...excluded, sourceUserSeq: excluded.sourceUserSeq + 100000 },
    { sessionId: 'other-composio-session', sourceUserSeq: excluded.sourceUserSeq }]) {
    assert.deepEqual(await learnComposioOperationEffects([boards], { ...scope, evaluate }), []);
  }
  assert.equal(calls, 0);
  assert.equal(store.learnedComposioOperationEffect(boards.slug), null);
  assert.deepEqual(await learnComposioOperationEffects([boards], { ...learningSource(), evaluate }), [boards.slug]);
  assert.equal(calls, 1);
});

test('Composio captures the current validated source before an awaited reading, never a later sibling', async () => {
  store._resetLearnedComposioOperationEffectsForTests();
  const source = learningSource();
  const row = eventlog.appendEvent({ sessionId: source.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Inspect the later operation.', learningPolicy: EXCLUDED_LEARNING } });
  const sibling = { sessionId: source.sessionId, sourceUserSeq: row.seq };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = sourceContexts.withAcceptedSourceSessionContext(source,
    () => learnComposioOperationEffects([boards], { sessionId: source.sessionId,
      evaluate: async () => { await held; return { ok: true, readOnly: 1, model: 'fixture' }; },
    }), { newlyAccepted: true });
  await sourceContexts.withAcceptedSourceSessionContext(sibling, async () => { release(); await pending; }, { newlyAccepted: true });
  assert.deepEqual(await pending, [boards.slug]);
  assert.ok(store.learnedComposioOperationEffect(boards.slug));
});

test('Composio rechecks before each dispatch and before persistence without suppressing a normal retry', async () => {
  store._resetLearnedComposioOperationEffectsForTests();
  const source = learningSource();
  let calls = 0;
  const other = { ...boards, slug: 'MONDAY_COLUMNS' };
  assert.deepEqual(await learnComposioOperationEffects([boards, other], { ...source,
    evaluate: async () => { calls += 1; replaceLearningPolicy(source, EXCLUDED_LEARNING); return { ok: true, readOnly: 1, model: 'fixture' }; },
  }), []);
  assert.equal(calls, 1);
  assert.equal(store.learnedComposioOperationEffect(boards.slug), null);
  assert.equal(store.learnedComposioOperationEffect(other.slug), null);
  const normal = learningSource();
  assert.deepEqual(await learnComposioOperationEffects([boards, other], { ...normal,
    evaluate: async () => { calls += 1; return { ok: true, readOnly: 1, model: 'fixture' }; },
  }), [boards.slug, other.slug]);
  assert.equal(calls, 3);

  store._resetLearnedComposioOperationEffectsForTests();
  const invalidated = learningSource();
  assert.deepEqual(await learnComposioOperationEffects([boards], { ...invalidated,
    evaluate: async () => { replaceLearningPolicy(invalidated, { ...EXCLUDED_LEARNING, mode: 'allow' }); return { ok: true, readOnly: 1, model: 'fixture' }; },
  }), []);
  assert.equal(store.learnedComposioOperationEffect(boards.slug), null);
});


test('Composio default screen checks the captured policy after its lazy import', async () => {
  store._resetLearnedComposioOperationEffectsForTests();
  const jev = await import('../../runtime/jev/client.js');
  jev._setTypesafeKeyForTests('fixture-key');
  let calls = 0;
  jev._setSystemOneFetchForTests(async () => { calls += 1; throw new Error('excluded screen dispatched'); });
  try {
    const source = learningSource();
    const pending = learnComposioOperationEffects([boards], source);
    replaceLearningPolicy(source, EXCLUDED_LEARNING);
    assert.deepEqual(await pending, []);
    assert.equal(calls, 0);
    assert.equal(store.learnedComposioOperationEffect(boards.slug), null);
  } finally {
    jev._setSystemOneFetchForTests(undefined);
    jev._setTypesafeKeyForTests(undefined);
  }
});
