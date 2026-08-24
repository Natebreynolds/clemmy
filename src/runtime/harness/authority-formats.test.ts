/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/authority-formats.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-authority-formats-'));

const {
  LEGACY_OWNER_FENCED_V1,
  PROVISIONAL_OWNER_FENCED_V2,
  STABLE_BUSINESS_V3,
  authorityMayAuthorizeExecution,
  classifyStoredAuthority,
  reservationClaimSealDigestOf,
  stableBusinessAuthorityDigestOf,
} = await import('./authority-formats.js');

type Business = Parameters<typeof stableBusinessAuthorityDigestOf>[0];

function business(overrides: Partial<Business> = {}): Business {
  return {
    acceptedSource: { sessionId: 'sess-1', sourceUserSeq: 1 },
    acceptedTaskId: 'task-1',
    claimEventId: 'evt-claim-1',
    semanticProvenanceDigest: '1'.repeat(64),
    goalRevision: 0,
    graphId: 'graph-1',
    graphHash: '2'.repeat(64),
    nodeId: 'op-write',
    logicalCallId: 'logical:op-write',
    physicalDispatchId: 'phys:op-write:1',
    ordinal: 1,
    relation: 'primary',
    operationId: 'host_create',
    capabilityRef: 'cap-write-1',
    manifestId: 'cap-write-1',
    manifestDigest: '3'.repeat(64),
    providerKind: 'local_registry',
    providerIdentity: 'local_registry',
    operationVersion: '1',
    liveProviderVersion: 'tool-registry-v1',
    liveFingerprint: '4'.repeat(64),
    accountId: 'acct-1',
    resolvedEffect: 'external_write',
    destination: { family: 'workbook', posture: 'create_new' },
    canonicalArgumentDigest: '5'.repeat(64),
    logicalArgumentDigest: '6'.repeat(64),
    argumentCompiler: { id: 'compiler-1', version: '1' },
    observationId: 'obs:host_create:acct-1:123',
    observationDigest: '7'.repeat(64),
    observationObservedAt: 123,
    observationOrigin: 'independent',
    observerImplementationId: '8'.repeat(64),
    invokePortId: 'port:invoke:1',
    reconcilePortId: 'port:reconcile:1',
    invokeImplementationDigest: '9'.repeat(64),
    reconcileImplementationDigest: 'a'.repeat(64),
    transportImplementationDigest: 'b'.repeat(64),
    providerClientDigest: 'c'.repeat(64),
    reconciliationPolicy: 'exact_artifact',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
    policySnapshotDigest: 'd'.repeat(64),
    catalogSnapshotDigest: 'e'.repeat(64),
    ...overrides,
  };
}

test('the stable business digest is frozen, and domain-separated from other formats', () => {
  // Frozen golden vectors. Every persisted v3 digest depends on these bytes, so
  // this value may only move behind a NEW format tag -- never in place. A
  // failure here means someone reinterpreted stored authority.
  const digest = stableBusinessAuthorityDigestOf(business());
  assert.equal(digest, 'cce15e530509a292a2ebb0bf36ee2938acb84084581503c994db60bfeb0efbfd');
  const seal = reservationClaimSealDigestOf({
    physicalDispatchId: 'phys:op-write:1',
    owner: 'owner-a',
    fence: 1,
    leaseRevision: 1,
    leaseExpiresAt: 999,
  });
  assert.equal(seal, 'a70ae6576ea4b4bb718d800eeaf76f9f3f06a980e65d79302a567904b37be9b7');
  // Domain separation: the seal over the same crossing must never collide.
  assert.notEqual(seal, digest);
});

test('owner, fence, lease revision and expiry never change the business digest', () => {
  const baseline = stableBusinessAuthorityDigestOf(business());
  const owners = [
    { physicalDispatchId: 'phys:op-write:1', owner: 'owner-a', fence: 1, leaseRevision: 1, leaseExpiresAt: 10 },
    { physicalDispatchId: 'phys:op-write:1', owner: 'owner-b', fence: 2, leaseRevision: 2, leaseExpiresAt: 20 },
    { physicalDispatchId: 'phys:op-write:1', owner: 'owner-c', fence: 9, leaseRevision: 7, leaseExpiresAt: 30 },
  ];
  const seals = owners.map(reservationClaimSealDigestOf);
  // Every owner is a distinct activation...
  assert.equal(new Set(seals).size, owners.length);
  // ...over one unchanged business crossing. This is the whole point: a
  // legitimate takeover must be able to satisfy the reservation it inherits.
  assert.equal(stableBusinessAuthorityDigestOf(business()), baseline);
});

