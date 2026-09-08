import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { CapabilityManifestV1 } from './capability-manifest.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-proof-write-evidence-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-proof-write-evidence\n');
const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const provisioning = await import('./proof-provisioned-catalog.js');
const production = await import('./production-capability-adapters.js');
const ports = await import('./production-capability-ports.js');
const manifests = await import('./capability-manifest.js');
const stores = await import('./capability-manifest-store.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const composio = await import('../../integrations/composio/client.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');
const search = await import('../../tools/tool-search-tool.js');
const sources = await import('../../tools/tool-search-provider-sources.js');
const INPUT = { type: 'object', required: ['content'], properties: { content: { type: 'string' } } };
const OUTPUT = { type: 'object', properties: { successful: { type: 'boolean' }, data: { type: 'object' } } };
const ACCOUNT = 'connection-write-evidence';
let schemaReads = 0;
let accountReads = 0;

production.installProductionTransport(async () => { throw new Error('this proof must never dispatch'); });
composio.__test__.setConnectedAccountsLoader(async () => {
  accountReads += 1;
  return [{ id: ACCOUNT, status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'fixture' } }];
});
schemas._setToolSchemaLoaderForTests(async () => {
  schemaReads += 1;
  return { inputParameters: INPUT, outputParameters: OUTPUT,
    providerObservedAt: Date.now(), providerOperationVersion: '20260905_01' };
});

