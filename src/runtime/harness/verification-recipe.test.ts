/**
 * Run: npx tsx src/runtime/harness/verification-recipe.test.ts
 *
 * The host derives an exact verification recipe from current manifests, freezes
 * it onto the mutation's own binding, and refuses BEFORE any mutation when it
 * cannot determine exactly one verifier.
 *
 * Live 2026-08-26: a two-operation plan was admitted, a real sheet was created,
 * and only then did the dependent write discover the plan could never discharge
 * — a mutation discharges solely against a host-issued readback the model never
 * authored. Deriving the recipe moves that failure from after the side effect
 * to before it.
 *
 * Selection here reads manifest FACTS only. No test below names a provider,
 * toolkit or operation to make a decision, because core must not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CapabilityManifestV1 } from './capability-manifest.js';
import type {
  CanonicalCatalogIdentityV1,
  RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import {
  compatibleVerifiers,
  deriveVerificationRecipe,
  proofKindForMutation,
  verificationRecipeDigest,
  verificationTargetDigest,
  verifierLogicalCallId,
} from './verification-recipe.js';

const ACCOUNT = 'account-quarrystone-1';
const PROVIDER_IDENTITY = 'quarrystone-provider';

function manifest(overrides: Partial<CapabilityManifestV1> & { manifestId: string }): CapabilityManifestV1 {
  return {
    version: 1,
    providerKind: 'composio',
    operationId: overrides.manifestId.toUpperCase(),
    providerIdentity: PROVIDER_IDENTITY,
    providerVersion: 'v1',
    operationVersion: '1',
    definitionFingerprint: `fp-${overrides.manifestId}`,
    effect: 'external_write',
    destination: { family: 'ledger', posture: 'create_new' },
    accountId: ACCOUNT,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'ledger_handle' },
    purpose: 'provider-neutral purpose',
    acceptedInputKinds: [],
    producedOutputKinds: ['ledger_handle'],
    applicableDeliverableKinds: ['ledger'],
    evidenceContract: { kinds: ['external_receipt'], readbackRequired: true },
    readbackContract: { required: true, contentDigestRequired: false },
    ...overrides,
  } as CapabilityManifestV1;
}

function entry(source: CapabilityManifestV1): RegisteredHostCapability {
  return {
    capabilityId: `cap:resolved:${source.manifestId}`,
    toolName: source.operationId,
    schemaVersion: source.operationVersion,
    schemaDigest: source.definitionFingerprint,
    effect: source.effect as RegisteredHostCapability['effect'],
    account: source.accountId,
    manifestDigest: `md-${source.manifestId}`,
    providerKind: source.providerKind,
    manifest: source,
    invoke: (async () => ({})) as never,
  };
}

const CREATE = manifest({ manifestId: 'ledger_create' });
const READER = manifest({
  manifestId: 'ledger_read',
  effect: 'read',
  destination: { family: 'ledger', posture: 'named_existing' },
  outputContract: { kind: 'ledger_records' },
  acceptedInputKinds: ['ledger_handle'],
  producedOutputKinds: ['ledger_records'],
  readbackContract: { required: true, contentDigestRequired: false },
});

function canonicalIdentityOf(candidate: RegisteredHostCapability): CanonicalCatalogIdentityV1 {
  const source = candidate.manifest!;
  return {
    capabilityId: candidate.capabilityId,
    manifestId: source.manifestId,
    manifestDigest: candidate.manifestDigest!,
    operationId: source.operationId,
    schemaVersion: source.operationVersion,
    schemaDigest: source.definitionFingerprint,
    providerKind: source.providerKind,
    providerVersion: source.providerVersion,
    liveFingerprint: `live-${source.manifestId}`,
    account: source.accountId,
    effect: source.effect,
    destination: source.destination ?? null,
    idempotency: null,
    reconciliation: null,
    invokePortId: `port:${source.manifestId}`,
    implementationDigest: `impl-${source.manifestId}`,
    argumentCompiler: { id: 'compiler', version: '1' },
  } as CanonicalCatalogIdentityV1;
}

const BASE = {
  acceptedTaskId: 'task:session#1',
  workContractId: 'expected-work:v1:abc',
  ownerRequirementId: 'create_thing',
  ownerBindingDigest: 'owner-binding-digest',
  ownerEffect: 'external_write',
  mutation: CREATE,
  canonicalIdentityOf,
  targetSource: 'owner_result_resource_id' as const,
  requestTargetPointers: ['resourceId'],
  responseProjector: 'resource_id_projector_v1',
};

test('a zero-content create asks for identity proof, a content-bearing one asks for content', () => {
  assert.equal(proofKindForMutation(CREATE), 'resource_identity_v1',
    'a create that provisions an empty resource has no intended content to compare');
  assert.equal(proofKindForMutation(manifest({
    manifestId: 'ledger_create_with_content',
    readbackContract: { required: true, contentDigestRequired: true },
  })), 'reversible_exact_content_v1');
});

test('a mutation declaring no readback contract yields no proof kind', () => {
  assert.equal(proofKindForMutation(manifest({
    manifestId: 'ledger_fire_and_forget',
    evidenceContract: { kinds: [], readbackRequired: false },
    readbackContract: { required: false, contentDigestRequired: false },
  })), null);
});

test('exactly one compatible verifier freezes a recipe', () => {
  const result = deriveVerificationRecipe({ ...BASE, catalog: [entry(CREATE), entry(READER)] });
  assert.equal(result.ok, true, result.ok ? '' : result.detail);
  if (!result.ok) return;
  assert.equal(result.recipe.proof, 'resource_identity_v1');
  assert.equal(result.recipe.verifier.capabilityId, 'cap:resolved:ledger_read');
  assert.equal(result.recipe.ownerRequirementId, 'create_thing');
  assert.equal(result.recipe.ownerBindingDigest, 'owner-binding-digest');
  assert.ok(result.recipe.recipeDigest.length === 64, 'the recipe is content-addressed');
});

test('no compatible verifier refuses before any mutation', () => {
  const result = deriveVerificationRecipe({ ...BASE, catalog: [entry(CREATE)] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'verification_successor_required');
  assert.equal(result.requirementId, 'create_thing');
});

test('two compatible verifiers refuse rather than guess', () => {
  const second = manifest({
    manifestId: 'ledger_read_alt',
    effect: 'read',
    acceptedInputKinds: ['ledger_handle'],
    producedOutputKinds: ['ledger_records'],
    outputContract: { kind: 'ledger_records' },
  });
  const result = deriveVerificationRecipe({
    ...BASE, catalog: [entry(CREATE), entry(READER), entry(second)],
  });
  assert.equal(result.ok, false, 'ambiguity must refuse, never pick');
  if (result.ok) return;
  assert.match(result.detail, /exactly one exact verifier/);
});

test('a different account, provider, or resource family is never a verifier', () => {
  const foreignAccount = manifest({
    manifestId: 'ledger_read_other_account', effect: 'read',
    accountId: 'account-someone-else', acceptedInputKinds: ['ledger_handle'],
  });
  const foreignProvider = manifest({
    manifestId: 'ledger_read_other_provider', effect: 'read',
    providerIdentity: 'a-different-provider', acceptedInputKinds: ['ledger_handle'],
  });
  const foreignFamily = manifest({
    manifestId: 'other_family_read', effect: 'read',
    destination: { family: 'mailbox', posture: 'named_existing' },
    applicableDeliverableKinds: ['mailbox'],
    acceptedInputKinds: ['ledger_handle'],
  });
  for (const candidate of [foreignAccount, foreignProvider, foreignFamily]) {
    assert.deepEqual(
      compatibleVerifiers({ mutation: CREATE, catalog: [entry(candidate)] }),
      [],
      `${candidate.manifestId} must not qualify as a verifier`,
    );
  }
});

test('a generic read that merely accepts inputs is not a declared verifier', () => {
  const genericRead = manifest({
    manifestId: 'ledger_search', effect: 'read',
    acceptedInputKinds: ['ledger_handle'],
    readbackContract: { required: false, contentDigestRequired: false },
  });
  assert.deepEqual(compatibleVerifiers({ mutation: CREATE, catalog: [entry(genericRead)] }), [],
    'accepting inputs is not a declaration; an unrelated search must never stand in as proof');
});

test('a read that cannot accept the handle the mutation produces is not a verifier', () => {
  const wrongHandle = manifest({
    manifestId: 'ledger_read_wrong_handle', effect: 'read',
    acceptedInputKinds: ['something_else'],
  });
  assert.deepEqual(compatibleVerifiers({ mutation: CREATE, catalog: [entry(wrongHandle)] }), []);
});

test('a missing request pointer or response projector refuses; core never guesses the shape', () => {
  const noPointer = deriveVerificationRecipe({
    ...BASE, catalog: [entry(CREATE), entry(READER)], requestTargetPointers: [],
  });
  assert.equal(noPointer.ok, false);
  const noProjector = deriveVerificationRecipe({
    ...BASE, catalog: [entry(CREATE), entry(READER)], responseProjector: '   ',
  });
  assert.equal(noProjector.ok, false);
});

test('the recipe digest covers identity, proof kind, verifier and projection', () => {
  const base = deriveVerificationRecipe({ ...BASE, catalog: [entry(CREATE), entry(READER)] });
  assert.equal(base.ok, true);
  if (!base.ok) return;
  const { recipeDigest, ...withoutDigest } = base.recipe;
  assert.equal(verificationRecipeDigest(withoutDigest), recipeDigest,
    'the digest is reproducible from the recipe body');
  assert.notEqual(
    verificationRecipeDigest({ ...withoutDigest, proof: 'reversible_exact_content_v1' }),
    recipeDigest,
    'a different proof kind is a different recipe',
  );
  assert.notEqual(
    verificationRecipeDigest({ ...withoutDigest, staticArgs: { range: 'A1:C1' } }),
    recipeDigest,
    'static verifier arguments are part of the frozen recipe',
  );
});

test('a verifier identity is deterministic across processes and unique per target', () => {
  const identity = {
    acceptedTaskId: BASE.acceptedTaskId,
    workContractId: BASE.workContractId,
    ownerRequirementId: BASE.ownerRequirementId,
    ownerBindingDigest: BASE.ownerBindingDigest,
    recipeDigest: 'recipe-digest',
    proof: 'resource_identity_v1' as const,
    targetDigest: verificationTargetDigest('resource-a'),
  };
  assert.equal(verifierLogicalCallId(identity), verifierLogicalCallId({ ...identity }),
    'the same durable facts reproduce the same identity — this is what makes restart replay, not redispatch');
  assert.notEqual(
    verifierLogicalCallId(identity),
    verifierLogicalCallId({ ...identity, targetDigest: verificationTargetDigest('resource-b') }),
    'a different target is a different verifier call',
  );
  assert.notEqual(
    verifierLogicalCallId(identity),
    verifierLogicalCallId({ ...identity, ownerRequirementId: 'write_thing' }),
    'each mutation owns its own verifier identity',
  );
  assert.notEqual(
    verifierLogicalCallId(identity),
    verifierLogicalCallId({ ...identity, proof: 'reversible_exact_content_v1' }),
    'identity proof and content proof are different calls proving different states',
  );
});

test('manifest or account drift changes the frozen recipe', () => {
  const before = deriveVerificationRecipe({ ...BASE, catalog: [entry(CREATE), entry(READER)] });
  const drifted = entry(manifest({
    manifestId: 'ledger_read', effect: 'read',
    destination: { family: 'ledger', posture: 'named_existing' },
    acceptedInputKinds: ['ledger_handle'],
    operationVersion: '2',
  }));
  const after = deriveVerificationRecipe({ ...BASE, catalog: [entry(CREATE), drifted] });
  assert.equal(before.ok, true);
  assert.equal(after.ok, true);
  if (!before.ok || !after.ok) return;
  assert.notEqual(after.recipe.recipeDigest, before.recipe.recipeDigest,
    'a drifted verifier version must not reuse a recipe frozen against the old one');
});
