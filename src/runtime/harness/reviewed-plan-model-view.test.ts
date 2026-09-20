import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewedPlanModelView } from './reviewed-plan-model-view.js';
import type { PlanStructuredOutline } from './plan-artifacts.js';

const digest = 'a'.repeat(64);
test('model view omits only local host digests and leaves the authoritative artifact intact', () => {
  const outline: PlanStructuredOutline = {
    steps: [{ id: 'save', capabilityRef: 'cap:local:space_save:reversible', staticArguments: { text: digest } }],
    executionDraft: { topology: { operations: [{ id: 'save', cardinality: { kind: 'once' } }] } },
    preparedBindings: [{
      stepId: 'save', inputSchema: { type: 'object', properties: { text: { const: digest } } },
      identity: { kind: 'local_registry', inputSchemaDigest: digest, definition: {
        version: 1, provenance: 'authorized_local_registry', name: 'space_save',
        accountIdentity: 'local_registry:host', destructive: false, reversibility: 'reversible',
        schemaFingerprint: digest, registrySemanticsFingerprint: digest, envelopeFingerprint: digest,
        descriptor: { manifestDigest: digest, effect: 'local_write', evidenceKinds: ['local_commit_receipt'] },
      } },
    }],
  };
  const original = JSON.stringify(outline);
  const expected = JSON.parse(original);
  const identity = expected.preparedBindings[0].identity;
  delete identity.inputSchemaDigest;
  for (const key of ['schemaFingerprint', 'registrySemanticsFingerprint', 'envelopeFingerprint']) delete identity.definition[key];
  delete identity.definition.descriptor.manifestDigest;
  assert.deepEqual(reviewedPlanModelView(outline), expected);
  assert.equal(JSON.stringify(outline), original);
  assert.deepEqual(reviewedPlanModelView(reviewedPlanModelView(outline)), expected);
});

test('provider identities, future versions, unexpected values and read-only draft state survive', () => {
  const outline: PlanStructuredOutline = { executionDraft: null, preparedBindings: [
    { identity: { kind: 'provider', inputSchemaDigest: digest } },
    { identity: { kind: 'local_registry', definition: { version: 2, provenance: 'authorized_local_registry', schemaFingerprint: digest } } },
    { identity: { kind: 'local_registry', definition: { version: 1, provenance: 'unrecognized', schemaFingerprint: digest } } },
    { identity: { kind: 'local_registry', definition: { version: 1, provenance: 'authorized_local_registry', schemaFingerprint: 'unexpected-value' } } },
    null,
  ] };
  assert.deepEqual(reviewedPlanModelView(outline), outline);
  assert.deepEqual(reviewedPlanModelView({ steps: [] }), { steps: [] });
});
