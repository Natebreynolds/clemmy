/**
 * Run: npx tsx --test src/spaces/space-read-authority.test.ts
 *
 * Workspace composio READ refreshes must discharge the shared durable
 * call-authority demand themselves: refreshSpaceData mints a
 * workflow_v1_read_only activation for the exact declared operation and
 * redeems it through the shared kernel. The provider edge is a registered
 * fixture port (same stubbing as the kernel suite) — no live crossing.
 *
 * Direction pins: a caller that bypasses the mint still gets the zero-body
 * refusal, a mismatched/malformed supplied authority still refuses, and
 * Space ACTIONS keep the stricter workflow_v3_call demand.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-read-authority-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('../runtime/harness/eventlog.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const externalCatalog = await import('../execution/workflow-step-external-catalog.js');
const readAuthority = await import('./space-read-authority.js');
const runner = await import('./runner.js');
const store = await import('./store.js');

const OPERATION = 'SALESFORCE_GET_CONTACTS';

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const digest = (label: string): string => createHash('sha256').update(label, 'utf8').digest('hex');

function coldComposioReadCapability(operationId: string, bodies: Map<string, number>) {
  const inputSchemaDigest = digest(`input:${operationId}`);
  const exactManifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.space.cold.${operationId.toLowerCase()}`,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'composio.test',
    providerVersion: 'composio-runtime-v1',
    operationVersion: 'v20260831_00',
    definitionFingerprint: digest(`definition:${operationId}`),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: inputSchemaDigest,
      semanticName: operationId,
      behaviorHints: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
    },
    effect: 'read',
    accountId: `account.space.${operationId}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'read_bounded_records',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host.test', issuedAt: '2026-08-31T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(exactManifest),
    {
      invoke: async () => {
        bodies.set(operationId, (bodies.get(operationId) ?? 0) + 1);
        return { data: { records: [{ operationId }] }, successful: true };
      },
    },
  ).ok, true);
  const entry: catalogs.RegisteredHostCapability = {
    capabilityId: exactManifest.manifestId,
    toolName: exactManifest.operationId,
    schemaVersion: exactManifest.operationVersion,
    schemaDigest: exactManifest.definitionFingerprint,
    effect: exactManifest.effect,
    account: exactManifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(exactManifest),
    providerKind: exactManifest.providerKind,
    providerInputSchemaDigest: inputSchemaDigest,
    liveFingerprint: exactManifest.definitionFingerprint,
    manifest: exactManifest,
    invoke: async () => {
      throw new Error('catalog invoke must not own the workspace crossing');
    },
  };
  return {
    manifest: exactManifest,
    entry,
    definition: {
      identifier: operationId,
      schemaDigest: inputSchemaDigest,
      accountIdentity: exactManifest.accountId,
      definitionFingerprint: exactManifest.definitionFingerprint,
      outputSchemaDigest: null,
      providerOperationVersion: exactManifest.operationVersion,
      invokePortId: exactManifest.invokePortId,
      schema: { type: 'object' },
      fingerprint: digest(`source-schema:${operationId}`),
      outputSchema: null,
    },
  };
}

function installReadCapability(operationId: string): { portBodies: () => number } {
  const exactManifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.space.${operationId}`,
    providerKind: 'local_registry',
    operationId,
    providerIdentity: 'runtime.test',
    providerVersion: 'runtime.1',
    operationVersion: '1',
    definitionFingerprint: digest(`schema:${operationId}`),
    effect: 'read',
    accountId: `account.space.${operationId}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'read_bounded_records',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host.test', issuedAt: '2026-08-22T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
  let portBodies = 0;
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(exactManifest),
    {
      invoke: async () => {
        portBodies += 1;
        return { data: { records: [{ id: 'contact.1' }] }, successful: true };
      },
    },
  ).ok, true);
  const entry: catalogs.RegisteredHostCapability = {
    capabilityId: exactManifest.manifestId,
    toolName: exactManifest.operationId,
    schemaVersion: exactManifest.operationVersion,
    schemaDigest: exactManifest.definitionFingerprint,
    effect: exactManifest.effect,
    account: exactManifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(exactManifest),
    providerKind: exactManifest.providerKind,
    liveFingerprint: exactManifest.definitionFingerprint,
    manifest: exactManifest,
    invoke: async () => {
      throw new Error('catalog invoke must not own the workspace crossing');
    },
  };
  const factory = catalogs.peekHostCapabilityCatalogFactory()
    ?? catalogs.createHostCapabilityCatalogFactory();
  factory.register(entry);
  catalogs.installHostCapabilityCatalogFactory(factory);
  assert.equal(observations.registerIndependentCapabilityObservation({
    operationId: exactManifest.operationId,
    accountId: exactManifest.accountId,
    definitionFingerprint: exactManifest.definitionFingerprint,
    providerVersion: exactManifest.providerVersion,
    operationVersion: exactManifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
    observe: () => ({
      operationId: exactManifest.operationId,
      accountId: exactManifest.accountId,
      definitionFingerprint: exactManifest.definitionFingerprint,
      providerVersion: exactManifest.providerVersion,
      operationVersion: exactManifest.operationVersion,
      observedAt: Date.now(),
    }),
  }).ok, true);
  return { portBodies: () => portBodies };
}

test('a composio-read Workspace refresh mints shared durable read authority and dispatches', async () => {
  const slug = 'authority-minted-read';
  const capability = installReadCapability(OPERATION);
  store.spaceStore.save({
    id: slug,
    title: 'Minted read',
    dataSources: [{
      id: 'contacts',
      composioSlug: OPERATION,
      composioArgs: { limit: 5 },
    }],
  });
  try {
    const first = await runner.refreshSpaceData(slug, 'contacts', { cause: 'manual' });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.ok, true, `refresh refused: ${first[0]?.error ?? ''}`);
    assert.equal(capability.portBodies(), 1, 'exactly one provider body ran');

    // A second refresh is a fresh occurrence: a new activation, a new dispatch.
    const second = await runner.refreshSpaceData(slug, 'contacts', { cause: 'scheduled' });
    assert.equal(second[0]?.ok, true, `second refresh refused: ${second[0]?.error ?? ''}`);
    assert.equal(capability.portBodies(), 2, 'each refresh redeems its own activation');
  } finally {
    store.spaceStore.archive(slug);
  }
});

test('a cold two-source Workspace refresh prepares each exact read before minting authority', async () => {
  const slug = 'authority-cold-two-source';
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  const bodies = new Map<string, number>();
  const sheet = coldComposioReadCapability('GOOGLESHEETS_BATCH_GET', bodies);
  const slack = coldComposioReadCapability('SLACK_FETCH_CONVERSATION_HISTORY', bodies);
  const exactByOperation = new Map([
    [sheet.manifest.operationId, sheet],
    [slack.manifest.operationId, slack],
  ]);
  const manifestStore = manifestStores.createCapabilityManifestStore();
  const installedSheet = manifestStore.install(sheet.manifest);
  assert.equal(installedSheet.ok, true, `sheet manifest refused: ${JSON.stringify(installedSheet)}`);
  const installedSlack = manifestStore.install(slack.manifest);
  assert.equal(installedSlack.ok, true, `slack manifest refused: ${JSON.stringify(installedSlack)}`);
  manifestStores.installCapabilityManifestStore(manifestStore);
  const factory = catalogs.peekHostCapabilityCatalogFactory()!;
  assert.equal(factory.get(sheet.manifest.manifestId), undefined);
  assert.equal(factory.get(slack.manifest.manifestId), undefined);
  const preparedOperations: string[] = [];
  readAuthority._setExactSpaceReadCatalogPreparerForTests((input) => (
    externalCatalog.prepareWorkflowStepExternalCatalog(input, {
      manifestStore,
      catalogFactory: factory,
      revalidate: async (selections) => {
        assert.equal(selections.length, 1);
        const operationId = selections[0]!.identifier;
        const exact = exactByOperation.get(operationId);
        assert.ok(exact, operationId);
        preparedOperations.push(operationId);
        return {
          ok: true,
          definitions: new Map([[operationId.toLowerCase(), exact!.definition]]),
        };
      },
      refresh: (manifestIds) => {
        assert.equal(manifestIds.length, 1);
        const exact = [...exactByOperation.values()].find(
          (candidate) => candidate.manifest.manifestId === manifestIds[0],
        );
        assert.ok(exact);
        factory.register(exact!.entry);
      },
      ready: (manifestIds) => manifestIds.every((id) => Boolean(factory.get(id))),
    })
  ));
  store.spaceStore.save({
    id: slug,
    title: 'Cold exact two-source refresh',
    dataSources: [
      {
        id: 'sheet_log',
        composioSlug: sheet.manifest.operationId,
        composioArgs: { spreadsheet_id: 'sheet-1', ranges: ['Log!A1:I500'] },
      },
      {
        id: 'slack_feed',
        composioSlug: slack.manifest.operationId,
        composioArgs: { channel: 'C-PLATFORM-49', limit: 50 },
      },
    ],
  });
  try {
    const result = await runner.refreshSpaceData(slug, undefined, { cause: 'manual' });
    assert.equal(result[0]?.ok, true, `sheet refresh refused: ${result[0]?.error ?? ''}`);
    assert.equal(result[1]?.ok, true, `slack refresh refused: ${result[1]?.error ?? ''}`);
    assert.deepEqual(result.map((row) => ({ sourceId: row.sourceId, ok: row.ok })), [
      { sourceId: 'sheet_log', ok: true },
      { sourceId: 'slack_feed', ok: true },
    ]);
    assert.deepEqual(preparedOperations.sort(), [
      'GOOGLESHEETS_BATCH_GET',
      'SLACK_FETCH_CONVERSATION_HISTORY',
    ]);
    assert.equal(bodies.get('GOOGLESHEETS_BATCH_GET'), 1);
    assert.equal(bodies.get('SLACK_FETCH_CONVERSATION_HISTORY'), 1);
  } finally {
    readAuthority._setExactSpaceReadCatalogPreparerForTests(null);
    store.spaceStore.archive(slug);
  }
});

test('bypassing the mint still gets the zero-body no-authority refusal', async () => {
  const slug = 'authority-bypass-refused';
  const capability = installReadCapability('SALESFORCE_GET_LEADS');
  store.spaceStore.save({
    id: slug,
    title: 'Bypass refused',
    dataSources: [{ id: 'leads', composioSlug: 'SALESFORCE_GET_LEADS' }],
  });
  try {
    const source = store.spaceStore.get(slug)!.dataSources[0]!;
    const direct = await runner.runSpaceDataSource(slug, source);
    assert.equal(direct.ok, false);
    assert.match(direct.ok ? '' : direct.error, /no shared durable call authority/i);
    assert.equal(direct.ok ? undefined : direct.provenNoDispatch, true);
    assert.equal(capability.portBodies(), 0, 'no provider body ran without an authority');
  } finally {
    store.spaceStore.archive(slug);
  }
});

test('a supplied authority that does not bind the declared operation still refuses', async () => {
  const slug = 'authority-mismatch-refused';
  const capability = installReadCapability('SALESFORCE_GET_ACCOUNTS');
  store.spaceStore.save({
    id: slug,
    title: 'Mismatch refused',
    dataSources: [{ id: 'accounts', composioSlug: 'SALESFORCE_GET_ACCOUNTS' }],
  });
  try {
    const source = store.spaceStore.get(slug)!.dataSources[0]!;
    const malformed = await runner.runSpaceDataSource(slug, source, {
      composioAuthority: {
        version: 1,
        kernel: 'workflow_v1_read_only',
        activationId: '   ',
        invocationPlan: { forged: true },
      },
    });
    assert.equal(malformed.ok, false);
    assert.match(malformed.ok ? '' : malformed.error, /authority address is malformed/i);

    const mismatched = await runner.runSpaceDataSource(slug, source, {
      composioAuthority: {
        version: 1,
        kernel: 'workflow_v1_read_only',
        activationId: 'activation-nonexistent',
        invocationPlan: { operation: 'SOMETHING_ELSE' },
      },
    });
    assert.equal(mismatched.ok, false);
    assert.match(
      mismatched.ok ? '' : mismatched.error,
      /does not bind this exact declared operation/i,
    );
    assert.equal(capability.portBodies(), 0, 'no provider body ran for refused authorities');
  } finally {
    store.spaceStore.archive(slug);
  }
});

test('composio Space ACTIONS keep the stricter demand: the read mint does not arm them', async () => {
  const slug = 'action-still-demands';
  const capability = installReadCapability('PROOF_SOCIAL_PUBLISH_READALIKE');
  store.spaceStore.save({
    id: slug,
    title: 'Action still demands',
    actions: [{
      id: 'publish',
      label: 'Publish',
      composioSlug: 'PROOF_SOCIAL_PUBLISH_READALIKE',
    }],
  });
  try {
    const action = store.spaceStore.get(slug)!.actions[0]!;
    const result = await runner.runSpaceAction(slug, action, {});
    assert.equal(result.ok, false);
    assert.match(
      result.ok ? '' : result.error,
      /no shared durable call authority|requires exact human approval/i,
    );
    assert.equal(capability.portBodies(), 0, 'actions never ride the read mint');
  } finally {
    store.spaceStore.archive(slug);
  }
});