test('every business field mutation changes the digest', () => {
  const baseline = stableBusinessAuthorityDigestOf(business());
  const mutations: Array<Partial<Business>> = [
    { acceptedSource: { sessionId: 'other', sourceUserSeq: 1 } },
    { acceptedSource: { sessionId: 'sess-1', sourceUserSeq: 2 } },
    { acceptedTaskId: 'task-2' },
    { claimEventId: 'evt-other' },
    { semanticProvenanceDigest: 'f'.repeat(64) },
    { goalRevision: 1 },
    { graphId: 'graph-2' },
    { graphHash: 'f'.repeat(64) },
    { nodeId: 'op-other' },
    { logicalCallId: 'logical:other' },
    { physicalDispatchId: 'phys:other:1' },
    { ordinal: 2 },
    { relation: 'retry' },
    { operationId: 'OTHER_OP' },
    { capabilityRef: 'cap-other' },
    { manifestId: 'cap-other' },
    { manifestDigest: 'f'.repeat(64) },
    { providerKind: 'composio' },
    { providerIdentity: 'composio' },
    { operationVersion: '2' },
    { liveProviderVersion: 'v2' },
    { liveFingerprint: 'f'.repeat(64) },
    { accountId: 'acct-2' },
    { resolvedEffect: 'local_write' },
    { destination: { family: 'workbook', posture: 'append' } },
    { canonicalArgumentDigest: 'f'.repeat(64) },
    { logicalArgumentDigest: 'f'.repeat(64) },
    { argumentCompiler: { id: 'compiler-2', version: '1' } },
    { observationId: 'obs:other' },
    { observationDigest: 'f'.repeat(64) },
    { observationObservedAt: 124 },
    { observationOrigin: 'pack_attested' },
    { observerImplementationId: 'f'.repeat(64) },
    { invokePortId: 'port:invoke:2' },
    { reconcilePortId: 'port:reconcile:2' },
    { invokeImplementationDigest: 'f'.repeat(64) },
    { reconcileImplementationDigest: 'f'.repeat(64) },
    { transportImplementationDigest: 'f'.repeat(64) },
    { providerClientDigest: 'f'.repeat(64) },
    { reconciliationPolicy: 'uncertain_if_absent' },
    { idempotency: { required: false, policy: 'none' } },
    { evidenceContract: { kinds: ['receipt'], readbackRequired: false } },
    { policySnapshotDigest: 'f'.repeat(64) },
    { catalogSnapshotDigest: 'f'.repeat(64) },
    {
      predecessor: {
        format: STABLE_BUSINESS_V3,
        digest: 'f'.repeat(64),
        physicalDispatchId: 'phys:op-write:0',
      },
    },
  ];
  const seen = new Set<string>([baseline]);
  for (const mutation of mutations) {
    const digest = stableBusinessAuthorityDigestOf(business(mutation));
    assert.notEqual(digest, baseline, `mutation did not change the digest: ${JSON.stringify(mutation)}`);
    assert.equal(seen.has(digest), false, `mutation collided: ${JSON.stringify(mutation)}`);
    seen.add(digest);
  }
});

test('a provisional owner-fenced v2 envelope is quarantined, never execution authority', () => {
  const evidence = classifyStoredAuthority({
    json: JSON.stringify({ version: 2, authorityDigest: '1'.repeat(64), ownerFence: 'fence:sess-1:1:phys:1' }),
    storedDigest: '1'.repeat(64),
  });
  assert.equal(evidence.format, PROVISIONAL_OWNER_FENCED_V2);
  assert.equal(evidence.quarantine, 'provisional_owner_fenced');
  assert.equal(evidence.ownerFence, 'fence:sess-1:1:phys:1');
  assert.equal(authorityMayAuthorizeExecution(evidence), false);
  // The stored digest is preserved exactly; nothing is rehashed.
  assert.equal(evidence.originalAuthorityDigest, '1'.repeat(64));
});

