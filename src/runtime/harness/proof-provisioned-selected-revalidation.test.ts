import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { OperationVerificationContractV1 } from './mutation-verification-contract.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-selected-definition-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-selected-definition\n', 'utf8');

const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const observations = await import('./independent-capability-observation.js');
const provisioning = await import('./proof-provisioned-catalog.js');
const production = await import('./production-capability-adapters.js');
const typedRuntime = await import('../semantic-boundary/configure-typed-execution-runtime.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');
const composio = await import('../../integrations/composio/client.js');
const providerIdentity = await import('../../integrations/composio/provider-definition-identity.js');
const selectedDefinitions = await import('../../integrations/composio/selected-definition-revalidation.js');

const CONNECTION_ID = 'connection-mega-selected';
const SELECTED_A = 'MEGA_SELECTED_SOURCE';
const SELECTED_B = 'MEGA_SELECTED_DESTINATION';
const UNSELECTED = 'MEGA_UNSELECTED_OPERATION';
const STALE_SELECTED = 'MEGA_STALE_SELECTED';
const SCHEMA_A = {
  type: 'object',
  required: ['query'],
  properties: { query: { type: 'string' } },
};
const SCHEMA_B = {
  type: 'object',
  required: ['rows'],
  properties: { rows: { type: 'array' } },
};
const DRIFTED_B = {
  type: 'object',
  required: ['records'],
  properties: { records: { type: 'array' } },
};
const OUTPUT_A = {
  type: 'object',
  properties: { rows: { type: 'array' } },
};
const OUTPUT_B = {
  type: 'object',
  properties: { records: { type: 'array' } },
};

/**
 * Local copies of the retired Sheets declarations. They describe the raw
 * Google API shape, not the Composio wrapper observed in production. Keeping
 * them test-local lets this suite prove that neither selected-definition
 * revalidation nor durable replay can turn a stale caller-supplied contract
 * into current adapter authority.
 */
const RETIRED_CREATE_VERIFICATION = {
  mutation: {
    version: 1,
    resourceFamily: 'googlesheets',
    producedHandleKind: 'created_resource',
    proof: 'resource_identity_v1',
    target: {
      source: 'authoritative_result',
      pointers: ['/spreadsheetId'],
    },
  },
} as const satisfies OperationVerificationContractV1;

const RETIRED_READBACK_VERIFICATION = {
  readback: {
    version: 1,
    resourceFamily: 'googlesheets',
    acceptedHandleKind: 'created_resource',
    requestTargetPointers: ['/spreadsheetId'],
    responseTargetPointers: ['/spreadsheetId'],
  },
} as const satisfies OperationVerificationContractV1;

