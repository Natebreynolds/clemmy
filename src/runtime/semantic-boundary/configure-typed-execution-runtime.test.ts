import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-typed-runtime-'));
process.env.CLEMENTINE_HOME = HOME;

import {
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} from '../harness/host-capability-catalog-factory.js';
import {
  createCapabilityManifestStore,
  installCapabilityManifestStore,
  peekCapabilityManifestStore,
  resolveCurrentSuccessorManifest,
} from '../harness/capability-manifest-store.js';
import {
  installProductionCapabilityAdapter,
  peekProductionCapabilityAdapter,
} from '../harness/production-capability-adapter.js';
import {
  configureTypedExecutionRuntime,
  refreshTypedExecutionReadiness,
  typedExecutionCatalogReady,
  typedExecutionCatalogRefusals,
} from './configure-typed-execution-runtime.js';
import {
  productionPortIdentityFromManifest,
  registerProductionCapabilityPort,
} from '../harness/production-capability-ports.js';
import { installTurnSemanticModelPort, peekTurnSemanticModelPort } from './turn-semantic-port-registry.js';
import { completeViaConfiguredBrain } from './configured-brain-semantic-port.js';
import { attachSemanticContract } from '../harness/capability-manifest.js';
import {
  FAKE_PROVISIONED_ACCOUNTS,
  productionCapabilityManifests,
  provisionAccountBoundCapabilitySuccessor,
} from '../harness/production-capability-catalog.js';
import { registerIndependentCapabilityObservation } from '../harness/independent-capability-observation.js';
import { capabilityManifestDigest } from '../harness/capability-manifest.js';
import { registerShippedTestPort } from '../harness/isolated-attested-transport.fixture.js';

test('runtime configuration never promotes model-facing tools into execution authority', () => {
  installTurnSemanticModelPort(null);
  installHostCapabilityCatalogFactory(null);
  installCapabilityManifestStore(null);
  installProductionCapabilityAdapter(null);

  configureTypedExecutionRuntime();

  const factory = peekHostCapabilityCatalogFactory();
  assert.ok(factory, 'the shared fail-closed catalog boundary is installed');
  assert.ok(peekCapabilityManifestStore(), 'trusted manifest store is installed');
  assert.ok(peekProductionCapabilityAdapter(), 'production adapter is installed');
  assert.deepEqual(factory.snapshot(), [], 'the built-in beta pack cannot populate an executable catalog without a live observer');
  assert.ok(peekTurnSemanticModelPort(), 'normal bootstrap installs the configured semantic adapter');
  assert.equal(typeof completeViaConfiguredBrain, 'function');
});

test('repeated configure keeps the same not-ready refusals', () => {
  installTurnSemanticModelPort(null);
  installHostCapabilityCatalogFactory(null);
  installCapabilityManifestStore(null);
  installProductionCapabilityAdapter(null);
  configureTypedExecutionRuntime();
  const firstReady = typedExecutionCatalogReady();
  const first = typedExecutionCatalogRefusals().map((entry) => `${entry.manifestId}:${entry.reason}`).sort();
  configureTypedExecutionRuntime();
  assert.equal(typedExecutionCatalogReady(), firstReady);
  assert.equal(firstReady, false);
  assert.deepEqual(
    typedExecutionCatalogRefusals().map((entry) => `${entry.manifestId}:${entry.reason}`).sort(),
    first,
  );
  assert.ok(first.some((entry) => (
    entry.includes('placeholder_account')
    || entry.includes('observation_unavailable')
    || entry.includes('empty_catalog')
  )));
});

test('daemon double-initialization keeps the same not-ready refusals', async () => {
  installTurnSemanticModelPort(null);
  installHostCapabilityCatalogFactory(null);
  installCapabilityManifestStore(null);
  installProductionCapabilityAdapter(null);
  const { configureHarnessRuntime, resetHarnessRuntimeConfig } = await import('../harness/codex-client.js');
  resetHarnessRuntimeConfig();
  await configureHarnessRuntime();
  const firstReady = typedExecutionCatalogReady();
  const first = typedExecutionCatalogRefusals().map((entry) => `${entry.manifestId}:${entry.reason}`).sort();
  configureTypedExecutionRuntime();
  assert.equal(firstReady, false);
  assert.equal(typedExecutionCatalogReady(), false);
  assert.deepEqual(
    typedExecutionCatalogRefusals().map((entry) => `${entry.manifestId}:${entry.reason}`).sort(),
    first,
  );
  assert.ok(first.length > 0);
});

