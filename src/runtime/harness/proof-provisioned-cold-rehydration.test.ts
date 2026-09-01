/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/proof-provisioned-cold-rehydration.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-proof-cold-validator-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { attachSemanticContract } = await import('./capability-manifest.js');
const {
  createProductionCapabilityAdapter,
  registeredCapabilityFromManifest,
} = await import('./production-capability-adapter.js');
const { createCapabilityManifestStore } = await import('./capability-manifest-store.js');
const { createHostCapabilityCatalogFactory } = await import('./host-capability-catalog-factory.js');
const {
  registerIndependentCapabilityObservation,
} = await import('./independent-capability-observation.js');
const {
  rememberToolSchema,
  resetToolSchemaCache,
} = await import('../../tools/composio-schema-cache.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('cold adapter rehydration restores exact proof-argument validation from its digest-bound durable schema', async () => {
  const operationId = 'FIXTURE_LOOKUP_RECORD';
  const schema = {
    type: 'object',
    required: ['record_key'],
    properties: {
      record_key: { type: 'string' },
      include_metadata: { type: 'boolean' },
    },
  };
  rememberToolSchema(operationId, schema);
  resetToolSchemaCache();

  const manifest = attachSemanticContract({
    version: 1,
    manifestId: 'cap:resolved:fixture_lookup_record',
    providerKind: 'composio',
    operationId,
    providerIdentity: 'composio',
    providerVersion: 'fixture-provider-v1',
    operationVersion: '1',
    definitionFingerprint: 'a'.repeat(64),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: digestSchema(schema),
      providerOutputSchemaObserved: true,
      semanticName: 'fixture lookup record',
      behaviorHints: {
        readOnly: true,
        destructive: false,
        idempotent: null,
        openWorld: null,
      },
    },
    effect: 'read',
    accountId: 'account:fixture:lookup',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: {
      issuer: 'host:resolution-proof',
      issuedAt: '1970-01-01T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['lookup'],
    argumentCompiler: { id: 'compile:proof-schema:v1', version: '1' },
  });
  let providerBodies = 0;
  const entry = registeredCapabilityFromManifest({
    manifest,
    observation: {
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      accountId: manifest.accountId,
      observedAt: Date.now(),
    },
    invoke: async () => {
      providerBodies += 1;
      return { records: [{ key: 'record-42' }] };
    },
  });

  assert.ok(entry.validateForegroundPayload,
    'the pre-existing proof manifest must regain its validator after the in-memory cache is cleared');
  const refused = entry.validateForegroundPayload!({ wrong_id: 'record-42' });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.repair, /Allowed top-level fields: "record_key", "include_metadata"/);
  assert.match(refused.repair, /Remove unknown fields: "wrong_id"/);
  assert.match(refused.repair, /call the first-class local tool_search control directly/i);
  assert.match(refused.repair, /do not put a local control name inside a provider execution carrier/i);
  assert.match(refused.repair, /No provider request was sent/);
  assert.equal(providerBodies, 0);

  const corrected = entry.validateForegroundPayload!({ record_key: 'record-42' });
  assert.deepEqual(corrected, { ok: true });
  await entry.invoke({
    nodeId: 'fixture-lookup',
    role: 'foreground',
    payload: { record_key: 'record-42' },
    identity: {
      sessionId: 'session:fixture',
      sourceUserSeq: 1,
      acceptedTaskId: 'task:fixture',
    },
    binding: entry,
  });
  assert.equal(providerBodies, 1);

  const { validateForegroundPayload: _legacyMissingValidator, ...legacyEntry } = entry;
  const factory = createHostCapabilityCatalogFactory([legacyEntry]);
  const store = createCapabilityManifestStore([manifest]);
  const observedAt = Date.now();
  assert.deepEqual(registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt,
    origin: 'independent',
    observe: () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt,
    }),
  }), { ok: true });
  const adapter = createProductionCapabilityAdapter({ factory, store });
  assert.deepEqual(adapter.refresh(new Set([manifest.manifestId])), {
    registered: 1,
    refused: [],
  });
  assert.ok(factory.get(manifest.manifestId)?.validateForegroundPayload,
    'refresh must enrich a still-current mixed-generation row instead of skipping it');
});