function proofTurn(
  id: string,
  identifiers: readonly string[],
  accountIdentity = CONNECTION_ID,
  effectClassFor: (identifier: string) => 'read' | 'write' = (identifier) => (
    identifier === SELECTED_B ? 'write' : 'read'
  ),
) {
  const session = eventlog.createSession({ id, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'selected definition revalidation proof' },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'capability_resolution',
    data: {
      sourceUserSeq: source.seq,
      authoritativeForTask: true,
      entries: identifiers.map((identifier) => ({
        intent: identifier,
        kind: 'composio',
        identifier,
        status: 'proven',
        connection: 'connected',
        accountIdentity,
        effectClass: effectClassFor(identifier),
      })),
    },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

test('retired adapter contracts cannot publish a mutation or host-derived verifier', async () => {
  const create = 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1';
  const readback = 'GOOGLESHEETS_BATCH_GET';
  const createInput = {
    type: 'object',
    required: ['title'],
    properties: { title: { type: 'string' } },
  };
  const createOutput = {
    type: 'object',
    required: ['spreadsheetId'],
    properties: { spreadsheetId: { type: 'string' } },
  };
  const readbackInput = {
    type: 'object',
    required: ['spreadsheetId'],
    properties: {
      spreadsheetId: { type: 'string' },
      ranges: { type: 'array', items: { type: 'string' } },
    },
  };
  const readbackOutput = {
    type: 'object',
    required: ['spreadsheetId', 'valueRanges'],
    properties: {
      spreadsheetId: { type: 'string' },
      valueRanges: { type: 'array' },
    },
  };
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: CONNECTION_ID,
    status: 'ACTIVE',
    user_id: 'selected-user',
    toolkit: { slug: 'googlesheets' },
  }]);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  let businessCalls = 0;
  production.installProductionTransport(async () => {
    businessCalls += 1;
    return {};
  });
  schemas.resetToolSchemaCache();
  schemas._setToolSchemaLoaderForTests(async (identifier) => {
    if (identifier === create) {
      return {
        inputParameters: createInput,
        outputParameters: createOutput,
        providerObservedAt: Date.now(),
        providerOperationVersion: '20260827_create',
      };
    }
    if (identifier === readback) {
      return {
        inputParameters: readbackInput,
        outputParameters: readbackOutput,
        providerObservedAt: Date.now(),
        providerOperationVersion: '20260827_readback',
      };
    }
    return null;
  });

  const result = await provisioning.registerProofProvisionedCapabilities(
    proofTurn(
      'exact-host-derived-verifier-publication',
      [create],
      CONNECTION_ID,
      () => 'write',
    ),
    {
      allowedIdentifiers: [create, readback],
      hostDerivedVerificationIdentifiers: [readback],
      selectedDefinitions: [
        {
          identifier: create,
          schemaDigest: digestSchema(createInput),
          outputSchemaDigest: digestSchema(createOutput),
          accountIdentity: CONNECTION_ID,
          verificationContract: RETIRED_CREATE_VERIFICATION,
        },
        {
          identifier: readback,
          schemaDigest: digestSchema(readbackInput),
          outputSchemaDigest: digestSchema(readbackOutput),
          accountIdentity: CONNECTION_ID,
          verificationContract: RETIRED_READBACK_VERIFICATION,
        },
      ],
    },
  );

  assert.deepEqual(result.refusal, {
    code: 'selected_definition_semantic_contract_drift',
    identifier: create,
  });
  assert.deepEqual(result.registered, []);
  assert.equal(factory.get(`cap:resolved:${create.toLowerCase()}`), undefined);
  assert.equal(factory.get(`cap:resolved:${readback.toLowerCase()}`), undefined);
  assert.equal(businessCalls, 0, 'publication revalidates metadata but never dispatches provider work');
});

test('a fully bound opaque operation preserves generic reversible semantics across exact refresh', async () => {
  const identifier = 'MEGA_OPAQUE_FORGE';
  const operationVersion = '20260827_opaque';
  const invokePortId = `port:cap:resolved:${identifier.toLowerCase()}:${identifier}`;
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: CONNECTION_ID,
    status: 'ACTIVE',
    user_id: 'selected-user',
    toolkit: { slug: 'mega' },
  }]);
  schemas.resetToolSchemaCache();
  schemas._setToolSchemaLoaderForTests(async (operationId) => operationId === identifier
    ? {
        inputParameters: SCHEMA_B,
        outputParameters: OUTPUT_B,
        providerObservedAt: Date.now(),
        providerOperationVersion: operationVersion,
      }
    : null);
  const definitionFingerprint = providerIdentity.fingerprintComposioProviderDefinition({
    operationId: identifier,
    operationVersion,
    accountId: CONNECTION_ID,
    invokePortId,
    inputSchema: SCHEMA_B,
    outputSchema: OUTPUT_B,
  });
  assert.ok(definitionFingerprint);
  const operationSemantics = { version: 1, reversibility: 'reversible' } as const;
  const result = await selectedDefinitions.revalidateSelectedComposioDefinitions([{
    identifier,
    schemaDigest: digestSchema(SCHEMA_B),
    accountIdentity: CONNECTION_ID,
    definitionFingerprint: definitionFingerprint!,
    outputSchemaDigest: digestSchema(OUTPUT_B),
    providerOperationVersion: operationVersion,
    invokePortId,
    operationSemantics,
  }]);
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.refusal));
  if (result.ok) {
    assert.deepEqual(result.definitions.get(identifier.toLowerCase())?.operationSemantics, operationSemantics);
  }
});

