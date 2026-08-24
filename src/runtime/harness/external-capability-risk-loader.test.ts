/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/external-capability-risk-loader.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import {
  attachSemanticContract,
  capabilityManifestDigest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import {
  createCapabilityManifestStore,
  installCapabilityManifestStore,
  peekCapabilityManifestStore,
} from './capability-manifest-store.js';
import {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import {
  installProductionCapabilityAdapter,
  peekProductionCapabilityAdapter,
} from './production-capability-adapter.js';
import {
  registerIndependentCapabilityObservation,
} from './independent-capability-observation.js';
import {
  deriveExternalCapabilityCallSignalsV1,
  loadCatalogManifestExternalRiskAttestationV1,
  loadExternalCapabilityRiskAttestationV1,
  type CatalogManifestExternalRiskAuthorityV1,
  type CatalogManifestExternalRiskBindingV1,
  type CurrentExternalCapabilityDefinitionV1,
  type LoadExternalCapabilityRiskAttestationInputV1,
} from './external-capability-risk-loader.js';
import type {
  ExternalCapabilityEffect,
  ExternalCapabilityProviderKind,
} from './external-capability-risk.js';

function sha256(value: unknown): string {
  const bytes = typeof value === 'string' ? value : closedCanonicalJson(value);
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function fixture(options: {
  semanticName?: string;
  effect?: ExternalCapabilityEffect;
  providerKind?: ExternalCapabilityProviderKind;
  operationId?: string;
  hints?: Partial<CurrentExternalCapabilityDefinitionV1['behaviorHints']>;
  outboundDelivery?: boolean | null;
} = {}): LoadExternalCapabilityRiskAttestationInputV1 {
  const semanticName = options.semanticName ?? 'CREATE_RECORD';
  const effect = options.effect ?? 'external_write';
  const providerKind = options.providerKind ?? 'composio';
  const operationId = options.operationId ?? (providerKind === 'composio'
    ? `EXAMPLE_${semanticName}`
    : `configured_server__${semanticName.toLowerCase()}`);
  const providerIdentity = providerKind === 'composio'
    ? 'composio:current-catalog'
    : 'mcp-config:configured_server:current';
  const providerVersion = providerKind === 'composio'
    ? 'composio-catalog-v23'
    : 'mcp-catalog-v1:current';
  const operationVersion = providerKind === 'composio'
    ? '20260823_00'
    : 'mcp-tool-v1:current';
  const accountId = providerKind === 'composio'
    ? 'ca_exact_account'
    : 'native_mcp:configured_server:exact';
  const inputSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      body: { type: 'string' },
    },
    additionalProperties: false,
  };
  const schemaDigest = sha256(inputSchema);
  // Intentionally not the schema digest. The native materializer fingerprints
  // a complete definition and Composio may use a schema-bound recipe; the
  // loader must preserve either without assuming the recipes are identical.
  const manifestDefinitionFingerprint = sha256({
    providerKind,
    providerIdentity,
    providerVersion,
    operationId,
    operationVersion,
    schemaDigest,
  });
  const posture = effect === 'read'
    ? 'not_applicable' as const
    : semanticName.startsWith('CREATE') ? 'create_new' as const : 'named_existing' as const;
  const manifest = attachSemanticContract({
    version: 1,
    manifestId: `cap:test:${providerKind}:${semanticName.toLowerCase()}`,
    providerKind,
    operationId,
    providerIdentity,
    providerVersion,
    operationVersion,
    definitionFingerprint: manifestDefinitionFingerprint,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: schemaDigest,
      semanticName: providerKind === 'native_mcp'
        ? operationId.slice(operationId.indexOf('__') + 2)
        : operationId,
      behaviorHints: {
        readOnly: options.hints?.readOnly ?? null,
        destructive: options.hints?.destructive ?? null,
        idempotent: options.hints?.idempotent ?? null,
        openWorld: options.hints?.openWorld ?? null,
      },
    },
    effect,
    ...(effect !== 'read'
      ? { destination: { family: 'external_resource', posture } }
      : {}),
    accountId,
    idempotency: {
      required: effect !== 'read',
      policy: effect === 'read' ? 'none' : 'key_before_dispatch',
    },
    reconciliation: {
      supported: false,
      policy: effect === 'read' ? 'none' : 'uncertain_if_absent',
    },
    outputContract: { kind: effect === 'read' ? 'records' : 'result' },
    purpose: effect === 'read' ? 'invoke_live_read' : 'invoke_live_operation',
    acceptedInputKinds: ['arguments'],
    producedOutputKinds: ['result'],
    applicableDeliverableKinds: ['result'],
    evidenceContract: { kinds: ['result'], readbackRequired: false },
    provenance: {
      issuer: 'host:test:current-definition',
      issuedAt: '2026-08-23T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    argumentCompiler: { id: 'host:test-json-arguments', version: '1' },
    invokePortId: `host:test:${providerKind}:invoke`,
  });
  return {
    version: 1,
    manifest,
    currentDefinition: {
      version: 1,
      providerKind,
      providerIdentity,
      providerVersion,
      operationId,
      operationVersion,
      accountId,
      manifestDefinitionFingerprint,
      schemaDigest,
      inputSchema,
      semanticName,
      behaviorHints: {
        readOnly: options.hints?.readOnly ?? null,
        destructive: options.hints?.destructive ?? null,
        idempotent: options.hints?.idempotent ?? null,
        openWorld: options.hints?.openWorld ?? null,
      },
    },
    destination: {
      digest: sha256({ accountId, semanticName, posture }),
      posture,
    },
    callSignals: { outboundDelivery: options.outboundDelivery ?? null },
    documentedSemantic: null,
    safety: 'admissible',
  };
}

function loaded(input: unknown) {
  const result = loadExternalCapabilityRiskAttestationV1(input);
  if (!result.ok) assert.fail(`loader refused: ${result.reason}`);
  return result.attestation;
}

function catalogAuthority(input: LoadExternalCapabilityRiskAttestationInputV1): {
  authority: CatalogManifestExternalRiskAuthorityV1;
  binding: CatalogManifestExternalRiskBindingV1;
} {
  const manifestStore = createCapabilityManifestStore([input.manifest]);
  const catalogFactory = createHostCapabilityCatalogFactory();
  const manifestDigest = capabilityManifestDigest(input.manifest);
  catalogFactory.register({
    capabilityId: input.manifest.manifestId,
    toolName: input.manifest.operationId,
    schemaVersion: input.manifest.operationVersion,
    schemaDigest: input.manifest.definitionFingerprint,
    effect: input.manifest.effect,
    ...(input.manifest.destination ? { destination: input.manifest.destination } : {}),
    account: input.manifest.accountId,
    manifestDigest,
    providerKind: input.manifest.providerKind,
    providerInputSchemaDigest: input.currentDefinition.schemaDigest,
    liveFingerprint: input.manifest.definitionFingerprint,
    manifest: input.manifest,
    invoke: async () => ({ ok: true }),
  });
  return {
    authority: {
      manifestStore,
      catalogFactory,
      observe: () => ({
        definitionFingerprint: input.currentDefinition.manifestDefinitionFingerprint,
        providerVersion: input.currentDefinition.providerVersion,
        operationVersion: input.currentDefinition.operationVersion,
        accountId: input.currentDefinition.accountId,
        observedAt: Date.now(),
      }),
    },
    binding: {
      bindingKind: 'catalog_manifest',
      capabilityId: input.manifest.manifestId,
      providerInputSchemaDigest: input.currentDefinition.schemaDigest,
      schemaFingerprint: input.manifest.definitionFingerprint,
      accountId: input.manifest.accountId,
      invokePortId: input.manifest.invokePortId,
      operationId: input.manifest.operationId,
      manifestId: input.manifest.manifestId,
      manifestDigest,
      effect: input.manifest.effect,
    },
  };
}

test('one loader preserves exact manifest, schema, definition, account, and normalized hints', () => {
  const input = fixture({
    semanticName: 'LIST_RECORDS',
    effect: 'read',
    hints: { readOnly: true, idempotent: true, openWorld: false },
  });
  const attestation = loaded(input);
  assert.equal(attestation.manifest.manifestDigest, capabilityManifestDigest(input.manifest));
  assert.equal(attestation.manifest.definitionFingerprint, input.manifest.definitionFingerprint);
  assert.equal(
    attestation.currentDefinition.manifestDefinitionFingerprint,
    input.currentDefinition.manifestDefinitionFingerprint,
  );
  assert.equal(attestation.currentDefinition.schemaDigest, sha256(input.currentDefinition.inputSchema));
  assert.match(attestation.currentDefinition.definitionDigest, /^[a-f0-9]{64}$/);
  assert.equal(attestation.currentDefinition.operationId, input.currentDefinition.operationId);
  assert.equal(attestation.currentDefinition.operationVersion, input.currentDefinition.operationVersion);
  assert.equal(attestation.currentDefinition.providerVersion, input.currentDefinition.providerVersion);
  assert.equal(attestation.currentDefinition.accountId, input.currentDefinition.accountId);
  assert.deepEqual(attestation.currentDefinition.behaviorHints, {
    readOnly: true,
    destructive: null,
    idempotent: true,
    openWorld: false,
  });
  assert.deepEqual(attestation.projection.risk, {
    reversibility: 'read_only', consequence: 'read', destructive: false,
  });
});

test('ordinary create and update project identically across Composio and native MCP carriers', () => {
  for (const semanticName of ['CREATE_RECORD', 'UPDATE_RECORD'] as const) {
    const projections = (['composio', 'native_mcp'] as const).map((providerKind) =>
      loaded(fixture({ semanticName, providerKind })).projection);
    const expectedConsequence = semanticName === 'CREATE_RECORD' ? 'create' : 'update';
    for (const projection of projections) {
      assert.equal(projection.effect, 'external_write');
      assert.deepEqual(projection.risk, {
        reversibility: 'ordinary_non_destructive',
        consequence: expectedConsequence,
        destructive: false,
      });
    }
    assert.deepEqual(projections[0]!.risk, projections[1]!.risk);
    assert.notEqual(
      projections[0]!.semanticBasis.digest,
      projections[1]!.semanticBasis.digest,
      'carrier identity remains part of authority even though policy risk is carrier-neutral',
    );
  }
});

test('prepared catalog_manifest work reopens current authority and documented odd-shaped creates generically', () => {
  for (const documentedCreate of [
    {
      semanticName: 'SHEET_FROM_JSON',
      operationId: 'GOOGLESHEETS_SHEET_FROM_JSON',
    },
    {
      semanticName: 'CREATE_DOCUMENT_MARKDOWN',
      operationId: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
    },
  ] as const) {
    const input = fixture({
      ...documentedCreate,
      effect: 'external_write',
      providerKind: 'composio',
    });
    const { authority, binding } = catalogAuthority(input);
    const result = loadCatalogManifestExternalRiskAttestationV1({
      version: 1,
      binding,
      inputSchema: input.currentDefinition.inputSchema,
      destination: input.destination,
      callSignals: { outboundDelivery: false },
      safety: 'admissible',
    }, authority);
    if (!result.ok) assert.fail(`${documentedCreate.operationId} catalog loader refused: ${result.reason}`);
    assert.equal(result.attestation.manifest.manifestDigest, binding.manifestDigest);
    assert.equal(result.attestation.manifest.accountId, binding.accountId);
    assert.deepEqual(result.attestation.projection.risk, {
      reversibility: 'reversible', consequence: 'create', destructive: false,
    });
  }
});

test('prepared catalog_manifest loader has carrier parity and reopens live versions before projection', () => {
  for (const providerKind of ['composio', 'native_mcp'] as const) {
    const input = fixture({ semanticName: 'UPDATE_RECORD', providerKind });
    const { authority, binding } = catalogAuthority(input);
    const result = loadCatalogManifestExternalRiskAttestationV1({
      version: 1,
      binding,
      inputSchema: input.currentDefinition.inputSchema,
      destination: input.destination,
      callSignals: input.callSignals,
      safety: 'admissible',
    }, authority);
    if (!result.ok) assert.fail(`${providerKind} catalog loader refused: ${result.reason}`);
    assert.deepEqual(result.attestation.projection.risk, {
      reversibility: 'ordinary_non_destructive', consequence: 'update', destructive: false,
    });
  }

  const drifted = fixture({ semanticName: 'UPDATE_RECORD' });
  const { authority, binding } = catalogAuthority(drifted);
  authority.observe = () => ({
    definitionFingerprint: drifted.currentDefinition.manifestDefinitionFingerprint,
    providerVersion: 'changed-provider-version',
    operationVersion: drifted.currentDefinition.operationVersion,
    accountId: drifted.currentDefinition.accountId,
    observedAt: Date.now(),
  });
  assert.deepEqual(loadCatalogManifestExternalRiskAttestationV1({
    version: 1,
    binding,
    inputSchema: drifted.currentDefinition.inputSchema,
    destination: drifted.destination,
    callSignals: drifted.callSignals,
    safety: 'admissible',
  }, authority), { ok: false, reason: 'current_definition_unavailable' });
});

test('production catalog loader consumes the fresh shipped independent observer without a parallel direct port', () => {
  const input = fixture({
    semanticName: 'CREATE_INDEPENDENT_OBSERVER_FIXTURE',
    operationId: 'EXAMPLE_CREATE_INDEPENDENT_OBSERVER_FIXTURE',
  });
  const { authority, binding } = catalogAuthority(input);
  const priorStore = peekCapabilityManifestStore();
  const priorFactory = peekHostCapabilityCatalogFactory();
  const priorAdapter = peekProductionCapabilityAdapter();
  let observedProviderVersion = input.currentDefinition.providerVersion;
  assert.deepEqual(registerIndependentCapabilityObservation({
    operationId: input.manifest.operationId,
    accountId: input.manifest.accountId,
    definitionFingerprint: input.manifest.definitionFingerprint,
    providerVersion: input.manifest.providerVersion,
    operationVersion: input.manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
    observe: () => ({
      operationId: input.manifest.operationId,
      accountId: input.manifest.accountId,
      definitionFingerprint: input.manifest.definitionFingerprint,
      providerVersion: observedProviderVersion,
      operationVersion: input.manifest.operationVersion,
      observedAt: Date.now(),
    }),
  }), { ok: true });

  try {
    installCapabilityManifestStore(authority.manifestStore);
    installHostCapabilityCatalogFactory(authority.catalogFactory);
    installProductionCapabilityAdapter(null);
    const request = {
      version: 1 as const,
      binding,
      inputSchema: input.currentDefinition.inputSchema,
      destination: input.destination,
      callSignals: input.callSignals,
      safety: 'admissible' as const,
    };
    const loaded = loadCatalogManifestExternalRiskAttestationV1(request);
    if (!loaded.ok) assert.fail(`production catalog loader refused: ${loaded.reason}`);
    assert.deepEqual(loaded.attestation.projection.risk, {
      reversibility: 'ordinary_non_destructive', consequence: 'create', destructive: false,
    });

    observedProviderVersion = 'drifted-provider-version';
    assert.deepEqual(loadCatalogManifestExternalRiskAttestationV1(request), {
      ok: false,
      reason: 'current_definition_unavailable',
    }, 'a fresh independent drift cannot be erased by a matching transport fallback');
  } finally {
    installProductionCapabilityAdapter(priorAdapter);
    installHostCapabilityCatalogFactory(priorFactory);
    installCapabilityManifestStore(priorStore);
  }
});

test('send, delete, and admin remain high-consequence through the loader', () => {
  assert.deepEqual(loaded(fixture({ semanticName: 'SEND_MESSAGE' })).projection.risk, {
    reversibility: 'irreversible', consequence: 'send', destructive: false,
  });
  assert.deepEqual(loaded(fixture({ semanticName: 'DELETE_RECORD' })).projection.risk, {
    reversibility: 'unknown', consequence: 'delete', destructive: true,
  });
  const admin = loaded(fixture({ semanticName: 'ROTATE_API_KEY', effect: 'admin' })).projection;
  assert.equal(admin.effect, 'admin');
  assert.deepEqual(admin.risk, {
    reversibility: 'unknown', consequence: 'admin', destructive: false,
  });
});

test('argument-derived outbound delivery raises an otherwise ordinary create', () => {
  assert.deepEqual(loaded(fixture({
    semanticName: 'CREATE_EVENT',
    outboundDelivery: true,
  })).projection.risk, {
    reversibility: 'irreversible', consequence: 'send', destructive: false,
  });
  assert.deepEqual(loaded(fixture({
    semanticName: 'CREATE_EVENT',
    outboundDelivery: false,
  })).projection.risk, {
    reversibility: 'ordinary_non_destructive', consequence: 'create', destructive: false,
  });
});

test('closed schema-declared boolean, enum, and nested path evidence raises outbound delivery', () => {
  const project = (inputSchema: unknown, args: unknown) => deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema,
    arguments: args,
  });
  assert.deepEqual(project({
    type: 'object',
    properties: { should_send: { type: 'boolean' } },
    additionalProperties: false,
  }, { should_send: true }), {
    status: 'projected', resolution: 'affirmative', callSignals: { outboundDelivery: true },
  });
  assert.deepEqual(project({
    type: 'object',
    properties: { mode: { type: 'string', enum: ['draft', 'send'] } },
    additionalProperties: false,
  }, { mode: 'send' }), {
    status: 'projected', resolution: 'affirmative', callSignals: { outboundDelivery: true },
  });
  assert.deepEqual(project({
    type: 'object',
    properties: {
      send: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  }, { send: { to: 'person@example.com' } }), {
    status: 'projected', resolution: 'affirmative', callSignals: { outboundDelivery: true },
  });
  assert.deepEqual(project({
    $ref: '#/$defs/input',
    $defs: {
      input: {
        type: 'object',
        allOf: [
          { properties: { title: { type: 'string' } } },
          { properties: { publish_now: { type: 'boolean' } } },
        ],
      },
    },
  }, { title: 'Release', publish_now: true }), {
    status: 'projected', resolution: 'affirmative', callSignals: { outboundDelivery: true },
  });
});

