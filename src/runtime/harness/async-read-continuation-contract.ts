import { createHash } from 'node:crypto';

import type { CanonicalCatalogIdentityV1 } from './host-capability-catalog-factory.js';

export const FIRECRAWL_BATCH_RECENT_ARTICLES_CONTINUATION =
  'firecrawl_batch_scrape_recent_articles_v1' as const;

export interface AsyncReadContinuationRecipeV1 {
  readonly version: 1;
  readonly kind: typeof FIRECRAWL_BATCH_RECENT_ARTICLES_CONTINUATION;
  readonly acceptedTaskId: string;
  readonly workContractId: string;
  readonly ownerRequirementId: string;
  /** Digest of the owner binding before this recipe is embedded. */
  readonly ownerBindingDigest: string;
  readonly owner: {
    readonly providerIdentity: string;
    readonly operationId: 'FIRECRAWL_BATCH_SCRAPE';
    readonly schemaVersion: '20260826_00';
    readonly providerInputSchemaDigest: string;
    readonly providerOutputSchemaDigest: string;
    readonly account: string;
  };
  /** Exact read-only successor frozen from the same accepted catalog. */
  readonly getter: CanonicalCatalogIdentityV1;
  readonly getterProviderIdentity: string;
  /** Output-schema attestation is carried separately because the shared
   * canonical catalog identity predates output-schema observation. */
  readonly getterProviderOutputSchemaDigest: string;
  readonly getterIdArgument: 'id';
  readonly maximumGetterAttempts: 6;
  readonly maximumElapsedMs: 180_000;
  readonly startReceiptContract: {
    readonly successfulPointer: '/successful';
    readonly successPointer: '/data/success';
    readonly idPointer: '/data/id';
    readonly urlPointer: '/data/url';
  };
  readonly getterResultContract: {
    readonly successfulPointer: '/successful';
    readonly statusPointer: '/data/status';
    readonly dataPointer: '/data/data';
    readonly completedStatus: 'completed';
  };
  readonly resultProjection: 'recent_article_date_evidence_v1';
  readonly recipeDigest: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const CONTRACT_ID = /^expected-work:v1:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9._:@/#\+-]{1,256}$/u;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

export function asyncReadContinuationRecipeDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const permitted = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => permitted.has(key));
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && IDENTIFIER.test(value);
}

function parseCatalogIdentity(value: unknown): CanonicalCatalogIdentityV1 | null {
  if (!record(value) || !exactKeys(value, [
    'capabilityId', 'manifestId', 'manifestDigest', 'operationId',
    'schemaVersion', 'schemaDigest', 'providerKind', 'providerVersion',
    'liveFingerprint', 'account', 'effect', 'destination', 'idempotency',
    'reconciliation', 'invokePortId', 'argumentCompiler',
  ], [
    'sourceSchemaFingerprint', 'providerInputSchemaDigest', 'reconcilePortId',
    'implementationDigest', 'invokeImplementationDigest', 'reconcileImplementationDigest',
  ])) return null;
  if (
    !boundedIdentity(value.capabilityId)
    || !boundedIdentity(value.manifestId)
    || !SHA256.test(String(value.manifestDigest))
    || value.operationId !== 'FIRECRAWL_BATCH_SCRAPE_GET'
    || !boundedIdentity(value.schemaVersion)
    || !SHA256.test(String(value.schemaDigest))
    || value.providerKind !== 'composio'
    || !boundedIdentity(value.providerVersion)
    || !SHA256.test(String(value.liveFingerprint))
    || !boundedIdentity(value.account)
    || value.effect !== 'read'
    || value.destination !== null
    || !record(value.idempotency)
    || !record(value.reconciliation)
    || !boundedIdentity(value.invokePortId)
    || !record(value.argumentCompiler)
    || !boundedIdentity(value.argumentCompiler.id)
    || !boundedIdentity(value.argumentCompiler.version)
    || !SHA256.test(String(value.providerInputSchemaDigest ?? ''))
  ) return null;
  return value as unknown as CanonicalCatalogIdentityV1;
}

