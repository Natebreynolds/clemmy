import assert from 'node:assert/strict';
import test from 'node:test';
import { unboundDestinationUsesOnlyRevalidatedLocalEnvelopes } from './admit-and-compile-accepted-source.js';

const localRef = 'cap:local:workflow_create:reversible';

function operation(input: {
  id: string;
  requestedEffect: 'read' | 'local_write' | 'external_write';
  capabilityRef: string | null;
}) {
  return {
    ...input,
    role: 'destination',
    dependsOn: [] as string[],
    evidence: [] as string[],
  };
}

test('unbound provider destination is inapplicable only for an exactly revalidated local write envelope', () => {
  assert.equal(unboundDestinationUsesOnlyRevalidatedLocalEnvelopes({
    operations: [operation({
      id: 'create_workflow',
      requestedEffect: 'local_write',
      capabilityRef: localRef,
    })],
    revalidatedLocalCapabilityRefs: new Set([localRef]),
  }), true);

  assert.equal(unboundDestinationUsesOnlyRevalidatedLocalEnvelopes({
    operations: [operation({
      id: 'create_workflow',
      requestedEffect: 'local_write',
      capabilityRef: localRef,
    })],
    revalidatedLocalCapabilityRefs: new Set(),
  }), false, 'a local-looking prefix without current revalidation cannot suppress the warning');

  assert.equal(unboundDestinationUsesOnlyRevalidatedLocalEnvelopes({
    operations: [
      operation({ id: 'create_workflow', requestedEffect: 'local_write', capabilityRef: localRef }),
      operation({ id: 'publish_workflow', requestedEffect: 'external_write', capabilityRef: 'cap:provider:publish' }),
    ],
    revalidatedLocalCapabilityRefs: new Set([localRef]),
  }), false, 'a mixed provider write still requires the provider-binding warning');
});

test('read operations do not turn an exactly local write into a provider destination', () => {
  assert.equal(unboundDestinationUsesOnlyRevalidatedLocalEnvelopes({
    operations: [
      operation({ id: 'read_source', requestedEffect: 'read', capabilityRef: 'cap:provider:read' }),
      operation({ id: 'create_workflow', requestedEffect: 'local_write', capabilityRef: localRef }),
    ],
    revalidatedLocalCapabilityRefs: new Set([localRef]),
  }), true);

  assert.equal(unboundDestinationUsesOnlyRevalidatedLocalEnvelopes({
    operations: [operation({ id: 'read_source', requestedEffect: 'read', capabilityRef: 'cap:provider:read' })],
    revalidatedLocalCapabilityRefs: new Set([localRef]),
  }), false, 'a turn with no admitted write is not classified as a local destination');
});
