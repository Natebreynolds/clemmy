/** Run: npx tsx --test src/runtime/harness/destination-binding.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  bindExecutableDestination,
  evidenceFloorFromManifest,
} from './destination-binding.js';
import type { CapabilityManifestV1 } from './capability-manifest.js';
import { attachSemanticContract, capabilityManifestDigest } from './capability-manifest.js';
import type { RegisteredHostCapability } from './host-capability-catalog-factory.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sheetManifest(): CapabilityManifestV1 {
  return attachSemanticContract({
    version: 1,
    manifestId: 'cap:sheet-create',
    providerKind: 'local_registry',
    operationId: 'sheet_create',
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: sha256('live:sheet_create'),
    effect: 'external_write',
    destination: { family: 'created_resource', posture: 'create_new' },
    accountId: 'acct-sheets',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'created_resource' },
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
    readbackContract: { required: true, contentDigestRequired: true },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-15T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination'],
  });
}

function asRegistered(manifest: CapabilityManifestV1): RegisteredHostCapability {
  return {
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
    invoke: async () => ({}),
  };
}

test('spreadsheet/false proposal binds the unique sheet create without family aliases', () => {
  const manifest = sheetManifest();
  const bound = bindExecutableDestination({
    requestedEffect: 'external_write',
    destinationPosture: 'create_new',
    candidateIds: [manifest.manifestId],
    catalog: [asRegistered(manifest)],
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  assert.equal(bound.binding.manifestId, 'cap:sheet-create');
  assert.equal(bound.binding.accountId, 'acct-sheets');
  assert.equal(bound.binding.posture, 'create_new');
  assert.equal(bound.floor.handleRequired, true);
  assert.ok(bound.floor.evidenceRequirements.includes('readback'));
  assert.ok(bound.floor.evidenceRequirements.includes('exact_readback'));
  assert.ok(bound.floor.evidenceRequirements.includes('artifact_handle'));
});

test('two compatible write destinations refuse instead of guessing a family', () => {
  const first = sheetManifest();
  const second = sheetManifest();
  second.manifestId = 'cap:other-create';
  second.operationId = 'other_create';
  second.accountId = 'acct-other';
  const bound = bindExecutableDestination({
    requestedEffect: 'external_write',
    destinationPosture: 'create_new',
    candidateIds: [first.manifestId, second.manifestId],
    catalog: [asRegistered(first), asRegistered(second)],
  });
  assert.equal(bound.ok, false);
});

test('role-only unique write cannot bind without an exact capability reference', () => {
  const bound = bindExecutableDestination({
    requestedEffect: 'external_write',
    destinationPosture: 'create_new',
    catalog: [asRegistered(sheetManifest())],
  });
  assert.equal(bound.ok, false);
});

test('destination binding compare requires every identity field', async () => {
  const { destinationBindingMatches } = await import('./host-capability-catalog-factory.js');
  const capability = asRegistered(sheetManifest());
  const binding = {
    manifestId: capability.manifest!.manifestId,
    manifestDigest: capability.manifestDigest!,
    accountId: capability.account!,
    operationId: capability.manifest!.operationId,
    schemaVersion: capability.schemaVersion,
    definitionFingerprint: capability.schemaDigest,
    effect: String(capability.effect),
    posture: capability.destination!.posture,
  };
  assert.equal(destinationBindingMatches(binding, capability), true);
  assert.equal(destinationBindingMatches({ ...binding, accountId: 'other' }, capability), false);
  assert.equal(destinationBindingMatches({ ...binding, posture: 'named_existing' }, capability), false);
  assert.equal(destinationBindingMatches({ ...binding, manifestDigest: '0'.repeat(64) }, capability), false);
  assert.equal(destinationBindingMatches({ ...binding, definitionFingerprint: '1'.repeat(64) }, capability), false);
  assert.equal(destinationBindingMatches({ ...binding, operationId: 'other_create' }, capability), false);
  assert.equal(destinationBindingMatches({ ...binding, schemaVersion: '2' }, capability), false);
  assert.equal(destinationBindingMatches({ ...binding, effect: 'read' }, capability), false);
});

test('manifest evidence is monotonic over a false handleRequired proposal', () => {
  const floor = evidenceFloorFromManifest(sheetManifest(), {
    handleRequired: false,
    evidenceRequirements: [],
  });
  assert.equal(floor.handleRequired, true);
  assert.ok(floor.evidenceRequirements.includes('exact_readback'));
});

test('handle identity and content verification remain distinct evidence floors', () => {
  const generic = sheetManifest();
  generic.readbackContract = undefined;
  generic.evidenceContract = { kinds: ['receipt', 'readback'], readbackRequired: true };
  const genericFloor = evidenceFloorFromManifest(generic, {
    handleRequired: false,
    evidenceRequirements: [],
  });
  assert.equal(genericFloor.handleRequired, true);
  assert.ok(genericFloor.evidenceRequirements.includes('readback'));

  const atomic = sheetManifest();
  atomic.operationId = 'GOOGLESHEETS_SHEET_FROM_JSON';
  atomic.evidenceContract = { kinds: ['receipt', 'content_commit'], readbackRequired: false };
  atomic.readbackContract = undefined;
  const atomicFloor = evidenceFloorFromManifest(atomic, {
    handleRequired: true,
    evidenceRequirements: ['receipt'],
  });
  assert.equal(atomicFloor.handleRequired, true);
  assert.ok(atomicFloor.evidenceRequirements.includes('artifact_handle'));
  assert.ok(atomicFloor.evidenceRequirements.includes('content_commit'));
  assert.equal(atomicFloor.evidenceRequirements.includes('readback'), false);

  const identityOnly = sheetManifest();
  identityOnly.evidenceContract = { kinds: ['receipt'], readbackRequired: false };
  identityOnly.readbackContract = undefined;
  const identityFloor = evidenceFloorFromManifest(identityOnly, {
    handleRequired: true,
    evidenceRequirements: [],
  });
  assert.deepEqual(new Set(identityFloor.evidenceRequirements), new Set(['receipt', 'artifact_handle']));
});
