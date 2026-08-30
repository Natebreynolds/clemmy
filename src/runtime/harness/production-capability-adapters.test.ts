/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/production-capability-adapters.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-adapter-'));

const {
  assertDistinctReadyRecords,
  createArgsFromEnvelope,
  installProductionTransport,
  invokeForSealedManifest,
  invokeHostCompute,
  invokeHostCreate,
  normalizeSheetRows,
  productionProviderCrossingAllowed,
  reconcileForSealedManifest,
  reconcileHostCreate,
  sealedPortsForManifest,
} = await import('./production-capability-adapters.js');
const { sealGraphNodeInvocationEnvelope } = await import('./graph-node-envelope.js');
const { saveToolContract } = await import('../../tools/tool-contract-store.js');
const { rememberToolSchema } = await import('../../tools/composio-schema-cache.js');
const { productionCapabilityManifests } = await import('./production-capability-catalog.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('./capability-manifest.js');

const identity = { sessionId: 'sess-adapter', sourceUserSeq: 1, acceptedTaskId: 'task-1' };
const FIVE = [
  { title: 'a', date: '1', link: 'l1' },
  { title: 'b', date: '2', link: 'l2' },
  { title: 'c', date: '3', link: 'l3' },
  { title: 'd', date: '4', link: 'l4' },
  { title: 'e', date: '5', link: 'l5' },
];

function manifestByPurpose(purpose: string) {
  const manifest = productionCapabilityManifests().find((entry) => entry.purpose === purpose);
  assert.ok(manifest);
  return manifest;
}

function envelopeFor(role: string, predecessors: Array<{ role: string; value: unknown }> = []) {
  const manifest = role === 'destination'
    ? manifestByPurpose('persist_collection')
    : role === 'source'
      ? manifestByPurpose('locate_source')
      : role === 'collection'
        ? manifestByPurpose('collect_records')
        : role === 'readback'
          ? manifestByPurpose('verify_created_resource')
          : manifestByPurpose('project_records');
  return sealGraphNodeInvocationEnvelope({
    version: 1,
    identity,
    goal: {
      objective: 'Produce the requested collection in one destination.',
      revision: 0,
      criteria: [{ id: 'c-set', statement: 'Bounded collection is present.' }],
    },
    node: { id: `op-${role}`, role },
    cardinality: { count: 5, fields: ['title', 'date', 'link'] },
    predecessors: predecessors.map((prior, index) => ({
      nodeId: `op-${index}`,
      role: prior.role,
      value: prior.value,
    })),
    expectedOutput: { kind: manifest.producedOutputKinds[0] ?? 'records' },
    binding: {
      capabilityId: manifest.manifestId,
      manifestDigest: 'b'.repeat(64),
      schemaDigest: manifest.definitionFingerprint,
      account: manifest.accountId,
      effect: manifest.effect,
    },
  });
}

function opaqueExternalWriteManifest() {
  return attachSemanticContract({
    version: 1,
    manifestId: 'cap:q7x9:k2m4',
    providerKind: 'composio',
    operationId: 'Q7X9_K2M4',
    providerIdentity: 'carrier:q7x9:k2m4',
    providerVersion: 'surface:q7x9:v1',
    operationVersion: 'definition:k2m4:v3',
    definitionFingerprint: '3'.repeat(64),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: '4'.repeat(64),
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: '5'.repeat(64),
      semanticName: 'Q7X9_K2M4',
      behaviorHints: {
        readOnly: false,
        destructive: null,
        idempotent: null,
        openWorld: null,
      },
    },
    effect: 'external_write',
    destination: { family: 'q7x9', posture: 'named_existing' },
    accountId: 'acct:q7x9:k2m4',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: false, policy: 'uncertain_if_absent' },
    outputContract: { kind: 'opaque_result' },
    purpose: 'q7x9_k2m4',
    acceptedInputKinds: ['opaque_input'],
    producedOutputKinds: ['opaque_result'],
    applicableDeliverableKinds: ['opaque_result'],
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
    provenance: {
      issuer: 'host:test:opaque-write',
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    argumentCompiler: { id: 'compile:q7x9:k2m4', version: '1' },
    invokePortId: 'port:q7x9:k2m4',
    reconcilePortId: 'reconcile:q7x9:k2m4',
  });
}