export function parseAsyncReadContinuationRecipe(
  value: unknown,
): AsyncReadContinuationRecipeV1 | null {
  if (!record(value) || !exactKeys(value, [
    'version', 'kind', 'acceptedTaskId', 'workContractId', 'ownerRequirementId',
    'ownerBindingDigest', 'owner', 'getter', 'getterProviderIdentity',
    'getterProviderOutputSchemaDigest',
    'getterIdArgument', 'maximumGetterAttempts', 'maximumElapsedMs',
    'startReceiptContract', 'getterResultContract', 'resultProjection', 'recipeDigest',
  ])) return null;
  if (
    value.version !== 1
    || value.kind !== FIRECRAWL_BATCH_RECENT_ARTICLES_CONTINUATION
    || !boundedIdentity(value.acceptedTaskId)
    || !CONTRACT_ID.test(String(value.workContractId))
    || !boundedIdentity(value.ownerRequirementId)
    || !SHA256.test(String(value.ownerBindingDigest))
    || value.getterIdArgument !== 'id'
    || value.maximumGetterAttempts !== 6
    || value.maximumElapsedMs !== 180_000
    || value.resultProjection !== 'recent_article_date_evidence_v1'
    || !SHA256.test(String(value.getterProviderOutputSchemaDigest))
    || !SHA256.test(String(value.recipeDigest))
  ) return null;
  const getter = parseCatalogIdentity(value.getter);
  if (
    !record(value.owner)
    || !exactKeys(value.owner, [
      'providerIdentity', 'operationId', 'schemaVersion',
      'providerInputSchemaDigest', 'providerOutputSchemaDigest', 'account',
    ])
    || !boundedIdentity(value.owner.providerIdentity)
    || value.owner.operationId !== 'FIRECRAWL_BATCH_SCRAPE'
    || value.owner.schemaVersion !== '20260826_00'
    || !SHA256.test(String(value.owner.providerInputSchemaDigest))
    || !SHA256.test(String(value.owner.providerOutputSchemaDigest))
    || !boundedIdentity(value.owner.account)
    || !boundedIdentity(value.getterProviderIdentity)
  ) return null;
  if (
    !getter
    || getter.schemaVersion !== '20260826_00'
    || getter.account !== value.owner.account
    || value.getterProviderIdentity !== value.owner.providerIdentity
  ) return null;
  if (
    !record(value.startReceiptContract)
    || !exactKeys(value.startReceiptContract, [
      'successfulPointer', 'successPointer', 'idPointer', 'urlPointer',
    ])
    || value.startReceiptContract.successfulPointer !== '/successful'
    || value.startReceiptContract.successPointer !== '/data/success'
    || value.startReceiptContract.idPointer !== '/data/id'
    || value.startReceiptContract.urlPointer !== '/data/url'
    || !record(value.getterResultContract)
    || !exactKeys(value.getterResultContract, [
      'successfulPointer', 'statusPointer', 'dataPointer', 'completedStatus',
    ])
    || value.getterResultContract.successfulPointer !== '/successful'
    || value.getterResultContract.statusPointer !== '/data/status'
    || value.getterResultContract.dataPointer !== '/data/data'
    || value.getterResultContract.completedStatus !== 'completed'
  ) return null;
  const unsigned = {
    version: 1 as const,
    kind: FIRECRAWL_BATCH_RECENT_ARTICLES_CONTINUATION,
    acceptedTaskId: value.acceptedTaskId,
    workContractId: value.workContractId as string,
    ownerRequirementId: value.ownerRequirementId,
    ownerBindingDigest: value.ownerBindingDigest as string,
    owner: {
      providerIdentity: value.owner.providerIdentity as string,
      operationId: 'FIRECRAWL_BATCH_SCRAPE' as const,
      schemaVersion: '20260826_00' as const,
      providerInputSchemaDigest: value.owner.providerInputSchemaDigest as string,
      providerOutputSchemaDigest: value.owner.providerOutputSchemaDigest as string,
      account: value.owner.account as string,
    },
    getter,
    getterProviderIdentity: value.getterProviderIdentity as string,
    getterProviderOutputSchemaDigest: value.getterProviderOutputSchemaDigest as string,
    getterIdArgument: 'id' as const,
    maximumGetterAttempts: 6 as const,
    maximumElapsedMs: 180_000 as const,
    startReceiptContract: {
      successfulPointer: '/successful' as const,
      successPointer: '/data/success' as const,
      idPointer: '/data/id' as const,
      urlPointer: '/data/url' as const,
    },
    getterResultContract: {
      successfulPointer: '/successful' as const,
      statusPointer: '/data/status' as const,
      dataPointer: '/data/data' as const,
      completedStatus: 'completed' as const,
    },
    resultProjection: 'recent_article_date_evidence_v1' as const,
  };
  if (asyncReadContinuationRecipeDigest(unsigned) !== value.recipeDigest) return null;
  return { ...unsigned, recipeDigest: value.recipeDigest as string };
}

export function deriveAsyncReadContinuationRecipe(input: {
  acceptedTaskId: string;
  workContractId: string;
  ownerRequirementId: string;
  ownerBindingDigest: string;
  owner: AsyncReadContinuationRecipeV1['owner'];
  getter: CanonicalCatalogIdentityV1;
  getterProviderIdentity: string;
  getterProviderOutputSchemaDigest: string;
}): AsyncReadContinuationRecipeV1 | null {
  const unsigned = {
    version: 1 as const,
    kind: FIRECRAWL_BATCH_RECENT_ARTICLES_CONTINUATION,
    acceptedTaskId: input.acceptedTaskId,
    workContractId: input.workContractId,
    ownerRequirementId: input.ownerRequirementId,
    ownerBindingDigest: input.ownerBindingDigest,
    owner: input.owner,
    getter: input.getter,
    getterProviderIdentity: input.getterProviderIdentity,
    getterProviderOutputSchemaDigest: input.getterProviderOutputSchemaDigest,
    getterIdArgument: 'id' as const,
    maximumGetterAttempts: 6 as const,
    maximumElapsedMs: 180_000 as const,
    startReceiptContract: {
      successfulPointer: '/successful' as const,
      successPointer: '/data/success' as const,
      idPointer: '/data/id' as const,
      urlPointer: '/data/url' as const,
    },
    getterResultContract: {
      successfulPointer: '/successful' as const,
      statusPointer: '/data/status' as const,
      dataPointer: '/data/data' as const,
      completedStatus: 'completed' as const,
    },
    resultProjection: 'recent_article_date_evidence_v1' as const,
  };
  return parseAsyncReadContinuationRecipe({
    ...unsigned,
    recipeDigest: asyncReadContinuationRecipeDigest(unsigned),
  });
}
