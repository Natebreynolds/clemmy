/**
 * Discovery hands the send-shaped definitions it already holds to the
 * background delivery learner, and never waits for it.
 *
 * Drives the REAL composio candidate source with a stubbed provider client:
 * the judge is held open while discovery returns, so a discovery that waited
 * on learning would never return.
 *
 * Run: node scripts/run-tests-isolated.mjs src/tools/tool-search-operation-delivery-learning.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-discovery-delivery-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';

const composio = await import('../integrations/composio/client.js');
const providerSources = await import('./tool-search-provider-sources.js');
const schemaCache = await import('./composio-schema-cache.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const learner = await import('../runtime/harness/learned-operation-delivery.js');
const deliveryStore = await import('../runtime/harness/learned-operation-delivery-store.js');
const jev = await import('../runtime/jev/client.js');
const ports = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const { configuredBrainSemanticPort } = await import('../runtime/semantic-boundary/configured-brain-semantic-port.js');

const TOOLKIT = 'example';
const OPEN = `${TOOLKIT.toUpperCase()}_OPEN_DM`;
const SEND = `${TOOLKIT.toUpperCase()}_SEND_MESSAGE`;
const LIST = `${TOOLKIT.toUpperCase()}_LIST_MESSAGES`;
const DESCRIPTIONS: Record<string, string> = {
  [OPEN]: 'Opens a direct conversation with the given people and returns its id. Nothing is posted.',
  [SEND]: 'Posts a message to a conversation; everyone in it receives the message.',
  [LIST]: 'Lists the messages in a conversation.',
};

function fuzzyRow(slug: string) {
  return {
    slug,
    name: slug,
    description: DESCRIPTIONS[slug],
    toolkit: { slug: TOOLKIT },
    inputParameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    outputParameters: { type: 'object', properties: { id: { type: 'string' } } },
    version: 'fixture-v1',
  };
}

composio.resetComposioClient();
composio.__test__.setComposioApiKeyOverride('delivery-learning-key');
composio.__test__.setConnectedAccountsLoader(async () => [{
  id: 'ca_fixture_owner', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: TOOLKIT },
}]);
composio.__test__.setComposioClient({
  tools: {
    async getRawComposioTools(input: Record<string, unknown>) {
      if (Array.isArray(input.tools) && input.tools.length > 0) return [];
      return [OPEN, SEND, LIST].map(fuzzyRow);
    },
    async execute() { throw new Error('discovery must never execute'); },
  },
} as never);

const screened: string[] = [];
jev._setTypesafeKeyForTests('fixture-key');
jev._setSystemOneFetchForTests(async (_url, init) => {
  const request = JSON.parse(init.body) as { state: { description: string } };
  screened.push(request.state.description);
  const delivers = request.state.description.startsWith('Posts') ? 0.96 : 0.02;
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-fixture',
      answers: {
        delivers: { type: 'noul', noul: delivers },
        irreversible: { type: 'noul', noul: 0.01 },
      },
      usage: { input_tokens: 20, output_tokens: 2 },
    }),
  };
});

let releaseJudge!: () => void;
const judgeReleased = new Promise<void>((resolve) => { releaseJudge = resolve; });
let judgeCalls = 0;
ports.installTurnSemanticModelPort(configuredBrainSemanticPort(async (request) => {
  judgeCalls += 1;
  await judgeReleased;
  const { definitionDigest } = JSON.parse(request.user) as { definitionDigest: string };
  return {
    raw: { deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 0.97, definitionDigest },
    modelIdentity: 'judge-fixture-model',
    inputTokens: 50,
    outputTokens: 10,
    latencyMs: 1,
  };
}));

after(() => {
  jev._setSystemOneFetchForTests(undefined);
  jev._setTypesafeKeyForTests(undefined);
  ports.installTurnSemanticModelPort(null);
  schemaCache.resetToolSchemaCache();
  eventlog.resetEventLog();
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('discovery schedules delivery learning for its send-shaped definitions and returns without waiting', async () => {
  deliveryStore._resetLearnedOperationDeliveryForTests();
  learner._resetOperationDeliveryLearningForTests();
  const sources = providerSources.buildAuthorizedToolSearchCandidateSources({
    reason: 'delivery learning wiring',
    authority: 'catalog',
    allowedServerSlugs: [],
    toolPatterns: [],
    maxTools: 0,
  } as never);
  const source = sources.find((entry) => entry.kind === 'authorized_composio');
  assert.ok(source, 'the composio candidate source must exist');

  const outcome = await Promise.race([
    source!.search({ query: 'open a conversation and message my teammate', limit: 8 }).then((rows) => ({ rows })),
    new Promise<'timeout'>((resolve) => { setTimeout(() => resolve('timeout'), 10_000).unref(); }),
  ]);
  assert.notEqual(outcome, 'timeout', 'discovery returned while the judge was still held');
  if (outcome === 'timeout') return;
  const offered = outcome.rows.map((row) => row.name).sort();
  assert.deepEqual(offered, [LIST, OPEN, SEND].sort(), 'discovery offers the same operations as before');
  assert.equal(deliveryStore.learnedOperationDeliveryVerdict('composio', OPEN), null,
    'nothing is learned on the discovery path');

  releaseJudge();
  await learner._drainOperationDeliveryLearningForTests();
  assert.deepEqual([...screened].sort(), [DESCRIPTIONS[OPEN], DESCRIPTIONS[SEND]].sort(),
    'only the two send-shaped definitions were read; the list was not');
  assert.equal(judgeCalls, 1, 'only the definition the screen passed reached the judge');
  const verdict = deliveryStore.learnedOperationDeliveryVerdict('composio', OPEN);
  assert.ok(verdict, 'the definition that delivers nothing was learned in the background');
  assert.equal(verdict.confirm.model, 'judge-fixture-model');
  assert.equal(deliveryStore.learnedOperationDeliveryVerdict('composio', SEND), null, 'the send was not');
});