test('stale factory entries do not make the catalog ready', () => {
  installTurnSemanticModelPort(null);
  installHostCapabilityCatalogFactory(null);
  installCapabilityManifestStore(null);
  installProductionCapabilityAdapter(null);
  configureTypedExecutionRuntime();
  const factory = peekHostCapabilityCatalogFactory();
  assert.ok(factory);
  factory.register({
    capabilityId: 'cap:host_lookup:source',
    toolName: 'stale',
    schemaVersion: '1',
    schemaDigest: 'a'.repeat(64),
    effect: 'read',
    account: 'acct:beta:search:v1',
    invoke: async () => ({}),
  });
  configureTypedExecutionRuntime();
  assert.equal(typedExecutionCatalogReady(), false);
  assert.ok(typedExecutionCatalogRefusals().length > 0);
});

test('disabled production catalog is not executable readiness', () => {
  const previous = process.env.CLEMENTINE_PRODUCTION_CATALOG;
  process.env.CLEMENTINE_PRODUCTION_CATALOG = '0';
  installTurnSemanticModelPort(null);
  installHostCapabilityCatalogFactory(null);
  installCapabilityManifestStore(null);
  installProductionCapabilityAdapter(null);
  configureTypedExecutionRuntime();
  assert.equal(typedExecutionCatalogReady(), false);
  assert.ok(typedExecutionCatalogRefusals().some((entry) => entry.reason === 'production_catalog_disabled'));
  if (previous === undefined) delete process.env.CLEMENTINE_PRODUCTION_CATALOG;
  else process.env.CLEMENTINE_PRODUCTION_CATALOG = previous;
});

function resetRuntime() {
  installTurnSemanticModelPort(null);
  installHostCapabilityCatalogFactory(null);
  installCapabilityManifestStore(createCapabilityManifestStore());
  installProductionCapabilityAdapter(null);
}

function provisionedReadManifest(id = 'cap:test-read:v1') {
  return attachSemanticContract({
    version: 1,
    manifestId: id,
    providerKind: 'local_registry',
    operationId: `host_lookup:${id}`,
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: 'a'.repeat(64),
    effect: 'read',
    accountId: FAKE_PROVISIONED_ACCOUNTS.search,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'locator' },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:adversarial', issuedAt: '2026-08-16T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
}

function observeAndRegister(manifest: ReturnType<typeof provisionedReadManifest>) {
  const factory = peekHostCapabilityCatalogFactory();
  assert.ok(factory);
  const observedAt = Date.now();
  assert.equal(registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt,
    origin: 'independent',
    observe: () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt,
    }),
  }).ok, true);
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({}),
  });
  registerShippedTestPort(manifest);
}

test('partial-good catalog stays not-ready when another required entry is refused', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  assert.ok(store);
  const good = provisionedReadManifest('cap:good-read:v1');
  const refused = provisionedReadManifest('cap:refused-read:v1');
  assert.equal(store.install(good).ok, true);
  assert.equal(store.install(refused).ok, true);
  observeAndRegister(good);
  refreshTypedExecutionReadiness();
  assert.equal(typedExecutionCatalogReady(), false);
  assert.ok(typedExecutionCatalogRefusals().some((entry) => (
    entry.manifestId === refused.manifestId
    && (entry.reason === 'observation_unavailable' || entry.reason === 'port_missing')
  )));
});

test('an unmanifested factory entry never makes the catalog ready', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const factory = peekHostCapabilityCatalogFactory();
  assert.ok(factory);
  const ghost = provisionedReadManifest('cap:unmanifested:v1');
  observeAndRegister(ghost);
  refreshTypedExecutionReadiness();
  assert.equal(typedExecutionCatalogReady(), false);
  assert.equal(factory.get(ghost.manifestId), undefined);
  assert.ok(typedExecutionCatalogRefusals().some((entry) => entry.reason === 'empty_catalog'));
});