test('negative or absent delivery controls never fabricate outbound false', () => {
  const schema = {
    type: 'object',
    properties: { notify_users: { type: 'boolean' } },
    additionalProperties: false,
  };
  const explicitNegative = deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: schema,
    arguments: { notify_users: false },
  });
  assert.deepEqual(explicitNegative, {
    status: 'projected',
    resolution: 'resolved_non_affirmative',
    callSignals: { outboundDelivery: null },
  });
  assert.equal(JSON.stringify(explicitNegative).includes('false'), false);
  assert.deepEqual(deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: schema,
    arguments: {},
  }), {
    status: 'unknown',
    reason: 'unresolved_delivery_signal',
    callSignals: { outboundDelivery: null },
  });
  assert.deepEqual(deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, share_price: { type: 'number' } },
      additionalProperties: false,
    },
    arguments: { title: 'Record', share_price: 42 },
  }), {
    status: 'projected',
    resolution: 'not_exposed',
    callSignals: { outboundDelivery: null },
  });
});

test('malformed, accessor-backed, ambiguous, or undeclared delivery evidence remains explicit unknown', () => {
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, 'send', { enumerable: true, get: () => true });
  assert.deepEqual(deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: { type: 'object', properties: { send: { type: 'boolean' } } },
    arguments: accessor,
  }), {
    status: 'unknown', reason: 'malformed_input', callSignals: { outboundDelivery: null },
  });
  assert.deepEqual(deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: { type: 'object', properties: [], additionalProperties: false },
    arguments: {},
  }), {
    status: 'unknown', reason: 'malformed_input', callSignals: { outboundDelivery: null },
  });
  assert.deepEqual(deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: { type: 'object', patternProperties: { '^send': { type: 'boolean' } } },
    arguments: { send_now: true },
  }), {
    status: 'unknown', reason: 'ambiguous_schema', callSignals: { outboundDelivery: null },
  });
  assert.deepEqual(deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    arguments: { send_now: true },
  }), {
    status: 'unknown', reason: 'ambiguous_schema', callSignals: { outboundDelivery: null },
  });
});

