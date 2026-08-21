/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/physical-dispatch-grounding.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { attachSemanticContract, capabilityManifestDigest } from './capability-manifest.js';
import type { BoundNodeCapability } from './graph-node-capability.js';
import { groundingReceiptDigest } from '../semantic-boundary/plan-grounding.js';
import { installHostCompiledGroundingVerifier, validatePhysicalDispatchGrounding } from './physical-dispatch-grounding.js';
import { HOST_BIND_IDENTITY } from '../semantic-boundary/host-authority.js';

const manifest = attachSemanticContract({
  version: 1,
  manifestId: 'cap:host_lookup:source',
  providerKind: 'composio',
  operationId: 'TAVILY_TAVILY_SEARCH',
  providerIdentity: 'composio',
  providerVersion: 'a'.repeat(64),
  operationVersion: '1',
  definitionFingerprint: 'a'.repeat(64),
  effect: 'read',
  accountId: 'acct:beta:search:v1',
  idempotency: { required: false, policy: 'none' },
  reconciliation: { supported: false, policy: 'none' },
  outputContract: { kind: 'locator' },
  purpose: 'locate_source',
  acceptedInputKinds: ['query'],
  producedOutputKinds: ['locator'],
  applicableDeliverableKinds: ['locator'],
  evidenceContract: { kinds: ['payload'], readbackRequired: false },
  provenance: { issuer: 'host:test', issuedAt: '2026-08-16T00:00:00.000Z', trusted: true },
  lifecycle: { state: 'current' },
  advisoryRoles: ['source'],
});

const digest = capabilityManifestDigest(manifest);

function binding(overrides: Partial<BoundNodeCapability> = {}): BoundNodeCapability {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    args: {},
    account: manifest.accountId,
    effect: 'read',
    manifestDigest: digest,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({}),
    ...overrides,
  };
}

function receiptFields(overrides: Record<string, unknown> = {}) {
  const operations = [{
    operationId: 'op-source',
    verdict: 'entailed' as const,
    capabilityRef: manifest.manifestId,
    manifestDigest: digest,
    rationale: 'ok',
  }];
  const withoutDigest = {
    modelIdentity: 'ground-1',
    catalogSnapshotDigest: 'c'.repeat(64),
    shownDescriptorDigest: 'd'.repeat(64),
    proposalDigest: 'e'.repeat(64),
    overallVerdict: 'entailed' as const,
    operations,
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
  };
  return {
    validationOutcome: 'admitted',
    groundingIdentity: withoutDigest.modelIdentity,
    groundingCatalogDigest: withoutDigest.catalogSnapshotDigest,
    groundingShownDigest: withoutDigest.shownDescriptorDigest,
    groundingProposalDigest: withoutDigest.proposalDigest,
    groundingOverallVerdict: withoutDigest.overallVerdict,
    groundingVerdicts: operations,
    groundingInputTokens: 1,
    groundingOutputTokens: 1,
    groundingLatencyMs: 1,
    groundingReceiptDigest: groundingReceiptDigest(withoutDigest),
    ...overrides,
  };
}

test('missing or forged grounding refuses before reservation', () => {
  assert.throws(
    () => validatePhysicalDispatchGrounding({ record: null, nodeId: 'op-source', binding: binding() }),
    /grounding_receipt_missing/,
  );
  assert.throws(
    () => validatePhysicalDispatchGrounding({
      record: receiptFields({ groundingReceiptDigest: '0'.repeat(64) }),
      nodeId: 'op-source',
      binding: binding(),
    }),
    /grounding_receipt_digest_mismatch/,
  );
  assert.throws(
    () => validatePhysicalDispatchGrounding({
      record: receiptFields({ groundingIdentity: '' }),
      nodeId: 'op-source',
      binding: binding(),
    }),
    /grounding_receipt_missing/,
  );
});

