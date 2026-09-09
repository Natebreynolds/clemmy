import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-generic-verification-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-generic-verification\n', 'utf8');

const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const provisioning = await import('./proof-provisioned-catalog.js');
const production = await import('./production-capability-adapters.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const composio = await import('../../integrations/composio/client.js');
const semantics = await import('../../integrations/composio/operation-semantics.js');
const providerIdentity = await import('../../integrations/composio/provider-definition-identity.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');

const ACCOUNT = 'connection-generic-verification';
const UPDATE = 'GOOGLESHEETS_VALUES_UPDATE';
const READBACK = 'GOOGLESHEETS_BATCH_GET';

const PROVIDER_ENVELOPE = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['data', 'successful'],
  properties: {
    data: { type: 'object' },
    error: {},
    successful: { type: 'boolean' },
  },
});
const UPDATE_INPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['spreadsheet_id', 'range', 'values'],
  properties: {
    spreadsheet_id: { type: 'string' },
    range: { type: 'string' },
    values: { type: 'array', items: { type: 'array' } },
  },
});
const READBACK_INPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['spreadsheet_id'],
  properties: {
    spreadsheet_id: { type: 'string' },
    ranges: { type: 'array', items: { type: 'string' } },
  },
});

after(() => {
  schemas._setToolSchemaLoaderForTests(null);
  production.installProductionTransport(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  try { eventlog.closeEventLog(); } catch { /* already closed */ }
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function proofTurn() {
  const session = eventlog.createSession({ id: 'generic-verification-retention', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'update the existing sheet and verify the exact range' },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'capability_resolution',
    data: {
      sourceUserSeq: source.seq,
      authoritativeForTask: true,
      entries: [
        {
          intent: 'update the existing sheet',
          kind: 'composio',
          identifier: UPDATE,
          status: 'proven',
          connection: 'connected',
          accountIdentity: ACCOUNT,
          effectClass: 'write',
        },
        {
          intent: 'verify the exact range',
          kind: 'composio',
          identifier: READBACK,
          status: 'proven',
          connection: 'connected',
          accountIdentity: ACCOUNT,
          effectClass: 'read',
        },
      ],
    },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

test('generic proof replay preserves adapter-authored mutation and readback verification', async () => {
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: ACCOUNT,
    status: 'ACTIVE',
    user_id: 'selected-user',
    toolkit: { slug: 'googlesheets' },
  }]);
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  production.installProductionTransport(async () => ({}));
  schemas.resetToolSchemaCache();
  schemas._setToolSchemaLoaderForTests(async (identifier) => {
    if (identifier === UPDATE) {
      return {
        inputParameters: UPDATE_INPUT,
        outputParameters: PROVIDER_ENVELOPE,
        providerObservedAt: Date.now(),
        providerOperationVersion: '20260904_update',
      };
    }
    if (identifier === READBACK) {
      return {
        inputParameters: READBACK_INPUT,
        outputParameters: PROVIDER_ENVELOPE,
        providerObservedAt: Date.now(),
        providerOperationVersion: '20260904_readback',
      };
    }
    return null;
  });

  const updateContracts = semantics.validatedDocumentedComposioDefinitionContracts({
    operationId: UPDATE,
    inputSchema: UPDATE_INPUT,
    outputSchema: PROVIDER_ENVELOPE,
  });
  const readbackContracts = semantics.validatedDocumentedComposioDefinitionContracts({
    operationId: READBACK,
    inputSchema: READBACK_INPUT,
    outputSchema: PROVIDER_ENVELOPE,
  });
  assert.equal(updateContracts.ok, true);
  assert.equal(readbackContracts.ok, true);
  if (!updateContracts.ok || !readbackContracts.ok) throw new Error('fixture schemas drifted');

  const updatePort = `port:cap:resolved:${UPDATE.toLowerCase()}:${UPDATE}`;
  const readbackPort = `port:cap:resolved:${READBACK.toLowerCase()}:${READBACK}`;
  const updateFingerprint = providerIdentity.fingerprintComposioProviderDefinition({
    operationId: UPDATE,
    operationVersion: '20260904_update',
    accountId: ACCOUNT,
    invokePortId: updatePort,
    inputSchema: UPDATE_INPUT,
    outputSchema: PROVIDER_ENVELOPE,
  });
  const readbackFingerprint = providerIdentity.fingerprintComposioProviderDefinition({
    operationId: READBACK,
    operationVersion: '20260904_readback',
    accountId: ACCOUNT,
    invokePortId: readbackPort,
    inputSchema: READBACK_INPUT,
    outputSchema: PROVIDER_ENVELOPE,
  });
  assert.ok(updateFingerprint && readbackFingerprint);

  const identity = proofTurn();
  const selected = await provisioning.registerProofProvisionedCapabilities(identity, {
    allowedIdentifiers: [UPDATE, READBACK],
    selectedDefinitions: [
      {
        identifier: UPDATE,
        schemaDigest: digestSchema(UPDATE_INPUT),
        outputSchemaDigest: digestSchema(PROVIDER_ENVELOPE),
        accountIdentity: ACCOUNT,
        providerOperationVersion: '20260904_update',
        invokePortId: updatePort,
        definitionFingerprint: updateFingerprint!,
        verificationContract: updateContracts.verificationContract,
        operationSemantics: updateContracts.operationSemantics,
      },
      {
        identifier: READBACK,
        schemaDigest: digestSchema(READBACK_INPUT),
        outputSchemaDigest: digestSchema(PROVIDER_ENVELOPE),
        accountIdentity: ACCOUNT,
        providerOperationVersion: '20260904_readback',
        invokePortId: readbackPort,
        definitionFingerprint: readbackFingerprint!,
        verificationContract: readbackContracts.verificationContract,
        operationSemantics: readbackContracts.operationSemantics,
      },
    ],
  });
  assert.equal(selected.refusal, undefined, JSON.stringify(selected.refusal));

  const selectedUpdateId = catalogs.canonicalResolvedCapabilityId(UPDATE, ACCOUNT, 'composio');
  const selectedReadbackId = catalogs.canonicalResolvedCapabilityId(READBACK, ACCOUNT, 'composio');
  assert.equal(
    factory.get(selectedUpdateId)?.manifest?.externalDefinition?.behaviorHints.destructive,
    null,
    'fixture must retain the provider\'s unknown destructive hint',
  );
  assert.deepEqual(
    factory.get(selectedUpdateId)?.manifest?.externalDefinition?.verification,
    updateContracts.verificationContract,
  );
  assert.deepEqual(
    factory.get(selectedReadbackId)?.manifest?.externalDefinition?.verification,
    readbackContracts.verificationContract,
  );
  assert.deepEqual(factory.get(selectedUpdateId)?.manifest?.evidenceContract,
    { kinds: ['receipt', 'readback'], readbackRequired: true });
  assert.deepEqual(factory.get(selectedUpdateId)?.manifest?.readbackContract,
    { required: true, contentDigestRequired: true });

  // Whole-proof/JIT registration has no selected-definition row. It must
  // reconstruct the same reviewed contracts from the exact live schemas,
  // rather than minting verification-null successors for both operations.
  const generic = await provisioning.registerProofProvisionedCapabilities(identity);
  assert.equal(generic.refusal, undefined, JSON.stringify(generic.refusal));
  assert.equal(
    catalogs.canonicalResolvedCapabilityId(UPDATE, ACCOUNT, 'composio'),
    selectedUpdateId,
    'generic replay must not supersede the mutation with a metadata-empty definition',
  );
  assert.equal(
    catalogs.canonicalResolvedCapabilityId(READBACK, ACCOUNT, 'composio'),
    selectedReadbackId,
    'generic replay must not supersede the verifier with a metadata-empty definition',
  );
  assert.deepEqual(
    factory.get(selectedUpdateId)?.manifest?.externalDefinition?.verification,
    updateContracts.verificationContract,
  );
  assert.deepEqual(
    factory.get(selectedReadbackId)?.manifest?.externalDefinition?.verification,
    readbackContracts.verificationContract,
  );
  assert.deepEqual(factory.get(selectedUpdateId)?.manifest?.evidenceContract,
    { kinds: ['receipt', 'readback'], readbackRequired: true });
});

test('documented atomic content commits retain receipt and content-commit evidence', async () => {
  const operation = 'GOOGLESHEETS_SHEET_FROM_JSON';
  const schema = { type: 'object', required: ['sheet_name', 'sheet_json'], properties: {
    sheet_name: { type: 'string' }, sheet_json: { type: 'string' },
  } };
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  schemas._setToolSchemaLoaderForTests(async (identifier) => identifier === operation ? {
    inputParameters: schema, outputParameters: PROVIDER_ENVELOPE,
    providerObservedAt: Date.now(), providerOperationVersion: '20260905_atomic',
  } : null);
  const session = eventlog.createSession({ id: 'atomic-producer-evidence', kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Create the sheet with the supplied records.' } });
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'capability_resolution', data: {
    sourceUserSeq: source.seq, authoritativeForTask: true, entries: [{ intent: 'create the sheet', kind: 'composio',
      identifier: operation, status: 'proven', connection: 'active', accountIdentity: ACCOUNT, effectClass: 'write' }],
  } });
  const result = await provisioning.registerProofProvisionedCapabilities({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.equal(result.refusal, undefined, JSON.stringify(result));
  const entry = factory.get(catalogs.canonicalResolvedCapabilityId(operation, ACCOUNT, 'composio'));
  assert.ok(entry?.manifest?.operationSemantics?.atomicInputContent);
  assert.deepEqual(entry.manifest.evidenceContract, { kinds: ['receipt', 'content_commit'], readbackRequired: false });
});
