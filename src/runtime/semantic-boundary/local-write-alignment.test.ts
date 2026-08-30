import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampRequestedEffect,
  type HostSemanticAuthorityV1,
} from './admit-turn-semantics.js';
import type { SemanticProjectionV1 } from './project-checked-semantics.js';
import { isRegistryDeclaredLocalPlanningMutation } from '../harness/local-planning-capability.js';

const localRef = 'cap:local:space_edit_runner:reversible';

function authority(
  revalidatedLocalCapabilityRefs: ReadonlySet<string> = new Set(),
): HostSemanticAuthorityV1 {
  return {
    policyRevision: 'policy:test',
    audienceHash: 'audience:test',
    policyMaxCeiling: 'external_write',
    allowedEffects: ['local_write', 'external_write'],
    revalidatedLocalCapabilityRefs,
  };
}

function projection(input: {
  effect: 'local_write' | 'external_write';
  capabilityRef: string;
}): SemanticProjectionV1 {
  return {
    kind: 'mint_goal',
    source: {
      sessionId: 'session:test',
      sourceUserSeq: 1,
      inputHash: 'input:test',
      audienceHash: 'audience:test',
    },
    relation: 'new_root',
    targetGoal: null,
    parkPriorGoal: false,
    goal: {
      construct: 'single_act',
      requestedEffect: input.effect,
      constraintIds: [],
      openSlotKeys: [],
      candidateRefs: [{ kind: 'capability', id: input.capabilityRef }],
      operations: [{
        id: 'edit_definition',
        role: 'destination',
        requestedEffect: input.effect,
        capabilityRef: input.capabilityRef,
        dependsOn: [],
        evidence: [],
      }],
      deliverables: [],
      evidenceRequirements: [],
    },
  };
}

test('an exact revalidated local envelope aligns a destinationless reversible definition edit', () => {
  assert.equal(
    isRegistryDeclaredLocalPlanningMutation('space_edit_runner'),
    true,
    'the exact reversible runner editor must be citable instead of leaving workflow_run as the only local-write card row',
  );
  assert.deepEqual(
    clampRequestedEffect(
      'local_write',
      authority(new Set([localRef])),
      projection({ effect: 'local_write', capabilityRef: localRef }),
    ),
    { effect: 'local_write' },
  );
});

test('a local-looking ref without current host revalidation remains refused', () => {
  assert.deepEqual(
    clampRequestedEffect(
      'local_write',
      authority(),
      projection({ effect: 'local_write', capabilityRef: localRef }),
    ),
    { effect: 'none', refuse: 'write_not_aligned' },
  );
});

test('current local authority never aligns a destinationless external write', () => {
  assert.deepEqual(
    clampRequestedEffect(
      'external_write',
      authority(new Set([localRef])),
      projection({ effect: 'external_write', capabilityRef: localRef }),
    ),
    { effect: 'none', refuse: 'write_not_aligned' },
  );
});
