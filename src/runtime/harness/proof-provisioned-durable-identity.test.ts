/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/proof-provisioned-durable-identity.test.ts
 *
 * Live 2026-09-01 (mobile, GLM 5.3): tool_search proved SLACK_FETCH_CONVERSATION_HISTORY
 * as a read, the discovery record carried digest 58a1…, and the host then refused the
 * call with `catalog_entry_or_manifest_missing:candidates=0:proven=cap:resolved:slack_…`.
 * The durable manifest store held the same manifest id at digest 18d5… — installed
 * before the proof builder started writing behaviorHints.readOnly/destructive — so
 * every fresh proof minted a different digest under the SAME id, `store.install`
 * answered identity_mismatch, and registration `continue`d silently: no factory
 * entry, no log, a discovery record claiming a digest nothing held, and a JIT
 * re-provision reporting ok with nothing registered. 28 durable rows (15 reads,
 * 13 writes: sheets, drive, outlook, salesforce, slack) were dead for the chat lane.
 *
 * Contract under pin:
 *   1. Identity is the PROVIDER definition (operation, version, fingerprint, account,
 *      port, schema digests, verification, semantics). When it matches the installed
 *      manifest, the installed manifest IS the registration — host-side decoration
 *      never forks the identity — and the entry resolves as a proven live read.
 *   2. A manifest the store refuses is a typed refusal, never an empty success.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-proof-durable-identity-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-proof-durable-identity\n', 'utf8');

const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const provisioning = await import('./proof-provisioned-catalog.js');
const production = await import('./production-capability-adapters.js');
const manifests = await import('./capability-manifest.js');
const manifestStores = await import('./capability-manifest-store.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const composio = await import('../../integrations/composio/client.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');
import type { CapabilityManifestV1 } from './capability-manifest.js';

const CONNECTION_ID = 'ca_slack_durable_identity';
const SLUG = 'SLACK_FETCH_CONVERSATION_HISTORY';
const BASE_ID = `cap:resolved:${SLUG.toLowerCase()}`;
const INPUT_SCHEMA = {
  type: 'object',
  required: ['channel'],
  properties: { channel: { type: 'string' }, limit: { type: 'number' } },
};
const OUTPUT_SCHEMA = { type: 'object', properties: { messages: { type: 'array' } } };
/** What tool_search passes: the selected subset and its discovery-time schema digest. */
const PROOF_OPTIONS = {
  allowedIdentifiers: [SLUG],
  expectedSchemaDigests: [{ identifier: SLUG, schemaDigest: digestSchema(INPUT_SCHEMA) }],
};

composio.__test__.setConnectedAccountsLoader(async () => [{
  id: CONNECTION_ID,
  status: 'ACTIVE',
  user_id: 'durable-identity-user',
  toolkit: { slug: 'slack' },
}]);
production.installProductionTransport(async () => ({ messages: [] }));
schemas.resetToolSchemaCache();
schemas._setToolSchemaLoaderForTests(async (identifier) => (
  identifier === SLUG
    ? {
        inputParameters: INPUT_SCHEMA,
        outputParameters: OUTPUT_SCHEMA,
        providerObservedAt: Date.now(),
        providerOperationVersion: '20260826_00',
      }
    : null
));

after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function proofTurn(id: string) {
  const session = eventlog.createSession({ id, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'last three messages in the platform channel' },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'capability_resolution',
    data: {
      sourceUserSeq: source.seq,
      authoritativeForTask: true,
      entries: [{
        intent: 'foreground tool_search disclosed this exact live operation',
        kind: 'composio',
        identifier: SLUG,
        status: 'proven',
        connection: 'active',
        accountIdentity: CONNECTION_ID,
        effectClass: 'read',
      }],
    },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

/** The manifest shape the builder wrote before 2026-08-30: no behaviour hints. */
function preHintManifest(current: CapabilityManifestV1): CapabilityManifestV1 {
  return {
    ...current,
    externalDefinition: {
      ...current.externalDefinition!,
      behaviorHints: { readOnly: null, destructive: null, idempotent: null, openWorld: null },
    },
  };
}

test('a read whose durable manifest predates the builder shape registers against the installed identity and resolves as a proven live read', async () => {
  const first = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(first);
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore([]));
  const seeded = await provisioning.registerProofProvisionedCapabilities(
    proofTurn('durable-identity-seed'),
    PROOF_OPTIONS,
  );
  assert.equal(seeded.refusal, undefined);
  assert.ok(seeded.registered.includes(BASE_ID), JSON.stringify(seeded));
  const current = manifestStores.peekCapabilityManifestStore()!.get(BASE_ID)!.manifest;

  // The daemon restarts: the durable store rehydrates the OLD row; the factory is empty.
  const stale = preHintManifest(current);
  const staleDigest = manifests.capabilityManifestDigest(stale);
  assert.notEqual(staleDigest, manifests.capabilityManifestDigest(current), 'the fixture must model a real digest drift');
  const store = manifestStores.createCapabilityManifestStore([stale]);
  manifestStores.installCapabilityManifestStore(store);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);

  const result = await provisioning.registerProofProvisionedCapabilities(
    proofTurn('durable-identity-after-restart'),
    PROOF_OPTIONS,
  );
  assert.equal(result.refusal, undefined, JSON.stringify(result));
  assert.ok(result.registered.includes(BASE_ID), 'the same provider identity registers under the installed id');
  const entry = factory.get(BASE_ID);
  assert.ok(entry, 'the factory holds the proven read');
  assert.equal(entry.manifestDigest, staleDigest, 'the registration carries the INSTALLED identity, not a rebuilt one');
  assert.equal(store.get(BASE_ID)?.digest, staleDigest, 'the durable row is untouched');
  assert.equal(entry.effect, 'read');
  const resolved = catalogs.resolveProvenLiveReadCatalogEntry({
    capabilityId: BASE_ID,
    effectiveName: SLUG,
    accountIdentity: CONNECTION_ID,
  });
  assert.equal(resolved?.capabilityId, BASE_ID, 'the host\'s proven-live-read resolver binds it');
});

test('a manifest the store refuses is a typed refusal, never an empty success', async () => {
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore([]));
  const seeded = await provisioning.registerProofProvisionedCapabilities(
    proofTurn('durable-identity-revoked-seed'),
    PROOF_OPTIONS,
  );
  assert.ok(seeded.registered.includes(BASE_ID), JSON.stringify(seeded));
  const current = manifestStores.peekCapabilityManifestStore()!.get(BASE_ID)!.manifest;
  // A revoked row under the same id: not current, so no lineage, so the proof
  // rebuilds the base id and the store must refuse it — loudly.
  const revoked: CapabilityManifestV1 = { ...current, lifecycle: { state: 'revoked' } };
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore([]));
  const store = manifestStores.peekCapabilityManifestStore()!;
  assert.equal(store.install(current).ok, true);
  assert.equal(store.revoke(BASE_ID), true);
  void revoked;
  factory.clear();

  const result = await provisioning.registerProofProvisionedCapabilities(
    proofTurn('durable-identity-revoked'),
    PROOF_OPTIONS,
  );
  assert.deepEqual(result.registered, []);
  assert.equal(result.refusal?.code, 'proof_manifest_install_refused', JSON.stringify(result));
  assert.equal(result.refusal?.identifier, SLUG);
  assert.equal(factory.get(BASE_ID), undefined);
});
