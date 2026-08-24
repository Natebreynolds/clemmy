import { createHash } from 'node:crypto';

import { closedCanonicalJson } from '../shared/closed-canonical-json.js';

/**
 * Human-reviewed interpretation of one retained read result as canonical
 * entity observations. This is data authority, not execution authority: it
 * names no provider, tool, catalog row, schedule, or recurrence.
 */
export const WORKFLOW_CANONICAL_ENTITY_RESULT_PROJECTION_VERSION = 1 as const;

export type WorkflowCanonicalEntityFieldTypeV1 =
  | 'string'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'object'
  | 'array';

export type WorkflowCanonicalEntityNormalizerV1 =
  | 'trim'
  | 'case_fold'
  | 'unicode_nfkc'
  | 'numeric';

export interface WorkflowCanonicalEntityFieldProjectionV1 {
  field: string;
  recordPath: string;
  type: WorkflowCanonicalEntityFieldTypeV1;
  required: boolean;
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
  confidence: number;
}

export interface WorkflowCanonicalEntityIdentityRuleProjectionV1 {
  ruleId: string;
  fields: string[];
  normalizers: WorkflowCanonicalEntityNormalizerV1[];
  exactIdentifierNamespace: string;
}

export interface WorkflowCanonicalEntityResolutionPolicyV1 {
  policyId: string;
  mergeThreshold: number;
  distinctThreshold: number;
  ambiguityMargin: number;
  weights: {
    defaultExactIdentifierMatch: number;
    exactIdentifierMatches?: Record<string, number>;
    defaultCompoundSignalMatch: number;
    compoundSignalMatches?: Record<string, number>;
  };
  exclusiveIdentifierNamespaces?: string[];
}

export interface WorkflowCanonicalEntityResultProjectionV1 {
  version: typeof WORKFLOW_CANONICAL_ENTITY_RESULT_PROJECTION_VERSION;
  recordsPath: string;
  fields: WorkflowCanonicalEntityFieldProjectionV1[];
  sourceRecord: {
    idPath: string;
    revisionPath?: string;
    observedAt:
      | { kind: 'record_path'; path: string }
      | { kind: 'page_settled_at' };
  };
  entityKind: string;
  identityRules: WorkflowCanonicalEntityIdentityRuleProjectionV1[];
  /** Exact policy consumed by the canonical resolution engine. */
  resolutionPolicy: WorkflowCanonicalEntityResolutionPolicyV1;
  /** The current engine retains every evidence assertion and marks conflicting
   * values. Other proposal merge modes remain unrepresented and fail closed. */
  fieldResolution: {
    kind: 'retain_all_evidence';
    selection: 'highest_confidence_then_newest';
    conflict: 'mark_conflicting_for_review';
  };
  provenance: {
    kind: 'workflow_page_record';
    retainSourceSnapshots: true;
  };
  partition: {
    kind: 'workflow_run';
    coverageItems: 'source_record_occurrences';
    denominator: 'settled_record_count';
    completion: 'closed_authority_exhaustion';
  };
  bounds: {
    maxPages: number;
    maxRecordsPerPage: number;
    maxRecords: number;
    maxPageBytes: number;
    maxRecordBytes: number;
    maxTotalBytes: number;
  };
  projectionDigest: string;
}

export type WorkflowCanonicalEntityResultProjectionParseResult =
  | { ok: true; contract: WorkflowCanonicalEntityResultProjectionV1 }
  | { ok: false; errors: string[] };

const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PATH_RE = /^(?:[A-Za-z_][A-Za-z0-9_-]*)(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const FIELD_TYPES = new Set<WorkflowCanonicalEntityFieldTypeV1>([
  'string', 'number', 'boolean', 'timestamp', 'object', 'array',
]);
const SENSITIVITIES = new Set(['public', 'internal', 'confidential', 'restricted']);
const NORMALIZERS = new Set<WorkflowCanonicalEntityNormalizerV1>([
  'trim', 'case_fold', 'unicode_nfkc', 'numeric',
]);
const MAX_FIELDS = 512;
const MAX_RULES = 64;
const MAX_PAGE_BYTES = 8_000_000;
const MAX_TOTAL_BYTES = 64_000_000;

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 32,
    maxNodes: 24_000,
    maxStringBytes: 65_536,
    maxTotalBytes: 512_000,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && ID_RE.test(value);
}

function field(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && FIELD_RE.test(value)
    && !FORBIDDEN.has(value);
}

