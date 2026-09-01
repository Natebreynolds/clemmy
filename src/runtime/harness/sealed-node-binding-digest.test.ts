import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingDigestOf, type SealedNodeBinding } from './host-capability-catalog-factory.js';
import { sealedNodeBindingDigestOf } from './sealed-node-binding-digest.js';
import { deriveAsyncReadContinuationRecipe } from './async-read-continuation-contract.js';

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

test('the final node-binding digest covers the exact async read successor recipe', () => {
  const recipe = deriveAsyncReadContinuationRecipe({
    acceptedTaskId: 'task:session#1',
    workContractId: `expected-work:v1:${'4'.repeat(64)}`,
    ownerRequirementId: 'verify_recent_articles',
    ownerBindingDigest: sealedNodeBindingDigestOf(base),
    owner: {
      providerIdentity: 'provider:firecrawl',
      operationId: 'FIRECRAWL_BATCH_SCRAPE',
      schemaVersion: '20260826_00',
      providerInputSchemaDigest: '1'.repeat(64),
      providerOutputSchemaDigest: 'a'.repeat(64),
      account: 'connection:firecrawl',
    },
    getter: {
      capabilityId: 'cap:firecrawl:batch-get',
      manifestId: 'manifest:firecrawl:batch-get',
      manifestDigest: '5'.repeat(64),
      operationId: 'FIRECRAWL_BATCH_SCRAPE_GET',
      schemaVersion: '20260826_00',
      schemaDigest: '6'.repeat(64),
      providerKind: 'composio',
      providerVersion: '20260826_00',
      providerInputSchemaDigest: '7'.repeat(64),
      liveFingerprint: '8'.repeat(64),
      account: 'connection:firecrawl',
      effect: 'read',
      destination: null,
      idempotency: { required: false, policy: 'none' },
      reconciliation: { supported: false, policy: 'none' },
      invokePortId: 'invoke:composio:firecrawl',
      argumentCompiler: { id: 'composio', version: '1' },
    },
    getterProviderIdentity: 'provider:firecrawl',
    getterProviderOutputSchemaDigest: '9'.repeat(64),
  });
  assert.ok(recipe);
  const withAsync = { ...base, asyncRead: recipe! };
  assert.notEqual(sealedNodeBindingDigestOf(withAsync), sealedNodeBindingDigestOf(base));
  assert.notEqual(
    sealedNodeBindingDigestOf({
      ...withAsync,
      asyncRead: { ...recipe!, getterProviderOutputSchemaDigest: 'a'.repeat(64) },
    }),
    sealedNodeBindingDigestOf(withAsync),
  );
});
