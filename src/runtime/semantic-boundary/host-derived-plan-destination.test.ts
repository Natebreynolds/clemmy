/** Run: npx tsx --test src/runtime/semantic-boundary/host-derived-plan-destination.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  deriveMissingPrimaryPlanDestination,
} from './admit-and-compile-accepted-source.js';
import type { TurnSemanticProposalV1 } from './turn-semantic-proposal.js';
import {
  attachSemanticContract,
  capabilityManifestDigest,
  type CapabilityManifestV1,
  type CapabilityProviderKind,
  type ManifestEffect,
} from '../harness/capability-manifest.js';
import {
  createHostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from '../harness/host-capability-catalog-factory.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function manifest(input: {
  manifestId: string;
  operationId: string;
  providerKind: CapabilityProviderKind;
  effect?: ManifestEffect;
  account?: string;
  family?: string;
  posture?: 'create_new' | 'named_existing';
}): CapabilityManifestV1 {
  const effect = input.effect ?? 'external_write';
  return attachSemanticContract({
    version: 1,
    manifestId: input.manifestId,
    providerKind: input.providerKind,
    operationId: input.operationId,
    providerIdentity: `fixture:${input.providerKind}`,
    providerVersion: 'fixture-v1',
    operationVersion: '1',
    definitionFingerprint: sha256(`${input.providerKind}:${input.operationId}`),
    effect,
    destination: {
      family: input.family ?? 'fixture-resource',
      posture: input.posture ?? 'create_new',
    },
    accountId: input.account ?? 'acct-fixture',
    idempotency: {
      required: effect === 'external_write',
      policy: effect === 'external_write' ? 'key_before_dispatch' : 'none',
    },
    reconciliation: {
      supported: effect === 'external_write',
      policy: effect === 'external_write' ? 'exact_artifact' : 'none',
    },
    outputContract: { kind: 'created_resource' },
    evidenceContract: { kinds: ['receipt'], readbackRequired: false },
    provenance: {
      issuer: 'host:test',
      issuedAt: '2026-08-30T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination'],
  });
}

function registered(current: CapabilityManifestV1): RegisteredHostCapability {
  return {
    capabilityId: current.manifestId,
    toolName: current.operationId,
    schemaVersion: current.operationVersion,
    schemaDigest: current.definitionFingerprint,
    effect: current.effect,
    destination: current.destination,
    account: current.accountId,
    advisoryRoles: current.advisoryRoles,
    manifestDigest: capabilityManifestDigest(current),
    providerKind: current.providerKind,
    liveFingerprint: current.definitionFingerprint,
    manifest: current,
    invoke: async () => ({}),
  };
}

function frozenEntries(...manifests: CapabilityManifestV1[]): RegisteredHostCapability[] {
  return [...createHostCapabilityCatalogFactory(manifests.map(registered)).snapshot()];
}

function proposal(input: {
  refs: readonly string[];
  effects?: readonly ('external_write' | 'admin' | 'local_write')[];
  destination?: NonNullable<TurnSemanticProposalV1['work']>['destination'];
  destinations?: NonNullable<TurnSemanticProposalV1['work']>['destinations'];
}): TurnSemanticProposalV1 {
  const effects = input.effects ?? input.refs.map(() => 'external_write' as const);
  return {
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Perform the exact selected fixture work.',
      criteria: [{ id: 'criterion_1', statement: 'The exact fixture result exists.' }],
      openSlots: [],
      candidates: [],
    },
    work: {
      construct: 'single_act',
      cardinality: { count: input.refs.length, fields: [] },
      destination: input.destination ?? null,
      ...(input.destinations !== undefined ? { destinations: input.destinations } : {}),
      requestedEffect: effects.includes('admin') ? 'admin'
        : effects.includes('external_write') ? 'external_write'
          : 'local_write',
      operations: input.refs.map((capabilityRef, index) => ({
        id: `write_${index + 1}`,
        role: 'destination',
        requestedEffect: effects[index]!,
        capabilityRef,
        dependsOn: [],
        evidence: ['receipt'],
      })),
      deliverables: input.refs.map((_, index) => ({
        id: `artifact_${index + 1}`,
        kind: 'fixture-resource',
      })),
      evidenceRequirements: ['receipt'],
    },
    slotAnswers: [],
    rationale: 'fixture',
  };
}

test('a destinationless exact write derives only host-owned current manifest metadata', () => {
  for (const providerKind of ['composio', 'native_mcp', 'reviewed_cli'] as const) {
    const baseRef = `cap:resolved:${providerKind}:create`;
    const currentRef = `${baseRef}:definition:${providerKind}`;
    const current = manifest({
      manifestId: currentRef,
      operationId: `fixture_${providerKind}_create`,
      providerKind,
      account: `acct-${providerKind}`,
      family: `family-${providerKind}`,
      posture: 'create_new',
    });
    const result = deriveMissingPrimaryPlanDestination({
      proposal: proposal({ refs: [baseRef] }),
      catalogEntries: frozenEntries(current),
      resolveCurrentRef: (ref) => ref === baseRef ? currentRef : undefined,
    });
    assert.equal(result.ok, true, providerKind);
    if (!result.ok) continue;
    assert.equal(result.derived, true, providerKind);
    assert.deepEqual(result.proposal.work?.destination, {
      family: `family-${providerKind}`,
      posture: 'create_new',
      handleRequired: false,
    });
    assert.deepEqual(result.proposal.work?.destinations, [result.proposal.work.destination]);
  }
});

test('an invented write ref cannot acquire destination authority', () => {
  const current = manifest({
    manifestId: 'cap:fixture:current',
    operationId: 'fixture_create',
    providerKind: 'native_mcp',
  });
  const result = deriveMissingPrimaryPlanDestination({
    proposal: proposal({ refs: ['cap:fixture:invented'] }),
    catalogEntries: frozenEntries(current),
  });
  assert.deepEqual(result, {
    ok: false,
    reason: 'host_destination_identity_unavailable:cap:fixture:invented',
  });
});

test('a selected manifest whose effect differs from the operation fails closed', () => {
  const current = manifest({
    manifestId: 'cap:fixture:admin',
    operationId: 'fixture_admin',
    providerKind: 'composio',
    effect: 'admin',
  });
  const result = deriveMissingPrimaryPlanDestination({
    proposal: proposal({ refs: [current.manifestId], effects: ['external_write'] }),
    catalogEntries: frozenEntries(current),
  });
  assert.deepEqual(result, {
    ok: false,
    reason: `host_destination_effect_mismatch:${current.manifestId}`,
  });
});

test('different exact destination accounts or families are never collapsed into one sink', () => {
  const first = manifest({
    manifestId: 'cap:fixture:first',
    operationId: 'fixture_create_first',
    providerKind: 'composio',
    account: 'acct-first',
    family: 'family-first',
  });
  const second = manifest({
    manifestId: 'cap:fixture:second',
    operationId: 'fixture_create_second',
    providerKind: 'native_mcp',
    account: 'acct-second',
    family: 'family-second',
  });
  const result = deriveMissingPrimaryPlanDestination({
    proposal: proposal({ refs: [first.manifestId, second.manifestId] }),
    catalogEntries: frozenEntries(first, second),
  });
  assert.deepEqual(result, {
    ok: false,
    reason: 'host_destination_ambiguous_multiple_exact_targets',
  });
});

test('a conflicting destination-list projection fails closed', () => {
  const current = manifest({
    manifestId: 'cap:fixture:projected',
    operationId: 'fixture_create_projected',
    providerKind: 'reviewed_cli',
  });
  const result = deriveMissingPrimaryPlanDestination({
    proposal: proposal({
      refs: [current.manifestId],
      destinations: [{
        family: 'model-invented-family',
        posture: 'named_existing',
        handleRequired: false,
      }],
    }),
    catalogEntries: frozenEntries(current),
  });
  assert.deepEqual(result, {
    ok: false,
    reason: 'host_destination_projection_conflict',
  });
});

test('local-only writes remain destinationless for the revalidated local-envelope path', () => {
  const draft = proposal({ refs: ['cap:local:fixture-edit'], effects: ['local_write'] });
  const result = deriveMissingPrimaryPlanDestination({
    proposal: draft,
    catalogEntries: [],
  });
  assert.deepEqual(result, { ok: true, proposal: draft, derived: false });
});