test('a non-cap:host_* provider capability still gates readiness', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  assert.ok(store);
  const provider = attachSemanticContract({
    version: 1,
    manifestId: 'composio:gmail.send',
    providerKind: 'composio',
    operationId: 'GMAIL_SEND_EMAIL',
    providerIdentity: 'composio',
    providerVersion: 'b'.repeat(64),
    operationVersion: '1',
    definitionFingerprint: 'c'.repeat(64),
    effect: 'external_write',
    destination: { family: 'email', posture: 'create_new' },
    accountId: 'acct:fake:gmail:v1',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'created_resource' },
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
    provenance: { issuer: 'host:adversarial', issuedAt: '2026-08-16T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination'],
  });
  assert.equal(store.install(provider).ok, true);
  refreshTypedExecutionReadiness();
  assert.equal(typedExecutionCatalogReady(), false);
  assert.ok(typedExecutionCatalogRefusals().some((entry) => entry.manifestId === provider.manifestId));
});

test('revocation after registration drops readiness', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  assert.ok(store);
  const manifest = provisionedReadManifest('cap:revoke-me:v1');
  assert.equal(store.install(manifest).ok, true);
  observeAndRegister(manifest);
  refreshTypedExecutionReadiness();
  assert.equal(typedExecutionCatalogReady(), true);
  assert.equal(store.revoke(manifest.manifestId), true);
  refreshTypedExecutionReadiness();
  assert.equal(typedExecutionCatalogReady(), false);
  assert.equal(peekHostCapabilityCatalogFactory()?.get(manifest.manifestId), undefined);
});

test('observer loss after readiness fails closed', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  assert.ok(store);
  const manifest = provisionedReadManifest('cap:observer-loss:v1');
  assert.equal(store.install(manifest).ok, true);
  let live = true;
  const factory = peekHostCapabilityCatalogFactory();
  assert.ok(factory);
  assert.equal(registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
    observe: () => {
      if (!live) {
        return {
          operationId: manifest.operationId,
          accountId: manifest.accountId,
          definitionFingerprint: manifest.definitionFingerprint,
          providerVersion: manifest.providerVersion,
          operationVersion: manifest.operationVersion,
          observedAt: 0,
        };
      }
      return {
        operationId: manifest.operationId,
        accountId: manifest.accountId,
        definitionFingerprint: manifest.definitionFingerprint,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
        observedAt: Date.now(),
      };
    },
  }).ok, true);
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({}),
  });
  registerProductionCapabilityPort(productionPortIdentityFromManifest(manifest), {
    observe: () => {
      if (!live) {
        return {
          definitionFingerprint: manifest.definitionFingerprint,
          providerVersion: manifest.providerVersion,
          operationVersion: manifest.operationVersion,
          accountId: manifest.accountId,
          observedAt: 0,
        };
      }
      return {
        definitionFingerprint: manifest.definitionFingerprint,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
        accountId: manifest.accountId,
        observedAt: Date.now(),
      };
    },
    invoke: async () => ({}),
  });
  refreshTypedExecutionReadiness();
  assert.equal(typedExecutionCatalogReady(), true);
  live = false;
  assert.equal(typedExecutionCatalogReady(), false);
});

test('stale observation cannot keep the catalog ready', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  assert.ok(store);
  const manifest = provisionedReadManifest('cap:stale-obs:v1');
  assert.equal(store.install(manifest).ok, true);
  const factory = peekHostCapabilityCatalogFactory();
  assert.ok(factory);
  assert.equal(registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now() - 120_000,
    origin: 'independent',
    observe: () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now() - 120_000,
    }),
  }).ok, true);
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({}),
  });
  refreshTypedExecutionReadiness();
  assert.equal(typedExecutionCatalogReady(), false);
  assert.ok(typedExecutionCatalogRefusals().some((entry) => (
    entry.manifestId === manifest.manifestId && entry.reason === 'observation_mismatch'
  )));
});

test('a placeholder account successor is never executable readiness', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  assert.ok(store);
  const template = productionCapabilityManifests()[0];
  assert.ok(template);
  assert.equal(store.install(template).ok, true);
  refreshTypedExecutionReadiness();
  assert.equal(typedExecutionCatalogReady(), false);
  assert.ok(typedExecutionCatalogRefusals().some((entry) => (
    entry.manifestId === template.manifestId && entry.reason === 'placeholder_account'
  )));
  const provisioned = provisionAccountBoundCapabilitySuccessor({
    store,
    template,
    accountId: template.accountId,
    observation: {
      definitionFingerprint: template.definitionFingerprint,
      providerVersion: template.providerVersion,
      operationVersion: template.operationVersion,
      accountId: template.accountId,
    },
  });
  assert.equal(provisioned.ok, false);
  if (!provisioned.ok) assert.equal(provisioned.reason, 'placeholder_account');
});