test('wrong capability, account, schema, or effect refuses', () => {
  assert.throws(
    () => validatePhysicalDispatchGrounding({
      record: receiptFields(),
      nodeId: 'op-source',
      binding: binding({ capabilityId: 'cap:host_create:destination' }),
    }),
    /grounding_capability_mismatch/,
  );
  assert.throws(
    () => validatePhysicalDispatchGrounding({
      record: receiptFields(),
      nodeId: 'op-source',
      binding: binding({ account: 'acct:other' }),
    }),
    /account_mismatch/,
  );
  assert.throws(
    () => validatePhysicalDispatchGrounding({
      record: receiptFields(),
      nodeId: 'op-source',
      binding: binding({ liveFingerprint: 'f'.repeat(64), schemaDigest: 'f'.repeat(64) }),
    }),
    /schema_drift/,
  );
  assert.throws(
    () => validatePhysicalDispatchGrounding({
      record: receiptFields(),
      nodeId: 'op-source',
      binding: binding({ effect: 'external_write' }),
    }),
    /effect_mismatch/,
  );
  assert.throws(
    () => validatePhysicalDispatchGrounding({
      record: receiptFields(),
      nodeId: 'op-source',
      binding: binding({ toolName: 'GOOGLESHEETS_SHEET_FROM_JSON' }),
    }),
    /operation_mismatch/,
  );
});

test('exact claim-linked receipt and bound manifest authorize one node', () => {
  const ok = validatePhysicalDispatchGrounding({
    record: receiptFields(),
    nodeId: 'op-source',
    binding: binding(),
  });
  assert.match(ok.receiptDigest, /^[a-f0-9]{64}$/);
  assert.equal(ok.identity, 'ground-1');
});

test('HOST NAMESPACE: unproven host authority refuses closed before any standard check', () => {
  const operations = [{
    operationId: 'op-source',
    verdict: 'entailed' as const,
    capabilityRef: manifest.manifestId,
    manifestDigest: digest,
    rationale: 'schema-proven',
  }];
  const withoutDigest = {
    modelIdentity: HOST_BIND_IDENTITY,
    catalogSnapshotDigest: 'c'.repeat(64),
    shownDescriptorDigest: 'd'.repeat(64),
    proposalDigest: 'e'.repeat(64),
    overallVerdict: 'entailed' as const,
    operations,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 3,
  };
  const record = receiptFields({
    groundingIdentity: HOST_BIND_IDENTITY,
    groundingReceiptDigest: groundingReceiptDigest(withoutDigest),
  });
  // No verifier installed → structurally unproven, refused.
  installHostCompiledGroundingVerifier(null);
  assert.throws(
    () => validatePhysicalDispatchGrounding({ record, nodeId: 'op-source', binding: binding() }),
    /host_authority_unproven/,
  );
  // Verifier refuses → its reason surfaces, still refused closed.
  installHostCompiledGroundingVerifier(() => ({ ok: false, reason: 'host_compile_recompute_mismatch' }));
  try {
    assert.throws(
      () => validatePhysicalDispatchGrounding({ record, nodeId: 'op-source', binding: binding() }),
      /host_compile_recompute_mismatch/,
    );
  } finally {
    installHostCompiledGroundingVerifier(null);
  }
});

test('HOST NAMESPACE: a passing recompute still runs EVERY standard receipt check', () => {
  installHostCompiledGroundingVerifier(() => ({ ok: true }));
  try {
    const operations = [{
      operationId: 'op-source',
      verdict: 'entailed' as const,
      capabilityRef: manifest.manifestId,
      manifestDigest: digest,
      rationale: 'schema-proven',
    }];
    const withoutDigest = {
      modelIdentity: HOST_BIND_IDENTITY,
      catalogSnapshotDigest: 'c'.repeat(64),
      shownDescriptorDigest: 'd'.repeat(64),
      proposalDigest: 'e'.repeat(64),
      overallVerdict: 'entailed' as const,
      operations,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 3,
    };
    const good = receiptFields({
      groundingIdentity: HOST_BIND_IDENTITY,
      groundingReceiptDigest: groundingReceiptDigest(withoutDigest),
    });
    const authorized = validatePhysicalDispatchGrounding({ record: good, nodeId: 'op-source', binding: binding() });
    assert.equal(authorized.identity, HOST_BIND_IDENTITY);
    // Tampered receipt digest still refuses — host acceptance is a superset,
    // never a bypass, of the standard digest checks.
    const tampered = { ...good, groundingReceiptDigest: 'f'.repeat(64) };
    assert.throws(
      () => validatePhysicalDispatchGrounding({ record: tampered, nodeId: 'op-source', binding: binding() }),
      /grounding_receipt_digest_mismatch/,
    );
  } finally {
    installHostCompiledGroundingVerifier(null);
  }
});