test('historical disclosure cannot inject retired mutation or verifier semantics', async () => {
  const create = 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1';
  const readback = 'GOOGLESHEETS_BATCH_GET';
  const generic = 'GOOGLESHEETS_ZZZ_LEGACY_NON_VERIFICATION_READ';
  const fillers = Array.from({ length: 8 }, (_, index) =>
    `GOOGLESHEETS_AAA_LEGACY_CARD_FILLER_${String(index + 1).padStart(2, '0')}`);
  const createInput = {
    type: 'object',
    required: ['title'],
    properties: { title: { type: 'string' } },
  };
  const createOutput = {
    type: 'object',
    required: ['spreadsheetId'],
    properties: { spreadsheetId: { type: 'string' } },
  };
  const readbackInput = {
    type: 'object',
    required: ['spreadsheetId'],
    properties: {
      spreadsheetId: { type: 'string' },
      ranges: { type: 'array', items: { type: 'string' } },
    },
  };
  const readbackOutput = {
    type: 'object',
    required: ['spreadsheetId', 'valueRanges'],
    properties: {
      spreadsheetId: { type: 'string' },
      valueRanges: { type: 'array' },
    },
  };
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: CONNECTION_ID,
    status: 'ACTIVE',
    user_id: 'selected-user',
    toolkit: { slug: 'googlesheets' },
  }]);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  let businessCalls = 0;
  production.installProductionTransport(async () => {
    businessCalls += 1;
    return {};
  });
  schemas.resetToolSchemaCache();
  schemas._setToolSchemaLoaderForTests(async (identifier) => {
    if (identifier === create) {
      return {
        inputParameters: createInput,
        outputParameters: createOutput,
        providerObservedAt: Date.now(),
        providerOperationVersion: '20260827_create',
      };
    }
    if (identifier === readback) {
      return {
        inputParameters: readbackInput,
        outputParameters: readbackOutput,
        providerObservedAt: Date.now(),
        providerOperationVersion: '20260827_readback',
      };
    }
    if (identifier === generic || fillers.includes(identifier)) {
      return {
        inputParameters: SCHEMA_A,
        outputParameters: OUTPUT_A,
        providerObservedAt: Date.now(),
        providerOperationVersion: '20260827_legacy_generic',
      };
    }
    return null;
  });

  const genericIdentifiers = [...fillers, generic];
  const genericSeed = await provisioning.registerProofProvisionedCapabilities(
    proofTurn('legacy-semantic-generic-seed', genericIdentifiers, CONNECTION_ID, () => 'read'),
    {
      allowedIdentifiers: genericIdentifiers,
      expectedSchemaDigests: genericIdentifiers.map((identifier) => ({
        identifier,
        schemaDigest: digestSchema(SCHEMA_A),
      })),
    },
  );
  assert.equal(genericSeed.refusal, undefined, JSON.stringify(genericSeed.refusal));

  const retiredOperationSeed = await provisioning.registerProofProvisionedCapabilities(
    proofTurn(
      'legacy-semantic-retired-operation-seed',
      [create, readback],
      CONNECTION_ID,
      (identifier) => identifier === create ? 'write' : 'read',
    ),
    {
      allowedIdentifiers: [create, readback],
      expectedSchemaDigests: [
        {
          identifier: create,
          schemaDigest: digestSchema(createInput),
        },
        {
          identifier: readback,
          schemaDigest: digestSchema(readbackInput),
        },
      ],
    },
  );
  assert.equal(
    retiredOperationSeed.refusal,
    undefined,
    JSON.stringify(retiredOperationSeed.refusal),
  );

  const replaySession = eventlog.createSession({
    id: 'legacy-semantic-contract-replay',
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: replaySession.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'quux wibble frobnicator' },
  });
  const initial = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: replaySession.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(initial.ok, true, initial.ok ? '' : initial.reason);
  if (!initial.ok) throw new Error(initial.reason);
  const currentByIdentifier = new Map([create, readback, generic].map((identifier) => {
    const entry = factory.snapshot().find((candidate) =>
      candidate.manifest?.operationId === identifier);
    assert.ok(entry, `seeded current definition is live for ${identifier}`);
    const descriptor = semantic.hostDescriptorFromRegistered(entry!);
    assert.ok(descriptor, `seeded current definition has a descriptor for ${identifier}`);
    return [identifier, { entry: entry!, descriptor: descriptor! }] as const;
  }));
  const legacyRows = [create, readback, generic].map((identifier) => {
    const current = currentByIdentifier.get(identifier)!;
    const manifest = current.entry.manifest;
    assert.ok(manifest?.externalDefinition, `seeded definition is external for ${identifier}`);
    return {
      kind: 'composio',
      providerKind: 'composio',
      identifier,
      effectClass: identifier === create ? 'write' : 'read',
      capabilityRef: current.descriptor.id,
      manifestDigest: current.descriptor.manifestDigest,
      accountIdentity: CONNECTION_ID,
      descriptor: current.descriptor,
      ...(identifier === generic
        ? {
            // A genuine legacy row binds only the provider input digest. It is
            // compatible solely because the current definition also carries
            // no verification semantics.
            schemaFingerprint: current.entry.providerInputSchemaDigest,
          }
        : {
            // Historical state may contain a structurally valid contract, but
            // it cannot inject that contract into the current adapter row.
            providerDefinition: {
              version: 1,
              providerInputSchemaDigest:
                manifest!.externalDefinition!.providerInputSchemaDigest,
              definitionFingerprint: manifest!.definitionFingerprint,
              providerOperationVersion: manifest!.operationVersion,
              providerOutputSchemaDigest:
                manifest!.externalDefinition!.providerOutputSchemaDigest ?? null,
              invokePortId: manifest!.invokePortId,
              verificationContract: identifier === create
                ? RETIRED_CREATE_VERIFICATION
                : RETIRED_READBACK_VERIFICATION,
            },
          }),
    };
  });
  eventlog.appendEvent({
    sessionId: replaySession.id,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: { sourceUserSeq: source.seq, capabilities: legacyRows },
  });

  const replayed = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: replaySession.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(replayed.ok, true, replayed.ok ? '' : replayed.reason);
  if (!replayed.ok) throw new Error(replayed.reason);
  assert.deepEqual(
    replayed.planning.capabilities,
    initial.planning.capabilities,
    'a later disclosure cannot rewrite the immutable initial planning card',
  );
  const staged = new Set(semantic.snapshotPrimaryModelSelectedStagedPlanningDescriptors({
    authority: replayed.planning.authority,
    identity: replayed.planning.identity,
    selectedRefs: new Set(
      [...currentByIdentifier.values()].map((current) => current.descriptor.id),
    ),
  }).map((descriptor) => descriptor.id));
  assert.equal(staged.has(currentByIdentifier.get(create)!.descriptor.id), false,
    'a historical row cannot inject a retired mutation verification declaration');
  assert.equal(staged.has(currentByIdentifier.get(readback)!.descriptor.id), false,
    'a historical row cannot inject a retired readback verification declaration');
  assert.equal(staged.has(currentByIdentifier.get(generic)!.descriptor.id), true,
    'a legacy row for a still-current non-verification operation remains staged for exact selection');
  assert.equal(businessCalls, 0, 'replay and catalog priming perform no business provider I/O');
});

