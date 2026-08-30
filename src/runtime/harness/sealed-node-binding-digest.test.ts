import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingDigestOf, type SealedNodeBinding } from './host-capability-catalog-factory.js';
import { sealedNodeBindingDigestOf } from './sealed-node-binding-digest.js';

const base = {
  nodeId: 'write_once',
  capabilityId: 'cap:opaque:create',
  providerOperationId: 'OPAQUE_CREATE',
  logicalToolName: 'opaque_create',
  toolName: 'OPAQUE_CREATE',
  schemaVersion: 'v1',
  providerInputSchemaDigest: '1'.repeat(64),
  schemaDigest: '2'.repeat(64),
  argumentDigest: '3'.repeat(64),
  account: 'account:opaque',
  effect: 'external_write' as const,
  destination: { family: 'opaque-records', posture: 'create_new' },
};

test('mint and terminal re-derivation share one digest that seals generic operation semantics', () => {
  const withSemantics: Omit<SealedNodeBinding, 'bindingDigest'> = {
    ...base,
    operationSemantics: { version: 1, reversibility: 'reversible' },
  };
  const minted = bindingDigestOf(withSemantics);

  assert.equal(sealedNodeBindingDigestOf(withSemantics), minted);
  assert.notEqual(
    sealedNodeBindingDigestOf(base),
    minted,
    'a terminal verifier that omits the sealed semantics must not reproduce the minted authority',
  );
  assert.notEqual(
    sealedNodeBindingDigestOf({
      ...withSemantics,
      operationSemantics: { version: 1, reversibility: 'irreversible' },
    }),
    minted,
    'changing the provider-neutral risk semantic changes the binding authority',
  );
});