function opaqueWriteInvocation(
  manifest: ReturnType<typeof opaqueExternalWriteManifest>,
  canonicalArgs: Record<string, unknown>,
  authorityOverrides: Record<string, unknown> = {},
) {
  return {
    nodeId: 'op-q7x9',
    role: 'opaque_role',
    payload: { ambient: 'must-not-cross' },
    identity,
    binding: {
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      args: canonicalArgs,
      account: manifest.accountId,
      effect: manifest.effect,
      manifestDigest: capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: async () => ({}),
    },
    authority: {
      version: 2,
      operationId: manifest.operationId,
      capabilityRef: manifest.manifestId,
      manifestId: manifest.manifestId,
      manifestDigest: capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      providerIdentity: manifest.providerIdentity,
      operationVersion: manifest.operationVersion,
      liveProviderVersion: manifest.providerVersion,
      canonicalArgs,
      accountId: manifest.accountId,
      resolvedEffect: manifest.effect,
      argumentCompiler: manifest.argumentCompiler,
      invokePortId: manifest.invokePortId,
      liveFingerprint: manifest.definitionFingerprint,
      ...authorityOverrides,
    } as never,
  };
}

test.afterEach(() => {
  installProductionTransport(null);
});

test('source invoked with a readback role refuses before transport', async () => {
  const source = manifestByPurpose('locate_source');
  await assert.rejects(
    () => invokeForSealedManifest(source)({
      nodeId: 'op-source',
      role: 'readback',
      payload: null,
      envelope: envelopeFor('source'),
      identity,
      binding: {
        capabilityId: source.manifestId,
        toolName: source.operationId,
        schemaVersion: source.operationVersion,
        schemaDigest: source.definitionFingerprint,
        args: {},
        account: source.accountId,
        effect: 'read',
        invoke: async () => ({}),
      },
    }),
    /refuses readback role/,
  );
});

test('collection records come from a fake transport behind the real adapter', async () => {
  const sourceManifest = manifestByPurpose('locate_source');
  const collectionManifest = manifestByPurpose('collect_records');
  installProductionTransport(async (call) => {
    if (call.operationId === sourceManifest.operationId) {
      return { locator: 'loc-1', query: 'q' };
    }
    assert.equal(call.operationId, collectionManifest.operationId);
    assert.ok(call.args.locator);
    return { records: FIVE };
  });
  const source = await invokeForSealedManifest(sourceManifest)({
    nodeId: 'op-source',
    role: 'source',
    payload: null,
    envelope: envelopeFor('source'),
    identity,
    binding: {
      capabilityId: sourceManifest.manifestId,
      toolName: sourceManifest.operationId,
      schemaVersion: sourceManifest.operationVersion,
      schemaDigest: sourceManifest.definitionFingerprint,
      args: {},
      account: sourceManifest.accountId,
      effect: 'read',
      invoke: async () => ({}),
    },
  });
  let transportCalls = 0;
  installProductionTransport(async (call) => {
    transportCalls += 1;
    assert.equal(call.operationId, collectionManifest.operationId);
    assert.ok(call.args.locator);
    return { records: FIVE };
  });
  const collected = await invokeForSealedManifest(collectionManifest)({
    nodeId: 'op-collect',
    role: 'collection',
    payload: source,
    envelope: envelopeFor('collection', [{ role: 'source', value: source }]),
    identity,
    binding: {
      capabilityId: collectionManifest.manifestId,
      toolName: collectionManifest.operationId,
      schemaVersion: collectionManifest.operationVersion,
      schemaDigest: collectionManifest.definitionFingerprint,
      args: {},
      account: collectionManifest.accountId,
      effect: 'read',
      invoke: async () => ({}),
    },
  });
  assert.equal(transportCalls, 1);
  const collectedRecords = Array.isArray(collected)
    ? collected
    : (collected as { records: Array<Record<string, unknown>> }).records;
  assert.equal(collectedRecords.length, 5);
  assertDistinctReadyRecords(collectedRecords, {
    count: 5,
    fields: ['title', 'date', 'link'],
  });
});

test('create adapter receives title, sheet_name, and five rows from the envelope', () => {
  const args = createArgsFromEnvelope(envelopeFor('destination', [{ role: 'transform', value: FIVE }]), FIVE);
  assert.equal(typeof args.title, 'string');
  assert.ok(args.title.length > 0);
  assert.equal(args.sheet_name, 'Sheet1');
  assert.equal(args.sheet_json.length, 5);
});

test('readback normalizes provider-shaped BATCH_GET valueRanges', () => {
  const rows = normalizeSheetRows({
    spreadsheetId: 'sheet-1',
    valueRanges: [{
      range: 'Sheet1!A1:C3',
      majorDimension: 'ROWS',
      values: [
        ['title', 'date', 'link'],
        ['a', '1', 'l1'],
        ['b', '2', 'l2'],
      ],
    }],
  });
  assert.deepEqual(rows[0], { title: 'a', date: '1', link: 'l1' });
  assert.deepEqual(rows[1], { title: 'b', date: '2', link: 'l2' });
});

