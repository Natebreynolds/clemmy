/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/tool-search-deferred-write-review.test.ts
 *
 * A chat search does not wait for a write's account review. The write comes
 * back pending, the same review keeps running, and the write is published
 * only when that review entails — exactly as if the search had waited. The
 * write's own call waits for that publication. A review that does not entail
 * publishes nothing, and the next search reports the account question from
 * the finished review without asking the reviewer again.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-deferred-write-review-'));
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
const WRITE = 'OUTLOOK_SEND_EMAIL';
const READ = 'OUTLOOK_LIST_MESSAGES';

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

let sessionCount = 0;

/** One fresh home state and accepted source, with an account reviewer the
 * test releases by hand. */
function fixture(decision: 'allow' | 'conflict') {
  schemas.resetToolSchemaCache();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  production.installProductionTransport(async () => { throw new Error('no business calls in discovery'); });
  schemas._setToolSchemaLoaderForTests(async () => ({ inputParameters: INPUT, outputParameters: OUTPUT,
    providerObservedAt: Date.now(), providerOperationVersion: '20261010_00' }));
  composio.__test__.setComposioApiKeyOverride('fixture-only');
  composio.__test__.setConnectedAccountsLoader(async () => [
    { id: 'fixture-outlook', status: 'ACTIVE', user_id: 'fixture-owner', toolkit: { slug: 'outlook' }, data: { user_info: { email: 'owner@mail.invalid' } } },
  ]);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const reviews: string[] = [];
  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('no hidden work plan'); },
    async judgeAccountSelection(call) {
      reviews.push(call.toolkit);
      await released;
      const verdict = decision === 'conflict' ? 'conflict' : call.mode === 'current_source_default' ? 'default_compatible' : 'entailed';
      return { verdict, proposalDigest: call.proposalDigest, modelIdentity: 'fixture-account-judge' };
    },
  } as never);
  sessionCount += 1;
  const session = eventlog.createSession({ id: `deferred-write-review-${sessionCount}`, kind: 'chat', userId: 'fixture-owner' });
  const event = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Email the team that the launch moved to Friday.' } });
  const identity = { sessionId: session.id, sourceUserSeq: event.seq };
  const candidates = [WRITE, READ].map((name) => ({
    name, sourceKind: 'authorized_composio' as const, carrier: 'work_call' as const, schema: INPUT,
  }));
  const published = (name: string) => catalogs.peekHostCapabilityCatalogFactory()!.snapshot()
    .some((entry) => entry.toolName === name);
  return { identity, candidates, release, reviews, published };
}

test('a chat search answers before a write\'s account review, and the review then publishes the write', async () => {
  const { identity, candidates, release, reviews, published } = fixture('allow');
  const startedAt = Date.now();
  const staged = await sources.stageDisclosedPlanningProviderCandidates({
    ...identity, candidates, deferSlowWriteReviews: true });
  assert.ok(Date.now() - startedAt < 5_000, 'the search did not wait for the review');
  assert.deepEqual(staged.pending, { [WRITE]: true }, 'the write is pending');
  assert.ok(staged.refs[READ], 'the read needs no review and is published now');
  assert.equal(published(WRITE), false, 'nothing publishes the write before its review entails');
  assert.deepEqual(reviews, ['outlook'], 'the review is running');

  const settling = sources.settleDeferredWritePublication({ ...identity, operation: WRITE });
  release();
  assert.equal(await settling, true, 'the write\'s own call waits for that publication');
  assert.equal(published(WRITE), true, 'the entailed review published the write');
  assert.deepEqual(reviews, ['outlook'], 'publishing reused the same review');
  assert.equal(await sources.settleDeferredWritePublication({ ...identity, operation: WRITE, waitMs: 0 }), true,
    'a call arriving after it finished binds what it published instead of provisioning again');
  assert.equal(await sources.settleDeferredWritePublication({ ...identity, operation: READ, waitMs: 0 }), false,
    'a write never deferred is provisioned as before');
});

test('a review that does not entail publishes nothing, and the next search asks from it', async () => {
  const { identity, candidates, release, reviews, published } = fixture('conflict');
  const staged = await sources.stageDisclosedPlanningProviderCandidates({
    ...identity, candidates, deferSlowWriteReviews: true });
  assert.deepEqual(staged.pending, { [WRITE]: true });
  release();
  await sources.settleDeferredWritePublication({ ...identity, operation: WRITE });
  assert.equal(published(WRITE), false, 'the write was not published');

  const again = await sources.stageDisclosedPlanningProviderCandidates({
    ...identity, candidates, deferSlowWriteReviews: true });
  assert.equal(again.blockers[WRITE]?.code, 'account_selection_required',
    'the next search reports the account question as before');
  assert.deepEqual(again.pending ?? {}, {}, 'it is not pending a second time');
  assert.deepEqual(reviews, ['outlook'], 'the finished review answered it; the reviewer was not asked again');
});

test('a search that names the account waits for its review', async () => {
  const { identity, candidates, release, published } = fixture('allow');
  const staging = sources.stageDisclosedPlanningProviderCandidates({
    ...identity, candidates, deferSlowWriteReviews: true,
    accountSelection: { toolkit: 'outlook', identity: 'owner@mail.invalid', source_quote: 'Email the team' },
  });
  const early = await Promise.race([staging.then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 600))]);
  assert.equal(early, 'waiting', 'an account answer is the next step, so the search waits for it');
  release();
  const staged = await staging;
  assert.deepEqual(staged.pending ?? {}, {});
  assert.equal(published(WRITE), true);
});

test('without the chat option a search still waits for every review', async () => {
  const { identity, candidates, release, published } = fixture('allow');
  const staging = sources.stageDisclosedPlanningProviderCandidates({ ...identity, candidates });
  const early = await Promise.race([staging.then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 600))]);
  assert.equal(early, 'waiting');
  release();
  const staged = await staging;
  assert.deepEqual(staged.pending ?? {}, {});
  assert.equal(published(WRITE), true);
});
