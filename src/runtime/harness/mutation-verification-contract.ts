import { createHash } from 'node:crypto';

import type { CapabilityManifestV1 } from './capability-manifest.js';
import type {
  CanonicalCatalogIdentityV1,
  RegisteredHostCapability,
} from './host-capability-catalog-factory.js';

export type MutationVerificationProofV1 =
  | 'resource_identity_v1'
  | 'exact_content_v1';

export interface ExactRangeValuesProjectionV1 {
  readonly version: 1;
  readonly kind: 'exact_range_values_v1';
  /** RFC 6901 pointer from the provider-owned root to the entry array. */
  readonly entriesPointer: string;
  /** RFC 6901 pointers relative to each entry. */
  readonly rangePointer: string;
  readonly valuesPointer: string;
}

/** One provider argument names one exact A1 range and its complete 2D grid. */
export interface ExactSingleRangeValuesProjectionV1 {
  readonly version: 1;
  readonly kind: 'exact_single_range_values_v1';
  readonly rangePointer: string;
  readonly valuesPointer: string;
}

export type ExactContentProjectionV1 =
  | ExactRangeValuesProjectionV1
  | ExactSingleRangeValuesProjectionV1;

/**
 * The retained provider result must be the payload of one closed, positively
 * acknowledged `{data,error,successful}` transport envelope. This is a
 * provider-neutral transport fact, not an operation-name heuristic.
 */
export type SuccessfulDataEnvelopeV1 = 'successful_data_envelope_v1';

export interface MutationVerificationContractV1 {
  readonly version: 1;
  readonly resourceFamily: string;
  readonly producedHandleKind: string;
  readonly proof: MutationVerificationProofV1;
  readonly target: {
    readonly source: 'authoritative_result' | 'provider_arguments';
    /** Exactly one required string pointer. Multiple ambient IDs are refused. */
    readonly pointers: readonly [string];
  };
  readonly resultEnvelope?: SuccessfulDataEnvelopeV1;
  readonly expectedContent?: {
    readonly projection: ExactContentProjectionV1;
    /** Exact verifier argument which receives the projected range list. */
    readonly verifierRequestRangePointer: string;
  };
}

export interface ReadbackVerificationContractV1 {
  readonly version: 1;
  readonly resourceFamily: string;
  readonly acceptedHandleKind: string;
  /** Exactly one verifier request target and one provider response target. */
  readonly requestTargetPointers: readonly [string];
  /** Legacy/direct response identity. New opaque-wrapper reads should bind
   * identity to the exact acknowledged request instead. */
  readonly responseTargetPointers?: readonly [string];
  readonly responseTarget?: {
    readonly version: 1;
    readonly kind: 'request_bound_success_v1';
  };
  readonly resultEnvelope?: SuccessfulDataEnvelopeV1;
  readonly observedContent?: {
    readonly projection: ExactContentProjectionV1;
    readonly requestRangePointer: string;
  };
}

export type OperationVerificationContractV1 =
  | { readonly mutation: MutationVerificationContractV1 }
  | { readonly readback: ReadbackVerificationContractV1 };

export interface MutationVerificationRecipeV1 {
  readonly version: 1;
  readonly acceptedTaskId: string;
  readonly workContractId: string;
  readonly ownerRequirementId: string;
  /** Digest of the owner binding before this recipe is embedded. */
  readonly ownerBindingDigest: string;
  readonly proof: MutationVerificationProofV1;
  readonly mutation: MutationVerificationContractV1;
  readonly verifierContract: ReadbackVerificationContractV1;
  readonly verifier: CanonicalCatalogIdentityV1;
  /** Static verifier arguments only. Target/ranges are instantiated from proof. */
  readonly verifierStaticArgs: Readonly<Record<string, unknown>>;
  readonly recipeDigest: string;
}

export type DeriveMutationVerificationRecipeResult =
  | { readonly ok: true; readonly recipe: MutationVerificationRecipeV1 }
  | {
      readonly ok: false;
      readonly code: 'verification_successor_required';
      readonly requirementId: string;
      readonly detail: string;
    };