test('exact-id readback content equals the intended written rows', async () => {
  const readback = manifestByPurpose('verify_created_resource');
  installProductionTransport(async (call) => {
    assert.equal(call.operationId, 'GOOGLESHEETS_BATCH_GET');
    assert.equal(call.args.spreadsheet_id, 'sheet-exact');
    return {
      spreadsheetId: 'sheet-exact',
      valueRanges: [{
        values: [
          ['title', 'date', 'link'],
          ...FIVE.map((row) => [row.title, row.date, row.link]),
        ],
      }],
    };
  });
  const result = await invokeForSealedManifest(readback)({
    nodeId: 'op-readback',
    role: 'readback',
    payload: { id: 'sheet-exact' },
    envelope: envelopeFor('readback', [{ role: 'destination', value: { id: 'sheet-exact' } }]),
    identity,
    binding: {
      capabilityId: readback.manifestId,
      toolName: readback.operationId,
      schemaVersion: readback.operationVersion,
      schemaDigest: readback.definitionFingerprint,
      args: {},
      account: readback.accountId,
      effect: 'read',
      invoke: async () => ({}),
    },
  });
  assert.deepEqual((result as { content: unknown }).content, FIVE);
});

test('lost create recovery is unsupported and does not retry', async () => {
  const dest = manifestByPurpose('persist_collection');
  let calls = 0;
  installProductionTransport(async () => {
    calls += 1;
    throw new Error('should not probe');
  });
  const recovered = await reconcileForSealedManifest(dest)({ intendedDigest: 'a'.repeat(64) });
  assert.equal(recovered.exists, false);
  assert.equal(calls, 0);
  const digestAsId = await reconcileHostCreate({ intendedDigest: 'sheet-1', artifactId: 'b'.repeat(64) });
  assert.equal(digestAsId.exists, false);
});

test('create args satisfy the cached live tool schema required fields', async () => {
  rememberToolSchema('GOOGLESHEETS_SHEET_FROM_JSON', {
    type: 'object',
    required: ['title', 'sheet_name', 'sheet_json'],
    properties: {
      title: { type: 'string' },
      sheet_name: { type: 'string' },
      sheet_json: { type: 'array' },
    },
  });
  saveToolContract({
    identifier: 'GOOGLESHEETS_SHEET_FROM_JSON',
    schema: {
      type: 'object',
      required: ['title', 'sheet_name', 'sheet_json'],
      properties: {
        title: { type: 'string' },
        sheet_name: { type: 'string' },
        sheet_json: { type: 'array' },
      },
    },
    providerObservedAt: new Date().toISOString(),
  });
  const args = createArgsFromEnvelope(envelopeFor('destination', [{ role: 'transform', value: FIVE }]), FIVE);
  const { grid, ...providerArgs } = args;
  assert.deepEqual(Object.keys(providerArgs).sort(), ['sheet_json', 'sheet_name', 'title']);
  assert.ok(grid.header.length > 0);
  assert.equal(grid.rows.length, 5);
});

test('host transform is locally executable and does not require a provider', async () => {
  const rows = [{ name: 'a' }, { name: 'b' }];
  const result = await invokeHostCompute({
    nodeId: 'op-transform',
    role: 'transform',
    payload: rows,
    identity,
    binding: {
      capabilityId: 'cap:host_compute:transform',
      toolName: 'host_compute',
      schemaVersion: '1',
      schemaDigest: 'a'.repeat(64),
      args: {},
      effect: 'compute',
      invoke: invokeHostCompute,
    },
  });
  assert.deepEqual(result, rows);
});

test('changing role does not select another sealed provider operation', async () => {
  const source = manifestByPurpose('locate_source');
  const seen: string[] = [];
  installProductionTransport(async (call) => {
    seen.push(call.operationId);
    return { locator: 'loc-role', query: 'q' };
  });
  const ports = sealedPortsForManifest(source);
  const locator = await ports.invoke({
    nodeId: 'op-source',
    role: 'collection',
    payload: null,
    envelope: envelopeFor('source'),
    identity,
    binding: {
      capabilityId: source.manifestId,
      toolName: source.operationId,
      schemaVersion: source.operationVersion,
      schemaDigest: source.definitionFingerprint,
      args: {},
      account: source.accountId,
      effect: 'read',
      invoke: ports.invoke,
    },
  });
  assert.equal(typeof (locator as { locator?: string }).locator, 'string');
  assert.deepEqual(seen, [source.operationId]);
  assert.equal(source.operationId, 'TAVILY_TAVILY_SEARCH');
});

