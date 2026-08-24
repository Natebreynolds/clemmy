import { createHash } from 'node:crypto';

/**
 * Domain-neutral entity resolution foundation.
 *
 * This module is deliberately pure. It owns no database, event log, memory,
 * workflow, or session integration. Callers provide immutable state and an
 * explicit scoring policy; every operation returns a new immutable state.
 */

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

export class CanonicalEntityContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalEntityContractError';
  }
}

function contractError(code: string, message: string): never {
  throw new CanonicalEntityContractError(code, message);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

const CANONICAL_JSON_MAX_DEPTH = 64;
const CANONICAL_JSON_MAX_NODES = 200_000;
const CANONICAL_JSON_MAX_CONTAINER_ENTRIES = 50_000;
const CANONICAL_JSON_MAX_STRING_BYTES = 1_048_576;
const CANONICAL_JSON_MAX_TOTAL_BYTES = 16_777_216;

/** Locale-independent ordering shared by content-addressed entity authority. */
export function compareCanonicalEntityText(left: string, right: string): number {
  if (left === right) return 0;
  const compared = Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  if (compared !== 0) return compared;
  // Defensive total-order fallback for any caller that has not yet crossed the
  // canonical-text boundary. Canonical entity inputs reject lone surrogates.
  return left < right ? -1 : 1;
}

export function isCanonicalEntityText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

interface CanonicalJsonTraversal {
  readonly seen: Set<object>;
  nodes: number;
}

function boundedJsonString(value: string, path: string): string {
  if (!isCanonicalEntityText(value)) {
    contractError('invalid_unicode', `${path} must contain well-formed Unicode text.`);
  }
  if (Buffer.byteLength(value, 'utf8') > CANONICAL_JSON_MAX_STRING_BYTES) {
    contractError('json_limit_exceeded', `${path} exceeds the canonical JSON string limit.`);
  }
  return value;
}

function canonicalJsonValue(
  value: unknown,
  path = '$',
  traversal: CanonicalJsonTraversal = { seen: new Set<object>(), nodes: 0 },
  depth = 0,
): CanonicalJson {
  traversal.nodes += 1;
  if (traversal.nodes > CANONICAL_JSON_MAX_NODES || depth > CANONICAL_JSON_MAX_DEPTH) {
    contractError('json_limit_exceeded', `${path} exceeds canonical JSON traversal limits.`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return boundedJsonString(value, path);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) contractError('non_json_value', `${path} must be a finite JSON number.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    contractError('non_json_value', `${path} must contain JSON values only.`);
  }
  const object = value as object;
  if (traversal.seen.has(object)) contractError('cyclic_json_value', `${path} must not contain a cycle.`);
  traversal.seen.add(object);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        contractError('non_json_value', `${path} must be a plain JSON array.`);
      }
      if (value.length > CANONICAL_JSON_MAX_CONTAINER_ENTRIES) {
        contractError('json_limit_exceeded', `${path} exceeds the canonical JSON container limit.`);
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key === 'symbol')
        || ownKeys.some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key as string))
        || ownKeys.length !== value.length + 1) {
        contractError('non_json_value', `${path} must be a dense JSON array without extra properties.`);
      }
      const result: CanonicalJson[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable
          || descriptor.value === undefined) {
          contractError('non_json_value', `${path}[${index}] must be an enumerable JSON data value.`);
        }
        result.push(canonicalJsonValue(
          descriptor.value,
          `${path}[${index}]`,
          traversal,
          depth + 1,
        ));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      contractError('non_json_value', `${path} must be a plain JSON object.`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      contractError('non_json_value', `${path} must be a JSON object with string keys only.`);
    }
    if (ownKeys.length > CANONICAL_JSON_MAX_CONTAINER_ENTRIES) {
      contractError('json_limit_exceeded', `${path} exceeds the canonical JSON container limit.`);
    }
    const result: Record<string, CanonicalJson> = {};
    for (const key of (ownKeys as string[]).sort(compareCanonicalEntityText)) {
      boundedJsonString(key, `${path} key`);
      if (RESERVED_MAP_KEYS.has(key)) {
        contractError('reserved_map_key', `${path} uses reserved map key "${key}".`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable
        || descriptor.value === undefined) {
        contractError('non_json_value', `${path}.${key} must not be undefined.`);
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: canonicalJsonValue(descriptor.value, `${path}.${key}`, traversal, depth + 1),
      });
    }
    return result;
  } finally {
    traversal.seen.delete(object);
  }
}

function stableJson(value: CanonicalJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort(compareCanonicalEntityText).map((key) => (
    `${JSON.stringify(key)}:${stableJson((value as Record<string, CanonicalJson>)[key])}`
  )).join(',')}}`;
}

/** Shared canonical bytes for durable normalized stores and integrity checks. */
export function canonicalEntityJson(value: unknown): string {
  const canonical = stableJson(canonicalJsonValue(value));
  if (Buffer.byteLength(canonical, 'utf8') > CANONICAL_JSON_MAX_TOTAL_BYTES) {
    contractError('json_limit_exceeded', 'Canonical JSON exceeds the total byte limit.');
  }
  return canonical;
}

/** Shared raw sha256 over canonical entity JSON (without a semantic prefix). */
export function canonicalEntitySha256(value: unknown): string {
  return createHash('sha256').update(canonicalEntityJson(value), 'utf8').digest('hex');
}

function digest(prefix: string, value: unknown): string {
  return `${prefix}:${createHash('sha256').update(canonicalEntityJson(value), 'utf8').digest('hex')}`;
}

function exactNonBlank(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    contractError('invalid_exact_identifier', `${label} must be a non-blank exact string without surrounding whitespace.`);
  }
  if (!isCanonicalEntityText(value)) {
    contractError('invalid_unicode', `${label} must contain well-formed Unicode text.`);
  }
  return value;
}

function normalizedName(value: string, label: string): string {
  if (typeof value !== 'string') contractError('invalid_name', `${label} must be a string.`);
  if (!isCanonicalEntityText(value)) {
    contractError('invalid_unicode', `${label} must contain well-formed Unicode text.`);
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) contractError('invalid_name', `${label} must not be blank.`);
  return normalized;
}

const RESERVED_MAP_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function safeMapKey(value: string, label: string): string {
  if (RESERVED_MAP_KEYS.has(value)) {
    contractError('reserved_map_key', `${label} uses reserved map key "${value}".`);
  }
  return value;
}

function normalizedSignalValue(value: string, label: string): string {
  if (typeof value !== 'string') contractError('invalid_signal', `${label} must be a string.`);
  if (!isCanonicalEntityText(value)) {
    contractError('invalid_unicode', `${label} must contain well-formed Unicode text.`);
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) contractError('invalid_signal', `${label} must not be blank after normalization.`);
  return normalized;
}

function canonicalInstant(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    contractError('invalid_timestamp', `${label} must be a timestamp string.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    contractError('invalid_timestamp', `${label} must be an RFC 3339 instant with an explicit offset.`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) contractError('invalid_timestamp', `${label} must be a valid timestamp.`);
  return new Date(millis).toISOString();
}

function finiteUnitInterval(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    contractError('invalid_confidence', `${label} must be finite and between 0 and 1.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function sortedUnique<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => compareCanonicalEntityText(left, right))
    .map(([, value]) => value);
}

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Readonly<Record<string, T>> {
  const result: Record<string, T> = {};
  for (const [key, value] of [...entries]
    .sort(([left], [right]) => compareCanonicalEntityText(left, right))) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }
  return result;
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export interface EntityOrigin {
  /** Opaque namespace controlled by the observer. */
  readonly sourceId: string;
  /** Opaque source-local identity. */
  readonly recordId: string;
  /** Optional immutable source revision. */
  readonly revision?: string;
}

export interface FieldProvenance {
  readonly sourceId: string;
  readonly recordId: string;
  readonly path?: string;
}

export interface ObservedFieldInput {
  readonly value: unknown;
  readonly provenance: FieldProvenance;
  readonly confidence: number;
  readonly observedAt: string;
}

export interface ExactEntityIdentifier {
  /** Namespace and value are opaque and byte-exact; the engine never case-folds them. */
  readonly namespace: string;
  readonly value: string;
}

export interface CompoundSignalInput {
  readonly name: string;
  /** At least two labeled components are required. */
  readonly components: Readonly<Record<string, string>>;
}

export interface EntityObservationInput {
  readonly entityKind: string;
  readonly origin: EntityOrigin;
  readonly observedAt: string;
  readonly fields: Readonly<Record<string, ObservedFieldInput>>;
  readonly exactIdentifiers?: readonly ExactEntityIdentifier[];
  readonly compoundSignals?: readonly CompoundSignalInput[];
}

export interface NormalizedCompoundSignal {
  readonly name: string;
  readonly components: Readonly<Record<string, string>>;
  /** Length-safe content identity; raw component concatenation is never used. */
  readonly fingerprint: string;
}

export interface EntityObservation {
  readonly version: 1;
  readonly observationId: string;
  readonly entityKind: string;
  readonly origin: EntityOrigin;
  readonly observedAt: string;
  readonly fields: Readonly<Record<string, {
    readonly value: CanonicalJson;
    readonly provenance: FieldProvenance;
    readonly confidence: number;
    readonly observedAt: string;
  }>>;
  readonly exactIdentifiers: readonly ExactEntityIdentifier[];
  readonly compoundSignals: readonly NormalizedCompoundSignal[];
}

function normalizeOrigin(origin: EntityOrigin, label: string): EntityOrigin {
  const normalized: EntityOrigin = {
    sourceId: exactNonBlank(origin.sourceId, `${label}.sourceId`),
    recordId: exactNonBlank(origin.recordId, `${label}.recordId`),
    ...(origin.revision === undefined
      ? {}
      : { revision: exactNonBlank(origin.revision, `${label}.revision`) }),
  };
  return normalized;
}

function normalizeProvenance(provenance: FieldProvenance, label: string): FieldProvenance {
  return {
    sourceId: exactNonBlank(provenance.sourceId, `${label}.sourceId`),
    recordId: exactNonBlank(provenance.recordId, `${label}.recordId`),
    ...(provenance.path === undefined
      ? {}
      : { path: exactNonBlank(provenance.path, `${label}.path`) }),
  };
}

export function normalizeCompoundSignal(input: CompoundSignalInput): NormalizedCompoundSignal {
  const name = normalizedName(input.name, 'compound signal name');
  const rawEntries = Object.entries(input.components);
  if (rawEntries.length < 2) {
    contractError('invalid_compound_signal', `Compound signal "${name}" requires at least two labeled components.`);
  }
  const entries = new Map<string, string>();
  for (const [rawName, rawValue] of rawEntries) {
    const componentName = safeMapKey(
      normalizedName(rawName, `component name in ${name}`),
      `component name in ${name}`,
    );
    const componentValue = normalizedSignalValue(rawValue, `component ${componentName} in ${name}`);
    if (entries.has(componentName)) {
      contractError('normalized_key_collision', `Compound signal "${name}" has colliding component names after normalization.`);
    }
    entries.set(componentName, componentValue);
  }
  const components = sortedRecord(entries);
  return deepFreeze({
    name,
    components,
    fingerprint: digest('compound-signal:v1', { name, components }),
  });
}

/** Create a content-addressed, deeply immutable observation. */
export function createEntityObservation(input: EntityObservationInput): EntityObservation {
  const entityKind = normalizedName(input.entityKind, 'entityKind');
  const origin = normalizeOrigin(input.origin, 'origin');
  const observedAt = canonicalInstant(input.observedAt, 'observedAt');

  const fields = new Map<string, EntityObservation['fields'][string]>();
  for (const [rawName, field] of Object.entries(input.fields)) {
    const name = safeMapKey(normalizedName(rawName, 'field name'), 'field name');
    if (fields.has(name)) {
      contractError('normalized_key_collision', `Field names collide after normalization at "${name}".`);
    }
    fields.set(name, {
      value: canonicalJsonValue(field.value, `fields.${name}.value`),
      provenance: normalizeProvenance(field.provenance, `fields.${name}.provenance`),
      confidence: finiteUnitInterval(field.confidence, `fields.${name}.confidence`),
      observedAt: canonicalInstant(field.observedAt, `fields.${name}.observedAt`),
    });
  }

  const exactIdentifiers = sortedUnique(
    (input.exactIdentifiers ?? []).map((identifier, index) => ({
      namespace: exactNonBlank(identifier.namespace, `exactIdentifiers[${index}].namespace`),
      value: exactNonBlank(identifier.value, `exactIdentifiers[${index}].value`),
    })),
    (identifier) => stableJson(canonicalJsonValue(identifier)),
  );
  const compoundSignals = sortedUnique(
    (input.compoundSignals ?? []).map(normalizeCompoundSignal),
    (signal) => signal.fingerprint,
  );
  const content = {
    version: 1 as const,
    entityKind,
    origin,
    observedAt,
    fields: sortedRecord(fields),
    exactIdentifiers,
    compoundSignals,
  };
  return deepFreeze({
    ...content,
    observationId: digest('entity-observation:v1', content),
  });
}

export interface EntityResolutionPolicy {
  readonly policyId: string;
  readonly mergeThreshold: number;
  readonly distinctThreshold: number;
  readonly ambiguityMargin: number;
  readonly weights: {
    readonly defaultExactIdentifierMatch: number;
    readonly exactIdentifierMatches?: Readonly<Record<string, number>>;
    readonly defaultCompoundSignalMatch: number;
    readonly compoundSignalMatches?: Readonly<Record<string, number>>;
  };
  /** Different values in one of these namespaces are a hard conflict once a candidate has positive evidence. */
  readonly exclusiveIdentifierNamespaces?: readonly string[];
}

interface NormalizedPolicy {
  readonly policyId: string;
  readonly policyDigest: string;
  readonly mergeThreshold: number;
  readonly distinctThreshold: number;
  readonly ambiguityMargin: number;
  readonly defaultExactIdentifierMatch: number;
  readonly exactIdentifierMatches: Readonly<Record<string, number>>;
  readonly defaultCompoundSignalMatch: number;
  readonly compoundSignalMatches: Readonly<Record<string, number>>;
  readonly exclusiveIdentifierNamespaces: readonly string[];
}

export interface EntityResolutionPolicySnapshot {
  readonly policyId: string;
  readonly policyDigest: string;
  readonly mergeThreshold: number;
  readonly distinctThreshold: number;
  readonly ambiguityMargin: number;
  readonly defaultExactIdentifierMatch: number;
  readonly exactIdentifierMatches: Readonly<Record<string, number>>;
  readonly defaultCompoundSignalMatch: number;
  readonly compoundSignalMatches: Readonly<Record<string, number>>;
  readonly exclusiveIdentifierNamespaces: readonly string[];
}

function policySnapshot(policy: NormalizedPolicy): EntityResolutionPolicySnapshot {
  return policy;
}

/** Normalize and content-address a supplied policy without resolving an entity. */
export function createEntityResolutionPolicySnapshot(
  policy: EntityResolutionPolicy,
): EntityResolutionPolicySnapshot {
  return policySnapshot(normalizePolicy(policy));
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    contractError('invalid_resolution_policy', `${label} must be finite and non-negative.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizeWeightMap(
  input: Readonly<Record<string, number>> | undefined,
  label: string,
): Readonly<Record<string, number>> {
  const weights = new Map<string, number>();
  for (const [rawName, rawWeight] of Object.entries(input ?? {})) {
    const name = safeMapKey(normalizedName(rawName, `${label} key`), `${label} key`);
    if (weights.has(name)) contractError('normalized_key_collision', `${label} keys collide at "${name}".`);
    weights.set(name, finiteNonNegative(rawWeight, `${label}.${name}`));
  }
  return sortedRecord(weights);
}

function normalizeExactWeightMap(
  input: Readonly<Record<string, number>> | undefined,
  label: string,
): Readonly<Record<string, number>> {
  const weights = new Map<string, number>();
  for (const [rawName, rawWeight] of Object.entries(input ?? {})) {
    const name = safeMapKey(exactNonBlank(rawName, `${label} key`), `${label} key`);
    weights.set(name, finiteNonNegative(rawWeight, `${label}.${name}`));
  }
  return sortedRecord(weights);
}

function normalizePolicy(policy: EntityResolutionPolicy): NormalizedPolicy {
  const policyId = exactNonBlank(policy.policyId, 'policyId');
  const mergeThreshold = finiteNonNegative(policy.mergeThreshold, 'mergeThreshold');
  const distinctThreshold = finiteNonNegative(policy.distinctThreshold, 'distinctThreshold');
  const ambiguityMargin = finiteNonNegative(policy.ambiguityMargin, 'ambiguityMargin');
  if (distinctThreshold >= mergeThreshold) {
    contractError('invalid_resolution_policy', 'distinctThreshold must be lower than mergeThreshold.');
  }
  const exactIdentifierMatches = normalizeExactWeightMap(
    policy.weights.exactIdentifierMatches,
    'exactIdentifierMatches',
  );
  const compoundSignalMatches = normalizeWeightMap(
    policy.weights.compoundSignalMatches,
    'compoundSignalMatches',
  );
  const exclusiveIdentifierNamespaces = sortedUnique(
    (policy.exclusiveIdentifierNamespaces ?? []).map((name) => exactNonBlank(name, 'exclusive identifier namespace')),
    (name) => name,
  );
  const normalizedWithoutDigest = {
    policyId,
    mergeThreshold,
    distinctThreshold,
    ambiguityMargin,
    defaultExactIdentifierMatch: finiteNonNegative(
      policy.weights.defaultExactIdentifierMatch,
      'defaultExactIdentifierMatch',
    ),
    exactIdentifierMatches,
    defaultCompoundSignalMatch: finiteNonNegative(
      policy.weights.defaultCompoundSignalMatch,
      'defaultCompoundSignalMatch',
    ),
    compoundSignalMatches,
    exclusiveIdentifierNamespaces,
  };
  return deepFreeze({
    ...normalizedWithoutDigest,
    policyDigest: digest('entity-resolution-policy:v1', normalizedWithoutDigest),
  });
}

export interface CanonicalFieldEvidence {
  readonly evidenceId: string;
  readonly observationId: string;
  readonly field: string;
  readonly value: CanonicalJson;
  readonly provenance: FieldProvenance;
  readonly confidence: number;
  readonly observedAt: string;
}

export interface CanonicalEntityField {
  readonly name: string;
  readonly selectedEvidenceId: string;
  /** Every assertion is retained; conflicting values never overwrite provenance. */
  readonly evidence: readonly CanonicalFieldEvidence[];
  readonly conflicting: boolean;
}

export interface ResolutionCandidateScore {
  readonly canonicalId: string;
  readonly score: number;
  readonly matchedExactIdentifiers: readonly string[];
  readonly matchedCompoundSignals: readonly string[];
  readonly conflictingExactNamespaces: readonly string[];
}

export interface EntityAuditFieldChange {
  readonly field: string;
  readonly addedEvidenceId: string;
  readonly previousSelectedEvidenceId?: string;
  readonly selectedEvidenceId: string;
  readonly conflicting: boolean;
}

export interface EntityResolutionAuditEntry {
  readonly auditId: string;
  readonly action: 'create' | 'merge';
  readonly canonicalId: string;
  readonly observationId: string;
  readonly observedAt: string;
  readonly policyId: string;
  readonly policyDigest: string;
  readonly policy: EntityResolutionPolicySnapshot;
  readonly score: number;
  readonly candidates: readonly ResolutionCandidateScore[];
  readonly fieldChanges: readonly EntityAuditFieldChange[];
}

export interface CanonicalEntityRecord {
  readonly version: 1;
  readonly canonicalId: string;
  readonly entityKind: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly observationIds: readonly string[];
  readonly exactIdentifiers: readonly ExactEntityIdentifier[];
  readonly compoundSignals: readonly NormalizedCompoundSignal[];
  readonly fields: Readonly<Record<string, CanonicalEntityField>>;
  /** Append-only immutable resolution history. */
  readonly audit: readonly EntityResolutionAuditEntry[];
}

export type EntityResolutionDecision =
  | {
    readonly decision: 'merge';
    readonly observationId: string;
    readonly canonicalId: string;
    readonly policyId: string;
    readonly policyDigest: string;
    readonly policy: EntityResolutionPolicySnapshot;
    readonly score: number;
    readonly candidates: readonly ResolutionCandidateScore[];
    readonly auditId: string;
  }
  | {
    readonly decision: 'distinct';
    readonly observationId: string;
    readonly canonicalId: string;
    readonly policyId: string;
    readonly policyDigest: string;
    readonly policy: EntityResolutionPolicySnapshot;
    readonly score: number;
    readonly candidates: readonly ResolutionCandidateScore[];
    readonly auditId: string;
  }
  | {
    readonly decision: 'quarantine';
    readonly observationId: string;
    readonly quarantineId: string;
    readonly policyId: string;
    readonly policyDigest: string;
    readonly policy: EntityResolutionPolicySnapshot;
    readonly reason:
      | 'exact_identifier_collision'
      | 'conflicting_exact_identifier'
      | 'ambiguous_candidates'
      | 'threshold_uncertainty'
      | 'canonical_id_collision';
    readonly candidates: readonly ResolutionCandidateScore[];
  };

export interface EntityResolutionState {
  readonly version: 1;
  readonly records: Readonly<Record<string, CanonicalEntityRecord>>;
  /** Immutable content retained so an observation-ID collision cannot masquerade as replay. */
  readonly observations: Readonly<Record<string, EntityObservation>>;
  /** Permanent idempotency receipts, including quarantines; never bounded or evicted. */
  readonly decisions: Readonly<Record<string, EntityResolutionDecision>>;
}

export function createEntityResolutionState(): EntityResolutionState {
  return deepFreeze({ version: 1, records: {}, observations: {}, decisions: {} });
}

function identifierKey(identifier: ExactEntityIdentifier): string {
  return stableJson(canonicalJsonValue([identifier.namespace, identifier.value]));
}

function identifierDisplayKey(identifier: ExactEntityIdentifier): string {
  return digest('exact-identifier:v1', identifier);
}

function fieldEvidence(observation: EntityObservation, name: string): CanonicalFieldEvidence {
  const field = ownValue(observation.fields, name);
  if (!field) contractError('invalid_observation_state', `Observation field ${name} is missing.`);
  const content = {
    observationId: observation.observationId,
    field: name,
    value: field.value,
    provenance: field.provenance,
    confidence: field.confidence,
    observedAt: field.observedAt,
  };
  return deepFreeze({ evidenceId: digest('entity-field-evidence:v1', content), ...content });
}

function selectedEvidence(evidence: readonly CanonicalFieldEvidence[]): CanonicalFieldEvidence {
  return [...evidence].sort((left, right) => (
    right.confidence - left.confidence
    || compareCanonicalEntityText(right.observedAt, left.observedAt)
    || compareCanonicalEntityText(left.evidenceId, right.evidenceId)
  ))[0];
}

function canonicalField(name: string, evidence: readonly CanonicalFieldEvidence[]): CanonicalEntityField {
  const retained = sortedUnique(evidence, (entry) => entry.evidenceId);
  const selected = selectedEvidence(retained);
  const values = new Set(retained.map((entry) => stableJson(entry.value)));
  return deepFreeze({
    name,
    selectedEvidenceId: selected.evidenceId,
    evidence: retained,
    conflicting: values.size > 1,
  });
}

function scoreCandidates(
  state: EntityResolutionState,
  observation: EntityObservation,
  policy: NormalizedPolicy,
): ResolutionCandidateScore[] {
  const incomingIdentifiers = new Map(observation.exactIdentifiers.map((identifier) => [identifierKey(identifier), identifier]));
  const incomingSignals = new Map(observation.compoundSignals.map((signal) => [signal.fingerprint, signal]));
  const exclusive = new Set(policy.exclusiveIdentifierNamespaces);
  const candidates: ResolutionCandidateScore[] = [];

  for (const record of Object.values(state.records)) {
    if (record.entityKind !== observation.entityKind) continue;
    const recordIdentifiers = new Map(record.exactIdentifiers.map((identifier) => [identifierKey(identifier), identifier]));
    const matchedExact = [...incomingIdentifiers.keys()]
      .filter((key) => recordIdentifiers.has(key))
      .sort(compareCanonicalEntityText);
    const recordSignals = new Map(record.compoundSignals.map((signal) => [signal.fingerprint, signal]));
    const matchedSignals = [...incomingSignals.keys()]
      .filter((key) => recordSignals.has(key))
      .sort(compareCanonicalEntityText);
    let score = 0;
    for (const key of matchedExact) {
      const namespace = incomingIdentifiers.get(key)!.namespace;
      score += ownValue(policy.exactIdentifierMatches, namespace)
        ?? policy.defaultExactIdentifierMatch;
    }
    for (const fingerprint of matchedSignals) {
      const name = incomingSignals.get(fingerprint)!.name;
      score += ownValue(policy.compoundSignalMatches, name) ?? policy.defaultCompoundSignalMatch;
    }

    const conflictingNamespaces: string[] = [];
    if (score > 0) {
      for (const namespace of exclusive) {
        const incomingValues = new Set(observation.exactIdentifiers
          .filter((identifier) => identifier.namespace === namespace)
          .map((identifier) => identifier.value));
        const recordValues = new Set(record.exactIdentifiers
          .filter((identifier) => identifier.namespace === namespace)
          .map((identifier) => identifier.value));
        if (incomingValues.size > 0 && recordValues.size > 0
          && ![...incomingValues].some((value) => recordValues.has(value))) {
          conflictingNamespaces.push(namespace);
        }
      }
    }
    if (score > 0 || conflictingNamespaces.length > 0) {
      candidates.push(deepFreeze({
        canonicalId: record.canonicalId,
        score,
        matchedExactIdentifiers: matchedExact.map((key) => identifierDisplayKey(incomingIdentifiers.get(key)!)),
        matchedCompoundSignals: matchedSignals,
        conflictingExactNamespaces: conflictingNamespaces.sort(compareCanonicalEntityText),
      }));
    }
  }
  return candidates.sort((left, right) => (
    right.score - left.score || compareCanonicalEntityText(left.canonicalId, right.canonicalId)
  ));
}

function exactIdentifierOwners(state: EntityResolutionState): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const record of Object.values(state.records)) {
    for (const identifier of record.exactIdentifiers) {
      const key = identifierKey(identifier);
      const current = owners.get(key) ?? [];
      if (!current.includes(record.canonicalId)) current.push(record.canonicalId);
      owners.set(key, current.sort(compareCanonicalEntityText));
    }
  }
  return owners;
}

function newCanonicalId(observation: EntityObservation): string {
  const stableAnchor = observation.exactIdentifiers.length > 0
    ? { entityKind: observation.entityKind, exactIdentifiers: observation.exactIdentifiers }
    : { entityKind: observation.entityKind, observationId: observation.observationId };
  return digest('canonical-entity:v1', stableAnchor);
}

function quarantineDecision(
  observation: EntityObservation,
  policy: NormalizedPolicy,
  reason: Extract<EntityResolutionDecision, { decision: 'quarantine' }>['reason'],
  candidates: readonly ResolutionCandidateScore[],
): Extract<EntityResolutionDecision, { decision: 'quarantine' }> {
  const content = {
    observationId: observation.observationId,
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
    reason,
    candidateIds: candidates.map((candidate) => candidate.canonicalId),
  };
  return deepFreeze({
    decision: 'quarantine',
    observationId: observation.observationId,
    quarantineId: digest('entity-quarantine:v1', content),
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
    policy: policySnapshot(policy),
    reason,
    candidates,
  });
}

interface ResolutionPlan {
  readonly decision: 'merge' | 'distinct';
  readonly canonicalId: string;
  readonly score: number;
  readonly candidates: readonly ResolutionCandidateScore[];
}

function planResolution(
  state: EntityResolutionState,
  observation: EntityObservation,
  policy: NormalizedPolicy,
): ResolutionPlan | Extract<EntityResolutionDecision, { decision: 'quarantine' }> {
  const candidates = scoreCandidates(state, observation, policy);
  const owners = exactIdentifierOwners(state);
  const matchedOwners = new Set<string>();
  const exclusive = new Set(policy.exclusiveIdentifierNamespaces);
  for (const namespace of exclusive) {
    const values = new Set(observation.exactIdentifiers
      .filter((identifier) => identifier.namespace === namespace)
      .map((identifier) => identifier.value));
    if (values.size > 1) {
      return quarantineDecision(observation, policy, 'conflicting_exact_identifier', candidates);
    }
  }
  for (const identifier of observation.exactIdentifiers) {
    const identifierOwners = owners.get(identifierKey(identifier)) ?? [];
    if (identifierOwners.length > 1) {
      return quarantineDecision(observation, policy, 'exact_identifier_collision', candidates);
    }
    for (const owner of identifierOwners) matchedOwners.add(owner);
  }
  if (matchedOwners.size > 1) {
    return quarantineDecision(observation, policy, 'exact_identifier_collision', candidates);
  }

  let best = candidates[0];
  if (matchedOwners.size === 1) {
    const exactOwner = [...matchedOwners][0];
    const ownerCandidate = candidates.find((candidate) => candidate.canonicalId === exactOwner);
    if (!ownerCandidate) {
      return quarantineDecision(observation, policy, 'exact_identifier_collision', candidates);
    }
    if (best && best.canonicalId !== exactOwner && best.score >= ownerCandidate.score) {
      return quarantineDecision(observation, policy, 'ambiguous_candidates', candidates);
    }
    best = ownerCandidate;
  }
  if (best?.conflictingExactNamespaces.length) {
    return quarantineDecision(observation, policy, 'conflicting_exact_identifier', candidates);
  }
  if (best && best.score >= policy.mergeThreshold) {
    const second = candidates.find((candidate) => candidate.canonicalId !== best.canonicalId);
    if (second && second.score > policy.distinctThreshold
      && best.score - second.score <= policy.ambiguityMargin) {
      return quarantineDecision(observation, policy, 'ambiguous_candidates', candidates);
    }
    return { decision: 'merge', canonicalId: best.canonicalId, score: best.score, candidates };
  }
  if (matchedOwners.size === 1) {
    return quarantineDecision(observation, policy, 'threshold_uncertainty', candidates);
  }
  if (best && best.score > policy.distinctThreshold) {
    return quarantineDecision(observation, policy, 'threshold_uncertainty', candidates);
  }
  const canonicalId = newCanonicalId(observation);
  if (ownValue(state.records, canonicalId)) {
    return quarantineDecision(observation, policy, 'canonical_id_collision', candidates);
  }
  return { decision: 'distinct', canonicalId, score: best?.score ?? 0, candidates };
}

function makeAudit(
  action: 'create' | 'merge',
  canonicalId: string,
  observation: EntityObservation,
  policy: NormalizedPolicy,
  score: number,
  candidates: readonly ResolutionCandidateScore[],
  fieldChanges: readonly EntityAuditFieldChange[],
): EntityResolutionAuditEntry {
  const content = {
    action,
    canonicalId,
    observationId: observation.observationId,
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
    policy: policySnapshot(policy),
    score,
    candidates,
    fieldChanges,
  };
  return deepFreeze({
    auditId: digest('entity-resolution-audit:v1', content),
    ...content,
    observedAt: observation.observedAt,
  });
}

function createRecord(
  canonicalId: string,
  observation: EntityObservation,
  policy: NormalizedPolicy,
  score: number,
  candidates: readonly ResolutionCandidateScore[],
): CanonicalEntityRecord {
  const fields = new Map<string, CanonicalEntityField>();
  const changes: EntityAuditFieldChange[] = [];
  for (const name of Object.keys(observation.fields).sort(compareCanonicalEntityText)) {
    const evidence = fieldEvidence(observation, name);
    const field = canonicalField(name, [evidence]);
    fields.set(name, field);
    changes.push({
      field: name,
      addedEvidenceId: evidence.evidenceId,
      selectedEvidenceId: field.selectedEvidenceId,
      conflicting: false,
    });
  }
  const audit = makeAudit('create', canonicalId, observation, policy, score, candidates, changes);
  return deepFreeze({
    version: 1,
    canonicalId,
    entityKind: observation.entityKind,
    createdAt: observation.observedAt,
    updatedAt: observation.observedAt,
    observationIds: [observation.observationId],
    exactIdentifiers: observation.exactIdentifiers,
    compoundSignals: observation.compoundSignals,
    fields: sortedRecord(fields),
    audit: [audit],
  });
}

function mergeRecord(
  record: CanonicalEntityRecord,
  observation: EntityObservation,
  policy: NormalizedPolicy,
  score: number,
  candidates: readonly ResolutionCandidateScore[],
): CanonicalEntityRecord {
  const fields = new Map(Object.entries(record.fields));
  const changes: EntityAuditFieldChange[] = [];
  for (const name of Object.keys(observation.fields).sort(compareCanonicalEntityText)) {
    const prior = fields.get(name);
    const evidence = fieldEvidence(observation, name);
    const next = canonicalField(name, [...(prior?.evidence ?? []), evidence]);
    fields.set(name, next);
    changes.push({
      field: name,
      addedEvidenceId: evidence.evidenceId,
      ...(prior ? { previousSelectedEvidenceId: prior.selectedEvidenceId } : {}),
      selectedEvidenceId: next.selectedEvidenceId,
      conflicting: next.conflicting,
    });
  }
  const audit = makeAudit('merge', record.canonicalId, observation, policy, score, candidates, changes);
  return deepFreeze({
    ...record,
    createdAt: record.createdAt < observation.observedAt ? record.createdAt : observation.observedAt,
    updatedAt: record.updatedAt > observation.observedAt ? record.updatedAt : observation.observedAt,
    observationIds: [...new Set([...record.observationIds, observation.observationId])]
      .sort(compareCanonicalEntityText),
    exactIdentifiers: sortedUnique(
      [...record.exactIdentifiers, ...observation.exactIdentifiers],
      identifierKey,
    ),
    compoundSignals: sortedUnique(
      [...record.compoundSignals, ...observation.compoundSignals],
      (signal) => signal.fingerprint,
    ),
    fields: sortedRecord(fields),
    audit: [...record.audit, audit],
  });
}

function resolutionDecision(
  plan: ResolutionPlan,
  observation: EntityObservation,
  policy: NormalizedPolicy,
  auditId: string,
): Extract<EntityResolutionDecision, { decision: 'merge' | 'distinct' }> {
  return deepFreeze({
    decision: plan.decision,
    observationId: observation.observationId,
    canonicalId: plan.canonicalId,
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
    policy: policySnapshot(policy),
    score: plan.score,
    candidates: plan.candidates,
    auditId,
  });
}

export interface EntityUpsertResult {
  readonly state: EntityResolutionState;
  readonly decision: EntityResolutionDecision;
  readonly idempotent: boolean;
}

/**
 * Immutable insert-or-return. A replay returns the original pinned decision,
 * even if the caller now supplies a different policy.
 */
export function upsertEntityObservation(
  state: EntityResolutionState,
  input: EntityObservationInput,
  suppliedPolicy: EntityResolutionPolicy,
): EntityUpsertResult {
  const observation = createEntityObservation(input);
  const prior = ownValue(state.decisions, observation.observationId);
  const priorObservation = ownValue(state.observations, observation.observationId);
  if (prior || priorObservation) {
    if (!prior || !priorObservation
      || stableJson(canonicalJsonValue(priorObservation)) !== stableJson(canonicalJsonValue(observation))) {
      contractError(
        'observation_id_collision',
        `Observation identity ${observation.observationId} is already bound to different or incomplete retained content.`,
      );
    }
    return { state, decision: prior, idempotent: true };
  }
  const policy = normalizePolicy(suppliedPolicy);
  const plan = planResolution(state, observation, policy);

  if ('quarantineId' in plan) {
    const decisions = sortedRecord([
      ...Object.entries(state.decisions),
      [observation.observationId, plan] as const,
    ]);
    const observations = sortedRecord([
      ...Object.entries(state.observations),
      [observation.observationId, observation] as const,
    ]);
    return {
      state: deepFreeze({ ...state, observations, decisions }),
      decision: plan,
      idempotent: false,
    };
  }

  const priorRecord = plan.decision === 'merge' ? ownValue(state.records, plan.canonicalId) : undefined;
  if (plan.decision === 'merge' && !priorRecord) {
    contractError('invalid_resolution_state', `Resolution candidate ${plan.canonicalId} is missing.`);
  }
  const record = plan.decision === 'merge'
    ? mergeRecord(priorRecord!, observation, policy, plan.score, plan.candidates)
    : createRecord(plan.canonicalId, observation, policy, plan.score, plan.candidates);
  const decision = resolutionDecision(
    plan,
    observation,
    policy,
    record.audit[record.audit.length - 1].auditId,
  );
  const records = sortedRecord([
    ...Object.entries(state.records).filter(([canonicalId]) => canonicalId !== record.canonicalId),
    [record.canonicalId, record] as const,
  ]);
  const decisions = sortedRecord([
    ...Object.entries(state.decisions),
    [observation.observationId, decision] as const,
  ]);
  const observations = sortedRecord([
    ...Object.entries(state.observations),
    [observation.observationId, observation] as const,
  ]);
  return {
    state: deepFreeze({ ...state, records, observations, decisions }),
    decision,
    idempotent: false,
  };
}

export interface EntityBatchUpsertResult {
  readonly state: EntityResolutionState;
  /** One result per unique content-addressed observation, sorted by observation ID. */
  readonly results: readonly Omit<EntityUpsertResult, 'state'>[];
  readonly duplicateObservationIds: readonly string[];
  readonly batchId: string;
}

/** Validate the whole batch first, then resolve its semantic set in stable order. */
export function upsertEntityObservationBatch(
  initialState: EntityResolutionState,
  inputs: readonly EntityObservationInput[],
  policy: EntityResolutionPolicy,
): EntityBatchUpsertResult {
  const normalizedPolicy = normalizePolicy(policy);
  const observations = inputs.map((input) => ({ input, observation: createEntityObservation(input) }));
  const byId = new Map<string, { input: EntityObservationInput; observation: EntityObservation }>();
  const duplicates = new Set<string>();
  for (const entry of observations) {
    if (byId.has(entry.observation.observationId)) duplicates.add(entry.observation.observationId);
    else byId.set(entry.observation.observationId, entry);
  }
  const ordered = [...byId.values()].sort((left, right) => (
    compareCanonicalEntityText(left.observation.observationId, right.observation.observationId)
  ));
  let state = initialState;
  const results: Array<Omit<EntityUpsertResult, 'state'>> = [];
  for (const entry of ordered) {
    const result = upsertEntityObservation(state, entry.input, policy);
    state = result.state;
    results.push({ decision: result.decision, idempotent: result.idempotent });
  }
  const semanticBatch = {
    observationIds: ordered.map((entry) => entry.observation.observationId),
    policyDigest: normalizedPolicy.policyDigest,
  };
  return deepFreeze({
    state,
    results,
    duplicateObservationIds: [...duplicates].sort(compareCanonicalEntityText),
    batchId: digest('entity-resolution-batch:v1', semanticBatch),
  });
}

// ---------------------------------------------------------------------------
// Large-dataset coverage contracts
// ---------------------------------------------------------------------------

export type CoverageDenominator =
  | { readonly kind: 'exact'; readonly total: number }
  | { readonly kind: 'lower_bound'; readonly atLeast: number }
  | { readonly kind: 'unknown' };

export type CoverageExhaustion = 'more' | 'exhausted' | 'unknown';
export type CoverageStatus = 'complete' | 'partial' | 'unknown';

export type PartitionUniverse =
  | { readonly kind: 'closed'; readonly partitionIds: readonly string[] }
  | { readonly kind: 'open' }
  | { readonly kind: 'unknown' };

export interface CoveragePageInput {
  readonly partitionId: string;
  /** Null only at the start of a partition. Cursors are opaque and never ordered lexically. */
  readonly inputCursor: string | null;
  /** Required when more pages are known; null when exhausted. */
  readonly outputCursor: string | null;
  readonly exhaustion: CoverageExhaustion;
  readonly denominator: CoverageDenominator;
  readonly itemIds: readonly string[];
}

export interface CoveragePage extends CoveragePageInput {
  readonly pageId: string;
}

export interface PartitionCoverageState {
  readonly partitionId: string;
  readonly nextCursor: string | null;
  readonly exhaustion: CoverageExhaustion;
  readonly denominator: CoverageDenominator;
  readonly status: CoverageStatus;
  readonly itemIds: readonly string[];
  /** Full idempotency history; pages are never truncated. */
  readonly pages: readonly CoveragePage[];
}

export interface DatasetCoverageState {
  readonly version: 1;
  readonly datasetId: string;
  readonly universe: PartitionUniverse;
  /** Dataset-level declaration. `complete` requires this to be exact. */
  readonly denominator: CoverageDenominator;
  readonly partitions: Readonly<Record<string, PartitionCoverageState>>;
}

export interface DatasetCoverageSummary {
  readonly status: CoverageStatus;
  readonly observed: number;
  readonly denominator: CoverageDenominator;
  readonly exhaustion: 'exhausted' | 'not_exhausted' | 'unknown';
  readonly reasons: readonly string[];
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    contractError('invalid_coverage_denominator', `${label} must be a non-negative safe integer.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizeDenominator(input: CoverageDenominator): CoverageDenominator {
  if (input.kind === 'exact') return { kind: 'exact', total: nonNegativeInteger(input.total, 'exact total') };
  if (input.kind === 'lower_bound') {
    return { kind: 'lower_bound', atLeast: nonNegativeInteger(input.atLeast, 'lower bound') };
  }
  if (input.kind === 'unknown') return { kind: 'unknown' };
  return contractError('invalid_coverage_denominator', 'Coverage denominator kind is unsupported.');
}

function exactOpaque(value: string, label: string): string {
  return exactNonBlank(value, label);
}

function normalizeUniverse(universe: PartitionUniverse): PartitionUniverse {
  if (universe.kind === 'closed') {
    const ids = universe.partitionIds.map((id, index) => exactOpaque(id, `partitionIds[${index}]`));
    if (new Set(ids).size !== ids.length) {
      contractError('duplicate_partition', 'A closed partition universe must not contain duplicate IDs.');
    }
    return { kind: 'closed', partitionIds: [...ids].sort(compareCanonicalEntityText) };
  }
  if (universe.kind === 'open' || universe.kind === 'unknown') return { kind: universe.kind };
  return contractError('invalid_partition_universe', 'Partition universe kind is unsupported.');
}

export function createDatasetCoverageState(
  datasetId: string,
  universe: PartitionUniverse,
  denominator: CoverageDenominator,
): DatasetCoverageState {
  return deepFreeze({
    version: 1,
    datasetId: exactOpaque(datasetId, 'datasetId'),
    universe: normalizeUniverse(universe),
    denominator: normalizeDenominator(denominator),
    partitions: {},
  });
}

export function createCoveragePage(datasetId: string, input: CoveragePageInput): CoveragePage {
  const normalizedDatasetId = exactOpaque(datasetId, 'datasetId');
  const partitionId = exactOpaque(input.partitionId, 'partitionId');
  const inputCursor = input.inputCursor === null ? null : exactOpaque(input.inputCursor, 'inputCursor');
  const outputCursor = input.outputCursor === null ? null : exactOpaque(input.outputCursor, 'outputCursor');
  if (!['more', 'exhausted', 'unknown'].includes(input.exhaustion)) {
    contractError('invalid_coverage_exhaustion', 'Coverage exhaustion must be more, exhausted, or unknown.');
  }
  if (input.exhaustion === 'more' && outputCursor === null) {
    contractError('invalid_coverage_cursor', 'A page with known remaining work requires an output cursor.');
  }
  if (input.exhaustion === 'exhausted' && outputCursor !== null) {
    contractError('invalid_coverage_cursor', 'An exhausted page must not claim a continuation cursor.');
  }
  if (inputCursor !== null && outputCursor === inputCursor) {
    contractError('invalid_coverage_cursor', 'A page must advance its opaque cursor when it supplies one.');
  }
  const itemIds = input.itemIds.map((id, index) => exactOpaque(id, `itemIds[${index}]`));
  if (new Set(itemIds).size !== itemIds.length) {
    contractError('duplicate_coverage_item', 'One coverage page must not repeat an item identity.');
  }
  const pageWithoutId = {
    partitionId,
    inputCursor,
    outputCursor,
    exhaustion: input.exhaustion,
    denominator: normalizeDenominator(input.denominator),
    itemIds: [...itemIds].sort(compareCanonicalEntityText),
  };
  return deepFreeze({
    ...pageWithoutId,
    pageId: digest('coverage-page:v1', { datasetId: normalizedDatasetId, ...pageWithoutId }),
  });
}

function reconcileDenominator(
  current: CoverageDenominator | undefined,
  incoming: CoverageDenominator,
): CoverageDenominator | null {
  if (!current || current.kind === 'unknown') return incoming;
  if (incoming.kind === 'unknown') return current;
  if (current.kind === 'exact') {
    if (incoming.kind === 'exact') return current.total === incoming.total ? current : null;
    return incoming.atLeast <= current.total ? current : null;
  }
  if (incoming.kind === 'exact') return incoming.total >= current.atLeast ? incoming : null;
  return { kind: 'lower_bound', atLeast: Math.max(current.atLeast, incoming.atLeast) };
}

function partitionStatus(
  observed: number,
  denominator: CoverageDenominator,
  exhaustion: CoverageExhaustion,
): CoverageStatus | null {
  if (denominator.kind === 'exact' && observed > denominator.total) return null;
  if (exhaustion === 'exhausted') {
    if (denominator.kind !== 'exact') return 'unknown';
    return observed === denominator.total ? 'complete' : null;
  }
  if (exhaustion === 'more') return 'partial';
  if (denominator.kind === 'exact' && observed < denominator.total) return 'partial';
  if (denominator.kind === 'lower_bound' && observed < denominator.atLeast) return 'partial';
  return 'unknown';
}

export type CoverageAdvanceResult =
  | {
    readonly ok: true;
    readonly state: DatasetCoverageState;
    readonly page: CoveragePage;
    readonly idempotent: boolean;
  }
  | {
    readonly ok: false;
    readonly state: DatasetCoverageState;
    readonly page: CoveragePage;
    readonly reason:
      | 'partition_outside_closed_universe'
      | 'cursor_discontinuity'
      | 'partition_already_exhausted'
      | 'denominator_contradiction'
      | 'coverage_count_contradiction'
      | 'item_partition_collision';
  };

/**
 * Advance one partition without guessing cursor order or silently repairing
 * contradictory totals. Exact replays are idempotent; discontinuities fail closed.
 */
export function applyCoveragePage(
  state: DatasetCoverageState,
  input: CoveragePageInput,
): CoverageAdvanceResult {
  const page = createCoveragePage(state.datasetId, input);
  if (state.universe.kind === 'closed' && !state.universe.partitionIds.includes(page.partitionId)) {
    return { ok: false, state, page, reason: 'partition_outside_closed_universe' };
  }
  const current = ownValue(state.partitions, page.partitionId);
  if (current?.pages.some((retained) => retained.pageId === page.pageId)) {
    return { ok: true, state, page, idempotent: true };
  }
  if (current?.exhaustion === 'exhausted') {
    return { ok: false, state, page, reason: 'partition_already_exhausted' };
  }
  if (current?.exhaustion === 'unknown' && current.nextCursor === null) {
    return { ok: false, state, page, reason: 'cursor_discontinuity' };
  }
  const expectedCursor = current?.nextCursor ?? null;
  if (page.inputCursor !== expectedCursor) {
    return { ok: false, state, page, reason: 'cursor_discontinuity' };
  }
  const denominator = reconcileDenominator(current?.denominator, page.denominator);
  if (!denominator) return { ok: false, state, page, reason: 'denominator_contradiction' };
  for (const [partitionId, partition] of Object.entries(state.partitions)) {
    if (partitionId === page.partitionId) continue;
    if (page.itemIds.some((itemId) => partition.itemIds.includes(itemId))) {
      return { ok: false, state, page, reason: 'item_partition_collision' };
    }
  }
  const itemIds = [...new Set([...(current?.itemIds ?? []), ...page.itemIds])]
    .sort(compareCanonicalEntityText);
  const status = partitionStatus(itemIds.length, denominator, page.exhaustion);
  if (!status) return { ok: false, state, page, reason: 'coverage_count_contradiction' };
  const partition: PartitionCoverageState = deepFreeze({
    partitionId: page.partitionId,
    nextCursor: page.outputCursor,
    exhaustion: page.exhaustion,
    denominator,
    status,
    itemIds,
    pages: [...(current?.pages ?? []), page],
  });
  const partitions = sortedRecord([
    ...Object.entries(state.partitions).filter(([partitionId]) => partitionId !== partition.partitionId),
    [partition.partitionId, partition] as const,
  ]);
  return {
    ok: true,
    state: deepFreeze({ ...state, partitions }),
    page,
    idempotent: false,
  };
}

/**
 * A universal complete result requires a closed partition universe, an exact
 * denominator in every partition, and explicit exhaustion of every partition.
 */
export function summarizeDatasetCoverage(state: DatasetCoverageState): DatasetCoverageSummary {
  const partitions = Object.values(state.partitions);
  const observed = partitions.reduce((sum, partition) => sum + partition.itemIds.length, 0);
  const reasons: string[] = [];
  if (state.universe.kind !== 'closed') reasons.push('partition_universe_not_closed');
  if (state.denominator.kind !== 'exact') reasons.push('dataset_denominator_not_exact');
  const requiredIds = state.universe.kind === 'closed' ? state.universe.partitionIds : [];
  const missing = requiredIds.filter((partitionId) => !ownValue(state.partitions, partitionId));
  if (missing.length > 0) reasons.push('required_partitions_unseen');
  if (partitions.some((partition) => partition.denominator.kind !== 'exact')) {
    reasons.push('denominator_not_exact');
  }
  if (partitions.some((partition) => partition.exhaustion === 'unknown')) {
    reasons.push('exhaustion_unknown');
  }
  if (partitions.some((partition) => partition.exhaustion === 'more')) {
    reasons.push('partitions_not_exhausted');
  }

  const allExact = partitions.every((partition) => partition.denominator.kind === 'exact');
  const exactTotal = allExact
    ? partitions.reduce((sum, partition) => sum + (partition.denominator as { kind: 'exact'; total: number }).total, 0)
    : undefined;
  const lowerBound = partitions.reduce((sum, partition) => {
    if (partition.denominator.kind === 'exact') return sum + partition.denominator.total;
    if (partition.denominator.kind === 'lower_bound') return sum + partition.denominator.atLeast;
    return sum + partition.itemIds.length;
  }, 0);
  const derivedDenominator: CoverageDenominator = allExact
    ? { kind: 'exact', total: exactTotal ?? 0 }
    : partitions.some((partition) => partition.denominator.kind !== 'unknown')
      ? { kind: 'lower_bound', atLeast: lowerBound }
      : { kind: 'unknown' };
  const denominator = state.denominator;
  const denominatorAgrees = state.denominator.kind === 'exact'
    && derivedDenominator.kind === 'exact'
    && state.denominator.total === derivedDenominator.total;
  if (missing.length === 0
    && state.denominator.kind === 'exact'
    && derivedDenominator.kind === 'exact'
    && !denominatorAgrees) {
    reasons.push('dataset_partition_denominator_mismatch');
  }

  const complete = state.universe.kind === 'closed'
    && denominatorAgrees
    && missing.length === 0
    && requiredIds.every((partitionId) => ownValue(state.partitions, partitionId)?.status === 'complete');
  const knownIncomplete = missing.length > 0
    || partitions.some((partition) => partition.status === 'partial');
  const status: CoverageStatus = complete ? 'complete' : knownIncomplete ? 'partial' : 'unknown';
  const exhaustion: DatasetCoverageSummary['exhaustion'] = complete
    ? 'exhausted'
    : partitions.some((partition) => partition.exhaustion === 'more') || missing.length > 0
      ? 'not_exhausted'
      : 'unknown';
  return deepFreeze({
    status,
    observed,
    denominator,
    exhaustion,
    reasons: [...new Set(reasons)].sort(compareCanonicalEntityText),
  });
}
