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