after(() => {
  schemas._setToolSchemaLoaderForTests(null);
  schemas.resetToolSchemaCache();
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  production.installProductionTransport(null);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('only selected refs receive one exact refresh before all-or-nothing publication', async () => {
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: CONNECTION_ID,
    status: 'ACTIVE',
    user_id: 'selected-user',
    toolkit: { slug: 'mega' },
  }]);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  let businessCalls = 0;
  production.installProductionTransport(async () => {
    businessCalls += 1;
    return {};
  });
  const exactReads: string[] = [];
  schemas._setToolSchemaLoaderForTests(async (identifier) => {
    exactReads.push(identifier);
    const inputParameters = identifier === SELECTED_A
      ? SCHEMA_A
      : identifier === SELECTED_B
        ? SCHEMA_B
        : null;
    return inputParameters
      ? {
          inputParameters,
          outputParameters: null,
          providerObservedAt: Date.now(),
          providerOperationVersion: '20260824_01',
        }
      : null;
  });

  const result = await provisioning.registerProofProvisionedCapabilities(
    proofTurn('selected-definition-match', [SELECTED_A, UNSELECTED]),
    {
      allowedIdentifiers: [SELECTED_A],
      expectedSchemaDigests: [{ identifier: SELECTED_A, schemaDigest: digestSchema(SCHEMA_A) }],
    },
  );

  assert.equal(result.refusal, undefined);
  assert.deepEqual(exactReads, [SELECTED_A]);
  assert.ok(factory.get(`cap:resolved:${SELECTED_A.toLowerCase()}`));
  assert.equal(factory.get(`cap:resolved:${UNSELECTED.toLowerCase()}`), undefined);
  assert.equal(businessCalls, 0, 'metadata proof never invokes the selected business operation');

  const initialTransform = observations.independentlyObserveCapability(
    'host_transform',
    'host:runtime',
  );
  assert.ok(initialTransform);
  const realDateNow = Date.now;
  const afterFreshnessWindow = realDateNow()
    + observations.INDEPENDENT_OBSERVATION_FRESHNESS_MS
    + 1;
  Date.now = () => afterFreshnessWindow;
  try {
    const refreshedTransform = observations.independentlyObserveCapability(
      'host_transform',
      'host:runtime',
    );
    assert.ok(refreshedTransform);
    assert.equal(refreshedTransform.observedAt, afterFreshnessWindow,
      'the shipped host-local observer reads a fresh instant, not its registration time');
    assert.equal(observations.observationIsFresh(refreshedTransform), true,
      'the deterministic host transform remains current in a long-lived process');
    typedRuntime.refreshTypedExecutionReadiness();
    assert.ok(factory.get('cap:resolved:host_transform'), JSON.stringify(
      typedRuntime.typedExecutionCatalogRefusals()
        .filter((entry) => entry.manifestId === 'cap:resolved:host_transform'),
    ));
  } finally {
    Date.now = realDateNow;
  }
});

