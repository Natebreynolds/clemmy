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
  getCachedToolSchema,
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
  assert.deepEqual(getCachedToolSchema(operationId), schema,
    'durable rehydration preserves the entire schema, independent of object-member order');
  assert.equal(digestSchema(getCachedToolSchema(operationId)), manifest.externalDefinition!.providerInputSchemaDigest);
  const refused = entry.validateForegroundPayload!({ wrong_id: 'record-42' });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.repair, /^\[provider-dispatch:not-started:invalid-args\] FIXTURE_LOOKUP_RECORD arguments did not match its exact current schema\./);
  // Exact failing pointers replace the old top-level name lists.
  assert.match(refused.repair, /Failing paths: "\/record_key" \(missing required, expected string\), "\/wrong_id" \(unknown field\)\./);
  const shape = refused.repair.match(/Required shape at "\/": object; required: \[record_key\]; ([^.]+)\./);
  assert.ok(shape, 'the repair includes the required object field');
  assert.deepEqual(new Set(shape[1]!.split(', ')), new Set(['record_key*: string', 'include_metadata: boolean']),
    'the repair preserves both field types without depending on schema object-member order');
  // The refusal never sends the model to discovery: the recovery surface the
  // host derives from it contains only the refused carrier. The single
  // remaining mention of tool_search is the negative instruction.
  assert.doesNotMatch(refused.repair, /call the first-class local tool_search/i);
  assert.doesNotMatch(refused.repair, /do not put a local control name inside a provider execution carrier/i);
  assert.equal(refused.repair.replace(/do not call tool_search/g, '').includes('tool_search'), false);
  assert.match(refused.repair, /Retry this same operation exactly once with one corrected JSON object; do not call tool_search or substitute another operation\. No provider request was sent\.$/);
  // The catalog entry's validation type is the generic foreground shape; the
  // proof validator's host-authored repair key rides on it structurally.
  assert.match((refused as { repairKey?: string }).repairKey ?? '', /^[a-f0-9]{64}$/);
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
