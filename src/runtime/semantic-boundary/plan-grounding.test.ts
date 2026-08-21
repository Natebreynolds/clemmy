/** Run: npx tsx --test src/runtime/semantic-boundary/plan-grounding.test.ts */
import { HOST_BIND_IDENTITY } from './host-authority.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { productionCapabilityManifests } from '../harness/production-capability-catalog.js';
import { capabilityManifestDigest } from '../harness/capability-manifest.js';
import { hostDescriptorFromRegistered } from './admit-and-compile-accepted-source.js';
import {
  bindPlanGroundingReceipt,
  catalogSnapshotDigestFromDescriptors,
  requireFrozenCatalogForExecutablePlan,
  validateGroundingReceiptReplay,
} from './plan-grounding.js';
import {
  boundHostCapabilityDescriptors,
  shownGroundingDescriptors,
  type HostCapabilityDescriptorV1,
} from './turn-semantic-proposal.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function productionDescriptors() {
  return productionCapabilityManifests().map((manifest) => hostDescriptorFromRegistered({
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
  })!);
}

function shownDigest(descriptors: HostCapabilityDescriptorV1[], refs: string[]): string {
  const shown = shownGroundingDescriptors({ descriptors, referencedIds: refs });
  assert.equal(shown.ok, true);
  return shown.ok ? shown.digest : '';
}

test('production descriptor conversion keeps purpose and kind contracts', () => {
  const descriptors = productionDescriptors();
  assert.equal(descriptors.length, 5);
  const source = descriptors.find((entry) => entry.id === 'cap:host_lookup:source');
  const collection = descriptors.find((entry) => entry.id === 'cap:host_lookup:collection');
  const transform = descriptors.find((entry) => entry.id === 'cap:host_compute:transform');
  const dest = descriptors.find((entry) => entry.id === 'cap:host_create:destination');
  const readback = descriptors.find((entry) => entry.id === 'cap:host_lookup:readback');
  assert.equal(source?.purpose, 'locate_source');
  assert.deepEqual(source?.acceptedInputKinds, ['query']);
  assert.deepEqual(source?.producedOutputKinds, ['locator']);
  assert.deepEqual(collection?.acceptedInputKinds, ['locator']);
  assert.deepEqual(collection?.producedOutputKinds, ['records']);
  assert.equal(transform?.effect, 'host_only');
  assert.equal(dest?.purpose, 'persist_collection');
  assert.deepEqual(dest?.applicableDeliverableKinds, ['created_resource']);
  assert.deepEqual(readback?.acceptedInputKinds, ['created_resource']);
  assert.notEqual(source?.purpose, source?.outputKind);
});

test('whole-plan bind requires exact one-to-one operation coverage', () => {
  const descriptors = productionDescriptors();
  const operations = [
    { id: 'op-source', role: 'source', requestedEffect: 'read', capabilityRef: 'cap:host_lookup:source', dependsOn: [], evidence: ['payload'] },
    { id: 'op-write', role: 'destination', requestedEffect: 'external_write', capabilityRef: 'cap:host_create:destination', dependsOn: ['op-source'], evidence: ['receipt'] },
  ];
  const digest = catalogSnapshotDigestFromDescriptors(descriptors);
  const shown = shownDigest(descriptors, operations.map((operation) => operation.capabilityRef));
  const proposal = sha256('proposal');
  const ok = bindPlanGroundingReceipt({
    judged: {
      verdict: 'entailed',
      operations: [
        { operationId: 'op-source', verdict: 'entailed', rationale: '' },
        { operationId: 'op-write', verdict: 'entailed', rationale: '' },
      ],
      modelIdentity: 'judge',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    },
    operations,
    descriptors,
    catalogSnapshotDigest: digest,
    shownDescriptorDigest: shown,
    proposalDigest: proposal,
  });
  assert.equal(ok.ok, true);
  const extra = bindPlanGroundingReceipt({
    judged: {
      verdict: 'entailed',
      operations: [
        { operationId: 'op-source', verdict: 'entailed', rationale: '' },
        { operationId: 'op-write', verdict: 'entailed', rationale: '' },
        { operationId: 'op-extra', verdict: 'entailed', rationale: '' },
      ],
      modelIdentity: 'judge',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    },
    operations,
    descriptors,
    catalogSnapshotDigest: digest,
    shownDescriptorDigest: shown,
    proposalDigest: proposal,
  });
  assert.equal(extra.ok, false);
  const missing = bindPlanGroundingReceipt({
    judged: {
      verdict: 'entailed',
      operations: [{ operationId: 'op-source', verdict: 'entailed', rationale: '' }],
      modelIdentity: 'judge',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    },
    operations,
    descriptors,
    catalogSnapshotDigest: digest,
    shownDescriptorDigest: shown,
    proposalDigest: proposal,
  });
  assert.equal(missing.ok, false);
  if (!ok.ok) return;
  const tampered = {
    ...ok.receipt,
    operations: ok.receipt.operations.map((operation, index) => (
      index === 0 ? { ...operation, verdict: 'conflict' as const } : operation
    )),
  };
  const replay = validateGroundingReceiptReplay({
    persisted: tampered,
    operations,
    descriptors,
    catalogSnapshotDigest: digest,
    shownDescriptorDigest: shown,
    proposalDigest: proposal,
  });
  assert.ok(replay);
});