test('the full 8/9/32-operation plan set revalidates with bounded concurrency', async (t) => {
  for (const count of [8, 9, 32]) {
    await t.test(`${count} selected definitions`, async () => {
      const identifiers = Array.from(
        { length: count },
        (_, index) => `MEGA_SCALE_${String(index + 1).padStart(2, '0')}`,
      );
      composio.__test__.setConnectedAccountsLoader(async () => [{
        id: CONNECTION_ID,
        status: 'ACTIVE',
        user_id: 'selected-user',
        toolkit: { slug: 'mega' },
      }]);
      const factory = catalogs.createHostCapabilityCatalogFactory();
      catalogs.installHostCapabilityCatalogFactory(factory);
      let businessCalls = 0;
      production.installProductionTransport(async () => {
        businessCalls += 1;
        return {};
      });
      schemas.resetToolSchemaCache();
      let exactReads = 0;
      let activeReads = 0;
      let maxActiveReads = 0;
      schemas._setToolSchemaLoaderForTests(async () => {
        exactReads += 1;
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeReads -= 1;
        return {
          inputParameters: SCHEMA_A,
          outputParameters: null,
          providerObservedAt: Date.now(),
          providerOperationVersion: '20260824_scale',
        };
      });

      const result = await provisioning.registerProofProvisionedCapabilities(
        proofTurn(`selected-definition-scale-${count}`, identifiers),
        {
          allowedIdentifiers: identifiers,
          expectedSchemaDigests: identifiers.map((identifier) => ({
            identifier,
            schemaDigest: digestSchema(SCHEMA_A),
          })),
        },
      );

      assert.equal(result.refusal, undefined, JSON.stringify(result.refusal));
      assert.equal(exactReads, count);
      assert.equal(businessCalls, 0);
      assert.ok(maxActiveReads <= 4, `provider metadata concurrency was ${maxActiveReads}`);
      if (count > 1) assert.ok(maxActiveReads > 1, 'independent selected definitions revalidate concurrently');
      for (const identifier of identifiers) {
        assert.ok(factory.get(`cap:resolved:${identifier.toLowerCase()}`), identifier);
      }
    });
  }
});

test('a second-batch definition failure publishes none of a nine-operation plan', async () => {
  const identifiers = Array.from(
    { length: 9 },
    (_, index) => `MEGA_BATCH_${String(index + 1).padStart(2, '0')}`,
  );
  const failedIdentifier = identifiers[5]!;
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: CONNECTION_ID,
    status: 'ACTIVE',
    user_id: 'selected-user',
    toolkit: { slug: 'mega' },
  }]);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  let businessCalls = 0;
  production.installProductionTransport(async () => {
    businessCalls += 1;
    return {};
  });
  schemas.resetToolSchemaCache();
  const exactReads: string[] = [];
  schemas._setToolSchemaLoaderForTests(async (identifier) => {
    exactReads.push(identifier);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (identifier === failedIdentifier) return null;
    return {
      inputParameters: SCHEMA_A,
      outputParameters: null,
      providerObservedAt: Date.now(),
      providerOperationVersion: '20260824_batch',
    };
  });

  const result = await provisioning.registerProofProvisionedCapabilities(
    proofTurn('selected-definition-second-batch-failure', identifiers),
    {
      allowedIdentifiers: identifiers,
      expectedSchemaDigests: identifiers.map((identifier) => ({
        identifier,
        schemaDigest: digestSchema(SCHEMA_A),
      })),
    },
  );

  assert.deepEqual(result, {
    registered: [],
    refusal: {
      code: 'selected_definition_exact_refresh_unavailable',
      identifier: failedIdentifier,
    },
  });
  assert.deepEqual(new Set(exactReads), new Set(identifiers.slice(0, 8)),
    'the failed second batch completes, but the third batch never starts');
  assert.deepEqual(factory.snapshot(), [], 'no earlier matching definition is published');
  assert.equal(businessCalls, 0);
});