after(() => {
  schemas._setToolSchemaLoaderForTests(null);
  production.installProductionTransport(null);
  semanticPorts.installTurnSemanticModelPort(null);
  ports.clearProductionCapabilityPorts();
  catalogs.installHostCapabilityCatalogFactory(null);
  stores.installCapabilityManifestStore(null);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function turn(slug: string, label: string, recordProof = true) {
  const session = eventlog.createSession({ id: `write-evidence-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Create the requested item once.' } });
  if (recordProof) eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'capability_resolution', data: {
    sourceUserSeq: source.seq, authoritativeForTask: true, entries: [{ intent: 'create the requested item', kind: 'composio',
      identifier: slug, status: 'proven', connection: 'active', accountIdentity: ACCOUNT, effectClass: 'write' }],
  } });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function selected(slug: string) {
  return { allowedIdentifiers: [slug], expectedSchemaDigests: [{ identifier: slug, schemaDigest: digestSchema(INPUT) }] };
}

async function seed(slug: string, label: string) {
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  stores.installCapabilityManifestStore(stores.createCapabilityManifestStore([]));
  const identity = turn(slug, label);
  const result = await provisioning.registerProofProvisionedCapabilities(identity, selected(slug));
  assert.equal(result.refusal, undefined, JSON.stringify(result));
  const capabilityId = `cap:resolved:${slug.toLowerCase()}`;
  const entry = factory.get(capabilityId);
  assert.ok(entry?.manifest, JSON.stringify(result));
  return { factory, identity, capabilityId, entry, manifest: entry.manifest };
}

test('generic selected and whole-proof writes advertise only provider acknowledgement', async () => {
  const fixture = await seed('FIXTURE_CREATE_ACKNOWLEDGED', 'generic');
  assert.deepEqual(fixture.manifest.evidenceContract, { kinds: ['tool_result'], readbackRequired: false });
  assert.equal(fixture.manifest.readbackContract, undefined);
  assert.equal(fixture.manifest.externalDefinition?.verification, undefined);
  assert.equal(fixture.manifest.operationSemantics?.atomicInputContent, undefined);
  const replay = await provisioning.registerProofProvisionedCapabilities(fixture.identity);
  assert.equal(replay.refusal, undefined);
  assert.equal(fixture.factory.get(fixture.capabilityId)?.manifestDigest, fixture.entry.manifestDigest);
  assert.deepEqual(fixture.factory.get(fixture.capabilityId)?.manifest?.evidenceContract,
    { kinds: ['tool_result'], readbackRequired: false });
});

test('reopened legacy default retains frozen evidence and fresh discovery publishes one durable successor', async () => {
  const slug = 'FIXTURE_CREATE_LEGACY_DEFAULT';
  const fixture = await seed(slug, 'legacy-seed');
  const legacy: CapabilityManifestV1 = { ...fixture.manifest, evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true } };
  const legacyDigest = manifests.capabilityManifestDigest(legacy);
  const durable = stores.createCapabilityManifestStore([], { durable: true });
  assert.equal(durable.install(legacy).ok, true);
  stores.installCapabilityManifestStore(durable);
  fixture.factory.register({ ...fixture.entry, manifest: legacy, manifestDigest: legacyDigest });
  const frozen = catalogs.freezeCatalogSnapshotForSource(fixture.identity);
  assert.equal(frozen.ok, true);
  const oldSnapshot = catalogs.persistedCatalogSnapshotManifestIdsForSource(fixture.identity);
  assert.equal(oldSnapshot.ok, true);
  if (!oldSnapshot.ok) throw new Error('fixture snapshot failed');

  // Close and reopen both storage owners, rather than supplying an in-memory
  // old shape to the new builder. This is the daemon rollout boundary.
  eventlog.closeEventLog();
  stores.installCapabilityManifestStore(null);
  const reopened = stores.createCapabilityManifestStore([], { durable: true });
  stores.installCapabilityManifestStore(reopened);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  assert.equal(reopened.get(fixture.capabilityId)?.digest, legacyDigest);
  const recovery = await provisioning.registerProofProvisionedCapabilities(fixture.identity, {
    ...selected(slug), recoveryExpectedIdentities: oldSnapshot.identities,
  });
  assert.equal(recovery.refusal, undefined, JSON.stringify(recovery));
  assert.equal(factory.get(fixture.capabilityId)?.manifestDigest, legacyDigest);
  assert.deepEqual(factory.get(fixture.capabilityId)?.manifest?.evidenceContract, legacy.evidenceContract);
  const sameSource = await provisioning.registerProofProvisionedCapabilities(fixture.identity, selected(slug));
  assert.equal(sameSource.refusal, undefined);
  assert.equal(factory.get(fixture.capabilityId)?.manifestDigest, legacyDigest,
    'a persisted source snapshot prevents policy migration even without a recovery override');

  const fresh = turn(slug, 'legacy-fresh');
  const upgrade = await provisioning.registerProofProvisionedCapabilities(fresh, selected(slug));
  assert.equal(upgrade.refusal, undefined, JSON.stringify(upgrade));
  const successor = reopened.list().find((row) => row.manifest.operationId === slug && row.manifest.lifecycle.state === 'current');
  assert.ok(successor);
  assert.ok(successor.manifest.manifestId.startsWith(`${fixture.capabilityId}:definition:`));
  assert.notEqual(successor.digest, legacyDigest);
  assert.deepEqual(successor.manifest.evidenceContract, { kinds: ['tool_result'], readbackRequired: false });
  assert.deepEqual(reopened.list().find((row) => row.manifest.manifestId === fixture.capabilityId)?.manifest.evidenceContract, legacy.evidenceContract);
  assert.deepEqual(catalogs.persistedCatalogSnapshotManifestIdsForSource(fixture.identity), oldSnapshot,
    'the old source keeps the exact strict identity and is never reclassified');
  const repeated = await provisioning.registerProofProvisionedCapabilities(fresh, selected(slug));
  assert.equal(repeated.refusal, undefined);
  assert.equal(factory.get(successor.manifest.manifestId)?.manifestDigest, successor.digest);
  assert.equal(reopened.list().filter((row) => row.manifest.operationId === slug).length, 2);

  eventlog.closeEventLog();
  stores.installCapabilityManifestStore(null);
  const secondBoot = stores.createCapabilityManifestStore([], { durable: true });
  stores.installCapabilityManifestStore(secondBoot);
  assert.equal(secondBoot.get(successor.manifest.manifestId)?.digest, successor.digest);
});

test('explicit caller evidence and readback requirements are not treated as the legacy default', async () => {
  for (const [index, additional] of [
    { evidenceContract: { kinds: ['receipt'], readbackRequired: false } },
    { evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
      readbackContract: { required: true, contentDigestRequired: true } },
    { evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
      provenance: { issuer: 'adapter:explicit-evidence', issuedAt: '1970-01-01T00:00:00.000Z', trusted: true as const } },
  ].entries()) {
    const slug = `FIXTURE_CREATE_EXPLICIT_${index}`;
    const fixture = await seed(slug, `explicit-seed-${index}`);
    const explicit: CapabilityManifestV1 = { ...fixture.manifest, ...additional };
    const digest = manifests.capabilityManifestDigest(explicit);
    const store = stores.createCapabilityManifestStore([explicit]);
    stores.installCapabilityManifestStore(store);
    fixture.factory.clear();
    const result = await provisioning.registerProofProvisionedCapabilities(turn(slug, `explicit-fresh-${index}`), selected(slug));
    assert.equal(result.refusal, undefined, JSON.stringify(result));
    assert.equal(fixture.factory.get(fixture.capabilityId)?.manifestDigest, digest);
    assert.deepEqual(fixture.factory.get(fixture.capabilityId)?.manifest?.evidenceContract, additional.evidenceContract);
    assert.equal(store.list().filter((row) => row.manifest.operationId === slug).length, 1,
      'explicit requirements do not receive a weaker successor');
  }
});

test('a fresh initial card withholds the legacy default until exact discovery publishes its acknowledgement successor', async () => {
  const slug = 'FIXTURE_CREATE_CARD_ITEM';
  const fixture = await seed(slug, 'card-seed');
  const legacy: CapabilityManifestV1 = { ...fixture.manifest,
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true } };
  const legacyDigest = manifests.capabilityManifestDigest(legacy);
  const durable = stores.createCapabilityManifestStore([], { durable: true });
  assert.equal(durable.install(legacy).ok, true);
  stores.installCapabilityManifestStore(durable);
  fixture.factory.register({ ...fixture.entry, manifest: legacy, manifestDigest: legacyDigest });
  assert.equal(catalogs.freezeCatalogSnapshotForSource(fixture.identity).ok, true);
  const oldSnapshot = catalogs.persistedCatalogSnapshotManifestIdsForSource(fixture.identity);
  assert.equal(oldSnapshot.ok, true);
  if (!oldSnapshot.ok) throw new Error('fixture snapshot failed');
  eventlog.closeEventLog();
  stores.installCapabilityManifestStore(null);
  const reopened = stores.createCapabilityManifestStore([], { durable: true });
  stores.installCapabilityManifestStore(reopened);
  fixture.factory.clear();
  assert.equal(reopened.get(fixture.capabilityId)?.digest, legacyDigest);
  const recovered = await provisioning.registerProofProvisionedCapabilities(fixture.identity, {
    ...selected(slug), recoveryExpectedIdentities: oldSnapshot.identities,
  });
  assert.equal(recovered.refusal, undefined, JSON.stringify(recovered));
  const frozenCard = await semantic.primePrimaryModelPlanningCatalog(fixture.identity);
  assert.equal(frozenCard.ok, true);
  if (!frozenCard.ok) throw new Error(frozenCard.reason);
  assert.ok(frozenCard.planning.capabilities.some((row) => row.id === fixture.capabilityId && row.readbackRequired),
    'an already frozen source retains its old strict card');
  const frozenIdentity = catalogs.persistedCatalogSnapshotManifestIdsForSource(fixture.identity);

  const fresh = turn(slug, 'card-fresh', false);
  const beforeMetadata = { schemaReads, accountReads };
  const primed = await semantic.primePrimaryModelPlanningCatalog(fresh);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);
  assert.deepEqual({ schemaReads, accountReads }, beforeMetadata,
    'withholding a known host default performs no provider/schema/account discovery');
  assert.ok(!primed.planning.capabilities.some((row) => row.id === fixture.capabilityId));
  assert.equal(provisioning.isLegacyGenericProviderWriteEvidencePolicy(legacy), true);
  assert.equal(fixture.factory.get(fixture.capabilityId)?.manifestDigest, legacyDigest,
    'prospective withholding cannot mutate the shared callable');

  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('no hidden model planning'); },
    async judgeAccountSelection(call) {
      return { verdict: call.mode === 'current_source_default' ? 'default_compatible' : 'entailed',
        proposalDigest: call.proposalDigest, modelIdentity: 'fixture-account-judge' };
    },
  });
  let handler!: (input: unknown) => Promise<{ content: Array<{ text: string }> }>;
  search.registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) {
    handler = callback;
  } } as never, {
    allowedNames: new Set(), dispatchCarrier: 'work_call',
    candidateSources: [{ kind: 'authorized_composio', async search() { return [{ name: slug,
      summary: 'Create the requested item once.', score: 1, carrier: 'work_call', schema: INPUT,
      invocation: { name: 'composio_execute_tool', fixedArgs: { tool_slug: slug }, payloadField: 'arguments' },
    }]; } }],
    async discloseForPlanning(candidates, control) {
      const staged = await sources.stageDisclosedPlanningProviderCandidates({ ...fresh, candidates,
        signal: control?.signal, deadlineAt: control?.deadlineAt });
      const refs = await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority,
        candidates, signal: control?.signal, deadlineAt: control?.deadlineAt });
      return { version: 1, refs, blockers: staged.blockers };
    },
  });
  const found = JSON.parse((await handler({ query: slug, limit: 8, account_selection: null })).content[0]!.text);
  const ref = found.results[0]?.capabilityRef;
  assert.ok(ref?.startsWith(`${fixture.capabilityId}:definition:`), JSON.stringify(found));
  assert.deepEqual(fixture.factory.get(ref)?.manifest?.evidenceContract, { kinds: ['tool_result'], readbackRequired: false });
  assert.ok(semantic.snapshotPrimaryModelPlanningContext(primed.planning.authority)?.capabilities.some((row) => (
    row.id === ref && row.evidenceKinds.length === 1 && row.evidenceKinds[0] === 'tool_result' && !row.readbackRequired
  )), JSON.stringify(semantic.snapshotPrimaryModelPlanningContext(primed.planning.authority)));
  const reprime = await semantic.primePrimaryModelPlanningCatalog(fresh);
  assert.equal(reprime.ok, true, reprime.ok ? '' : reprime.reason);
  if (!reprime.ok) throw new Error(reprime.reason);
  assert.ok(reprime.planning.capabilities.some((row) => row.id === ref && !row.readbackRequired));
  assert.ok(!reprime.planning.capabilities.some((row) => row.id === fixture.capabilityId),
    'indexed priming and durable disclosure replay cannot reintroduce the retired default');
  assert.deepEqual(catalogs.persistedCatalogSnapshotManifestIdsForSource(fixture.identity), frozenIdentity,
    'fresh discovery does not rewrite the prior frozen identity');
});
