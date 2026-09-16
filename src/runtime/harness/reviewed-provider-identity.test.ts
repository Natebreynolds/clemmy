import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-reviewed-provider-identity-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(home, 'state'), { recursive: true });

const identity = await import('./reviewed-provider-identity.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');
const { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } = await import('../../shared/closed-canonical-json.js');

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
test.after(() => { catalogs.installHostCapabilityCatalogFactory(null); rmSync(home, { recursive: true, force: true }); });

/** A reviewed-CLI-style entry: no externalDefinition on the manifest, schema deposited in the contract cache. */
function reviewedCliFixture(operationId = 'reviewed_cli_query_fixture') {
  const manifest = manifests.attachSemanticContract({
    version: 1, manifestId: `cap:fixture:reviewed-cli:${operationId}`, providerKind: 'reviewed_cli', operationId,
    providerIdentity: '/usr/bin/fixture-cli', providerVersion: 'fixture-v1', operationVersion: '1',
    definitionFingerprint: sha256(`definition:${operationId}`), effect: 'read', accountId: 'reviewed_cli:host',
    idempotency: { required: false, policy: 'none' }, reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' }, evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-09-01T00:00:00.000Z', trusted: true }, lifecycle: { state: 'current' },
  });
  assert.equal(manifest.externalDefinition, undefined);
  const schema = { type: 'object', properties: { query: { type: 'string', description: 'SOQL' } }, required: ['query'], additionalProperties: false };
  schemas.rememberToolSchema(operationId, schema, Date.now());
  const cached = schemas.getCachedToolSchema(operationId)!;
  assert.ok(cached);
  const entry = {
    capabilityId: manifest.manifestId, toolName: manifest.operationId, schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint, effect: manifest.effect, account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest), providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint, providerInputSchemaDigest: identity.providerInputSchemaDigestOf(cached),
    manifest, invoke: async () => ({ records: [], has_more: false }),
  };
  const factory = catalogs.createHostCapabilityCatalogFactory();
  factory.register(entry);
  catalogs.installHostCapabilityCatalogFactory(factory);
  return { manifest, schema, cached, entry, factory };
}

test('one canonicalisation: the sealed producer digest equals the cached digest and the canonical identity digest', () => {
  const f = reviewedCliFixture();
  const producer = digestSchema(f.schema);
  const sealedRoundTrip = digestSchema(JSON.parse(closedCanonicalJson(f.cached, { ...SEALED_CALL_CANONICAL_LIMITS, omitUndefinedObjectMembers: true })));
  assert.equal(identity.providerInputSchemaDigestOf(f.cached), producer);
  assert.equal(sealedRoundTrip, producer, 'the sealed round trip is an identity for cache JSON');
  const canonical = catalogs.canonicalCatalogIdentityOf(f.entry);
  assert.ok(canonical);
  assert.equal(canonical.providerInputSchemaDigest, producer, 'a callable entry without externalDefinition still carries the digest');
  const current = identity.currentReviewedProviderIdentity(f.manifest.manifestId);
  assert.equal(current.ok, true, JSON.stringify(current)); if (!current.ok) return;
  assert.deepEqual(current.canonical, canonical);
  assert.equal(identity.reviewedProviderIdentityMismatch(current, canonical as unknown as Record<string, unknown>), null);
});

test('a reviewed-CLI entry with a cached schema yields exactly the producer digest', () => {
  const f = reviewedCliFixture('reviewed_cli_producer_digest_fixture');
  // The producer seals digestSchema(inputSchema) at registration; the entry,
  // the canonical identity and the helper all report that same value.
  const producer = digestSchema(f.schema);
  assert.equal(f.entry.providerInputSchemaDigest, producer);
  assert.equal(catalogs.canonicalCatalogIdentityOf(f.entry)?.providerInputSchemaDigest, producer);
  const current = identity.currentReviewedProviderIdentity(f.manifest.manifestId);
  assert.equal(current.ok, true, JSON.stringify(current)); if (!current.ok) return;
  assert.equal(current.canonical.providerInputSchemaDigest, producer);
  assert.equal(identity.providerInputSchemaDigestOf(current.schema), producer);
});