test('opaque current external write crosses its exact sealed port once without provider-name semantics', async () => {
  const manifest = opaqueExternalWriteManifest();
  const canonicalArgs = {
    q7: 'sealed-value',
    k2: { m4: 17 },
  };
  assert.doesNotMatch(
    `${manifest.operationId} ${manifest.purpose} ${manifest.externalDefinition?.semanticName ?? ''}`,
    /create|update|delete|write|send|sheet|mail|slack|outlook|airtable|calendar/i,
  );
  const calls: Array<{
    operationId: string;
    args: Record<string, unknown>;
    accountId: string;
    expected?: unknown;
  }> = [];
  installProductionTransport(async (call) => {
    calls.push(call);
    return { q7: 'provider-result', receipt: 'receipt:q7x9:k2m4' };
  });
  const result = await invokeForSealedManifest(manifest)(opaqueWriteInvocation(manifest, canonicalArgs));
  assert.deepEqual(result, { q7: 'provider-result', receipt: 'receipt:q7x9:k2m4' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operationId, manifest.operationId);
  assert.equal(calls[0]?.accountId, manifest.accountId);
  assert.deepEqual(calls[0]?.args, canonicalArgs);
  assert.deepEqual(calls[0]?.expected, {
    manifestId: manifest.manifestId,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    providerIdentity: manifest.providerIdentity,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    definitionFingerprint: manifest.definitionFingerprint,
    providerInputSchemaDigest: manifest.externalDefinition?.providerInputSchemaDigest,
    providerOutputSchemaObserved: true,
    providerOutputSchemaDigest: manifest.externalDefinition?.providerOutputSchemaDigest,
    invokePortId: manifest.invokePortId,
    argumentCompiler: manifest.argumentCompiler,
  });
});

test('opaque external write refuses stale manifests and identity drift before transport', async () => {
  const current = opaqueExternalWriteManifest();
  const canonicalArgs = { q7: 'sealed-value' };
  let calls = 0;
  installProductionTransport(async () => {
    calls += 1;
    return { unexpected: true };
  });
  const stale = {
    ...current,
    lifecycle: { state: 'revoked' as const },
  };
  await assert.rejects(
    () => invokeForSealedManifest(stale)(opaqueWriteInvocation(stale, canonicalArgs)),
    /requires a current sealed manifest/,
  );
  await assert.rejects(
    () => invokeForSealedManifest(current)(opaqueWriteInvocation(current, canonicalArgs, {
      providerIdentity: 'carrier:drifted',
    })),
    /does not match the current sealed manifest port/,
  );
  assert.equal(calls, 0);
});

test('opaque timeout stays uncertain, invokes once, and cannot trigger a generic reconcile retry', async () => {
  const manifest = opaqueExternalWriteManifest();
  let calls = 0;
  installProductionTransport(async () => {
    calls += 1;
    throw new Error('opaque transport timeout; outcome uncertain');
  });
  await assert.rejects(
    () => invokeForSealedManifest(manifest)(opaqueWriteInvocation(manifest, { q7: 'sealed-value' })),
    /timeout; outcome uncertain/,
  );
  const recovered = await reconcileForSealedManifest(manifest)({
    intendedDigest: '6'.repeat(64),
    artifactId: 'opaque-resource-q7x9',
  });
  assert.deepEqual(recovered, { exists: false });
  assert.equal(calls, 1);
});

test('sheet adapters refuse to cross when outbound is denied or uncredentialed', async () => {
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  try {
    assert.equal(productionProviderCrossingAllowed(), false);
    await assert.rejects(
      () => invokeHostCreate({
        nodeId: 'op-write',
        role: 'destination',
        payload: [{ name: 'a' }],
        identity,
        binding: {
          capabilityId: 'cap:host_create:destination',
          toolName: 'host_create',
          schemaVersion: '1',
          schemaDigest: 'a'.repeat(64),
          args: {},
          effect: 'external_write',
          invoke: invokeHostCreate,
        },
      }),
      /transport unavailable/,
    );
  } finally {
    if (previous === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous;
  }
});

test('an arbitrary external write cannot inherit the transport\'s Sheets-shaped reconcile', async () => {
  const manifest = {
    ...opaqueExternalWriteManifest(),
    reconciliation: { supported: true as const, policy: 'exact_artifact' as const },
  };
  const { bindAttestedTransport } = await import('./implementation-artifacts/attested-transport.js');
  let executes = 0;
  let reconciles = 0;
  bindAttestedTransport({
    digest: 'fixture:opaque-reconcile',
    execute: async () => {
      executes += 1;
      return {};
    },
    observe: () => null,
    reconcile: async () => {
      reconciles += 1;
      return { exists: true, artifactId: 'opaque-resource-q7x9' };
    },
  });
  const result = await reconcileForSealedManifest(manifest)({
    intendedDigest: '7'.repeat(64),
    artifactId: 'opaque-resource-q7x9',
  });
  assert.deepEqual(result, { exists: false });
  assert.equal(executes, 0);
  assert.equal(reconciles, 0);
});
