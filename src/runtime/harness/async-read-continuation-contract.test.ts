import assert from 'node:assert/strict';
import test from 'node:test';

import {
  asyncReadContinuationRecipeDigest,
  deriveAsyncReadContinuationRecipe,
  parseAsyncReadContinuationRecipe,
} from './async-read-continuation-contract.js';

const digest = (value: string): string => value.repeat(64);

const getter = {
  capabilityId: 'cap:firecrawl:batch-get',
  manifestId: 'manifest:firecrawl:batch-get',
  manifestDigest: digest('1'),
  operationId: 'FIRECRAWL_BATCH_SCRAPE_GET',
  schemaVersion: '20260826_00',
  schemaDigest: digest('2'),
  providerKind: 'composio',
  providerVersion: '20260826_00',
  providerInputSchemaDigest: digest('3'),
  liveFingerprint: digest('4'),
  account: 'connection:firecrawl',
  effect: 'read',
  destination: null,
  idempotency: { required: false, policy: 'none' },
  reconciliation: { supported: false, policy: 'none' },
  invokePortId: 'invoke:composio:firecrawl',
  argumentCompiler: { id: 'composio', version: '1' },
};

test('batch read continuation seals one exact same-source getter and closed result contracts', () => {
  const recipe = deriveAsyncReadContinuationRecipe({
    acceptedTaskId: 'task:session#1',
    workContractId: `expected-work:v1:${digest('5')}`,
    ownerRequirementId: 'verify_recent_articles',
    ownerBindingDigest: digest('6'),
    owner: {
      providerIdentity: 'provider:firecrawl',
      operationId: 'FIRECRAWL_BATCH_SCRAPE',
      schemaVersion: '20260826_00',
      providerInputSchemaDigest: digest('8'),
      providerOutputSchemaDigest: digest('9'),
      account: 'connection:firecrawl',
    },
    getter,
    getterProviderIdentity: 'provider:firecrawl',
    getterProviderOutputSchemaDigest: digest('7'),
  });
  assert.ok(recipe);
  assert.deepEqual(parseAsyncReadContinuationRecipe(recipe), recipe);
  assert.equal(recipe!.getterIdArgument, 'id');
  assert.equal(recipe!.startReceiptContract.idPointer, '/data/id');
  assert.equal(recipe!.getterResultContract.dataPointer, '/data/data');
  assert.equal(recipe!.maximumGetterAttempts, 6);

  const unsigned = { ...recipe } as Record<string, unknown>;
  delete unsigned.recipeDigest;
  assert.equal(recipe!.recipeDigest, asyncReadContinuationRecipeDigest(unsigned));
});

test('batch read continuation refuses foreign, drifted, widened, and malformed getters', () => {
  const base = deriveAsyncReadContinuationRecipe({
    acceptedTaskId: 'task:session#1',
    workContractId: `expected-work:v1:${digest('5')}`,
    ownerRequirementId: 'verify_recent_articles',
    ownerBindingDigest: digest('6'),
    owner: {
      providerIdentity: 'provider:firecrawl',
      operationId: 'FIRECRAWL_BATCH_SCRAPE',
      schemaVersion: '20260826_00',
      providerInputSchemaDigest: digest('8'),
      providerOutputSchemaDigest: digest('9'),
      account: 'connection:firecrawl',
    },
    getter,
    getterProviderIdentity: 'provider:firecrawl',
    getterProviderOutputSchemaDigest: digest('7'),
  })!;
  const resign = (next: Record<string, unknown>) => {
    const unsigned = { ...next };
    delete unsigned.recipeDigest;
    return { ...unsigned, recipeDigest: asyncReadContinuationRecipeDigest(unsigned) };
  };
  for (const changed of [
    { ...base, getter: { ...base.getter, operationId: 'FIRECRAWL_GET_THE_STATUS_OF_A_CRAWL_JOB' } },
    { ...base, getter: { ...base.getter, schemaVersion: 'legacy' } },
    { ...base, getter: { ...base.getter, account: 'connection:foreign' } },
    { ...base, getter: { ...base.getter, effect: 'external_write' } },
    { ...base, getter: { ...base.getter, providerInputSchemaDigest: undefined } },
    { ...base, getterProviderOutputSchemaDigest: null },
    { ...base, maximumGetterAttempts: 7 },
    { ...base, getterResultContract: { ...base.getterResultContract, dataPointer: '/data' } },
    { ...base, unexpected: true },
  ]) {
    assert.equal(parseAsyncReadContinuationRecipe(resign(changed as unknown as Record<string, unknown>)), null);
  }
});