const SHA256 = /^[a-f0-9]{64}$/;
const CONTRACT_ID = /^expected-work:v1:[a-f0-9]{64}$/;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

export function mutationVerificationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const permitted = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => permitted.has(key));
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9._:@/+-]+$/.test(value);
}

export function isRfc6901Pointer(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 512 || value[0] !== '/') return false;
  // Every tilde escape must be one of the two RFC 6901 escapes.
  return !/~(?:[^01]|$)/.test(value);
}

function onePointer(value: unknown): value is [string] {
  return Array.isArray(value) && value.length === 1 && isRfc6901Pointer(value[0]);
}

function parseRangeProjection(value: unknown): ExactRangeValuesProjectionV1 | null {
  if (!record(value) || !exactKeys(value, [
    'version', 'kind', 'entriesPointer', 'rangePointer', 'valuesPointer',
  ])) return null;
  if (
    value.version !== 1
    || value.kind !== 'exact_range_values_v1'
    || !isRfc6901Pointer(value.entriesPointer)
    || !isRfc6901Pointer(value.rangePointer)
    || !isRfc6901Pointer(value.valuesPointer)
  ) return null;
  return {
    version: 1,
    kind: 'exact_range_values_v1',
    entriesPointer: value.entriesPointer,
    rangePointer: value.rangePointer,
    valuesPointer: value.valuesPointer,
  };
}

function parseSingleRangeProjection(value: unknown): ExactSingleRangeValuesProjectionV1 | null {
  if (!record(value) || !exactKeys(value, [
    'version', 'kind', 'rangePointer', 'valuesPointer',
  ])) return null;
  if (
    value.version !== 1
    || value.kind !== 'exact_single_range_values_v1'
    || !isRfc6901Pointer(value.rangePointer)
    || !isRfc6901Pointer(value.valuesPointer)
  ) return null;
  return {
    version: 1,
    kind: 'exact_single_range_values_v1',
    rangePointer: value.rangePointer,
    valuesPointer: value.valuesPointer,
  };
}

function parseContentProjection(value: unknown): ExactContentProjectionV1 | null {
  return parseRangeProjection(value) ?? parseSingleRangeProjection(value);
}

export function parseMutationVerificationContract(
  value: unknown,
): MutationVerificationContractV1 | null {
  if (!record(value) || !exactKeys(value, [
    'version', 'resourceFamily', 'producedHandleKind', 'proof', 'target',
  ], ['resultEnvelope', 'expectedContent'])) return null;
  if (
    value.version !== 1
    || !boundedIdentity(value.resourceFamily)
    || !boundedIdentity(value.producedHandleKind)
    || (value.proof !== 'resource_identity_v1' && value.proof !== 'exact_content_v1')
    || !record(value.target)
    || !exactKeys(value.target, ['source', 'pointers'])
    || (value.target.source !== 'authoritative_result' && value.target.source !== 'provider_arguments')
    || !onePointer(value.target.pointers)
    || (value.resultEnvelope !== undefined
      && value.resultEnvelope !== 'successful_data_envelope_v1')
  ) return null;
  let expectedContent: MutationVerificationContractV1['expectedContent'];
  if (value.expectedContent !== undefined) {
    if (!record(value.expectedContent) || !exactKeys(value.expectedContent, [
      'projection', 'verifierRequestRangePointer',
    ])) return null;
    const projection = parseContentProjection(value.expectedContent.projection);
    if (!projection || !isRfc6901Pointer(value.expectedContent.verifierRequestRangePointer)) return null;
    expectedContent = {
      projection,
      verifierRequestRangePointer: value.expectedContent.verifierRequestRangePointer,
    };
  }
  if ((value.proof === 'exact_content_v1') !== Boolean(expectedContent)) return null;
  return {
    version: 1,
    resourceFamily: value.resourceFamily,
    producedHandleKind: value.producedHandleKind,
    proof: value.proof,
    target: { source: value.target.source, pointers: [value.target.pointers[0]] },
    ...(value.resultEnvelope === 'successful_data_envelope_v1'
      ? { resultEnvelope: value.resultEnvelope }
      : {}),
    ...(expectedContent ? { expectedContent } : {}),
  };
}

