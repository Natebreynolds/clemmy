/**
 * STEP 0 of docs/SPELLING-IS-NOT-IDENTITY-PLAN-2026-09-18.md — the truth pin.
 *
 * The framework decides "is this an operation, and what performs it?" in 21
 * places, every one by testing the name against Composio's spelling convention
 * `/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/`. A reviewed CLI read is lower_snake, so
 * all 21 answer "not an operation" for it — which is how one workflow produced
 * twelve different failures on the path from citing a Salesforce read to
 * running it.
 *
 * A manifest already DECLARES what performs an operation (`providerKind`) and
 * what it does (`effect`). This pins the one question the whole wave replaces
 * those 21 sites with:
 *
 *     operationIdentity(name) -> { operationId, providerKind, effect } | null
 *
 * It must answer for EVERY provider kind, from identity alone, with no regex
 * anywhere in the path. A name no registry carries is not an operation — that
 * is the point, and it is why there is no shape fallback here.
 *
 * NOTHING in Step 2 moves until this is green: if identity cannot answer for
 * all four kinds, replacing 11 call sites with it would trade a wrong answer
 * for no answer.
 *
 * Run: node scripts/run-tests-isolated.mjs src/tools/operation-identity.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-operation-identity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-operation-identity-step0\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityManifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const { operationIdentity } = await import('./operation-name-identity.js');

/** The reviewed CLI read every one of the 21 sites currently misclassifies. */
const CLI_READ = 'salesforce_sf_soql_query';

/** One registered operation per remaining provider kind, so identity is proven
 *  across the whole space rather than for the carrier that happened to break. */
const FIXTURES = [
  { operationId: 'FIXTURE_SHEETS_VALUES_GET', providerKind: 'composio', effect: 'read', account: 'ca_fixture_sheets' },
  { operationId: 'fixture__mcp_read_rows', providerKind: 'native_mcp', effect: 'read', account: 'mcp:fixture' },
  { operationId: 'fixture_local_profile_read', providerKind: 'local_registry', effect: 'read', account: 'local:host' },
] as const;

test.before(() => {
  const store = manifestStores.createCapabilityManifestStore([], { durable: true });
  manifestStores.installCapabilityManifestStore(store);
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  for (const fixture of FIXTURES) {
    const manifest = capabilityManifests.attachSemanticContract({
      version: 1,
      manifestId: `cap:fixture:${fixture.providerKind}:${fixture.operationId}`,
      providerKind: fixture.providerKind,
      operationId: fixture.operationId,
      providerIdentity: `/fixture/${fixture.providerKind}`,
      providerVersion: 'fixture-v1',
      operationVersion: '1',
      definitionFingerprint: 'e'.repeat(64),
      effect: fixture.effect,
      accountId: fixture.account,
      idempotency: { required: false, policy: 'none' },
      reconciliation: { supported: false, policy: 'none' },
      outputContract: { kind: 'records' },
      evidenceContract: { kinds: ['payload'], readbackRequired: false },
      purpose: 'collect_records',
      provenance: { issuer: 'step0:operation-identity', issuedAt: '2026-09-18T00:00:00.000Z', trusted: true },
      lifecycle: { state: 'current' },
    });
    assert.equal(store.install(manifest).ok, true, `${fixture.operationId} installs`);
    factory.register({
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      account: manifest.accountId,
      manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: async () => { throw new Error('identity never dispatches'); },
    });
  }
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
});

test.after(() => {
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('identity answers for a reviewed CLI read — the carrier all 21 sites miss', () => {
  const identity = operationIdentity(CLI_READ);
  assert.ok(identity, `THE WHOLE DEFECT: ${CLI_READ} must resolve by identity, not by spelling`);
  assert.equal(identity.providerKind, 'reviewed_cli', 'the manifest declares what performs it');
  assert.equal(identity.effect, 'read', 'and declares what it does');
  assert.equal(identity.operationId, CLI_READ);
});

test('identity answers for every other provider kind', () => {
  for (const fixture of FIXTURES) {
    const identity = operationIdentity(fixture.operationId);
    assert.ok(identity, `${fixture.operationId} (${fixture.providerKind}) must resolve`);
    assert.equal(identity.providerKind, fixture.providerKind, `${fixture.operationId} declares its carrier`);
    assert.equal(identity.effect, fixture.effect, `${fixture.operationId} declares its effect`);
  }
});

test('identity is case-insensitive on the name but never invents one', () => {
  assert.equal(operationIdentity('SALESFORCE_SF_SOQL_QUERY')?.operationId, CLI_READ,
    'the same operation however it is spelled');
  assert.equal(operationIdentity('  salesforce_sf_soql_query  ')?.operationId, CLI_READ);
});

test('a name no registry carries is not an operation', () => {
  // NO SHAPE FALLBACK. An UPPER_SNAKE name that no registry knows must resolve
  // to nothing — otherwise this module reintroduces the very guess the wave
  // exists to delete, and the 21 sites would keep their wrong answer behind a
  // new function name.
  assert.equal(operationIdentity('TOTALLY_UNKNOWN_PROVIDER_ACTION'), null,
    'spelling must not manufacture an operation');
  assert.equal(operationIdentity('totally_unknown_local_thing'), null);
  assert.equal(operationIdentity(''), null);
  assert.equal(operationIdentity('   '), null);
});