test('a missing entry, a non-callable entry and an uncached schema refuse by exact reason', () => {
  const f = reviewedCliFixture('reviewed_cli_refusal_fixture');
  assert.deepEqual(identity.currentReviewedProviderIdentity('cap:fixture:absent'), { ok: false, reason: 'entry_missing' });
  const bare = { ...f.entry, providerInputSchemaDigest: undefined, capabilityId: 'cap:fixture:no-digest' };
  const bareManifest = { ...f.manifest, manifestId: 'cap:fixture:no-digest' };
  f.factory.register({ ...bare, manifest: bareManifest, manifestDigest: manifests.capabilityManifestDigest(bareManifest) });
  const noDigest = identity.currentReviewedProviderIdentity('cap:fixture:no-digest');
  assert.equal(noDigest.ok, false); if (noDigest.ok) return;
  assert.equal(noDigest.reason, 'entry_not_callable', 'a callable row with no sealed digest cannot anchor a reviewed plan');
  const uncachedManifest = { ...f.manifest, manifestId: 'cap:fixture:uncached', operationId: 'reviewed_cli_never_cached' };
  f.factory.register({ ...f.entry, capabilityId: uncachedManifest.manifestId, toolName: uncachedManifest.operationId,
    manifest: uncachedManifest, manifestDigest: manifests.capabilityManifestDigest(uncachedManifest) });
  const uncached = identity.currentReviewedProviderIdentity(uncachedManifest.manifestId);
  assert.equal(uncached.ok, false); if (uncached.ok) return;
  assert.equal(uncached.reason, 'schema_not_cached');
});

test('a mutated cached schema is a schema digest mismatch; a changed identity field is an identity mismatch', () => {
  const f = reviewedCliFixture('reviewed_cli_mutation_fixture');
  const reviewed = catalogs.canonicalCatalogIdentityOf(f.entry) as unknown as Record<string, unknown>;
  const before = identity.currentReviewedProviderIdentity(f.manifest.manifestId);
  assert.equal(before.ok, true); if (!before.ok) return;
  assert.equal(identity.reviewedProviderIdentityMismatch(before, { ...reviewed, account: 'reviewed_cli:other' }), 'identity_mismatch');
  assert.equal(identity.reviewedProviderIdentityMismatch(before, { ...reviewed, providerInputSchemaDigest: sha256('other schema') }), 'identity_mismatch');
  schemas.rememberToolSchema(f.manifest.operationId, { ...f.schema, properties: { ...f.schema.properties, limit: { type: 'number' } } }, Date.now());
  const after = identity.currentReviewedProviderIdentity(f.manifest.manifestId);
  assert.equal(after.ok, true); if (!after.ok) return;
  assert.equal(identity.reviewedProviderIdentityMismatch(after, reviewed), 'schema_digest_mismatch');
});

test('an attestation matches a reviewed identity only on every field, strictly', () => {
  const f = reviewedCliFixture('reviewed_cli_attestation_fixture');
  const canonical = catalogs.canonicalCatalogIdentityOf(f.entry)!;
  const attestation = {
    capabilityId: canonical.capabilityId, manifestDigest: canonical.manifestDigest, accountId: canonical.account,
    providerInputSchemaDigest: canonical.providerInputSchemaDigest, operationId: canonical.operationId,
  } as never;
  const reviewed = canonical as unknown as Record<string, unknown>;
  assert.equal(identity.attestationMatchesReviewedIdentity(attestation, reviewed), true);
  assert.equal(identity.attestationMatchesReviewedIdentity({ ...(attestation as object), providerInputSchemaDigest: undefined } as never, reviewed), false,
    'a missing attestation digest is never filled from the cache');
  assert.equal(identity.attestationMatchesReviewedIdentity({ ...(attestation as object), accountId: 'other' } as never, reviewed), false);
  assert.equal(identity.attestationMatchesReviewedIdentity({ ...(attestation as object), manifestDigest: sha256('x') } as never, reviewed), false);
  assert.equal(identity.attestationMatchesReviewedIdentity(undefined, reviewed), false);
});