test('derived affirmative arguments high-gate a noun-shaped draft mutation', () => {
  const signals = deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        send: { type: 'boolean' },
      },
      required: ['title', 'send'],
      additionalProperties: false,
    },
    arguments: { title: 'Draft', send: true },
  });
  assert.equal(signals.status, 'projected');
  if (signals.status !== 'projected') return;
  const input = fixture({ semanticName: 'CREATE_DRAFT' });
  input.callSignals = signals.callSignals;
  assert.deepEqual(loaded(input).projection.risk, {
    reversibility: 'irreversible', consequence: 'send', destructive: false,
  });
});

test('unknown operation shape remains typed unknown data instead of a fabricated public gate', () => {
  assert.deepEqual(loaded(fixture({ semanticName: 'SYNC_RESOURCE' })).projection.risk, {
    reversibility: 'unknown', consequence: 'unknown', destructive: false,
  });
});

test('version, account, materializer-fingerprint, and schema drift are independently refused', () => {
  const version = fixture();
  version.currentDefinition.operationVersion = 'changed-version';
  assert.deepEqual(loadExternalCapabilityRiskAttestationV1(version), {
    ok: false, reason: 'identity_mismatch',
  });

  const account = fixture();
  account.currentDefinition.accountId = 'different-account';
  assert.deepEqual(loadExternalCapabilityRiskAttestationV1(account), {
    ok: false, reason: 'identity_mismatch',
  });

  const definition = fixture();
  definition.currentDefinition.manifestDefinitionFingerprint = sha256('changed-definition');
  assert.deepEqual(loadExternalCapabilityRiskAttestationV1(definition), {
    ok: false, reason: 'definition_drift',
  });

  const schema = fixture();
  (schema.currentDefinition.inputSchema.properties as Record<string, unknown>).extra = {
    type: 'boolean',
  };
  assert.deepEqual(loadExternalCapabilityRiskAttestationV1(schema), {
    ok: false, reason: 'schema_drift',
  });
});