test('a historical v1 envelope decodes as evidence and keeps its exact bytes', () => {
  const raw = { version: 1, authorityDigest: '2'.repeat(64), ownerFence: 'fence:old', operationId: 'host_create' };
  const evidence = classifyStoredAuthority({ json: JSON.stringify(raw), storedDigest: '2'.repeat(64) });
  assert.equal(evidence.format, LEGACY_OWNER_FENCED_V1);
  assert.equal(evidence.quarantine, undefined, 'a clean v1 row is readable evidence, not corruption');
  assert.equal(evidence.originalAuthorityDigest, '2'.repeat(64));
  assert.equal(evidence.raw.operationId, 'host_create');
  // Readable, but still never permission to execute.
  assert.equal(authorityMayAuthorizeExecution(evidence), false);
  assert.throws(() => { (evidence.raw as { operationId: string }).operationId = 'forged'; });
});

test('malformed, unknown and ambiguous envelopes are quarantined and never execute', () => {
  const cases: Array<{ json: string; code: string }> = [
    { json: 'not json', code: 'malformed_envelope' },
    { json: '[]', code: 'malformed_envelope' },
    { json: JSON.stringify({ version: 99, authorityDigest: 'x' }), code: 'unknown_format' },
    { json: JSON.stringify({ authorityDigest: 'x' }), code: 'ambiguous_version' },
    { json: JSON.stringify({ version: '2', authorityDigest: 'x' }), code: 'ambiguous_version' },
  ];
  for (const entry of cases) {
    const evidence = classifyStoredAuthority({ json: entry.json });
    assert.equal(evidence.quarantine, entry.code, entry.json);
    assert.equal(authorityMayAuthorizeExecution(evidence), false, entry.json);
  }
});

test('a v1 row whose stored digest disagrees with its envelope is quarantined', () => {
  const evidence = classifyStoredAuthority({
    json: JSON.stringify({ version: 1, authorityDigest: '3'.repeat(64) }),
    storedDigest: '4'.repeat(64),
  });
  assert.equal(evidence.format, LEGACY_OWNER_FENCED_V1);
  assert.equal(evidence.quarantine, 'digest_mismatch');
  assert.equal(authorityMayAuthorizeExecution(evidence), false);
});

test('only a clean stable-v3 record may authorize execution', () => {
  const clean = classifyStoredAuthority({
    json: JSON.stringify({ format: STABLE_BUSINESS_V3, authorityDigest: '5'.repeat(64) }),
    storedDigest: '5'.repeat(64),
  });
  assert.equal(clean.format, STABLE_BUSINESS_V3);
  assert.equal(authorityMayAuthorizeExecution(clean), true);

  // A v3-tagged envelope that still carries ownership is self-contradictory.
  const fenced = classifyStoredAuthority({
    json: JSON.stringify({ format: STABLE_BUSINESS_V3, authorityDigest: '6'.repeat(64), ownerFence: 'fence:x' }),
    storedDigest: '6'.repeat(64),
  });
  assert.equal(fenced.quarantine, 'ambiguous_version');
  assert.equal(authorityMayAuthorizeExecution(fenced), false);
});

test('a predecessor reference cannot cross formats', () => {
  const withPredecessor = business({
    predecessor: {
      format: STABLE_BUSINESS_V3,
      digest: '7'.repeat(64),
      physicalDispatchId: 'phys:op-write:0',
    },
  });
  assert.notEqual(
    stableBusinessAuthorityDigestOf(withPredecessor),
    stableBusinessAuthorityDigestOf(business()),
  );
  // The type forbids naming a legacy predecessor; assert the runtime shape too,
  // so a cast cannot smuggle one past the digest.
  const smuggled = business({
    predecessor: {
      format: LEGACY_OWNER_FENCED_V1 as never,
      digest: '7'.repeat(64),
      physicalDispatchId: 'phys:op-write:0',
    },
  });
  assert.notEqual(
    stableBusinessAuthorityDigestOf(smuggled),
    stableBusinessAuthorityDigestOf(withPredecessor),
  );
});