test('graph selection binds to the current successor identity', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  assert.ok(store);
  const template = productionCapabilityManifests()[0];
  assert.ok(template);
  const accountId = FAKE_PROVISIONED_ACCOUNTS.search;
  const first = provisionAccountBoundCapabilitySuccessor({
    store,
    template,
    accountId,
    observation: {
      definitionFingerprint: template.definitionFingerprint,
      providerVersion: template.providerVersion,
      operationVersion: template.operationVersion,
      accountId,
    },
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  observeAndRegister(first.manifest);
  refreshTypedExecutionReadiness();
  assert.equal(typedExecutionCatalogReady(), true);
  const later = attachSemanticContract({
    ...first.manifest,
    manifestId: `${template.manifestId}:v3`,
    definitionFingerprint: 'd'.repeat(64),
    invokePortId: `port:${template.manifestId}:v3:${template.operationId}`,
  });
  assert.equal(store.supersede(first.manifest.manifestId, later).ok, true);
  refreshTypedExecutionReadiness();
  assert.equal(
    resolveCurrentSuccessorManifest(store, template.manifestId)?.manifest.manifestId,
    later.manifestId,
  );
  assert.equal(
    resolveCurrentSuccessorManifest(store, first.manifest.manifestId)?.manifest.manifestId,
    later.manifestId,
  );
});

test('readiness and refusals come from one predicate and cannot contradict', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  assert.ok(store);

  // Nothing installed: not ready, and it must SAY why. `ready` with no
  // refusals, or refusals with `ready`, are the contradictions that let a
  // blocked catalog look healthy.
  assert.equal(typedExecutionCatalogReady(), false);
  assert.ok(typedExecutionCatalogRefusals().length > 0, 'an unready catalog must name a blocking refusal');

  // The live accessor and the refreshing writer must agree, in both orders.
  refreshTypedExecutionReadiness();
  const afterRefresh = { ready: typedExecutionCatalogReady(), refusals: [...typedExecutionCatalogRefusals()] };
  const secondRead = { ready: typedExecutionCatalogReady(), refusals: [...typedExecutionCatalogRefusals()] };
  assert.deepEqual(secondRead, afterRefresh, 'reading readiness must be stable and side-effect free');
  assert.equal(
    afterRefresh.ready,
    afterRefresh.refusals.length === 0,
    'ready must be exactly "no blocking refusals"',
  );
});

test('a ready catalog is never empty and never carries blocking refusals', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  assert.ok(store);
  const manifest = provisionedReadManifest('cap:one-predicate:v1');
  assert.equal(store.install(manifest).ok, true);
  const factory = peekHostCapabilityCatalogFactory();
  assert.ok(factory);
  assert.equal(registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
    observe: () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now(),
    }),
  }).ok, true);
  registerProductionCapabilityPort(productionPortIdentityFromManifest(manifest), {
    invoke: (async () => ({})) as never,
  });
  refreshTypedExecutionReadiness();

  if (typedExecutionCatalogReady()) {
    assert.equal(typedExecutionCatalogRefusals().length, 0, 'ready must imply zero blocking refusals');
    assert.ok((peekCapabilityManifestStore()?.list().length ?? 0) > 0, 'ready must imply real membership');
  } else {
    assert.ok(typedExecutionCatalogRefusals().length > 0, 'unready must name a refusal');
  }
});

/**
 * Regression pin for the LIVE 2026-08-26 mechanism: registering one
 * correctly-proven capability collaterally forgot unrelated, still-current
 * manifests this same long-running daemon had accumulated from earlier,
 * unrelated sessions, purely because their independent observation had aged
 * past the 60s freshness window by the time this call ran. A daemon with N
 * composio operations across its lifetime can accumulate stale residue
 * indefinitely; scoping readiness to the manifestIds one call actually
 * touches is what keeps that residue from ever being swept in.
 */