export function parseReadbackVerificationContract(
  value: unknown,
): ReadbackVerificationContractV1 | null {
  if (!record(value) || !exactKeys(value, [
    'version', 'resourceFamily', 'acceptedHandleKind',
    'requestTargetPointers',
  ], ['responseTargetPointers', 'responseTarget', 'resultEnvelope', 'observedContent'])) return null;
  const responseTarget = record(value.responseTarget)
    && exactKeys(value.responseTarget, ['version', 'kind'])
    && value.responseTarget.version === 1
    && value.responseTarget.kind === 'request_bound_success_v1'
    ? { version: 1 as const, kind: 'request_bound_success_v1' as const }
    : null;
  const responsePointers = onePointer(value.responseTargetPointers)
    ? value.responseTargetPointers
    : null;
  if (
    value.version !== 1
    || !boundedIdentity(value.resourceFamily)
    || !boundedIdentity(value.acceptedHandleKind)
    || !onePointer(value.requestTargetPointers)
    || Boolean(responsePointers) === Boolean(responseTarget)
    || (value.resultEnvelope !== undefined
      && value.resultEnvelope !== 'successful_data_envelope_v1')
    || (responseTarget && value.resultEnvelope !== 'successful_data_envelope_v1')
  ) return null;
  let observedContent: ReadbackVerificationContractV1['observedContent'];
  if (value.observedContent !== undefined) {
    if (!record(value.observedContent) || !exactKeys(value.observedContent, [
      'projection', 'requestRangePointer',
    ])) return null;
    const projection = parseContentProjection(value.observedContent.projection);
    if (!projection || !isRfc6901Pointer(value.observedContent.requestRangePointer)) return null;
    observedContent = {
      projection,
      requestRangePointer: value.observedContent.requestRangePointer,
    };
  }
  return {
    version: 1,
    resourceFamily: value.resourceFamily,
    acceptedHandleKind: value.acceptedHandleKind,
    requestTargetPointers: [value.requestTargetPointers[0]],
    ...(responsePointers ? { responseTargetPointers: [responsePointers[0]] as [string] } : {}),
    ...(responseTarget ? { responseTarget } : {}),
    ...(value.resultEnvelope === 'successful_data_envelope_v1'
      ? { resultEnvelope: value.resultEnvelope }
      : {}),
    ...(observedContent ? { observedContent } : {}),
  };
}

export function parseOperationVerificationContract(
  value: unknown,
): OperationVerificationContractV1 | null {
  if (!record(value)) return null;
  if (exactKeys(value, ['mutation'])) {
    const mutation = parseMutationVerificationContract(value.mutation);
    return mutation ? { mutation } : null;
  }
  if (exactKeys(value, ['readback'])) {
    const readback = parseReadbackVerificationContract(value.readback);
    return readback ? { readback } : null;
  }
  return null;
}

