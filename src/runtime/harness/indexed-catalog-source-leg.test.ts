/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/indexed-catalog-source-leg.test.ts
 *
 * THE SOURCE LEG — the leg that binds zero times.
 *
 * Measured 2026-08-21: of 467 compiled turn graphs on a live install, exactly one
 * carried a bound operation. Replaying `synthesizeConstructOperations` against the
 * real 2,368-operation index showed why — across five canonical objectives the
 * create, transform and readback legs all bound, and `searchRead` bound NONE.
 *
 * The mechanism is crowding, not absence. A user who names the destination
 * ("...into a google sheet") writes an objective whose strongest BM25 terms all
 * belong to the destination carrier, so the shortlist fills with that carrier's
 * operations and the capability that could actually carry the goal never reaches
 * the catalog. The existing indexed-capability-catalog pin does not see this: its
 * source read lives on a different carrier from its write and its index holds
 * three rows, so nothing is ever crowded out.
 *
 * These tests pin the ACCEPTANCE CRITERION rather than any one mechanism, because
 * two different fixes are plausible (additive roles vs. separately-budgeted source
 * retrieval) and only the outcome is agreed:
 *
 *   1. An objective that names its destination still binds a source.
 *   2. That source is one that can carry the goal — never the destination carrier
 *      searching itself. Binding a wrong-goal operation is worse than failing
 *      closed: it executes and returns confident garbage.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-source-leg-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-source-leg\n', 'utf8');

const { recordCapabilityOperations } = await import('../../memory/capability-index.js');
const { rememberToolSchema } = await import('../../tools/composio-schema-cache.js');
const { createSession, appendEvent, closeEventLog } = await import('./eventlog.js');
const {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} = await import('./host-capability-catalog-factory.js');
const { createCapabilityManifestStore, installCapabilityManifestStore } = await import('./capability-manifest-store.js');
const { catalogEntriesForAcceptedSource, registerIndexedCapabilitiesForTurn } = await import('./indexed-capability-catalog.js');
const { synthesizeConstructOperations } = await import('../semantic-boundary/host-bind-operations.js');
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
  required: ['query'],
  properties: { query: { type: 'string' }, limit: { type: 'integer' } },
};
const CREATE_SCHEMA = {
  type: 'object',
  required: ['title', 'sheet_name', 'sheet_json'],
  properties: { title: { type: 'string' }, sheet_name: { type: 'string' }, sheet_json: { type: 'string' } },
};
const GENERIC_SCHEMA = {
  type: 'object',
  required: ['spreadsheet_id'],
  properties: { spreadsheet_id: { type: 'string' }, ranges: { type: 'array' } },
};

/** The destination carrier the user names. Real installs carry 200+ ops per app. */
const SHEET_OPS = 26;

/**
 * A realistic install: one fat destination carrier, plus a single research
 * capability on its own carrier that is the only thing able to answer the ASK.
 */
function seedRealisticIndex(): void {
  const rows = [];
  for (let i = 0; i < SHEET_OPS; i += 1) {
    rows.push({
      identifier: `SPREADSHEET_KIT_OP_${i}`,
      carrierKind: 'composio' as const,
      carrier: 'spreadsheet_kit',
      displayName: `Spreadsheet operation ${i}`,
      description: 'Work with a spreadsheet workbook: sheets, rows, ranges, values, columns.',
      effectClass: 'read' as const,
      effectProvenance: 'inferred' as const,
    });
    rememberToolSchema(`SPREADSHEET_KIT_OP_${i}`, GENERIC_SCHEMA);
  }
  rows.push({
    identifier: 'SPREADSHEET_KIT_FROM_JSON',
    carrierKind: 'composio' as const,
    carrier: 'spreadsheet_kit',
    displayName: 'Create spreadsheet from JSON',
    description: 'Create a new spreadsheet workbook from collected rows.',
    effectClass: 'write' as const,
    effectProvenance: 'inferred' as const,
  });
  rows.push({
    identifier: 'SPREADSHEET_KIT_BATCH_GET',
    carrierKind: 'composio' as const,
    carrier: 'spreadsheet_kit',
    displayName: 'Read spreadsheet',
    description: 'Read back a spreadsheet workbook by id.',
    effectClass: 'read' as const,
    effectProvenance: 'inferred' as const,
  });
  // The ONLY capability that can answer "find the top restaurants".
  rows.push({
    identifier: 'WEBINDEX_SEARCH',
    carrierKind: 'composio' as const,
    carrier: 'webindex',
    displayName: 'Search the web',
    description: 'Find restaurants, businesses and other public listings on the web.',
    effectClass: 'read' as const,
    effectProvenance: 'inferred' as const,
  });
  recordCapabilityOperations(rows);
  rememberToolSchema('SPREADSHEET_KIT_FROM_JSON', CREATE_SCHEMA);
  rememberToolSchema('SPREADSHEET_KIT_BATCH_GET', GENERIC_SCHEMA);
  rememberToolSchema('WEBINDEX_SEARCH', SEARCH_SCHEMA);
}