test('referenced 17KB descriptor omitted from the judge request is blocked with no receipt', () => {
  const huge: HostCapabilityDescriptorV1 = {
    id: 'cap:huge',
    effect: 'read',
    purpose: 'x'.repeat(17_000),
    acceptedInputKinds: ['query'],
    producedOutputKinds: ['locator'],
    applicableDeliverableKinds: ['locator'],
    inputShape: 'query',
    outputShape: 'locator',
    outputKind: 'locator',
    deliverableKind: 'locator',
    destinationPosture: null,
    evidenceKinds: ['payload'],
    handleRequired: false,
    readbackRequired: false,
    accountScope: 'host:test',
    manifestDigest: 'a'.repeat(64),
  };
  const shown = shownGroundingDescriptors({
    descriptors: [huge],
    referencedIds: ['cap:huge'],
  });
  assert.equal(shown.ok, false);
  if (shown.ok) return;
  assert.equal(shown.code, 'grounding_descriptor_omitted');
  const bound = bindPlanGroundingReceipt({
    judged: {
      verdict: 'entailed',
      operations: [{ operationId: 'op-source', verdict: 'entailed', rationale: '' }],
      modelIdentity: 'judge',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    },
    operations: [{
      id: 'op-source',
      role: 'source',
      requestedEffect: 'read',
      capabilityRef: 'cap:huge',
      dependsOn: [],
      evidence: [],
    }],
    descriptors: [huge],
    catalogSnapshotDigest: catalogSnapshotDigestFromDescriptors([huge]),
    shownDescriptorDigest: 'b'.repeat(64),
    proposalDigest: sha256('proposal'),
  });
  assert.equal(bound.ok, false);
});

test('host-only operations do not require a frozen capability catalog', () => {
  const operations = [{
    id: 'op-transform',
    role: 'transform',
    requestedEffect: 'host_only',
    capabilityRef: 'cap:host_compute:transform',
    dependsOn: [],
    evidence: [],
  }];
  assert.equal(requireFrozenCatalogForExecutablePlan({ operations, descriptors: [] }), null);
});

test('executable operations with a missing or empty catalog are blocked', () => {
  const operations = [{
    id: 'op-source',
    role: 'source',
    requestedEffect: 'read',
    capabilityRef: 'cap:host_lookup:source',
    dependsOn: [],
    evidence: [],
  }];
  const empty = requireFrozenCatalogForExecutablePlan({ operations, descriptors: [] });
  assert.ok(empty);
  assert.equal(empty?.code, 'capability_catalog_empty');
  const bound = bindPlanGroundingReceipt({
    judged: {
      verdict: 'entailed',
      operations: [{ operationId: 'op-source', verdict: 'entailed', rationale: '' }],
      modelIdentity: 'judge',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    },
    operations,
    descriptors: [],
    catalogSnapshotDigest: 'c'.repeat(64),
    shownDescriptorDigest: 'd'.repeat(64),
    proposalDigest: sha256('proposal'),
  });
  assert.equal(bound.ok, false);
  const replay = validateGroundingReceiptReplay({
    persisted: {
      modelIdentity: 'judge',
      catalogSnapshotDigest: 'c'.repeat(64),
      shownDescriptorDigest: 'd'.repeat(64),
      proposalDigest: sha256('proposal'),
      overallVerdict: 'entailed',
      operations: [{
        operationId: 'op-source',
        verdict: 'entailed',
        capabilityRef: 'cap:host_lookup:source',
        manifestDigest: 'e'.repeat(64),
        rationale: '',
      }],
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      digest: 'f'.repeat(64),
    },
    operations,
    descriptors: [],
    catalogSnapshotDigest: 'c'.repeat(64),
    shownDescriptorDigest: 'd'.repeat(64),
    proposalDigest: sha256('proposal'),
  });
  assert.ok(replay);
  assert.equal(replay?.code, 'capability_catalog_empty');
});

