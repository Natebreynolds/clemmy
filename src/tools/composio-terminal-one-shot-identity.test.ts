import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-composio-terminal-identity-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-composio-terminal-identity\n');

const client = await import('../integrations/composio/client.js');
const schemas = await import('./composio-schema-cache.js');
const tools = await import('./composio-tools.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const stores = await import('../runtime/harness/capability-manifest-store.js');
const authority = await import('../runtime/harness/accepted-turn-call-authority.js');
const providerIdentity = await import('../integrations/composio/provider-definition-identity.js');
const contracts = await import('./tool-contract-store.js');
const attestedComposio = await import('../runtime/harness/composio-attested-transport.js');
const abortContext = await import('../runtime/tool-abort-context.js');

const previousBackend = process.env.COMPOSIO_BACKEND;
process.env.COMPOSIO_BACKEND = 'sdk';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildManifest(input: {
  slug: string;
  accountId: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  operationVersion: string;
  invokePortId: string;
  definitionFingerprint?: string;
  effect?: 'read' | 'external_write';
}) {
  const definitionFingerprint = input.definitionFingerprint
    ?? providerIdentity.fingerprintComposioProviderDefinition({
      operationId: input.slug,
      operationVersion: input.operationVersion,
      accountId: input.accountId,
      invokePortId: input.invokePortId,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
    });
  assert.ok(definitionFingerprint);
  const effect = input.effect ?? 'read';
  return manifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:${input.slug.toLowerCase()}`,
    providerKind: 'composio',
    operationId: input.slug,
    providerIdentity: 'composio',
    providerVersion: providerIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION,
    operationVersion: input.operationVersion,
    definitionFingerprint,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: contracts.digestSchema(input.inputSchema),
      providerOutputSchemaObserved: true,
      ...(input.outputSchema
        ? { providerOutputSchemaDigest: contracts.digestSchema(input.outputSchema) }
        : {}),
      semanticName: input.slug,
      behaviorHints: {
        readOnly: effect === 'read',
        destructive: null,
        idempotent: null,
        openWorld: null,
      },
    },
    effect,
    ...(effect === 'external_write'
      ? { destination: { family: input.slug.split('_')[0]!.toLowerCase(), posture: 'update_existing' } }
      : {}),
    accountId: input.accountId,
    idempotency: { required: effect === 'external_write', policy: effect === 'external_write' ? 'key_before_dispatch' : 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: effect === 'read' ? 'records' : 'receipt' },
    evidenceContract: { kinds: effect === 'read' ? ['payload'] : ['receipt'], readbackRequired: false },
    provenance: { issuer: 'host:test-terminal-identity', issuedAt: '2026-08-25T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: [effect === 'read' ? 'source' : 'destination'],
    argumentCompiler: { id: 'compile:test-terminal-identity', version: '1' },
    invokePortId: input.invokePortId,
    ...(effect === 'external_write' ? { reconcilePortId: `reconcile:${input.invokePortId}` } : {}),
    acceptedInputKinds: ['evidence'],
    producedOutputKinds: ['evidence'],
    applicableDeliverableKinds: ['evidence'],
  });
}

function hostAttestation(
  manifest: ReturnType<typeof buildManifest>,
  overrides: Partial<authority.HostCallAttestation> = {},
): authority.HostCallAttestation {
  const sessionId = 'terminal-one-shot-identity';
  return {
    sessionId,
    sourceUserSeq: 1,
    acceptedTaskId: `task:${sessionId}#1`,
    sourceEventId: 'source-terminal-one-shot-identity',
    sourceEventDigest: digest('source'),
    logicalToolCallId: 'logical-terminal-one-shot-identity',
    toolName: manifest.operationId.toLowerCase(),
    argumentDigest: digest('arguments'),
    effect: manifest.effect === 'external_write' ? 'external_write' : 'read',
    bindingKind: 'catalog_manifest',
    capabilityId: manifest.manifestId,
    providerInputSchemaDigest: manifest.externalDefinition!.providerInputSchemaDigest,
    schemaFingerprint: manifest.definitionFingerprint,
    accountId: manifest.accountId,
    invokePortId: manifest.invokePortId,
    operationId: manifest.operationId,
    manifestId: manifest.manifestId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    bindingDigest: digest('binding'),
    engineVersion: 'host-v1',
    surfaceVersion: 'surface-v1',
    authorityDigest: digest('authority'),
    authorityRevision: 0,
    surfaceDigest: digest('surface'),
    catalogRevisionDigest: digest('catalog'),
    bindingRevisionDigest: digest('binding-revision'),
    ...overrides,
  };
}