test('conflicting declared hints and destination drift are typed refusals', () => {
  const hints = fixture({ hints: { readOnly: true, destructive: true } });
  assert.deepEqual(loadExternalCapabilityRiskAttestationV1(hints), {
    ok: false, reason: 'hint_conflict',
  });

  const destination = fixture({ semanticName: 'UPDATE_RECORD' });
  destination.destination.posture = 'create_new';
  assert.deepEqual(loadExternalCapabilityRiskAttestationV1(destination), {
    ok: false, reason: 'destination_mismatch',
  });
});

test('revoked manifests and unsupported local carriers cannot mint external risk authority', () => {
  const revoked = fixture();
  revoked.manifest = {
    ...revoked.manifest,
    lifecycle: { state: 'revoked' },
  } as CapabilityManifestV1;
  assert.deepEqual(loadExternalCapabilityRiskAttestationV1(revoked), {
    ok: false, reason: 'manifest_not_current',
  });

  const local = fixture() as unknown as Record<string, unknown>;
  const manifest = (local.manifest as CapabilityManifestV1);
  const { externalDefinition: _externalDefinition, ...withoutExternalDefinition } = manifest;
  local.manifest = { ...withoutExternalDefinition, providerKind: 'local_registry' };
  assert.deepEqual(loadExternalCapabilityRiskAttestationV1(local), {
    ok: false, reason: 'unsupported_provider',
  });
});