function schemaPath(pointer: string): string[] | null {
  if (!isRfc6901Pointer(pointer)) return null;
  return pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function schemaNodeAtPointer(schema: unknown, pointer: string): Record<string, unknown> | null {
  if (!record(schema)) return null;
  const path = schemaPath(pointer);
  if (!path || path.length === 0) return null;
  let cursor = schema;
  for (const segment of path) {
    if (!record(cursor.properties) || !record(cursor.properties[segment])) return null;
    cursor = cursor.properties[segment] as Record<string, unknown>;
  }
  return cursor;
}

function requiredSchemaPointer(schema: unknown, pointer: string, type: string): boolean {
  if (!record(schema)) return false;
  const path = schemaPath(pointer);
  if (!path || path.length !== 1) return false;
  return Array.isArray(schema.required)
    && schema.required.includes(path[0])
    && schemaNodeAtPointer(schema, pointer)?.type === type;
}

function topLevelSchemaPointer(schema: unknown, pointer: string, type: string): boolean {
  const path = schemaPath(pointer);
  return Boolean(path && path.length === 1 && schemaNodeAtPointer(schema, pointer)?.type === type);
}

function successfulDataEnvelopeSchema(schema: unknown): boolean {
  if (!record(schema) || !record(schema.properties)) return false;
  const keys = Object.keys(schema.properties);
  return schema.type === 'object'
    && keys.length === 3
    && keys.every((key) => key === 'data' || key === 'error' || key === 'successful')
    && Object.prototype.hasOwnProperty.call(schema.properties, 'error')
    && Array.isArray(schema.required)
    && schema.required.includes('data')
    && schema.required.includes('successful')
    && Boolean(schemaNodeAtPointer(schema, '/data'))
    && schemaNodeAtPointer(schema, '/successful')?.type === 'boolean';
}

function contentProjectionFitsSchema(
  schema: unknown,
  projection: ExactContentProjectionV1,
): boolean {
  return projection.kind === 'exact_range_values_v1'
    ? requiredSchemaPointer(schema, projection.entriesPointer, 'array')
    : requiredSchemaPointer(schema, projection.rangePointer, 'string')
      && requiredSchemaPointer(schema, projection.valuesPointer, 'array');
}

/** Revalidate one already-sealed verification descriptor against the exact
 * current schemas. The contract itself is the authority; operation/provider
 * names are never used to rediscover or replace it. */
export function validateOperationVerificationContractForSchemas(input: {
  contract: OperationVerificationContractV1;
  inputSchema: unknown;
  outputSchema: unknown;
}): OperationVerificationContractV1 | null {
  const contract = parseOperationVerificationContract(input.contract);
  if (!contract) return null;
  if ('mutation' in contract) {
    const mutation = contract.mutation;
    if (
      (mutation.resultEnvelope === 'successful_data_envelope_v1'
        && !successfulDataEnvelopeSchema(input.outputSchema))
      || (mutation.target.source === 'provider_arguments'
        && !requiredSchemaPointer(input.inputSchema, mutation.target.pointers[0], 'string'))
      || (mutation.target.source === 'authoritative_result'
        && mutation.resultEnvelope !== 'successful_data_envelope_v1'
        && !requiredSchemaPointer(input.outputSchema, mutation.target.pointers[0], 'string'))
      || (mutation.expectedContent
        && !contentProjectionFitsSchema(input.inputSchema, mutation.expectedContent.projection))
    ) return null;
    return contract;
  }
  const readback = contract.readback;
  if (
    !requiredSchemaPointer(input.inputSchema, readback.requestTargetPointers[0], 'string')
    || (readback.responseTarget?.kind === 'request_bound_success_v1'
      && (readback.resultEnvelope !== 'successful_data_envelope_v1'
        || !successfulDataEnvelopeSchema(input.outputSchema)))
    || (!readback.responseTarget
      && (!readback.responseTargetPointers
        || !requiredSchemaPointer(input.outputSchema, readback.responseTargetPointers[0], 'string')))
    || (readback.observedContent
      && (!topLevelSchemaPointer(input.inputSchema, readback.observedContent.requestRangePointer, 'array')
        || (readback.resultEnvelope !== 'successful_data_envelope_v1'
          && !contentProjectionFitsSchema(input.outputSchema, readback.observedContent.projection))))
  ) return null;
  return contract;
}

function externalVerification(manifest: CapabilityManifestV1): OperationVerificationContractV1 | null {
  return parseOperationVerificationContract(manifest.externalDefinition?.verification);
}

/** Provider-neutral semantic compatibility. Provider/account equality is a
 * separate catalog identity check because those facts do not belong inside an
 * adapter's operation contract. */
export function readbackContractMatchesMutation(
  mutation: MutationVerificationContractV1,
  readback: ReadbackVerificationContractV1,
): boolean {
  if (
    mutation.resourceFamily !== readback.resourceFamily
    || mutation.producedHandleKind !== readback.acceptedHandleKind
  ) return false;
  return mutation.proof !== 'exact_content_v1'
    || Boolean(
      mutation.expectedContent
      && readback.observedContent
      && mutation.expectedContent.verifierRequestRangePointer
        === readback.observedContent.requestRangePointer,
    );
}

function compatibleVerifier(input: {
  mutationManifest: CapabilityManifestV1;
  mutation: MutationVerificationContractV1;
  entry: RegisteredHostCapability;
}): boolean {
  const verifierManifest = input.entry.manifest;
  if (!verifierManifest || input.entry.effect !== 'read' || verifierManifest.effect !== 'read') return false;
  const declared = externalVerification(verifierManifest);
  if (!declared || !('readback' in declared)) return false;
  const readback = declared.readback;
  if (
    input.mutationManifest.providerKind !== verifierManifest.providerKind
    || input.mutationManifest.providerIdentity !== verifierManifest.providerIdentity
    || input.mutationManifest.accountId !== verifierManifest.accountId
    || !readbackContractMatchesMutation(input.mutation, readback)
  ) return false;
  return true;
}

export function compatibleMutationVerificationEntries(input: {
  mutation: CapabilityManifestV1;
  catalog: readonly RegisteredHostCapability[];
}): readonly RegisteredHostCapability[] {
  const declared = externalVerification(input.mutation);
  if (!declared || !('mutation' in declared)) return [];
  return input.catalog.filter((entry) => compatibleVerifier({
    mutationManifest: input.mutation,
    mutation: declared.mutation,
    entry,
  }));
}

export function deriveMutationVerificationRecipe(input: {
  readonly acceptedTaskId: string;
  readonly workContractId: string;
  readonly ownerRequirementId: string;
  readonly ownerBindingDigest: string;
  readonly mutation: CapabilityManifestV1;
  readonly catalog: readonly RegisteredHostCapability[];
  readonly canonicalIdentityOf: (entry: RegisteredHostCapability) => CanonicalCatalogIdentityV1 | null;
  readonly verifierStaticArgs?: Readonly<Record<string, unknown>>;
}): DeriveMutationVerificationRecipeResult {
  const refuse = (detail: string): DeriveMutationVerificationRecipeResult => ({
    ok: false,
    code: 'verification_successor_required',
    requirementId: input.ownerRequirementId,
    detail,
  });
  if (
    !input.acceptedTaskId.trim()
    || !CONTRACT_ID.test(input.workContractId)
    || !input.ownerRequirementId.trim()
    || !SHA256.test(input.ownerBindingDigest)
  ) return refuse('mutation verification owner identity is incomplete');
  const operation = externalVerification(input.mutation);
  if (!operation || !('mutation' in operation)) {
    return refuse(`mutation "${input.ownerRequirementId}" has no exact adapter verification contract`);
  }
  const candidates = compatibleMutationVerificationEntries({
    mutation: input.mutation,
    catalog: input.catalog,
  });
  if (candidates.length !== 1) {
    return refuse(candidates.length === 0
      ? `no compatible verifier exists for "${input.ownerRequirementId}"`
      : `${candidates.length} compatible verifiers exist for "${input.ownerRequirementId}"; exact selection is ambiguous`);
  }
  const verifier = input.canonicalIdentityOf(candidates[0]!);
  const verifierOperation = externalVerification(candidates[0]!.manifest!);
  if (!verifier || !verifierOperation || !('readback' in verifierOperation)) {
    return refuse(`the verifier for "${input.ownerRequirementId}" has no canonical identity`);
  }
  const draft = {
    version: 1 as const,
    acceptedTaskId: input.acceptedTaskId,
    workContractId: input.workContractId,
    ownerRequirementId: input.ownerRequirementId,
    ownerBindingDigest: input.ownerBindingDigest,
    proof: operation.mutation.proof,
    mutation: operation.mutation,
    verifierContract: verifierOperation.readback,
    verifier,
    verifierStaticArgs: { ...(input.verifierStaticArgs ?? {}) },
  };
  return {
    ok: true,
    recipe: { ...draft, recipeDigest: mutationVerificationDigest(draft) },
  };
}

export function parseMutationVerificationRecipe(value: unknown): MutationVerificationRecipeV1 | null {
  if (!record(value) || !exactKeys(value, [
    'version', 'acceptedTaskId', 'workContractId', 'ownerRequirementId',
    'ownerBindingDigest', 'proof', 'mutation', 'verifierContract', 'verifier',
    'verifierStaticArgs', 'recipeDigest',
  ])) return null;
  const mutation = parseMutationVerificationContract(value.mutation);
  const verifierContract = parseReadbackVerificationContract(value.verifierContract);
  if (
    value.version !== 1
    || typeof value.acceptedTaskId !== 'string'
    || !CONTRACT_ID.test(String(value.workContractId))
    || typeof value.ownerRequirementId !== 'string'
    || !SHA256.test(String(value.ownerBindingDigest))
    || !mutation
    || !verifierContract
    || value.proof !== mutation.proof
    || !record(value.verifier)
    || !record(value.verifierStaticArgs)
    || !SHA256.test(String(value.recipeDigest))
  ) return null;
  const { recipeDigest, ...body } = value;
  if (mutationVerificationDigest(body) !== recipeDigest) return null;
  return value as unknown as MutationVerificationRecipeV1;
}

function decodePointer(pointer: string): string[] | null {
  if (!isRfc6901Pointer(pointer)) return null;
  return pointer.slice(1).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function resolveVerificationPointer(root: unknown, pointer: string): unknown {
  const path = decodePointer(pointer);
  if (!path) return undefined;
  let cursor = root;
  for (const segment of path) {
    if (Array.isArray(cursor)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
      cursor = cursor[Number(segment)];
      continue;
    }
    if (!record(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

export function setVerificationPointer(
  root: Record<string, unknown>,
  pointer: string,
  value: unknown,
): boolean {
  const path = decodePointer(pointer);
  if (!path || path.length === 0) return false;
  let cursor: Record<string, unknown> = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const existing = cursor[segment];
    if (existing === undefined) {
      const child: Record<string, unknown> = {};
      cursor[segment] = child;
      cursor = child;
    } else if (record(existing)) {
      cursor = existing;
    } else {
      return false;
    }
  }
  cursor[path[path.length - 1]!] = value;
  return true;
}

export interface CanonicalRangeValuesV1 {
  readonly kind: 'exact_range_values_v1';
  readonly entries: readonly { readonly range: string; readonly values: unknown[][] }[];
}

function boundedJsonClone(value: unknown): unknown | undefined {
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > 1_000_000) return undefined;
    return JSON.parse(encoded) as unknown;
  } catch {
    return undefined;
  }
}

function projectRanges(root: unknown, projection: ExactRangeValuesProjectionV1): CanonicalRangeValuesV1 | null {
  const rows = resolveVerificationPointer(root, projection.entriesPointer);
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1_000) return null;
  const entries: Array<{ range: string; values: unknown[][] }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const range = resolveVerificationPointer(row, projection.rangePointer);
    const values = resolveVerificationPointer(row, projection.valuesPointer);
    if (
      typeof range !== 'string'
      || range !== range.trim()
      || !range
      || seen.has(range)
      || !Array.isArray(values)
      || !values.every((line) => Array.isArray(line))
    ) return null;
    const cloned = boundedJsonClone(values);
    if (!Array.isArray(cloned)) return null;
    seen.add(range);
    entries.push({ range, values: cloned as unknown[][] });
  }
  entries.sort((left, right) => left.range.localeCompare(right.range));
  return { kind: 'exact_range_values_v1', entries };
}

function projectSingleRange(
  root: unknown,
  projection: ExactSingleRangeValuesProjectionV1,
): CanonicalRangeValuesV1 | null {
  const range = resolveVerificationPointer(root, projection.rangePointer);
  const values = resolveVerificationPointer(root, projection.valuesPointer);
  if (
    typeof range !== 'string'
    || range !== range.trim()
    || !range
    || !Array.isArray(values)
    || values.length === 0
    || !values.every((line) => Array.isArray(line))
  ) return null;
  const cloned = boundedJsonClone(values);
  if (!Array.isArray(cloned)) return null;
  return {
    kind: 'exact_range_values_v1',
    entries: [{ range, values: cloned as unknown[][] }],
  };
}

function projectContent(
  root: unknown,
  projection: ExactContentProjectionV1,
): CanonicalRangeValuesV1 | null {
  return projection.kind === 'exact_range_values_v1'
    ? projectRanges(root, projection)
    : projectSingleRange(root, projection);
}

function exactResourceId(root: unknown, pointers: readonly [string]): string | null {
  const candidate = resolveVerificationPointer(root, pointers[0]);
  return typeof candidate === 'string'
    && candidate === candidate.trim()
    && candidate.length > 0
    && candidate.length <= 4_096
    ? candidate
    : null;
}

export type MutationVerificationIntentProjection =
  | {
      ok: true;
      resourceId: string;
      expectedContent: CanonicalRangeValuesV1 | null;
      verifierStaticArgs: Record<string, unknown>;
    }
  | { ok: false; reason: string };

export function projectMutationVerificationIntent(input: {
  contract: MutationVerificationContractV1;
  providerArguments: unknown;
  authoritativeResult: unknown;
  phase: 'pre_dispatch' | 'settled_result';
  providerAcknowledged?: boolean;
}): MutationVerificationIntentProjection {
  const contract = parseMutationVerificationContract(input.contract);
  if (!contract) return { ok: false, reason: 'mutation verification contract is invalid' };
  if (input.phase === 'pre_dispatch' && contract.target.source !== 'provider_arguments') {
    return { ok: false, reason: 'pre-dispatch verification may project only provider-owned arguments' };
  }
  const targetRoot = contract.target.source === 'provider_arguments'
    ? input.providerArguments
    : input.authoritativeResult;
  if (
    input.phase === 'settled_result'
    && contract.resultEnvelope
    && input.providerAcknowledged !== true
  ) {
    return { ok: false, reason: 'mutation result lacks one exact successful provider envelope' };
  }
  const resourceId = exactResourceId(targetRoot, contract.target.pointers);
  if (!resourceId) return { ok: false, reason: 'mutation did not yield one exact resource id' };
  if (!contract.expectedContent) {
    return { ok: true, resourceId, expectedContent: null, verifierStaticArgs: {} };
  }
  const expectedContent = projectContent(input.providerArguments, contract.expectedContent.projection);
  if (!expectedContent) return { ok: false, reason: 'mutation intended content is not exactly projectable' };
  const verifierStaticArgs: Record<string, unknown> = {};
  if (!setVerificationPointer(
    verifierStaticArgs,
    contract.expectedContent.verifierRequestRangePointer,
    expectedContent.entries.map((entry) => entry.range),
  )) return { ok: false, reason: 'verifier range argument cannot be instantiated' };
  return { ok: true, resourceId, expectedContent, verifierStaticArgs };
}

export type ReadbackVerificationResultProjection =
  | { ok: true; resourceId: string; observedContent: CanonicalRangeValuesV1 | null }
  | { ok: false; reason: string };

export function projectReadbackVerificationResult(input: {
  contract: ReadbackVerificationContractV1;
  providerArguments: unknown;
  authoritativeResult: unknown;
  requireContent: boolean;
  providerAcknowledged?: boolean;
}): ReadbackVerificationResultProjection {
  const contract = parseReadbackVerificationContract(input.contract);
  if (!contract) return { ok: false, reason: 'readback verification contract is invalid' };
  const requested = exactResourceId(input.providerArguments, contract.requestTargetPointers);
  if (contract.resultEnvelope && input.providerAcknowledged !== true) {
    return { ok: false, reason: 'readback lacks one exact successful provider envelope' };
  }
  const observed = contract.responseTarget?.kind === 'request_bound_success_v1'
    ? requested
    : contract.responseTargetPointers
      ? exactResourceId(input.authoritativeResult, contract.responseTargetPointers)
      : null;
  if (!requested || !observed || requested !== observed) {
    return { ok: false, reason: 'readback request and response resource ids do not match byte-for-byte' };
  }
  const observedContent = contract.observedContent
    ? projectContent(input.authoritativeResult, contract.observedContent.projection)
    : null;
  if (input.requireContent && !observedContent) {
    return { ok: false, reason: 'readback content is not exactly projectable' };
  }
  return { ok: true, resourceId: observed, observedContent };
}

export function exactVerificationContentMatches(
  expected: CanonicalRangeValuesV1 | null,
  observed: CanonicalRangeValuesV1 | null,
): boolean {
  return expected !== null
    && observed !== null
    && canonicalJson(expected) === canonicalJson(observed);
}

export function verifierLogicalCallId(input: {
  acceptedTaskId: string;
  workContractId: string;
  ownerRequirementId: string;
  ownerBindingDigest: string;
  recipeDigest: string;
  proof: MutationVerificationProofV1;
  targetDigest: string;
}): string {
  const digest = mutationVerificationDigest({ version: 1, ...input });
  return `verify:${input.ownerRequirementId}:${digest.slice(0, 32)}`;
}

/** A bounded verifier retry is a new read-only logical generation, never a new
 * mutation owner. Ordinal zero preserves the original protocol id; later ids
 * are deterministic and task-salted by that immutable base. */
export function verifierLogicalCallAttemptId(baseLogicalCallId: string, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error('verifier attempt ordinal is invalid');
  }
  if (ordinal === 0) return baseLogicalCallId;
  const digest = mutationVerificationDigest({
    version: 1,
    baseLogicalCallId,
    ordinal,
  });
  return `verify-retry:${ordinal}:${digest.slice(0, 32)}`;
}