test('host overall follows operation verdicts, not a conflicting top-level label', () => {
  const descriptors = productionDescriptors();
  const operations = [
    { id: 'op-source', role: 'source', requestedEffect: 'read', capabilityRef: 'cap:host_lookup:source', dependsOn: [], evidence: ['payload'] },
  ];
  const bound = bindPlanGroundingReceipt({
    judged: {
      verdict: 'conflict',
      operations: [{ operationId: 'op-source', verdict: 'entailed', rationale: '' }],
      modelIdentity: 'judge',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    },
    operations,
    descriptors,
    catalogSnapshotDigest: catalogSnapshotDigestFromDescriptors(descriptors),
    shownDescriptorDigest: shownDigest(descriptors, ['cap:host_lookup:source']),
    proposalDigest: sha256('proposal'),
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  assert.equal(bound.receipt.overallVerdict, 'entailed');
});

test('grounding receipt or catalog/proposal digest tampering fails replay', () => {
  const descriptors = productionDescriptors();
  const operations = [
    { id: 'op-source', role: 'source', requestedEffect: 'read', capabilityRef: 'cap:host_lookup:source', dependsOn: [], evidence: ['payload'] },
  ];
  const digest = catalogSnapshotDigestFromDescriptors(descriptors);
  const shown = shownDigest(descriptors, ['cap:host_lookup:source']);
  const proposal = sha256('proposal');
  const ok = bindPlanGroundingReceipt({
    judged: {
      verdict: 'entailed',
      operations: [{ operationId: 'op-source', verdict: 'entailed', rationale: '' }],
      modelIdentity: 'judge',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    },
    operations,
    descriptors,
    catalogSnapshotDigest: digest,
    shownDescriptorDigest: shown,
    proposalDigest: proposal,
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.ok(validateGroundingReceiptReplay({
    persisted: { ...ok.receipt, catalogSnapshotDigest: '1'.repeat(64) },
    operations,
    descriptors,
    catalogSnapshotDigest: digest,
    shownDescriptorDigest: shown,
    proposalDigest: proposal,
  }));
  assert.ok(validateGroundingReceiptReplay({
    persisted: { ...ok.receipt, proposalDigest: '2'.repeat(64) },
    operations,
    descriptors,
    catalogSnapshotDigest: digest,
    shownDescriptorDigest: shown,
    proposalDigest: proposal,
  }));
  assert.ok(validateGroundingReceiptReplay({
    persisted: { ...ok.receipt, digest: '3'.repeat(64) },
    operations,
    descriptors,
    catalogSnapshotDigest: digest,
    shownDescriptorDigest: shown,
    proposalDigest: proposal,
  }));
  assert.ok(validateGroundingReceiptReplay({
    persisted: { ...ok.receipt, shownDescriptorDigest: '4'.repeat(64) },
    operations,
    descriptors,
    catalogSnapshotDigest: digest,
    shownDescriptorDigest: shown,
    proposalDigest: proposal,
  }));
});

test('a 1000-capability catalog stays in the byte budget and shows every referenced descriptor', () => {
  const descriptors: HostCapabilityDescriptorV1[] = [];
  for (let index = 0; index < 1000; index += 1) {
    descriptors.push({
      id: `cap:n${index}`,
      effect: 'read',
      purpose: `p${index}`,
      acceptedInputKinds: ['query'],
      producedOutputKinds: ['locator'],
      applicableDeliverableKinds: ['locator'],
      inputShape: 'query',
      outputShape: 'locator',
      outputKind: 'locator',
      deliverableKind: 'locator',
      destinationPosture: null,
      evidenceKinds: ['payload'],
      handleRequired: false,
      readbackRequired: false,
      accountScope: 'host:test',
      manifestDigest: sha256(`m${index}`),
    });
  }
  const referenced = ['cap:n0', 'cap:n17', 'cap:n999'];
  const shown = shownGroundingDescriptors({ descriptors, referencedIds: referenced });
  assert.equal(shown.ok, true);
  if (!shown.ok) return;
  assert.equal(shown.shown.length, 3);
  assert.deepEqual(shown.shown.map((entry) => entry.id), referenced);
  const encoded = JSON.stringify(shown.shown);
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= 16_384);
  const boundedAll = boundHostCapabilityDescriptors(descriptors);
  assert.ok(boundedAll.length <= 32);
  assert.ok(Buffer.byteLength(JSON.stringify(boundedAll), 'utf8') <= 16_384);
});

test('RESERVED NAMESPACE: a model verdict cannot claim host deterministic-bind authority', () => {
  const descriptors = productionDescriptors();
  const operations = [
    { id: 'op-source', role: 'source', requestedEffect: 'read', capabilityRef: 'cap:host_lookup:source', dependsOn: [], evidence: ['payload'] },
  ];
  const judged = {
    verdict: 'entailed' as const,
    operations: [{ operationId: 'op-source', verdict: 'entailed' as const, rationale: '' }],
    modelIdentity: HOST_BIND_IDENTITY,
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
  };
  const shared = {
    judged,
    operations,
    descriptors,
    catalogSnapshotDigest: catalogSnapshotDigestFromDescriptors(descriptors),
    shownDescriptorDigest: shownDigest(descriptors, ['cap:host_lookup:source']),
    proposalDigest: sha256('proposal'),
  };
  const asModel = bindPlanGroundingReceipt(shared);
  assert.equal(asModel.ok, false, 'a model-port verdict in the host namespace must refuse');
  if (!asModel.ok) assert.equal(asModel.issue.code, 'grounding_identity_invalid');
  const asHost = bindPlanGroundingReceipt({ ...shared, hostMinted: true });
  assert.equal(asHost.ok, true, 'the host compile lane mints under the same binder with the flag it alone sets');
});
