/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/indexed-capability-catalog.test.ts
 *
 * Connect-time index → first-turn bind, with no use-derived receipt.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-indexed-catalog-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-indexed-catalog\n', 'utf8');

const { recordCapabilityOperations } = await import('../../memory/capability-index.js');
const { rememberToolSchema } = await import('../../tools/composio-schema-cache.js');
const { createSession, appendEvent, closeEventLog } = await import('./eventlog.js');
const {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} = await import('./host-capability-catalog-factory.js');
const { createCapabilityManifestStore, installCapabilityManifestStore } = await import('./capability-manifest-store.js');
const {
  catalogEntriesForAcceptedSource,
  hostDescriptorsFromCapabilityIndex,
  registerIndexedCapabilitiesForTurn,
} = await import('./indexed-capability-catalog.js');
const { synthesizeConstructOperations } = await import('../semantic-boundary/host-bind-operations.js');
const { provenCapabilityEntriesForTurn } = await import('./capability-resolution.js');
const {
  installConnectedRegistryPort,
  recordConnectedGoalCatalog,
} = await import('./connected-goal-catalog.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('./capability-manifest.js');
import { createHash } from 'node:crypto';
import type { RegisteredHostCapability } from './host-capability-catalog-factory.js';
import type { ManifestEffect } from './capability-manifest.js';

test.after(() => {
  installConnectedRegistryPort(null);
  closeEventLog();
});

const SEARCH_SCHEMA = {
  type: 'object',
  required: ['q'],
  properties: { q: { type: 'string' }, limit: { type: 'integer' } },
};
const CREATE_SCHEMA = {
  type: 'object',
  required: ['title', 'sheet_name', 'sheet_json'],
  properties: {
    title: { type: 'string' },
    sheet_name: { type: 'string' },
    sheet_json: { type: 'string' },
  },
};
const READBACK_SCHEMA = {
  type: 'object',
  required: ['spreadsheet_id'],
  properties: { spreadsheet_id: { type: 'string' }, ranges: { type: 'array' } },
};

const OBJECTIVE = 'Find the top 5 restaurants and put them on a new spreadsheet';

function seedIndex(): void {
  recordCapabilityOperations([
    {
      identifier: 'WEBINDEX_SEARCH',
      carrierKind: 'composio',
      carrier: 'webindex',
      displayName: 'Search the web',
      description: 'Find restaurants and other public listings on the web.',
      effectClass: 'read',
      effectProvenance: 'inferred',
    },
    {
      identifier: 'SPREADSHEET_KIT_FROM_JSON',
      carrierKind: 'composio',
      carrier: 'spreadsheet_kit',
      displayName: 'Create spreadsheet from JSON',
      description: 'Create a new spreadsheet workbook from collected rows.',
      effectClass: 'write',
      effectProvenance: 'inferred',
    },
    {
      identifier: 'SPREADSHEET_KIT_BATCH_GET',
      carrierKind: 'composio',
      carrier: 'spreadsheet_kit',
      displayName: 'Read spreadsheet',
      description: 'Read back a spreadsheet workbook by id.',
      effectClass: 'read',
      effectProvenance: 'inferred',
    },
  ]);
  rememberToolSchema('WEBINDEX_SEARCH', SEARCH_SCHEMA);
  rememberToolSchema('SPREADSHEET_KIT_FROM_JSON', CREATE_SCHEMA);
  rememberToolSchema('SPREADSHEET_KIT_BATCH_GET', READBACK_SCHEMA);
}

test('a cold index does not invent descriptors', () => {
  assert.deepEqual(hostDescriptorsFromCapabilityIndex('restaurants spreadsheet'), []);
});

test('a provisioned carrier is visible to typed bind with no prior receipt', async () => {
  seedIndex();
  const descriptors = hostDescriptorsFromCapabilityIndex(OBJECTIVE);
  assert.ok(descriptors.some((entry) => entry.id.includes('spreadsheet_kit_from_json')));
  assert.ok(descriptors.some((entry) => entry.effect === 'external_write'));
  assert.ok(descriptors.every((entry) => entry.id.startsWith('cap:resolved:')));

  installCapabilityManifestStore(createCapabilityManifestStore());
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory());
  const session = createSession({ kind: 'chat', userId: 'index-user' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: OBJECTIVE },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  assert.equal(provenCapabilityEntriesForTurn(identity).length, 0, 'blank-state: no use-derived proof');

  const materialized = await registerIndexedCapabilitiesForTurn({
    ...identity,
    objective: OBJECTIVE,
  });
  assert.deepEqual(materialized.registered, [], 'index hits must not install bindable capabilities');

  const catalog = catalogEntriesForAcceptedSource({ ...identity, objective: OBJECTIVE });
  assert.equal(catalog.some((entry) => entry.effect === 'external_write'), false,
    'an index id is not bind authority');

  const bound = synthesizeConstructOperations({
    construct: 'collect_then_construct',
    objective: OBJECTIVE,
    destinationFamily: 'workbook',
    effectCeiling: 'external_write',
    count: 5,
    identity,
  });
  assert.equal(bound, null, 'host-bind must not succeed from an index hit alone');
});

function registerAttested(input: {
  slug: string;
  effect: ManifestEffect;
  roles: readonly string[];
  destination?: { family: string; posture: string };
}): void {
  const factory = peekHostCapabilityCatalogFactory() ?? createHostCapabilityCatalogFactory();
  if (!peekHostCapabilityCatalogFactory()) installHostCapabilityCatalogFactory(factory);
  const fingerprint = createHash('sha256').update(`attested:${input.slug}`).digest('hex');
  const write = input.effect === 'external_write' || input.effect === 'local_write';
  const manifest = attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:${input.slug.toLowerCase()}`,
    providerKind: input.effect === 'host_only' ? 'local_registry' : 'composio',
    operationId: input.slug,
    providerIdentity: input.effect === 'host_only' ? 'local_registry' : 'composio',
    providerVersion: 'v1',
    operationVersion: '1',
    definitionFingerprint: fingerprint,
    effect: input.effect,
    ...(input.destination ? { destination: input.destination } : {}),
    accountId: input.effect === 'host_only' ? 'host:runtime' : 'acct:connected:v1',
    idempotency: { required: write, policy: write ? 'key_before_dispatch' : 'none' },
    reconciliation: { supported: write, policy: write ? 'exact_artifact' : 'none' },
    outputContract: { kind: write ? 'created_resource' : 'records' },
    evidenceContract: { kinds: write ? ['receipt', 'readback'] : ['payload'], readbackRequired: write },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-21T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: [...input.roles],
  });
  const entry: RegisteredHostCapability = {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    destination: manifest.destination,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({ handle: input.slug }),
  };
  factory.register(entry);
}

test('a connected attested capability binds on first use without receipts or index authority', async () => {
  installConnectedRegistryPort(() => ({
    connectedToolkits: ['firecrawl', 'googlesheets'],
    tools: [
      { slug: 'FIRECRAWL_SEARCH', schema: SEARCH_SCHEMA },
      { slug: 'GOOGLESHEETS_SHEET_FROM_JSON', schema: CREATE_SCHEMA },
      { slug: 'GOOGLESHEETS_BATCH_GET', schema: READBACK_SCHEMA },
    ],
  }));
  rememberToolSchema('FIRECRAWL_SEARCH', SEARCH_SCHEMA);
  rememberToolSchema('GOOGLESHEETS_SHEET_FROM_JSON', CREATE_SCHEMA);
  rememberToolSchema('GOOGLESHEETS_BATCH_GET', READBACK_SCHEMA);
  installCapabilityManifestStore(createCapabilityManifestStore());
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory());
  registerAttested({
    slug: 'FIRECRAWL_SEARCH',
    effect: 'read',
    roles: ['source', 'collection'],
  });
  registerAttested({
    slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
    effect: 'external_write',
    roles: ['create', 'destination'],
    destination: { family: 'workbook', posture: 'create_new' },
  });
  registerAttested({
    slug: 'GOOGLESHEETS_BATCH_GET',
    effect: 'read',
    roles: ['readback'],
  });
  registerAttested({
    slug: 'host_transform',
    effect: 'host_only',
    roles: ['transform', 'extract'],
  });

  const session = createSession({ kind: 'chat', userId: 'connected-first-use' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: OBJECTIVE },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  assert.equal(provenCapabilityEntriesForTurn(identity).length, 0, 'blank-state: no use-derived proof');

  await recordConnectedGoalCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    objective: OBJECTIVE,
  });
  const selected = provenCapabilityEntriesForTurn(identity);
  assert.ok(selected.some((entry) => entry.identifier === 'FIRECRAWL_SEARCH'));
  assert.ok(selected.some((entry) => entry.identifier === 'GOOGLESHEETS_SHEET_FROM_JSON'));

  const catalog = catalogEntriesForAcceptedSource({ ...identity, objective: OBJECTIVE });
  assert.ok(catalog.some((entry) => entry.toolName === 'FIRECRAWL_SEARCH'));
  assert.ok(catalog.some((entry) => entry.effect === 'external_write'));
  assert.equal(
    catalog.some((entry) => entry.toolName.startsWith('WEBINDEX') || entry.toolName.startsWith('SPREADSHEET_KIT')),
    false,
    'index-only slugs stay out of the bindable catalog',
  );

  const bound = synthesizeConstructOperations({
    construct: 'collect_then_construct',
    objective: OBJECTIVE,
    destinationFamily: 'workbook',
    effectCeiling: 'external_write',
    count: 5,
    identity,
  });
  assert.ok(bound, 'adapter-attested connected tools must bind without prior use');
  const sourceOp = bound.find((operation) => operation.role === 'source');
  assert.ok(sourceOp, 'source leg binds from the connected search');
  assert.match(sourceOp.capabilityRef, /firecrawl_search/);
  assert.doesNotMatch(sourceOp.capabilityRef, /googlesheets/);
});