async function prepareFixture(input: {
  slug: string;
  manifestAccount?: string;
  currentAccount?: string;
  inputSchema?: Record<string, unknown>;
  observedInputSchema?: Record<string, unknown>;
  observedOutput?: Record<string, unknown> | null;
  manifestOutput?: Record<string, unknown> | null;
  observedVersion?: string;
  manifestVersion?: string;
  invokePortId?: string;
  definitionFingerprint?: string;
  effect?: 'read' | 'external_write';
  rememberSchema?: boolean;
}) {
  const inputSchema = input.inputSchema ?? {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: { query: { type: 'string' } },
  };
  const observedInputSchema = input.observedInputSchema ?? inputSchema;
  const manifestOutput = input.manifestOutput === undefined
    ? { type: 'object', properties: { items: { type: 'array' } } }
    : input.manifestOutput;
  const observedOutput = input.observedOutput === undefined ? manifestOutput : input.observedOutput;
  const manifestAccount = input.manifestAccount ?? 'ca-terminal-a';
  const currentAccount = input.currentAccount ?? manifestAccount;
  const manifestVersion = input.manifestVersion ?? '20260825_01';
  const observedVersion = input.observedVersion ?? manifestVersion;
  const invokePortId = input.invokePortId ?? `port:cap:resolved:${input.slug.toLowerCase()}:${input.slug}`;
  const manifest = buildManifest({
    slug: input.slug,
    accountId: manifestAccount,
    inputSchema,
    outputSchema: manifestOutput,
    operationVersion: manifestVersion,
    invokePortId,
    definitionFingerprint: input.definitionFingerprint,
    effect: input.effect,
  });
  const store = stores.createCapabilityManifestStore([manifest]);
  stores.installCapabilityManifestStore(store);
  let accountLoads = 0;
  client.__test__.setComposioApiKeyOverride('terminal-one-shot-test-key');
  client.__test__.setConnectedAccountsLoader(async () => {
    accountLoads += 1;
    return [{
      id: currentAccount,
      status: 'ACTIVE',
      user_id: `owner:${currentAccount}`,
      toolkit: { slug: input.slug.split('_')[0]!.toLowerCase() },
    }];
  });
  await client.listConnectedToolkits({ requireFresh: true });
  if (input.rememberSchema !== false) {
    schemas.rememberToolSchema(
      input.slug,
      observedInputSchema,
      Date.now(),
      observedVersion,
      observedOutput,
    );
  }
  let rawBodies = 0;
  let legacyBodies = 0;
  const noRetryOptions: unknown[] = [];
  const rawSignals: Array<AbortSignal | undefined> = [];
  client.__test__.setComposioClient({
    getClient: () => ({
      withOptions: (options: unknown) => {
        noRetryOptions.push(options);
        return {
          tools: {
            execute: async (
              _slug: string,
              _body: Record<string, unknown>,
              options?: { signal?: AbortSignal },
            ) => {
              rawBodies += 1;
              rawSignals.push(options?.signal);
              return { successful: true, error: null, data: { items: [] } };
            },
          },
        };
      },
    }),
    tools: {
      execute: async () => {
        legacyBodies += 1;
        throw new Error('legacy execute must not run');
      },
    },
  });
  return {
    inputSchema,
    manifest,
    accountLoads: () => accountLoads,
    rawBodies: () => rawBodies,
    legacyBodies: () => legacyBodies,
    noRetryOptions,
    rawSignals,
  };
}

afterEach(() => {
  client.__test__.setConnectedAccountsLoader(null);
  client.__test__.setComposioApiKeyOverride(null);
  client.resetComposioClient();
  schemas.resetToolSchemaCache();
  stores.installCapabilityManifestStore(null);
});