test('a later selected schema drift refuses before any selected capability is published', async () => {
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: CONNECTION_ID,
    status: 'ACTIVE',
    user_id: 'selected-user',
    toolkit: { slug: 'mega' },
  }]);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  schemas.resetToolSchemaCache();
  const exactReads: string[] = [];
  schemas._setToolSchemaLoaderForTests(async (identifier) => {
    exactReads.push(identifier);
    return {
      inputParameters: identifier === SELECTED_A ? SCHEMA_A : DRIFTED_B,
      outputParameters: null,
      providerObservedAt: Date.now(),
      providerOperationVersion: '20260824_01',
    };
  });

  const result = await provisioning.registerProofProvisionedCapabilities(
    proofTurn('selected-definition-drift', [SELECTED_A, SELECTED_B]),
    {
      allowedIdentifiers: [SELECTED_A, SELECTED_B],
      expectedSchemaDigests: [
        { identifier: SELECTED_A, schemaDigest: digestSchema(SCHEMA_A) },
        { identifier: SELECTED_B, schemaDigest: digestSchema(SCHEMA_B) },
      ],
    },
  );

  assert.deepEqual(exactReads, [SELECTED_A, SELECTED_B]);
  assert.deepEqual(result, {
    registered: [],
    refusal: { code: 'selected_definition_schema_drift', identifier: SELECTED_B },
  });
  assert.deepEqual(factory.snapshot(), [], 'phase one cannot partially publish a prior matching ref');
});

test('selected provider output, version, full fingerprint, and invoke port drift fail exact', async (t) => {
  const liveOperationVersion = '20260824_02';
  const canonicalInvokePort = `port:cap:resolved:${SELECTED_A.toLowerCase()}:${SELECTED_A}`;
  const canonicalFingerprint = providerIdentity.fingerprintComposioProviderDefinition({
    operationId: SELECTED_A,
    operationVersion: liveOperationVersion,
    accountId: CONNECTION_ID,
    invokePortId: canonicalInvokePort,
    inputSchema: SCHEMA_A,
    outputSchema: OUTPUT_A,
  });
  assert.ok(canonicalFingerprint);
  const cases = [
    {
      label: 'provider output schema',
      selection: {
        outputSchemaDigest: digestSchema(OUTPUT_B),
        providerOperationVersion: liveOperationVersion,
        invokePortId: canonicalInvokePort,
        definitionFingerprint: canonicalFingerprint,
      },
      code: 'selected_definition_output_schema_drift',
    },
    {
      label: 'provider operation version',
      selection: {
        outputSchemaDigest: digestSchema(OUTPUT_A),
        providerOperationVersion: '20260824_01',
        invokePortId: canonicalInvokePort,
        definitionFingerprint: canonicalFingerprint,
      },
      code: 'selected_definition_operation_version_drift',
    },
    {
      label: 'full definition fingerprint',
      selection: {
        outputSchemaDigest: digestSchema(OUTPUT_A),
        providerOperationVersion: liveOperationVersion,
        invokePortId: canonicalInvokePort,
        definitionFingerprint: 'a'.repeat(64),
      },
      code: 'selected_definition_fingerprint_drift',
    },
    {
      label: 'invoke port identity',
      selection: {
        outputSchemaDigest: digestSchema(OUTPUT_A),
        providerOperationVersion: liveOperationVersion,
        invokePortId: `${canonicalInvokePort}:changed`,
        definitionFingerprint: canonicalFingerprint,
      },
      code: 'selected_definition_fingerprint_drift',
    },
  ] as const;

  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.label, async () => {
      composio.__test__.setConnectedAccountsLoader(async () => [{
        id: CONNECTION_ID,
        status: 'ACTIVE',
        user_id: 'selected-user',
        toolkit: { slug: 'mega' },
      }]);
      const factory = catalogs.createHostCapabilityCatalogFactory();
      catalogs.installHostCapabilityCatalogFactory(factory);
      schemas.resetToolSchemaCache();
      let exactReads = 0;
      schemas._setToolSchemaLoaderForTests(async () => {
        exactReads += 1;
        return {
          inputParameters: SCHEMA_A,
          outputParameters: OUTPUT_A,
          providerObservedAt: Date.now(),
          providerOperationVersion: liveOperationVersion,
        };
      });

      const result = await provisioning.registerProofProvisionedCapabilities(
        proofTurn(`selected-definition-field-drift-${index}`, [SELECTED_A]),
        {
          allowedIdentifiers: [SELECTED_A],
          selectedDefinitions: [{
            identifier: SELECTED_A,
            schemaDigest: digestSchema(SCHEMA_A),
            accountIdentity: CONNECTION_ID,
            ...fixture.selection,
          }],
        },
      );
      assert.deepEqual(result, {
        registered: [],
        refusal: { code: fixture.code, identifier: SELECTED_A },
      });
      assert.equal(exactReads, 1);
      assert.deepEqual(factory.snapshot(), []);
    });
  }
});

