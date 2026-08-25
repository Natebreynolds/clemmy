/** Run: node scripts/run-tests-isolated.mjs src/tools/composio-prepared-definition-remedy.test.ts
 *
 * PREPARED-DEFINITION GATE MUST NOT DEADLOCK (live 2026-08-25,
 * workflow scrape_and_analyze, 87 calls): every workflow-lane dispatch is
 * preparedExecution, and the gate demanded a live provider observation
 * (fingerprint + digest + operation version inside the 30-min lease). When the
 * lease was cold the refusal prescribed "run one exact search/list/describe
 * read" — but those reads transit the SAME gateway with the SAME flag and were
 * refused by the SAME gate (52 refused APIFY_RUN_ACTOR, 15 refused
 * COMPOSIO_SEARCH_TOOLS, COMPOSIO_RETRIEVE_TOOL_SCHEMA itself refused). These
 * pin the two legs of the fix:
 *   - a cold lease is discharged IN the gate by the strong exact-slug provider
 *     refresh (the one that stamps providerObservedAt + operation version),
 *     not by a cached validation return that can never re-arm the lease;
 *   - an action on the platform's own catalog/connection plane is a
 *     preparation instrument and is never refused PREPARATION-REQUIRED by the
 *     prepared-definition gate, even when the exact refresh is unreachable.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRIOR_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const PRIOR_COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-prepared-definition-remedy-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.COMPOSIO_API_KEY = 'ck_test_prepared_definition_remedy';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'prepared-definition-remedy-test\n', 'utf8');

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runComposioExecuteWithGatewayForTest } = await import('./composio-tools.js');
const {
  rememberToolSchema,
  resetToolSchemaCache,
  _setToolSchemaLoaderForTests,
  liveComposioSchemaFingerprint,
  liveComposioOperationVersion,
} = await import('./composio-schema-cache.js');
const {
  __test__: composioClientTest,
  listUsableConnectedToolkits,
  resetComposioClient,
} = await import('../integrations/composio/client.js');
const {
  appendEvent,
  closeEventLog,
  createSession,
} = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const {
  withHarnessRunContext,
  ToolCallsCounter,
} = await import('../runtime/harness/brackets.js');
const { closeOperationalTelemetryDb } = await import('../runtime/operational-telemetry.js');

const FIRECRAWL_SCHEMA = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', description: 'search query' },
    limit: { type: 'integer' },
  },
};

test.after(() => {
  _setToolSchemaLoaderForTests(null);
  composioClientTest.setConnectedAccountsLoader(null);
  resetComposioClient();
  resetToolSchemaCache();
  closeEventLog();
  closeOperationalTelemetryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_CLEMENTINE_HOME;
  if (PRIOR_COMPOSIO_API_KEY === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = PRIOR_COMPOSIO_API_KEY;
});

function acceptedRun(sessionId: string, text: string): { sourceUserSeq: number; turn: number } {
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: source.turn },
  }));
  return { sourceUserSeq: source.seq, turn: source.turn };
}

function withAcceptedRun<T>(
  sessionId: string,
  accepted: { sourceUserSeq: number; turn: number },
  work: () => Promise<T>,
): Promise<T> {
  return withHarnessRunContext({
    sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
    turn: accepted.turn,
    counter: new ToolCallsCounter(20),
  }, work) as Promise<T>;
}

function outputText(output: unknown): string {
  return typeof output === 'string'
    ? output
    : (output as { output: string }).output;
}

test('a prepared dispatch with a cold lease re-arms authority through the exact provider refresh instead of refusing', async () => {
  const sessionId = 'sess-prepared-cold-lease-remedy';
  const accepted = acceptedRun(sessionId, 'Search Firecrawl for Big Bear restaurants.');
  resetComposioClient();
  resetToolSchemaCache();
  // A durable validation contract exists, but no live provider observation:
  // the exact cold-lease state every post-restart workflow dispatch is in.
  rememberToolSchema('FIRECRAWL_SEARCH', FIRECRAWL_SCHEMA);
  assert.equal(liveComposioSchemaFingerprint('FIRECRAWL_SEARCH'), undefined,
    'fixture precondition: the validation cache holds no executable lease');
  let exactRefreshes = 0;
  _setToolSchemaLoaderForTests(async () => {
    exactRefreshes += 1;
    return {
      inputParameters: FIRECRAWL_SCHEMA,
      providerObservedAt: Date.now(),
      providerOperationVersion: '20260825_01',
    };
  });
  composioClientTest.setConnectedAccountsLoader(async () => [{
    id: 'ca_firecrawl_cold_lease',
    status: 'ACTIVE',
    toolkit: { slug: 'firecrawl' },
    user_id: 'hermetic-owner',
  }]);
  await listUsableConnectedToolkits({ requireFresh: true });
  composioClientTest.setComposioClient({
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async () => {
            throw new Error('unexpected raw transport execution');
          },
        },
      }),
    }),
  });
  let providerBodies = 0;

  const output = await withAcceptedRun(sessionId, accepted, () =>
    runComposioExecuteWithGatewayForTest(
      'FIRECRAWL_SEARCH',
      { q: 'Big Bear restaurants', limit: 5 },
      (async () => {
        providerBodies += 1;
        return { successful: true, data: { results: [{ title: 'Big Bear Lake Brewing' }] } };
      }) as never,
      sessionId,
    ));

  const text = outputText(output);
  assert.doesNotMatch(text, /PREPARATION-REQUIRED/i,
    'the in-gate exact refresh must discharge the demand the gate reads');
  assert.equal(providerBodies, 1, 'the accepted call dispatches exactly once');
  assert.equal(exactRefreshes, 1, 'exactly one bounded provider metadata read discharges the cold lease');
  // Leg-by-leg: the refresh re-armed the same lease the gate demands.
  assert.ok(liveComposioSchemaFingerprint('FIRECRAWL_SEARCH'),
    'the exact refresh stamps providerObservedAt so the fingerprint leg derives');
  assert.equal(liveComposioOperationVersion('FIRECRAWL_SEARCH'), '20260825_01',
    'the exact refresh stamps the provider operation version leg');
});

test('a platform-plane catalog read is never refused PREPARATION-REQUIRED, even with the exact refresh unreachable', async () => {
  const sessionId = 'sess-platform-plane-instrument';
  const accepted = acceptedRun(sessionId, 'Find the exact Apify actor-run action.');
  resetComposioClient();
  resetToolSchemaCache();
  // The platform cannot describe its own catalog action right now: the state
  // in which the old gate refused the very read its banner prescribed.
  _setToolSchemaLoaderForTests(async () => null);
  composioClientTest.setConnectedAccountsLoader(async () => []);
  composioClientTest.setComposioClient({
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async () => {
            throw new Error('unexpected raw transport execution');
          },
        },
      }),
    }),
  });
  let providerBodies = 0;

  const output = await withAcceptedRun(sessionId, accepted, () =>
    runComposioExecuteWithGatewayForTest(
      'COMPOSIO_SEARCH_TOOLS',
      { query: 'apify run actor' },
      (async () => {
        providerBodies += 1;
        return { successful: true, data: { items: [{ slug: 'APIFY_RUN_ACTOR' }] } };
      }) as never,
      sessionId,
    ));

  const text = outputText(output);
  assert.doesNotMatch(text, /PREPARATION-REQUIRED/i,
    'a preparation instrument must never be refused by the gate whose remedy it is');
  assert.equal(providerBodies, 1, 'the catalog read dispatches');
});
