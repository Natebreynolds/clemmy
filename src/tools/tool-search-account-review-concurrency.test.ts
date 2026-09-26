/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/tool-search-account-review-concurrency.test.ts
 *
 * Discovery reviews which connected account each disclosed write operates as.
 * Those reviews are model calls, one per toolkit and effect. Reviews of
 * different toolkits are independent, so one search waits for the slowest of
 * them, not for their sum.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-account-review-concurrency-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('../runtime/harness/eventlog.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const production = await import('../runtime/harness/production-capability-adapters.js');
const semanticPorts = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const schemas = await import('./composio-schema-cache.js');
const composio = await import('../integrations/composio/client.js');
const sources = await import('./tool-search-provider-sources.js');

const INPUT = { type: 'object', required: ['text'], properties: { text: { type: 'string' } } };
const OUTPUT = { type: 'object', properties: { ok: { type: 'boolean' } } };
const WRITES = ['OUTLOOK_SEND_EMAIL', 'SLACK_SEND_MESSAGE'];

test.after(() => {
  production.installProductionTransport(null);
  semanticPorts.installTurnSemanticModelPort(null);
  schemas._setToolSchemaLoaderForTests(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifests.installCapabilityManifestStore(null);
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('account reviews of different toolkits run together, and each still decides its own writes', async () => {
  schemas.resetToolSchemaCache();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  production.installProductionTransport(async () => { throw new Error('no business calls in discovery'); });
  schemas._setToolSchemaLoaderForTests(async () => ({ inputParameters: INPUT, outputParameters: OUTPUT,
    providerObservedAt: Date.now(), providerOperationVersion: '20260926_00' }));
  composio.__test__.setComposioApiKeyOverride('fixture-only');
  composio.__test__.setConnectedAccountsLoader(async () => [
    { id: 'fixture-outlook', status: 'ACTIVE', user_id: 'fixture-owner', toolkit: { slug: 'outlook' }, data: { user_info: { email: 'owner@mail.invalid' } } },
    { id: 'fixture-slack', status: 'ACTIVE', user_id: 'fixture-owner', toolkit: { slug: 'slack' } },
  ]);
  let inFlight = 0;
  let maxInFlight = 0;
  const reviewed: string[] = [];
  let bothStarted!: () => void;
  const started = new Promise<void>((resolve) => { bothStarted = resolve; });
  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('no hidden work plan'); },
    async judgeAccountSelection(call) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      reviewed.push(call.toolkit);
      if (inFlight >= 2) bothStarted();
      // A review that runs alone finishes on its own after a short wait; two
      // running together see each other.
      await Promise.race([started, new Promise((resolve) => setTimeout(resolve, 250))]);
      inFlight -= 1;
      return { verdict: call.mode === 'current_source_default' ? 'default_compatible' : 'entailed',
        proposalDigest: call.proposalDigest, modelIdentity: 'fixture-account-judge' };
    },
  } as never);
  const session = eventlog.createSession({ id: 'account-review-concurrency', kind: 'chat', userId: 'fixture-owner' });
  const event = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Tell the team the launch moved to Friday.' } });
  const identity = { sessionId: session.id, sourceUserSeq: event.seq };
  const staged = await sources.stageDisclosedPlanningProviderCandidates({ ...identity,
    candidates: WRITES.map((name) => ({ name, sourceKind: 'authorized_composio' as const, carrier: 'work_call' as const, schema: INPUT })) });
  assert.deepEqual([...reviewed].sort(), ['outlook', 'slack'], 'one review per toolkit');
  assert.equal(maxInFlight, 2, 'the two toolkits were reviewed at the same time, not one after the other');
  assert.deepEqual(staged.blockers, {}, 'each review still decides its own toolkit\'s writes');
  const published = catalogs.peekHostCapabilityCatalogFactory()!.snapshot().map((entry) => entry.toolName);
  assert.deepEqual(WRITES.filter((name) => published.includes(name)), WRITES, 'both writes are published with their accounts');
});
