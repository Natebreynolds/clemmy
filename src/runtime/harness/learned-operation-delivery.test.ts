/**
 * The learned operation-delivery verdict: two models, the operation's own
 * definition, and nothing recorded unless both agree.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/learned-operation-delivery.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-learned-delivery-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const learner = await import('./learned-operation-delivery.js');
const store = await import('./learned-operation-delivery-store.js');
const jev = await import('../jev/client.js');
const ports = await import('../semantic-boundary/turn-semantic-port-registry.js');
const {
  configuredBrainSemanticPort,
  semanticModelRoleForPurpose,
} = await import('../semantic-boundary/configured-brain-semantic-port.js');

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const OPEN = {
  providerKind: 'composio' as const,
  operationId: 'EXAMPLE_OPEN_DM',
  description: 'Opens a direct conversation with the given people and returns its id. Nothing is posted.',
  inputSchema: { type: 'object', properties: { users: { type: 'string' } }, required: ['users'] },
};

let jevAnswers: { delivers: number; irreversible: number } | null = { delivers: 0.03, irreversible: 0.02 };
let jevModel = 'jev-fixture';
const jevRequests: Array<Record<string, unknown>> = [];
jev._setTypesafeKeyForTests('fixture-key');
jev._setSystemOneFetchForTests(async (_url, init) => {
  jevRequests.push(JSON.parse(init.body) as Record<string, unknown>);
  if (!jevAnswers) return { status: 503, ok: false, text: async () => 'unavailable' };
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: jevModel,
      answers: {
        delivers: { type: 'noul', noul: jevAnswers!.delivers },
        irreversible: { type: 'noul', noul: jevAnswers!.irreversible },
      },
      usage: { input_tokens: 30, output_tokens: 2 },
    }),
  };
});

type JudgeRaw = Record<string, unknown> | ((definitionDigest: string) => Record<string, unknown>);
let judgeRaw: JudgeRaw = (definitionDigest) => ({
  deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 0.95, definitionDigest,
});
let judgeModel = 'judge-fixture-model';
let judgeHook: (() => void) | null = null;
const judgeRequests: Array<{ purpose: string; system: string; user: string; schemaName: string }> = [];
function installJudge(): void {
  ports.installTurnSemanticModelPort(configuredBrainSemanticPort(async (request) => {
    judgeRequests.push(request);
    judgeHook?.();
    const { definitionDigest } = JSON.parse(request.user) as { definitionDigest: string };
    return {
      raw: typeof judgeRaw === 'function' ? judgeRaw(definitionDigest) : judgeRaw,
      modelIdentity: judgeModel,
      inputTokens: 90,
      outputTokens: 12,
      latencyMs: 2,
    };
  }));
}
installJudge();

beforeEach(() => {
  store._resetLearnedOperationDeliveryForTests();
  learner._resetOperationDeliveryLearningForTests();
  jevAnswers = { delivers: 0.03, irreversible: 0.02 };
  jevModel = 'jev-fixture';
  judgeRaw = (definitionDigest) => ({
    deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 0.95, definitionDigest,
  });
  judgeModel = 'judge-fixture-model';
  judgeHook = null;
  jevRequests.length = 0;
  judgeRequests.length = 0;
  jev._setTypesafeKeyForTests('fixture-key');
  installJudge();
});

after(() => {
  jev._setSystemOneFetchForTests(undefined);
  jev._setTypesafeKeyForTests(undefined);
  ports.installTurnSemanticModelPort(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('both models read the definition, never the name, and only their agreement is recorded', async () => {
  assert.equal(await learner.learnOperationDelivery(OPEN, { sessionId: 'session-a' }), 'learned');
  const verdict = store.learnedOperationDeliveryVerdict('composio', 'example_open_dm');
  assert.ok(verdict, 'the provider operation id is matched case-insensitively for this provider');
  assert.equal(verdict.verdict, 'delivers_nothing_non_destructive');
  assert.deepEqual(verdict.screen, { model: 'jev-fixture', deliveryProbability: 0.03, irreversibleProbability: 0.02 });
  assert.deepEqual(verdict.confirm, {
    role: 'judge', model: 'judge-fixture-model', deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 0.95,
  });
  assert.match(verdict.definitionDigest, /^[a-f0-9]{64}$/);
  assert.match(verdict.inputSchemaDigest, /^[a-f0-9]{64}$/);

  const screen = jevRequests[0] as { state: Record<string, unknown>; questions: Record<string, { type: string }> };
  assert.deepEqual(Object.keys(screen.state).sort(), ['description', 'inputSchema']);
  assert.deepEqual(Object.keys(screen.questions).sort(), ['delivers', 'irreversible']);
  assert.equal(screen.questions.delivers!.type, 'noul');
  assert.equal(screen.questions.irreversible!.type, 'noul');
  assert.doesNotMatch(JSON.stringify(jevRequests[0]), /EXAMPLE_OPEN_DM|OPEN_DM/);

  assert.equal(judgeRequests.length, 1);
  const judge = judgeRequests[0]!;
  assert.equal(judge.purpose, 'operation_delivery_judge');
  assert.equal(judge.schemaName, 'OperationDeliveryJudgeV1');
  assert.equal(semanticModelRoleForPurpose('operation_delivery_judge'), 'judge');
  const user = JSON.parse(judge.user) as Record<string, string>;
  assert.deepEqual(Object.keys(user).sort(), ['definitionDigest', 'description', 'inputSchema']);
  assert.equal(user.definitionDigest, verdict.definitionDigest);
  assert.doesNotMatch(judge.user, /OPEN_DM/);

  // The same definition is never asked again.
  assert.equal(await learner.learnOperationDelivery(OPEN), 'already_learned');
  assert.equal(jevRequests.length, 1);
});

test('a screen that is not confident, or unavailable, never reaches the judge and records nothing', async () => {
  for (const answers of [
    { delivers: 0.11, irreversible: 0 },
    { delivers: 0, irreversible: 0.3 },
    { delivers: 0.9, irreversible: 0.9 },
  ]) {
    jevAnswers = answers;
    assert.equal(await learner.learnOperationDelivery(OPEN), 'screen_not_confident', JSON.stringify(answers));
  }
  jevAnswers = null;
  assert.equal(await learner.learnOperationDelivery(OPEN), 'screen_unavailable');
  jevAnswers = { delivers: 0, irreversible: 0 };
  jev._setTypesafeKeyForTests(null);
  assert.equal(await learner.learnOperationDelivery(OPEN), 'screen_unavailable', 'no key, no screen');
  assert.equal(judgeRequests.length, 0);
  assert.equal(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId), null);
});

test('the judge must be present, independent, confident, agreeing, and bound to the same definition', async () => {
  ports.installTurnSemanticModelPort(null);
  assert.equal(await learner.learnOperationDelivery(OPEN), 'confirm_unavailable', 'no semantic port');
  installJudge();

  judgeRaw = () => { throw new Error('judge model down'); };
  assert.equal(await learner.learnOperationDelivery(OPEN), 'confirm_unavailable', 'a failing judge');

  judgeRaw = (definitionDigest) => ({ deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 0.99, definitionDigest });
  judgeModel = 'jev-fixture';
  assert.equal(await learner.learnOperationDelivery(OPEN), 'confirm_unavailable', 'one model twice is one reading');
  judgeModel = 'judge-fixture-model';

  judgeRaw = { deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 0.99, definitionDigest: sha('another definition') };
  assert.equal(await learner.learnOperationDelivery(OPEN), 'confirm_mismatched');

  judgeRaw = (definitionDigest) => ({ deliversToOthers: 'no', deletesOrIrreversible: 'yes', confidence: 0.99, definitionDigest });
  assert.equal(await learner.learnOperationDelivery(OPEN), 'confirm_disagreed');

  judgeRaw = (definitionDigest) => ({ deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 1.4, definitionDigest });
  assert.equal(await learner.learnOperationDelivery(OPEN), 'confirm_not_confident', 'an out-of-range confidence is no confidence');

  judgeRaw = { verdict: 'fine' };
  assert.equal(await learner.learnOperationDelivery(OPEN), 'confirm_mismatched', 'a malformed verdict binds no definition');

  assert.equal(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId), null);
});

test('only structural sends with a whole, readable definition are ever asked', async () => {
  for (const definition of [
    { ...OPEN, operationId: 'EXAMPLE_CREATE_RECORD' },
    { ...OPEN, operationId: 'EXAMPLE_LIST_MESSAGES' },
    { ...OPEN, operationId: 'EXAMPLE_DELETE_MESSAGE' },
  ]) {
    assert.equal(await learner.learnOperationDelivery(definition), 'not_send_shaped', definition.operationId);
  }
  assert.equal(await learner.learnOperationDelivery({ ...OPEN, description: '   ' }), 'definition_unreadable');
  assert.equal(await learner.learnOperationDelivery({ ...OPEN, inputSchema: undefined }), 'definition_unreadable');
  const huge = {
    type: 'object',
    properties: Object.fromEntries(Array.from({ length: 400 }, (_, index) => [
      `field_${index}`, { type: 'string', description: 'x'.repeat(40) },
    ])),
  };
  assert.equal(await learner.learnOperationDelivery({ ...OPEN, inputSchema: huge }), 'definition_unreadable',
    'a schema the models cannot read whole is not read at all');
  assert.equal(jevRequests.length, 0);
});

test('a newly observed definition removes the old verdict at once, and a reading it superseded is discarded', async () => {
  assert.equal(await learner.learnOperationDelivery(OPEN), 'learned');
  const changed = { ...OPEN, description: 'Opens a direct conversation and posts a greeting in it.' };
  // Observation alone removes the verdict, before any model is asked.
  ports.installTurnSemanticModelPort(null);
  assert.equal(learner.scheduleOperationDeliveryLearning([changed]), 1);
  assert.equal(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId), null, 'removed on observation');
  await learner._drainOperationDeliveryLearningForTests();
  assert.equal(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId), null,
    'with no judge the newer definition stays unlearned');
  installJudge();

  // A reading of the old definition that finishes after the newer one was
  // observed writes nothing; the newer definition is read on its own.
  learner._resetOperationDeliveryLearningForTests();
  judgeRequests.length = 0;
  judgeHook = () => {
    judgeHook = null;
    learner.scheduleOperationDeliveryLearning([changed]);
  };
  assert.equal(await learner.learnOperationDelivery(OPEN), 'superseded');
  const oldDigest = (JSON.parse(judgeRequests[0]!.user) as { definitionDigest: string }).definitionDigest;
  await learner._drainOperationDeliveryLearningForTests();
  const verdict = store.learnedOperationDeliveryVerdict('composio', OPEN.operationId);
  assert.ok(verdict, 'the newer definition was read and agreed on');
  assert.notEqual(verdict.definitionDigest, oldDigest, 'the superseded reading never wrote its verdict');
});

for (const [label, patch] of [
  ['missing description', { description: undefined }],
  ['blank description', { description: '   ' }],
  ['oversized description', { description: 'x'.repeat(4_001) }],
  ['missing schema', { inputSchema: undefined }],
  ['oversized schema', { inputSchema: { type: 'object', description: 'x'.repeat(12_001) } }],
  ['changed semantic classification', { semanticName: 'delete_message' }],
] as const) {
  test(`observing a ${label} retires the prior verdict without new model work`, async () => {
    const unrelated = { ...OPEN, operationId: 'OTHER_OPEN_DM' };
    assert.equal(await learner.learnOperationDelivery(OPEN), 'learned');
    assert.equal(await learner.learnOperationDelivery(unrelated), 'learned');
    const screenCalls = jevRequests.length;
    const judgeCalls = judgeRequests.length;

    assert.equal(learner.scheduleOperationDeliveryLearning([{ ...OPEN, ...patch }]), 0);
    assert.equal(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId), null);
    assert.ok(store.learnedOperationDeliveryVerdict('composio', unrelated.operationId), 'another operation is preserved');
    const persisted = JSON.parse(readFileSync(path.join(TEST_HOME, 'state', 'operation-delivery-verdicts.json'), 'utf8'));
    assert.equal(Object.hasOwn(persisted.verdicts, store.learnedOperationDeliveryKey('composio', OPEN.operationId)!), false,
      'the retired verdict is gone from disk, not just this process');
    assert.equal(jevRequests.length, screenCalls);
    assert.equal(judgeRequests.length, judgeCalls);
  });
}

test('invalidation keeps provider boundaries and exact native operation identities', async () => {
  const native = { ...OPEN, providerKind: 'native_mcp' as const, semanticName: 'open_dm' };
  const differentlyCased = { ...native, operationId: OPEN.operationId.toLowerCase() };
  for (const definition of [OPEN, native, differentlyCased]) {
    assert.equal(await learner.learnOperationDelivery(definition), 'learned');
  }
  assert.equal(learner.scheduleOperationDeliveryLearning([{ ...native, description: null }]), 0);
  assert.equal(store.learnedOperationDeliveryVerdict('native_mcp', native.operationId), null);
  assert.ok(store.learnedOperationDeliveryVerdict('native_mcp', differentlyCased.operationId));
  assert.ok(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId));

  assert.equal(learner.scheduleOperationDeliveryLearning([{ ...OPEN, operationId: OPEN.operationId.toLowerCase(), description: null }]), 0);
  assert.equal(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId), null,
    'the existing case-insensitive identity rule still applies');
  assert.ok(store.learnedOperationDeliveryVerdict('native_mcp', differentlyCased.operationId));
  assert.equal(jevRequests.length, 3);
});

test('metadata without an operation identity cannot retire another operation', async () => {
  assert.equal(await learner.learnOperationDelivery(OPEN), 'learned');
  assert.equal(learner.scheduleOperationDeliveryLearning([{ ...OPEN, operationId: '', description: null }]), 0);
  assert.ok(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId));
  assert.equal(jevRequests.length, 1);
});

test('an unreadable definition supersedes a judge reading already in flight', async () => {
  judgeHook = () => {
    judgeHook = null;
    assert.equal(learner.scheduleOperationDeliveryLearning([{ ...OPEN, description: null }]), 0);
  };
  assert.equal(await learner.learnOperationDelivery(OPEN), 'superseded');
  assert.equal(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId), null,
    'the old judge cannot restore the retired verdict');
  assert.equal(judgeRequests.length, 1);
});

test('a definition superseded during screening does not spend a judge call', async () => {
  assert.equal(await learner.learnOperationDelivery(OPEN, {
    screen: async () => {
      learner.scheduleOperationDeliveryLearning([{ ...OPEN, inputSchema: undefined }]);
      return { ok: true, model: 'screen-fixture', deliveryProbability: 0, irreversibleProbability: 0 };
    },
  }), 'superseded');
  assert.equal(judgeRequests.length, 0);
  assert.equal(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId), null);
});

test('a superseded queued definition spends no model calls', async () => {
  assert.equal(learner.scheduleOperationDeliveryLearning([OPEN]), 1);
  assert.equal(learner.scheduleOperationDeliveryLearning([{ ...OPEN, description: null }]), 0);
  await learner._drainOperationDeliveryLearningForTests();
  assert.equal(jevRequests.length, 0);
  assert.equal(judgeRequests.length, 0);
  assert.equal(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId), null);
});

test('a discovery batch still retires stale verdicts after its model-work budget is full', async () => {
  assert.equal(await learner.learnOperationDelivery(OPEN), 'learned');
  const newDefinitions = Array.from({ length: 6 }, (_, index) => ({ ...OPEN, operationId: `NEW_OPEN_DM_${index}` }));
  try {
    assert.equal(learner.scheduleOperationDeliveryLearning([
      ...newDefinitions, { ...OPEN, description: 'Now posts a greeting to the conversation.' },
    ]), 6);
    assert.equal(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId), null);
    assert.equal(jevRequests.length, 1, 'observing definitions does not run models on the discovery path');
  } finally {
    await learner._drainOperationDeliveryLearningForTests();
  }
  assert.equal(jevRequests.length, 7, 'the six-new-learning budget is unchanged');
});

test('a full background queue does not suppress invalidation of an observed definition', async () => {
  assert.equal(await learner.learnOperationDelivery(OPEN), 'learned');
  let scheduled = 0;
  try {
    for (let batch = 0; batch < 6; batch += 1) {
      scheduled += learner.scheduleOperationDeliveryLearning(Array.from({ length: 6 }, (_, index) => ({
        ...OPEN, operationId: `QUEUED_OPEN_DM_${batch}_${index}`,
      })));
    }
    assert.equal(scheduled, 32);
    assert.equal(learner.scheduleOperationDeliveryLearning([{ ...OPEN, description: null }]), 0);
    assert.equal(store.learnedOperationDeliveryVerdict('composio', OPEN.operationId), null);
  } finally {
    await learner._drainOperationDeliveryLearningForTests();
  }
  assert.equal(jevRequests.length, 33, 'queue capacity stays bounded');
});

test('scheduling returns before any model is asked, is bounded, deduplicated, and waits after an answer', async () => {
  const sends = Array.from({ length: 9 }, (_, index) => ({
    ...OPEN, operationId: `EXAMPLE_OPEN_DM_${index}`,
  }));
  judgeRaw = (definitionDigest) => ({ deliversToOthers: 'yes', deletesOrIrreversible: 'no', confidence: 0.99, definitionDigest });
  const scheduled = learner.scheduleOperationDeliveryLearning([sends[0]!, sends[0]!, ...sends.slice(1)]);
  assert.equal(scheduled, 6, 'a few new operations per discovery, duplicates dropped');
  assert.equal(jevRequests.length, 0, 'nothing is asked on the caller\'s path');
  assert.equal(learner.scheduleOperationDeliveryLearning([sends[0]!]), 0, 'already pending');
  await learner._drainOperationDeliveryLearningForTests();
  assert.equal(jevRequests.length, 6);
  assert.equal(judgeRequests.length, 6);
  for (const send of sends.slice(0, 6)) {
    assert.equal(store.learnedOperationDeliveryVerdict('composio', send.operationId), null);
  }
  assert.equal(learner.scheduleOperationDeliveryLearning([sends[0]!]), 0,
    'an answered definition is not asked again soon');
  assert.equal(learner.scheduleOperationDeliveryLearning([sends[7]!]), 1, 'an unasked one still is');
  await learner._drainOperationDeliveryLearningForTests();
});

test('the store parses only closed, agreeing, independent verdicts', () => {
  const valid = {
    version: 1, providerKind: 'composio', operationId: 'EXAMPLE_OPEN_DM',
    verdict: 'delivers_nothing_non_destructive',
    definitionDigest: sha('definition'), inputSchemaDigest: sha('schema'),
    screen: { model: 'jev-fixture', deliveryProbability: 0.1, irreversibleProbability: 0 },
    confirm: { role: 'judge', model: 'judge-fixture-model', deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 0.9 },
    learnedAt: '2026-09-25T12:00:00.000Z',
  };
  assert.ok(store.parseLearnedOperationDeliveryVerdictV1(valid));
  for (const [label, mutated] of [
    ['extra key', { ...valid, note: 'x' }],
    ['lower-case composio id', { ...valid, operationId: 'example_open_dm' }],
    ['screen above threshold', { ...valid, screen: { ...valid.screen, deliveryProbability: 0.11 } }],
    ['judge below threshold', { ...valid, confirm: { ...valid.confirm, confidence: 0.89 } }],
    ['judge said yes', { ...valid, confirm: { ...valid.confirm, deliversToOthers: 'yes' } }],
    ['same model twice', { ...valid, confirm: { ...valid.confirm, model: 'jev-fixture' } }],
    ['not a digest', { ...valid, inputSchemaDigest: 'abc' }],
    ['not an instant', { ...valid, learnedAt: 'yesterday' }],
    ['unknown provider', { ...valid, providerKind: 'other' }],
  ] as const) {
    assert.equal(store.parseLearnedOperationDeliveryVerdictV1(mutated), null, label);
  }
  assert.equal(store.rememberLearnedOperationDelivery({ ...valid, confirm: { ...valid.confirm, confidence: 0.2 } } as never), false);
  assert.equal(store.learnedOperationDeliveryVerdict('composio', 'EXAMPLE_OPEN_DM'), null);
});