test('legacy disclosure from account A cannot replay against a current account B definition', async () => {
  const currentAccount = 'connection-account-b';
  const staleAccount = 'connection-account-a';
  const identifiers = [
    ...Array.from({ length: 7 }, (_, index) => `MEGA_A${index}_ACCOUNT_PADDING`),
    'MEGA_ZZZ_ACCOUNT_TARGET',
  ];
  const target = identifiers.at(-1)!;
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: currentAccount,
    status: 'ACTIVE',
    user_id: 'selected-user',
    toolkit: { slug: 'mega' },
  }]);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  schemas.resetToolSchemaCache();
  schemas._setToolSchemaLoaderForTests(async () => ({
    inputParameters: SCHEMA_A,
    outputParameters: null,
    providerObservedAt: Date.now(),
    providerOperationVersion: '20260824_account_b',
  }));
  const currentTurn = proofTurn('legacy-account-current-catalog', identifiers, currentAccount);
  const published = await provisioning.registerProofProvisionedCapabilities(currentTurn, {
    allowedIdentifiers: identifiers,
    expectedSchemaDigests: identifiers.map((identifier) => ({
      identifier,
      schemaDigest: digestSchema(SCHEMA_A),
    })),
  });
  assert.equal(published.refusal, undefined, JSON.stringify(published.refusal));
  const targetEntry = factory.get(`cap:resolved:${target.toLowerCase()}`);
  assert.ok(targetEntry);
  const targetDescriptor = semantic.hostDescriptorFromRegistered(targetEntry!);
  assert.ok(targetDescriptor);

  const replaySession = eventlog.createSession({
    id: 'legacy-account-a-to-b-replay',
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: replaySession.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'quux wibble frobnicator' },
  });
  const initial = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: replaySession.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(initial.ok, true, initial.ok ? '' : initial.reason);
  if (!initial.ok) throw new Error(initial.reason);
  eventlog.appendEvent({
    sessionId: replaySession.id,
    turn: 1,
    role: 'system',
    type: 'capability_discovered',
    data: {
      sourceUserSeq: source.seq,
      capabilities: [{
        kind: 'composio',
        providerKind: 'composio',
        identifier: target,
        effectClass: 'read',
        capabilityRef: targetDescriptor!.id,
        manifestDigest: targetDescriptor!.manifestDigest,
        accountIdentity: staleAccount,
        descriptor: { ...targetDescriptor!, accountScope: staleAccount },
        schemaFingerprint: digestSchema(SCHEMA_A),
      }],
    },
  });

  const replayed = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: replaySession.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(replayed.ok, true, replayed.ok ? '' : replayed.reason);
  if (!replayed.ok) throw new Error(replayed.reason);
  assert.deepEqual(
    replayed.planning.capabilities,
    initial.planning.capabilities,
    'a later disclosure cannot rewrite the immutable initial planning card',
  );
  const staged = semantic.snapshotPrimaryModelSelectedStagedPlanningDescriptors({
    authority: replayed.planning.authority,
    identity: replayed.planning.identity,
    selectedRefs: new Set([targetDescriptor!.id]),
  });
  assert.equal(staged.some((descriptor) => descriptor.id === targetDescriptor!.id), false,
    'the legacy input digest cannot upgrade across an account-identity change',
  );
});