function path(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim() || !PATH_RE.test(value)) return false;
  return (value.match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? [])
    .every((segment) => !FORBIDDEN.has(segment));
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positiveBound(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum;
}

function withoutDigest(
  contract: WorkflowCanonicalEntityResultProjectionV1,
): Omit<WorkflowCanonicalEntityResultProjectionV1, 'projectionDigest'> {
  const { projectionDigest: _ignored, ...rest } = contract;
  return rest;
}

export function workflowCanonicalEntityResultProjectionDigest(
  contract: Omit<WorkflowCanonicalEntityResultProjectionV1, 'projectionDigest'>
    | WorkflowCanonicalEntityResultProjectionV1,
): string {
  const value = 'projectionDigest' in contract
    ? withoutDigest(contract as WorkflowCanonicalEntityResultProjectionV1)
    : contract;
  return sha256(canonicalJson({
    domain: 'workflow-canonical-entity-result-projection',
    version: WORKFLOW_CANONICAL_ENTITY_RESULT_PROJECTION_VERSION,
    contract: value,
  }));
}

export function parseWorkflowCanonicalEntityResultProjection(
  value: unknown,
): WorkflowCanonicalEntityResultProjectionParseResult {
  let canonical: WorkflowCanonicalEntityResultProjectionV1;
  try {
    canonical = JSON.parse(canonicalJson(value)) as WorkflowCanonicalEntityResultProjectionV1;
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : 'Result projection is not bounded plain JSON.'] };
  }
  const errors: string[] = [];
  const top = record(canonical);
  if (!top || !exactKeys(top, [
    'version', 'recordsPath', 'fields', 'sourceRecord', 'entityKind',
    'identityRules', 'resolutionPolicy', 'fieldResolution', 'provenance',
    'partition', 'bounds', 'projectionDigest',
  ])) return { ok: false, errors: ['Result projection must be a closed versioned object.'] };
  if (canonical.version !== WORKFLOW_CANONICAL_ENTITY_RESULT_PROJECTION_VERSION) {
    errors.push(`Result projection version must be ${WORKFLOW_CANONICAL_ENTITY_RESULT_PROJECTION_VERSION}.`);
  }
  if (!path(canonical.recordsPath)) errors.push('recordsPath must be an exact bounded record path.');
  if (!id(canonical.entityKind)) errors.push('entityKind must be an exact bounded identity.');

  const names = new Set<string>();
  if (!Array.isArray(canonical.fields) || canonical.fields.length < 1 || canonical.fields.length > MAX_FIELDS) {
    errors.push('fields must be a bounded non-empty array.');
  } else {
    for (const [index, mapping] of canonical.fields.entries()) {
      const item = record(mapping);
      if (!item || !exactKeys(item, [
        'field', 'recordPath', 'type', 'required', 'sensitivity', 'confidence',
      ])) {
        errors.push(`fields[${index}] must be closed.`);
        continue;
      }
      if (!field(mapping.field) || names.has(mapping.field)) errors.push(`fields[${index}].field is invalid or duplicated.`);
      else names.add(mapping.field);
      if (!path(mapping.recordPath)) errors.push(`fields[${index}].recordPath is invalid.`);
      if (!FIELD_TYPES.has(mapping.type)) errors.push(`fields[${index}].type is invalid.`);
      if (typeof mapping.required !== 'boolean') errors.push(`fields[${index}].required must be boolean.`);
      if (!SENSITIVITIES.has(mapping.sensitivity)) errors.push(`fields[${index}].sensitivity is invalid.`);
      if (!finiteNonNegative(mapping.confidence) || mapping.confidence > 1) errors.push(`fields[${index}].confidence must be within 0..1.`);
    }
  }

  const source = record(canonical.sourceRecord);
  if (!source || !exactKeys(source, ['idPath', 'observedAt'], ['revisionPath'])
    || !path(canonical.sourceRecord?.idPath)
    || (canonical.sourceRecord?.revisionPath !== undefined && !path(canonical.sourceRecord.revisionPath))) {
    errors.push('sourceRecord identity/revision mapping is malformed.');
  }
  const observedAt = record(canonical.sourceRecord?.observedAt);
  if (!observedAt || (
    observedAt.kind === 'record_path'
      ? !exactKeys(observedAt, ['kind', 'path']) || !path(observedAt.path)
      : observedAt.kind === 'page_settled_at'
        ? !exactKeys(observedAt, ['kind'])
        : true
  )) errors.push('sourceRecord.observedAt must be an exact record path or page settlement source.');

  const ruleIds = new Set<string>();
  const namespaces = new Set<string>();
  if (!Array.isArray(canonical.identityRules)
    || canonical.identityRules.length < 1
    || canonical.identityRules.length > MAX_RULES) {
    errors.push('identityRules must be a bounded non-empty array.');
  } else {
    for (const [index, rule] of canonical.identityRules.entries()) {
      const item = record(rule);
      if (!item || !exactKeys(item, ['ruleId', 'fields', 'normalizers', 'exactIdentifierNamespace'])) {
        errors.push(`identityRules[${index}] must be closed.`);
        continue;
      }
      if (!id(rule.ruleId) || ruleIds.has(rule.ruleId)) errors.push(`identityRules[${index}].ruleId is invalid or duplicated.`);
      else ruleIds.add(rule.ruleId);
      if (!id(rule.exactIdentifierNamespace) || namespaces.has(rule.exactIdentifierNamespace)) {
        errors.push(`identityRules[${index}].exactIdentifierNamespace is invalid or duplicated.`);
      } else namespaces.add(rule.exactIdentifierNamespace);
      if (!Array.isArray(rule.fields) || rule.fields.length < 1 || rule.fields.length > 32
        || new Set(rule.fields).size !== rule.fields.length
        || rule.fields.some((name) => !field(name) || !names.has(name))) {
        errors.push(`identityRules[${index}].fields do not exactly reference projected fields.`);
      }
      if (!Array.isArray(rule.normalizers) || rule.normalizers.length < 1 || rule.normalizers.length > 8
        || new Set(rule.normalizers).size !== rule.normalizers.length
        || rule.normalizers.some((normalizer) => !NORMALIZERS.has(normalizer))) {
        errors.push(`identityRules[${index}].normalizers are invalid or duplicated.`);
      }
    }
  }

  const policy = record(canonical.resolutionPolicy);
  if (!policy || !exactKeys(policy, [
    'policyId', 'mergeThreshold', 'distinctThreshold', 'ambiguityMargin', 'weights',
  ], ['exclusiveIdentifierNamespaces']) || !id(canonical.resolutionPolicy?.policyId)) {
    errors.push('resolutionPolicy must be a closed exact policy.');
  } else {
    for (const key of ['mergeThreshold', 'distinctThreshold', 'ambiguityMargin'] as const) {
      if (!finiteNonNegative(canonical.resolutionPolicy[key])) errors.push(`resolutionPolicy.${key} is invalid.`);
    }
    if (finiteNonNegative(canonical.resolutionPolicy.mergeThreshold)
      && finiteNonNegative(canonical.resolutionPolicy.distinctThreshold)
      && canonical.resolutionPolicy.distinctThreshold >= canonical.resolutionPolicy.mergeThreshold) {
      errors.push('resolutionPolicy.distinctThreshold must be below mergeThreshold.');
    }
    const weights = record(canonical.resolutionPolicy.weights);
    if (!weights || !exactKeys(weights, [
      'defaultExactIdentifierMatch', 'defaultCompoundSignalMatch',
    ], ['exactIdentifierMatches', 'compoundSignalMatches'])) {
      errors.push('resolutionPolicy.weights must be closed.');
    } else {
      if (!finiteNonNegative(weights.defaultExactIdentifierMatch)
        || !finiteNonNegative(weights.defaultCompoundSignalMatch)) errors.push('resolutionPolicy default weights are invalid.');
      for (const [label, weightMap] of [
        ['exactIdentifierMatches', weights.exactIdentifierMatches],
        ['compoundSignalMatches', weights.compoundSignalMatches],
      ] as const) {
        if (weightMap === undefined) continue;
        const map = record(weightMap);
        if (!map || Object.entries(map).some(([key, weight]) => !id(key) || !finiteNonNegative(weight))) {
          errors.push(`resolutionPolicy.weights.${label} is invalid.`);
        }
      }
    }
    const exclusive = canonical.resolutionPolicy.exclusiveIdentifierNamespaces;
    if (exclusive !== undefined && (!Array.isArray(exclusive)
      || new Set(exclusive).size !== exclusive.length
      || exclusive.some((namespace) => !namespaces.has(namespace)))) {
      errors.push('resolutionPolicy.exclusiveIdentifierNamespaces must reference projected namespaces exactly.');
    }
  }

  if (canonical.fieldResolution?.kind !== 'retain_all_evidence'
    || canonical.fieldResolution?.selection !== 'highest_confidence_then_newest'
    || canonical.fieldResolution?.conflict !== 'mark_conflicting_for_review'
    || !exactKeys(record(canonical.fieldResolution) ?? {}, ['kind', 'selection', 'conflict'])) {
    errors.push('fieldResolution does not name the canonical engine field policy.');
  }
  if (canonical.provenance?.kind !== 'workflow_page_record'
    || canonical.provenance?.retainSourceSnapshots !== true
    || !exactKeys(record(canonical.provenance) ?? {}, ['kind', 'retainSourceSnapshots'])) {
    errors.push('provenance does not name exact workflow/page/record lineage.');
  }
  if (canonical.partition?.kind !== 'workflow_run'
    || canonical.partition?.coverageItems !== 'source_record_occurrences'
    || canonical.partition?.denominator !== 'settled_record_count'
    || canonical.partition?.completion !== 'closed_authority_exhaustion'
    || !exactKeys(record(canonical.partition) ?? {}, [
      'kind', 'coverageItems', 'denominator', 'completion',
    ])) errors.push('partition/coverage mapping is unsupported or incomplete.');

  const bounds = record(canonical.bounds);
  if (!bounds || !exactKeys(bounds, [
    'maxPages', 'maxRecordsPerPage', 'maxRecords', 'maxPageBytes',
    'maxRecordBytes', 'maxTotalBytes',
  ])) errors.push('bounds must be a closed object.');
  else {
    if (!positiveBound(bounds.maxPages, 10_000)) errors.push('bounds.maxPages is invalid.');
    if (!positiveBound(bounds.maxRecordsPerPage, 1_000_000)) errors.push('bounds.maxRecordsPerPage is invalid.');
    if (!positiveBound(bounds.maxRecords, 10_000_000)) errors.push('bounds.maxRecords is invalid.');
    if (!positiveBound(bounds.maxPageBytes, MAX_PAGE_BYTES)) errors.push('bounds.maxPageBytes is invalid.');
    if (!positiveBound(bounds.maxRecordBytes, MAX_PAGE_BYTES)) errors.push('bounds.maxRecordBytes is invalid.');
    if (!positiveBound(bounds.maxTotalBytes, MAX_TOTAL_BYTES)) errors.push('bounds.maxTotalBytes is invalid.');
    if (positiveBound(bounds.maxRecordsPerPage, 1_000_000)
      && positiveBound(bounds.maxRecords, 10_000_000)
      && bounds.maxRecordsPerPage > bounds.maxRecords) errors.push('maxRecordsPerPage exceeds maxRecords.');
    if (positiveBound(bounds.maxRecordBytes, MAX_PAGE_BYTES)
      && positiveBound(bounds.maxPageBytes, MAX_PAGE_BYTES)
      && bounds.maxRecordBytes > bounds.maxPageBytes) errors.push('maxRecordBytes exceeds maxPageBytes.');
    if (positiveBound(bounds.maxPageBytes, MAX_PAGE_BYTES)
      && positiveBound(bounds.maxTotalBytes, MAX_TOTAL_BYTES)
      && bounds.maxPageBytes > bounds.maxTotalBytes) errors.push('maxPageBytes exceeds maxTotalBytes.');
  }

  if (!DIGEST_RE.test(canonical.projectionDigest)) errors.push('projectionDigest must be sha256 hex.');
  else {
    try {
      if (workflowCanonicalEntityResultProjectionDigest(canonical) !== canonical.projectionDigest) {
        errors.push('projectionDigest does not bind the exact result projection bytes.');
      }
    } catch {
      errors.push('Result projection contains non-canonical bytes.');
    }
  }
  return errors.length > 0
    ? { ok: false, errors: [...new Set(errors)] }
    : { ok: true, contract: canonical };
}

export function createWorkflowCanonicalEntityResultProjection(
  input: Omit<WorkflowCanonicalEntityResultProjectionV1, 'version' | 'projectionDigest'>,
): WorkflowCanonicalEntityResultProjectionV1 {
  const withoutDigest = JSON.parse(canonicalJson({
    version: WORKFLOW_CANONICAL_ENTITY_RESULT_PROJECTION_VERSION,
    ...input,
  })) as Omit<WorkflowCanonicalEntityResultProjectionV1, 'projectionDigest'>;
  const candidate: WorkflowCanonicalEntityResultProjectionV1 = {
    ...withoutDigest,
    projectionDigest: workflowCanonicalEntityResultProjectionDigest(withoutDigest),
  };
  const parsed = parseWorkflowCanonicalEntityResultProjection(candidate);
  if (!parsed.ok) throw new Error(parsed.errors.join(' '));
  return parsed.contract;
}