/** The shape a user actually types: the destination is named, so it dominates the text. */
const OBJECTIVE = 'Find the top 5 restaurants and put them on a new spreadsheet';

const CONNECTED_SEARCH = {
  type: 'object',
  required: ['q'],
  properties: { q: { type: 'string' }, limit: { type: 'integer' } },
};

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

function provisionConnectedGoalCatalog(): void {
  rememberToolSchema('FIRECRAWL_SEARCH', CONNECTED_SEARCH);
  rememberToolSchema('GOOGLESHEETS_SHEET_FROM_JSON', CREATE_SCHEMA);
  rememberToolSchema('GOOGLESHEETS_BATCH_GET', GENERIC_SCHEMA);
  installConnectedRegistryPort(() => ({
    connectedToolkits: ['firecrawl', 'googlesheets'],
    tools: [
      { slug: 'FIRECRAWL_SEARCH', schema: CONNECTED_SEARCH },
      { slug: 'GOOGLESHEETS_SHEET_FROM_JSON', schema: CREATE_SCHEMA },
      { slug: 'GOOGLESHEETS_BATCH_GET', schema: GENERIC_SCHEMA },
    ],
  }));
  installCapabilityManifestStore(createCapabilityManifestStore());
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory());
  registerAttested({ slug: 'FIRECRAWL_SEARCH', effect: 'read', roles: ['source', 'collection'] });
  registerAttested({
    slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
    effect: 'external_write',
    roles: ['create', 'destination'],
    destination: { family: 'workbook', posture: 'create_new' },
  });
  registerAttested({ slug: 'GOOGLESHEETS_BATCH_GET', effect: 'read', roles: ['readback'] });
  registerAttested({ slug: 'host_transform', effect: 'host_only', roles: ['transform', 'extract'] });
}

test('an objective that names its destination still binds a source that carries the goal', async () => {
  seedRealisticIndex();
  provisionConnectedGoalCatalog();

  const session = createSession({ kind: 'chat', userId: 'source-leg-user' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: OBJECTIVE },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };

  await registerIndexedCapabilitiesForTurn({ ...identity, objective: OBJECTIVE });
  await recordConnectedGoalCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    objective: OBJECTIVE,
  });
  const catalog = catalogEntriesForAcceptedSource({ ...identity, objective: OBJECTIVE });

  assert.equal(
    catalog.some((entry) => /^SPREADSHEET_KIT_OP_/.test(entry.toolName)),
    false,
    'index crowding must not enter the bindable catalog',
  );
  // The destination binds — this leg was never the problem.
  assert.ok(
    catalog.some((entry) => entry.effect === 'external_write'),
    'the named destination must reach the catalog',
  );

  const bound = synthesizeConstructOperations({
    construct: 'collect_then_construct',
    objective: OBJECTIVE,
    destinationFamily: 'workbook',
    effectCeiling: 'external_write',
    count: 5,
    identity,
  });

  assert.ok(bound, 'host-bind must not fail closed when the install can carry the goal');
  const sourceOp = bound.find((operation) => operation.role === 'source');
  assert.ok(sourceOp, 'the SOURCE leg must bind — this is the leg that binds zero times in production');
  assert.match(sourceOp.capabilityRef, /firecrawl_search/);
});

test('the destination carrier is never bound as its own source', async () => {
  provisionConnectedGoalCatalog();
  const session = createSession({ kind: 'chat', userId: 'source-leg-user-2' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: OBJECTIVE },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };

  await registerIndexedCapabilitiesForTurn({ ...identity, objective: OBJECTIVE });
  await recordConnectedGoalCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    objective: OBJECTIVE,
  });
  const bound = synthesizeConstructOperations({
    construct: 'collect_then_construct',
    objective: OBJECTIVE,
    destinationFamily: 'workbook',
    effectCeiling: 'external_write',
    count: 5,
    identity,
  });

  assert.ok(bound, 'host-bind must succeed from connected attested tools');
  const sourceOp = bound.find((operation) => operation.role === 'source');
  assert.ok(sourceOp, 'source leg must bind');
  assert.ok(
    !sourceOp.capabilityRef.includes('spreadsheet_kit')
    && !sourceOp.capabilityRef.includes('googlesheets'),
    `the spreadsheet cannot be the source of "top 5 restaurants" — bound ${sourceOp.capabilityRef}. `
    + 'Binding a wrong-goal operation is worse than failing closed: it executes and returns garbage.',
  );
});