test('invalid disclosure digests and removed exact slugs refuse before publication', async () => {
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: CONNECTION_ID,
    status: 'ACTIVE',
    user_id: 'selected-user',
    toolkit: { slug: 'mega' },
  }]);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  schemas.resetToolSchemaCache();
  let exactReads = 0;
  schemas._setToolSchemaLoaderForTests(async () => {
    exactReads += 1;
    return null;
  });
  const turn = proofTurn('selected-definition-missing', [SELECTED_A]);

  const invalid = await provisioning.registerProofProvisionedCapabilities(turn, {
    allowedIdentifiers: [SELECTED_A],
    expectedSchemaDigests: [{ identifier: SELECTED_A, schemaDigest: 'not-a-digest' }],
  });
  assert.deepEqual(invalid.refusal, {
    code: 'selected_definition_digest_invalid',
    identifier: SELECTED_A.toLowerCase(),
  });
  assert.equal(exactReads, 0, 'invalid staged authority is rejected before provider metadata I/O');

  composio.__test__.setConnectedAccountsLoader(async () => []);
  const disconnected = await provisioning.registerProofProvisionedCapabilities(turn, {
    allowedIdentifiers: [SELECTED_A],
    expectedSchemaDigests: [{ identifier: SELECTED_A, schemaDigest: digestSchema(SCHEMA_A) }],
  });
  assert.deepEqual(disconnected.refusal, {
    code: 'selected_connection_missing_or_changed',
    identifier: SELECTED_A,
  });
  assert.equal(exactReads, 0, 'a removed selected account refuses before schema or business I/O');

  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: CONNECTION_ID,
    status: 'ACTIVE',
    user_id: 'selected-user',
    toolkit: { slug: 'mega' },
  }]);
  const missing = await provisioning.registerProofProvisionedCapabilities(turn, {
    allowedIdentifiers: [SELECTED_A],
    expectedSchemaDigests: [{ identifier: SELECTED_A, schemaDigest: digestSchema(SCHEMA_A) }],
  });
  assert.deepEqual(missing.refusal, {
    code: 'selected_definition_exact_refresh_unavailable',
    identifier: SELECTED_A,
  });
  assert.equal(exactReads, 1);
  assert.deepEqual(factory.snapshot(), []);
});

test('a stale pre-existing global catalog entry cannot bypass selected revalidation', async () => {
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: CONNECTION_ID,
    status: 'ACTIVE',
    user_id: 'selected-user',
    toolkit: { slug: 'mega' },
  }]);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  schemas.resetToolSchemaCache();
  let currentSchema = SCHEMA_A;
  let exactReads = 0;
  schemas._setToolSchemaLoaderForTests(async () => {
    exactReads += 1;
    return {
      inputParameters: currentSchema,
      outputParameters: null,
      providerObservedAt: Date.now(),
      providerOperationVersion: '20260824_01',
    };
  });
  const turn = proofTurn('selected-definition-stale-global', [STALE_SELECTED]);
  const options = {
    allowedIdentifiers: [STALE_SELECTED],
    expectedSchemaDigests: [{ identifier: STALE_SELECTED, schemaDigest: digestSchema(SCHEMA_A) }],
  };

  const seeded = await provisioning.registerProofProvisionedCapabilities(turn, options);
  assert.equal(seeded.refusal, undefined);
  assert.ok(factory.get(`cap:resolved:${STALE_SELECTED.toLowerCase()}`));

  await new Promise<void>((resolve) => setTimeout(resolve, 2));
  currentSchema = DRIFTED_B;
  const refused = await provisioning.registerProofProvisionedCapabilities(turn, {
    // The operation is already present in the global catalog/initial model
    // card. Nothing is staged for publication on this source, but the selected
    // initial ref must still pay the same provider proof.
    allowedIdentifiers: [],
    selectedDefinitions: [{
      identifier: STALE_SELECTED,
      schemaDigest: digestSchema(SCHEMA_A),
      accountIdentity: CONNECTION_ID,
    }],
  });
  assert.deepEqual(refused.refusal, {
    code: 'selected_definition_schema_drift',
    identifier: STALE_SELECTED,
  });
  assert.equal(exactReads, 2, 'factory.get cannot suppress the final exact provider read');
  assert.ok(factory.get(`cap:resolved:${STALE_SELECTED.toLowerCase()}`),
    'the stale global entry may remain installed, but the typed caller must abort before freeze');
});