test('scoped readiness refresh never forgets an unrelated stale entry outside its scope', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  assert.ok(store);
  const factory = peekHostCapabilityCatalogFactory();
  assert.ok(factory);

  // residue: installed and registered by an earlier, unrelated turn in this
  // same process. Its independent observation is already older than
  // INDEPENDENT_OBSERVATION_FRESHNESS_MS.
  const residue = provisionedReadManifest('cap:residue-unrelated:v1');
  assert.equal(store.install(residue).ok, true);
  assert.equal(registerIndependentCapabilityObservation({
    operationId: residue.operationId,
    accountId: residue.accountId,
    definitionFingerprint: residue.definitionFingerprint,
    providerVersion: residue.providerVersion,
    operationVersion: residue.operationVersion,
    observedAt: Date.now() - 120_000,
    origin: 'independent',
    observe: () => ({
      operationId: residue.operationId,
      accountId: residue.accountId,
      definitionFingerprint: residue.definitionFingerprint,
      providerVersion: residue.providerVersion,
      operationVersion: residue.operationVersion,
      observedAt: Date.now() - 120_000,
    }),
  }).ok, true);
  factory.register({
    capabilityId: residue.manifestId,
    toolName: residue.operationId,
    schemaVersion: residue.operationVersion,
    schemaDigest: residue.definitionFingerprint,
    effect: residue.effect,
    account: residue.accountId,
    manifestDigest: capabilityManifestDigest(residue),
    providerKind: residue.providerKind,
    liveFingerprint: residue.definitionFingerprint,
    manifest: residue,
    invoke: async () => ({}),
  });

  // fresh: THIS call's own registration, observed just now with a real port.
  const fresh = provisionedReadManifest('cap:fresh-registration:v1');
  assert.equal(store.install(fresh).ok, true);
  observeAndRegister(fresh);

  // THE LIVE SHAPE: refreshing readiness scoped to only what this call
  // registered must not touch `residue`, even though residue's own
  // observation is stale and would be forgotten by an unscoped sweep.
  refreshTypedExecutionReadiness([fresh.manifestId]);

  assert.ok(factory.get(residue.manifestId), 'an unrelated stale residue must survive a scoped registration');
  assert.equal(typedExecutionCatalogReady([fresh.manifestId]), true,
    'the capability this call actually registered is ready on its own');
  assert.equal(typedExecutionCatalogReady([residue.manifestId]), false,
    'the residue is still correctly refused for a call that actually needs it — scoping never launders staleness');
});

/**
 * Direction pins for the same scoping change: narrowing WHO readiness
 * inspects must never narrow WHAT it demands from the thing actually asked
 * about.
 */
test('scoped readiness still fails closed for what a call actually needs', () => {
  resetRuntime();
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  assert.ok(store);
  const factory = peekHostCapabilityCatalogFactory();
  assert.ok(factory);

  // A capability whose OWN observation is genuinely stale is not
  // dispatchable as freshly-proven for the call that needs exactly it, even
  // when the check is scoped to just that one manifest.
  const stale = provisionedReadManifest('cap:scoped-stale:v1');
  assert.equal(store.install(stale).ok, true);
  assert.equal(registerIndependentCapabilityObservation({
    operationId: stale.operationId,
    accountId: stale.accountId,
    definitionFingerprint: stale.definitionFingerprint,
    providerVersion: stale.providerVersion,
    operationVersion: stale.operationVersion,
    observedAt: Date.now() - 120_000,
    origin: 'independent',
    observe: () => ({
      operationId: stale.operationId,
      accountId: stale.accountId,
      definitionFingerprint: stale.definitionFingerprint,
      providerVersion: stale.providerVersion,
      operationVersion: stale.operationVersion,
      observedAt: Date.now() - 120_000,
    }),
  }).ok, true);
  factory.register({
    capabilityId: stale.manifestId,
    toolName: stale.operationId,
    schemaVersion: stale.operationVersion,
    schemaDigest: stale.definitionFingerprint,
    effect: stale.effect,
    account: stale.accountId,
    manifestDigest: capabilityManifestDigest(stale),
    providerKind: stale.providerKind,
    liveFingerprint: stale.definitionFingerprint,
    manifest: stale,
    invoke: async () => ({}),
  });
  assert.equal(typedExecutionCatalogReady([stale.manifestId]), false,
    'a genuinely stale observation refuses even when the check is scoped to just itself');

  // A call whose own needed operation was never registered at all (no
  // current manifest anywhere in the store) still fails closed rather than
  // reading an empty scope as vacuously ready.
  assert.equal(typedExecutionCatalogReady(['cap:never-registered:v1']), false,
    'a call needing an operation with no current manifest fails closed');
});