after(() => {
  if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
  else process.env.COMPOSIO_BACKEND = previousBackend;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('prepared platform read uses one SDK raw no-retry body and cannot reuse its opaque token', async () => {
  const fixture = await prepareFixture({ slug: 'COMPOSIO_LIST_TOOLS' });
  const result = await authority.withHostCallAttestation(
    hostAttestation(fixture.manifest),
    () => tools.resolveComposioDispatch(
      fixture.manifest.operationId,
      { query: 'calendar' },
      fixture.manifest.accountId,
      { preparedExecution: true },
    ),
  );
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) return;
  assert.equal(result.definitionFingerprint, fixture.manifest.definitionFingerprint);
  assert.equal(result.providerOperationVersion, fixture.manifest.operationVersion);
  assert.equal(result.providerOutputSchemaDigest,
    fixture.manifest.externalDefinition?.providerOutputSchemaDigest);
  assert.equal(result.invokePortId, fixture.manifest.invokePortId);
  assert.ok(result.preparedDispatch);
  await tools.executePreparedComposioGatewayTool(result.preparedDispatch!);
  assert.equal(fixture.rawBodies(), 1);
  assert.equal(fixture.legacyBodies(), 0);
  assert.deepEqual(fixture.noRetryOptions, [{ maxRetries: 0 }]);
  await assert.rejects(tools.executePreparedComposioGatewayTool(result.preparedDispatch!));
  assert.equal(fixture.rawBodies(), 1, 'one opaque token owns exactly one raw provider body');
  assert.equal(fixture.accountLoads(), 1, 'execution preparation performs no hidden account refresh');
});

test('cold platform mutation refuses with zero SDK, CLI, legacy, or provider body', async () => {
  const fixture = await prepareFixture({
    slug: 'COMPOSIO_DELETE_CONNECTED_ACCOUNT',
    effect: 'external_write',
    rememberSchema: false,
  });
  const result = await tools.resolveComposioDispatch(
    fixture.manifest.operationId,
    { query: 'ca-old' },
    fixture.manifest.accountId,
    { preparedExecution: true },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /exact current provider input definition is not prepared/i);
  assert.equal(fixture.rawBodies(), 0);
  assert.equal(fixture.legacyBodies(), 0);
  assert.deepEqual(fixture.noRetryOptions, []);
  assert.equal(fixture.accountLoads(), 1, 'cold refusal does not refresh account state inside the call');
});

test('attested Composio transport refuses an unsealed call before gateway or provider work', async () => {
  const fixture = await prepareFixture({ slug: 'ACME_UNSEALED_SEARCH' });
  const transport = attestedComposio.buildComposioAttestedTransport();
  await assert.rejects(
    transport.execute({
      operationId: fixture.manifest.operationId,
      args: { query: 'bounded' },
      accountId: fixture.manifest.accountId,
    }),
    /sealed Composio manifest identity is required/i,
  );
  assert.equal(fixture.rawBodies(), 0);
  assert.equal(fixture.legacyBodies(), 0);
  assert.deepEqual(fixture.noRetryOptions, []);
  assert.equal(fixture.accountLoads(), 1);
});

test('attested exact registered read executes one abortable SDK raw body', async () => {
  const fixture = await prepareFixture({ slug: 'ACME_ATTESTED_SEARCH' });
  const manifest = fixture.manifest;
  const transport = attestedComposio.buildComposioAttestedTransport();
  const controller = new AbortController();
  const result = await abortContext.runWithToolAbortSignal(
    controller.signal,
    () => transport.execute({
      operationId: manifest.operationId,
      args: { query: 'bounded' },
      accountId: manifest.accountId,
      expected: {
        manifestId: manifest.manifestId,
        manifestDigest: manifests.capabilityManifestDigest(manifest),
        providerKind: manifest.providerKind,
        providerIdentity: manifest.providerIdentity,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
        definitionFingerprint: manifest.definitionFingerprint,
        providerInputSchemaDigest: manifest.externalDefinition!.providerInputSchemaDigest,
        providerOutputSchemaObserved: true,
        providerOutputSchemaDigest:
          manifest.externalDefinition!.providerOutputSchemaDigest ?? null,
        invokePortId: manifest.invokePortId,
        argumentCompiler: { ...manifest.argumentCompiler },
      },
    }),
  );
  assert.deepEqual(result, { successful: true, error: null, data: { items: [] } });
  assert.equal(fixture.rawBodies(), 1);
  assert.equal(fixture.legacyBodies(), 0);
  assert.deepEqual(fixture.noRetryOptions, [{ maxRetries: 0 }]);
  assert.deepEqual(fixture.rawSignals, [controller.signal]);
  assert.equal(fixture.accountLoads(), 1);
});

for (const drift of [
  {
    label: 'account A to B',
    prepare: { currentAccount: 'ca-terminal-b' },
    attestation: {},
  },
  {
    label: 'input schema',
    prepare: {
      observedInputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'locale'],
        properties: {
          query: { type: 'string' },
          locale: { type: 'string' },
        },
      },
    },
    attestation: {},
  },
  {
    label: 'output schema',
    prepare: {
      observedOutput: { type: 'object', properties: { changed: { type: 'boolean' } } },
    },
    attestation: {},
  },
  {
    label: 'operation version',
    prepare: { observedVersion: '20260825_02' },
    attestation: {},
  },
  {
    label: 'full definition fingerprint',
    prepare: { definitionFingerprint: 'a'.repeat(64) },
    attestation: {},
  },
] as const) {
  test(`${drift.label} drift refuses before an SDK transport or provider body`, async () => {
    const slug = `ACME_${drift.label.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_SEARCH`;
    const fixture = await prepareFixture({ slug, ...drift.prepare });
    const result = await authority.withHostCallAttestation(
      hostAttestation(fixture.manifest, drift.attestation),
      () => tools.resolveComposioDispatch(
        slug,
        { query: 'bounded' },
        fixture.manifest.accountId,
        { preparedExecution: true },
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(fixture.rawBodies(), 0);
    assert.equal(fixture.legacyBodies(), 0);
    assert.deepEqual(fixture.noRetryOptions, []);
    assert.equal(fixture.accountLoads(), 1);
  });
}

test('invoke-port drift between the host attestation and registered manifest is zero-body', async () => {
  const fixture = await prepareFixture({ slug: 'ACME_INVOKE_DRIFT_SEARCH' });
  const result = await authority.withHostCallAttestation(
    hostAttestation(fixture.manifest, { invokePortId: `${fixture.manifest.invokePortId}:changed` }),
    () => tools.resolveComposioDispatch(
      fixture.manifest.operationId,
      { query: 'bounded' },
      fixture.manifest.accountId,
      { preparedExecution: true },
    ),
  );
  assert.equal(result.ok, false);
  assert.equal(fixture.rawBodies(), 0);
  assert.equal(fixture.legacyBodies(), 0);
  assert.deepEqual(fixture.noRetryOptions, []);
  assert.equal(fixture.accountLoads(), 1);
});