export function verificationTargetDigest(resourceId: string): string {
  return mutationVerificationDigest({ version: 1, kind: 'resource_id', resourceId });
}

export interface MutationVerificationReceiptIdentityV1 {
  readonly recipe: MutationVerificationRecipeV1;
  readonly ownerLogicalToolCallId: string;
  readonly ownerPhysicalDispatchId: string;
  readonly ownerResultHandleId: string;
  readonly ownerResultSha256: string;
  readonly verifierLogicalCallId: string;
  readonly verifierPhysicalDispatchId: string;
  readonly verifierResultHandleId: string;
  readonly verifierResultSha256: string;
  readonly resourceId: string;
  readonly targetDigest: string;
}

/** Content address for one fully re-provable host-derived verifier receipt. */
export function mutationVerificationReceiptId(
  input: MutationVerificationReceiptIdentityV1,
): string {
  return `mutation-verification-receipt:v1:${mutationVerificationDigest({
    version: 1,
    acceptedTaskId: input.recipe.acceptedTaskId,
    workContractId: input.recipe.workContractId,
    ownerRequirementId: input.recipe.ownerRequirementId,
    ownerBindingDigest: input.recipe.ownerBindingDigest,
    recipeDigest: input.recipe.recipeDigest,
    proof: input.recipe.proof,
    providerKind: input.recipe.verifier.providerKind,
    account: input.recipe.verifier.account,
    manifestId: input.recipe.verifier.manifestId,
    manifestDigest: input.recipe.verifier.manifestDigest,
    ownerLogicalToolCallId: input.ownerLogicalToolCallId,
    ownerPhysicalDispatchId: input.ownerPhysicalDispatchId,
    ownerResultHandleId: input.ownerResultHandleId,
    ownerResultSha256: input.ownerResultSha256,
    verifierLogicalCallId: input.verifierLogicalCallId,
    verifierPhysicalDispatchId: input.verifierPhysicalDispatchId,
    verifierResultHandleId: input.verifierResultHandleId,
    verifierResultSha256: input.verifierResultSha256,
    resourceId: input.resourceId,
    targetDigest: input.targetDigest,
  })}`;
}