test('the loader is closed, canonical, and never evaluates accessors', () => {
  const input = fixture({ semanticName: 'UPDATE_RECORD', hints: { idempotent: false } });
  const first = loaded(input);
  const reorderedSchema = fixture({ semanticName: 'UPDATE_RECORD', hints: { idempotent: false } });
  reorderedSchema.currentDefinition.inputSchema = {
    additionalProperties: false,
    properties: {
      body: { type: 'string' },
      id: { type: 'string' },
    },
    type: 'object',
  };
  reorderedSchema.currentDefinition.schemaDigest = sha256(reorderedSchema.currentDefinition.inputSchema);
  assert.equal(
    loaded(reorderedSchema).currentDefinition.definitionDigest,
    first.currentDefinition.definitionDigest,
  );

  const extra = fixture() as unknown as Record<string, unknown>;
  extra.providerOverride = 'allow';
  assert.deepEqual(loadExternalCapabilityRiskAttestationV1(extra), {
    ok: false, reason: 'malformed_input',
  });

  let getterRan = false;
  const accessor = fixture() as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, 'safety', {
    enumerable: true,
    get() {
      getterRan = true;
      return 'admissible';
    },
  });
  assert.deepEqual(loadExternalCapabilityRiskAttestationV1(accessor), {
    ok: false, reason: 'malformed_input',
  });
  assert.equal(getterRan, false);
});
