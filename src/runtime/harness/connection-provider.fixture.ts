/** Recording provider for connection continuation tests. Imported only after
 * the test home is selected. No network, credentials or business account. */
import assert from 'node:assert/strict';
import * as client from '../../integrations/composio/client.js';
import * as schemas from '../../tools/composio-schema-cache.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import { COMPOSIO_PROVIDER_SURFACE_VERSION, fingerprintComposioProviderDefinition } from '../../integrations/composio/provider-definition-identity.js';
import { attachSemanticContract } from './capability-manifest.js';
import { createCapabilityManifestStore, installCapabilityManifestStore } from './capability-manifest-store.js';
import { peekHostCapabilityCatalogFactory } from './host-capability-catalog-factory.js';
import { registeredCapabilityFromManifest } from './production-capability-adapter.js';
import { registerIndependentCapabilityObservation, clearIndependentCapabilityObservations } from './independent-capability-observation.js';
import { registerFixtureCapabilityPort, productionPortIdentityFromManifest, clearProductionCapabilityPorts } from './production-capability-ports.js';
import { installProductionTransport } from './production-capability-adapters.js';
import { buildComposioAttestedTransport } from './composio-attested-transport.js';

export async function installConnectionProviderFixture() {
  const operation = 'FIXTURECRM_READ';
  const capability = 'cap:resolved:fixturecrm_read';
  const account = 'fixture-server-returned-account';
  const invokePortId = `port:${capability}:${operation}`;
  const schema = { type: 'object', additionalProperties: false, required: ['recordId'],
    properties: { recordId: { type: 'string' } } };
  const outputSchema = { type: 'object', properties: { status: { type: 'string' } } };
  let active = true;
  let operationVersion = '1';
  let currentSchema: Record<string, unknown> = schema;
  let beforeSchema: (() => void) | undefined;
  const counts = { accountChecks: 0, schemaChecks: 0, businessCalls: 0 };
  client.__test__.setComposioApiKeyOverride('connection-fixture-key');
  client.__test__.setConnectedAccountsLoader(async () => {
    counts.accountChecks += 1;
    return [{ id: account, status: active ? 'ACTIVE' : 'INACTIVE', user_id: 'fixture-owner',
      toolkit: { slug: 'fixturecrm' }, account_email: 'owner@example.invalid' }];
  });
  await client.listConnectedToolkits({ requireFresh: true });
  schemas.rememberToolSchema(operation, schema, Date.now(), '1', outputSchema);
  schemas._setToolSchemaLoaderForTests(async identifier => {
    assert.equal(identifier, operation);
    counts.schemaChecks += 1;
    beforeSchema?.();
    return { inputParameters: currentSchema, outputParameters: outputSchema,
      providerObservedAt: Date.now(), providerOperationVersion: operationVersion };
  });
  const definitionFingerprint = fingerprintComposioProviderDefinition({ operationId: operation,
    operationVersion: '1', accountId: account, invokePortId, inputSchema: schema, outputSchema });
  assert.ok(definitionFingerprint);
  const manifest = attachSemanticContract({ version: 1, manifestId: capability,
    providerKind: 'composio', providerIdentity: 'composio', providerVersion: COMPOSIO_PROVIDER_SURFACE_VERSION,
    operationId: operation, operationVersion: '1', definitionFingerprint,
    externalDefinition: { version: 1, providerInputSchemaDigest: digestSchema(schema),
      providerOutputSchemaObserved: true, providerOutputSchemaDigest: digestSchema(outputSchema), semanticName: operation,
      behaviorHints: { readOnly: true, destructive: false, idempotent: true, openWorld: false } },
    effect: 'read', accountId: account,
    idempotency: { required: false, policy: 'none' }, reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'result' }, purpose: 'Read the controlled CRM board status.',
    acceptedInputKinds: ['evidence'], producedOutputKinds: ['evidence'], applicableDeliverableKinds: ['evidence'],
    evidenceContract: { kinds: ['tool_result'], readbackRequired: false },
    provenance: { issuer: 'host:connection-provider:test', issuedAt: '2026-09-30T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' }, invokePortId, argumentCompiler: { id: 'host:json', version: '1' } });
  installCapabilityManifestStore(createCapabilityManifestStore([manifest], { durable: true }));
  const observation = { definitionFingerprint, providerVersion: manifest.providerVersion,
    operationVersion: '1', accountId: account, observedAt: Date.now() };
  assert.equal(registerIndependentCapabilityObservation({ operationId: operation, ...observation, origin: 'independent',
    observe: () => ({ operationId: operation, ...observation, observedAt: Date.now() }) }).ok, true);
  const transport = buildComposioAttestedTransport();
  installProductionTransport(call => transport.execute(call));
  client.__test__.setComposioClient({ getClient: () => ({ withOptions: () => ({ tools: {
    execute: async (slug: string, body: Record<string, unknown>) => {
      assert.equal(slug, operation);
      assert.equal(body.connected_account_id, account);
      assert.deepEqual(body.arguments, { recordId: 'fixture-board' });
      counts.businessCalls += 1;
      return { successful: true, error: null, data: { status: 'Ready' }, logId: 'fixture-crm-read' };
    },
  } }) }), tools: { execute: async () => { throw new Error('Legacy provider execution is forbidden.'); } } });
  const invoke = async () => { throw new Error('The fixture must use the actual attested Composio carrier.'); };
  clearProductionCapabilityPorts();
  assert.equal(registerFixtureCapabilityPort(productionPortIdentityFromManifest(manifest), {
    invoke: invoke as never, admitPreparation: () => undefined,
    prepareInvocation: async () => ({ fixture: true }),
    invokeWithPreparation: async <T>(_proof: unknown, work: () => Promise<T>) => work(),
  }).ok, true);
  peekHostCapabilityCatalogFactory()!.register(registeredCapabilityFromManifest({ manifest, observation, invoke: invoke as never }));
  return { operation, capability, account, schema, counts,
    setActive: (value: boolean) => { active = value; },
    setVersion: (value: string) => { operationVersion = value; },
    setSchema: (value: Record<string, unknown>) => { currentSchema = value; },
    beforeSchema: (fn: () => void) => { beforeSchema = fn; },
    dispose: () => {
      installProductionTransport(null);
      schemas._setToolSchemaLoaderForTests(null);
      schemas.resetToolSchemaCache();
      client.__test__.setConnectedAccountsLoader(null);
      client.__test__.setComposioClient(null);
      client.__test__.setComposioApiKeyOverride(null);
      client.resetComposioClient();
      clearIndependentCapabilityObservations();
      clearProductionCapabilityPorts();
    } };
}
