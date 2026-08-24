import { createHash } from 'node:crypto';

import {
  parseWorkflowCanonicalEntityResultProjection,
  type WorkflowCanonicalEntityResultProjectionV1,
} from './workflow-result-projection-contract.js';

/**
 * Durable, provider-neutral authority requested by one workflow node.
 *
 * This is a binding artifact, not an invocation. It deliberately contains no
 * tool display name and no rendered/user-supplied argument bytes. Arguments
 * are compiled at node admission from typed sources. A deterministic literal
 * is the one exception: its exact bytes and a separate review digest are both
 * content-addressed by the plan.
 */
export const WORKFLOW_NODE_INVOCATION_PLAN_VERSION = 1 as const;

/**
 * Provider-neutral effect bound into the exact capability fingerprint.
 *
 * Version 1 originally admitted only read/compute plans. Extending the closed
 * value domain does not change any existing read-plan bytes or digests; it
 * merely lets the activation compiler describe the same catalog effects the
 * shared host kernel already understands. Execution authority remains a
 * separate concern (non-read workflow calls are preparation-only until the
 * workflow_v3_call authority root exists).
 */
export type WorkflowNodeInvocationEffectV1 =
  | 'read'
  | 'compute'
  | 'host_only'
  | 'local_write'
  | 'external_write'
  | 'admin';

export type WorkflowNodeInvocationMutationEffectV1 = Extract<
  WorkflowNodeInvocationEffectV1,
  'local_write' | 'external_write' | 'admin'
>;

const WORKFLOW_NODE_INVOCATION_EFFECTS = new Set<WorkflowNodeInvocationEffectV1>([
  'read',
  'compute',
  'host_only',
  'local_write',
  'external_write',
  'admin',
]);

export function workflowNodeInvocationEffectIsMutation(
  effect: WorkflowNodeInvocationEffectV1,
): effect is WorkflowNodeInvocationMutationEffectV1 {
  return effect === 'local_write' || effect === 'external_write' || effect === 'admin';
}
export type WorkflowNodeInvocationValueTypeV1 =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array';

export type WorkflowNodeArgumentSourceV1 =
  | {
    kind: 'workflow_input';
    key: string;
  }
  | {
    kind: 'upstream_output';
    stepId: string;
    path?: string;
  }
  | {
    kind: 'partition_item';
    path?: string;
  }
  | {
    /** Host-owned runtime overlay from the preceding settled page. It is never
     * read from workflow/user input and is never persisted back into the plan. */
    kind: 'continuation_cursor';
  }
  | {
    kind: 'reviewed_literal';
    value: unknown;
    valueDigest: string;
    reviewRef: string;
    reviewDigest: string;
  };

export interface WorkflowNodeArgumentBindingV1 {
  source: WorkflowNodeArgumentSourceV1;
  required: boolean;
  type: WorkflowNodeInvocationValueTypeV1;
}

export interface WorkflowNodeCapabilityFingerprintV1 {
  capabilityId: string;
  manifestId: string;
  manifestDigest: string;
  operationId: string;
  operationVersion: string;
  schemaDigest: string;
  providerVersion: string;
  liveFingerprint: string;
  accountId: string;
  effect: WorkflowNodeInvocationEffectV1;
  invokePortId: string;
  argumentCompiler: {
    id: string;
    version: string;
  };
}

/** A rename is never inferred from a similar name. The successor's complete
 * identity and the exact predecessor it replaces must be part of a new plan
 * revision before admission may select it. */
export interface WorkflowNodeCapabilityPredecessorV1 {
  capabilityId: string;
  manifestId: string;
  manifestDigest: string;
}

export interface WorkflowNodeEvidenceContractV1 {
  requiredPaths: string[];
  nonEmptyPaths: string[];
  minItems: Record<string, number>;
}

export type WorkflowNodeCompletenessContractV1 =
  | {
    kind: 'terminal_result';
    evidencePaths: string[];
  }
  | {
    kind: 'finite_exhaustive';
    exhaustedPath: string;
    evidencePaths: string[];
    denominator?: WorkflowNodeArgumentSourceV1;
  }
  | {
    kind: 'per_run_boundary';
    boundaryPath: string;
    evidencePaths: string[];
  };

export type WorkflowNodeContinuationContractV1 =
  | { kind: 'none' }
  | {
    kind: 'cursor';
    cursorArgument: string;
    nextCursorPath: string;
    exhaustedPath: string;
    maxPages: number;
  };

export interface WorkflowNodeInvocationPlanV1 {
  version: typeof WORKFLOW_NODE_INVOCATION_PLAN_VERSION;
  requirementId: string;
  /** Stable semantic identity selected during approved compilation. It is not a
   * display/tool name and never dispatches by itself. */
  logicalCapabilityId: string;
  /** The one and only fingerprint authorized to dispatch by this revision. */
  binding: WorkflowNodeCapabilityFingerprintV1;
  /** Optional exact lineage proving that `binding` is a reviewed rename of a
   * prior binding. It is audit evidence, never a second dispatch candidate. */
  predecessor?: WorkflowNodeCapabilityPredecessorV1;
  arguments: Record<string, WorkflowNodeArgumentBindingV1>;
  evidence: WorkflowNodeEvidenceContractV1;
  completeness: WorkflowNodeCompletenessContractV1;
  continuation: WorkflowNodeContinuationContractV1;
  /** Optional, separately reviewed interpretation of retained read bytes as
   * canonical entity observations. Absence preserves ordinary read behavior. */
  resultProjection?: WorkflowCanonicalEntityResultProjectionV1;
  bindingDigest: string;
}

export type WorkflowNodeInvocationPlanParseResult =
  | { ok: true; plan: WorkflowNodeInvocationPlanV1 }
  | { ok: false; errors: string[] };

const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const ARGUMENT_RE = /^[A-Za-z_][A-Za-z0-9_.\-]{0,127}$/;
const PATH_RE = /^(?:[A-Za-z_][A-Za-z0-9_-]*)(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*$/;
const VALUE_TYPES = new Set<WorkflowNodeInvocationValueTypeV1>([
  'string',
  'number',
  'boolean',
  'object',
  'array',
]);
const MAX_REVIEWED_LITERAL_BYTES = 16_384;
const TEMPLATE_SYNTAX_RE = /\{\{|\}\}|\$\{|\{%|%\}|<%|%>/;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TOP_KEYS = new Set([
  'version',
  'requirementId',
  'logicalCapabilityId',
  'binding',
  'predecessor',
  'arguments',
  'evidence',
  'completeness',
  'continuation',
  'resultProjection',
  'bindingDigest',
]);
const FINGERPRINT_KEYS = new Set([
  'capabilityId',
  'manifestId',
  'manifestDigest',
  'operationId',
  'operationVersion',
  'schemaDigest',
  'providerVersion',
  'liveFingerprint',
  'accountId',
  'effect',
  'invokePortId',
  'argumentCompiler',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalize(
  value: unknown,
  input: { rejectTemplates: boolean; depth?: number; seen?: Set<object> },
): CanonicalJson {
  const depth = input.depth ?? 0;
  const seen = input.seen ?? new Set<object>();
  if (depth > 24) throw new Error('JSON value exceeds the depth limit.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_REVIEWED_LITERAL_BYTES) {
      throw new Error('JSON string exceeds the reviewed literal byte limit.');
    }
    if (input.rejectTemplates && TEMPLATE_SYNTAX_RE.test(value)) {
      throw new Error('JSON value contains template syntax.');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON value contains a non-finite number.');
    return value;
  }
  if (!value || typeof value !== 'object') throw new Error('Value is not JSON-serializable.');
  if (seen.has(value)) throw new Error('JSON value is cyclic or aliased.');
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error('JSON array must have the standard Array prototype.');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error('JSON array contains symbol keys.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor && 'value' in lengthDescriptor
      ? lengthDescriptor.value as unknown
      : undefined;
    if (!Number.isSafeInteger(length) || (length as number) < 0) {
      throw new Error('JSON array has a malformed length.');
    }
    if ((length as number) > 1_024) throw new Error('JSON array exceeds its item limit.');
    if (Object.getOwnPropertyNames(value).some((key) => (
      key !== 'length'
      && (!/^\d+$/.test(key) || Number(key) >= (length as number))
    ))) {
      throw new Error('JSON array contains non-index properties.');
    }
    seen.add(value);
    try {
      const output: CanonicalJson[] = [];
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('JSON array contains a sparse or undefined item.');
        }
        if (descriptor.value === undefined) {
          throw new Error('JSON array contains a sparse or undefined item.');
        }
        output.push(canonicalize(descriptor.value, {
          rejectTemplates: input.rejectTemplates,
          depth: depth + 1,
          seen,
        }));
      }
      return output;
    } finally {
      seen.delete(value);
    }
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('JSON object must have Object or null prototype.');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('JSON object contains symbol keys.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => (
    !descriptor.enumerable || !('value' in descriptor)
  ))) {
    throw new Error('JSON object contains hidden or accessor properties.');
  }
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > 1_024) throw new Error('JSON object exceeds its key limit.');
  seen.add(value);
  try {
    const output: Record<string, CanonicalJson> = Object.create(null) as Record<string, CanonicalJson>;
    for (const key of keys.sort()) {
      if (
        key.length === 0
        || key.length > 256
        || FORBIDDEN_OBJECT_KEYS.has(key)
        || (input.rejectTemplates && TEMPLATE_SYNTAX_RE.test(key))
      ) throw new Error('JSON object contains an unsafe key.');
      const item = (descriptors[key] as PropertyDescriptor & { value: unknown }).value;
      if (item === undefined) throw new Error('JSON object contains an undefined value.');
      output[key] = canonicalize(item, {
        rejectTemplates: input.rejectTemplates,
        depth: depth + 1,
        seen,
      });
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown, rejectTemplates = false): string {
  return JSON.stringify(canonicalize(value, { rejectTemplates }));
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => (
    !descriptor.enumerable || !('value' in descriptor)
  ))) return null;
  if (Object.getOwnPropertyNames(value).some((key) => FORBIDDEN_OBJECT_KEYS.has(key))) return null;
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function exactId(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && ID_RE.test(value);
}

function exactPath(value: unknown): value is string {
  if (typeof value !== 'string' || !PATH_RE.test(value)) return false;
  const segments = value.match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? [];
  return segments.length > 0 && segments.every((segment) => !FORBIDDEN_OBJECT_KEYS.has(segment));
}

function safeArgumentName(value: unknown): value is string {
  return typeof value === 'string'
    && ARGUMENT_RE.test(value)
    && !FORBIDDEN_OBJECT_KEYS.has(value);
}

function jsonValueIsSafe(value: unknown): boolean {
  try {
    canonicalJson(value, true);
    return true;
  } catch {
    return false;
  }
}

export function workflowNodeReviewedLiteralDigest(value: unknown): string {
  return sha256(canonicalJson({ domain: 'workflow-reviewed-literal', version: 1, value }));
}

function validateArgumentSource(
  value: unknown,
  where: string,
  errors: string[],
  literalBudget: { bytes: number },
): value is WorkflowNodeArgumentSourceV1 {
  const source = recordOf(value);
  if (!source || typeof source.kind !== 'string') {
    errors.push(`${where} must be a typed argument source.`);
    return false;
  }
  if (source.kind === 'workflow_input') {
    if (!exactKeys(source, new Set(['kind', 'key'])) || !safeArgumentName(source.key)) {
      errors.push(`${where} workflow_input source is malformed.`);
      return false;
    }
    return true;
  }
  if (source.kind === 'upstream_output') {
    if (
      !exactKeys(source, new Set(['kind', 'stepId', 'path']))
      || !exactId(source.stepId)
      || (source.path !== undefined && !exactPath(source.path))
    ) {
      errors.push(`${where} upstream_output source is malformed.`);
      return false;
    }
    return true;
  }
  if (source.kind === 'partition_item') {
    if (
      !exactKeys(source, new Set(['kind', 'path']))
      || (source.path !== undefined && !exactPath(source.path))
    ) {
      errors.push(`${where} partition_item source is malformed.`);
      return false;
    }
    return true;
  }
  if (source.kind === 'continuation_cursor') {
    if (!exactKeys(source, new Set(['kind']))) {
      errors.push(`${where} continuation_cursor source is malformed.`);
      return false;
    }
    return true;
  }
  if (source.kind === 'reviewed_literal') {
    let valid = exactKeys(source, new Set(['kind', 'value', 'valueDigest', 'reviewRef', 'reviewDigest']));
    const safeValue = jsonValueIsSafe(source.value);
    valid = valid && safeValue;
    if (safeValue) {
      literalBudget.bytes += Buffer.byteLength(canonicalJson(source.value, true), 'utf8');
      if (literalBudget.bytes > MAX_REVIEWED_LITERAL_BYTES) {
        errors.push(
          `Invocation plan reviewed literals exceed the ${MAX_REVIEWED_LITERAL_BYTES}-byte canonical budget.`,
        );
        valid = false;
      }
      valid = valid
        && SHA256_RE.test(String(source.valueDigest ?? ''))
        && source.valueDigest === workflowNodeReviewedLiteralDigest(source.value);
    } else {
      valid = false;
    }
    valid = valid
      && exactId(source.reviewRef)
      && SHA256_RE.test(String(source.reviewDigest ?? ''));
    if (!valid) {
      errors.push(`${where} reviewed_literal source lacks exact reviewed bytes.`);
      return false;
    }
    return true;
  }
  errors.push(`${where} has unsupported source kind "${source.kind}".`);
  return false;
}

function validateFingerprint(
  value: unknown,
  where: string,
  errors: string[],
): value is WorkflowNodeCapabilityFingerprintV1 {
  const fingerprint = recordOf(value);
  if (!fingerprint || !exactKeys(fingerprint, FINGERPRINT_KEYS)) {
    errors.push(`${where} must be a closed capability fingerprint.`);
    return false;
  }
  for (const key of [
    'capabilityId',
    'manifestId',
    'operationId',
    'operationVersion',
    'providerVersion',
    'accountId',
    'invokePortId',
  ]) {
    if (!exactId(fingerprint[key])) errors.push(`${where}.${key} is not an exact identity.`);
  }
  for (const key of ['manifestDigest', 'schemaDigest', 'liveFingerprint']) {
    if (!SHA256_RE.test(String(fingerprint[key] ?? ''))) {
      errors.push(`${where}.${key} is not a sha256 digest.`);
    }
  }
  if (!WORKFLOW_NODE_INVOCATION_EFFECTS.has(fingerprint.effect as WorkflowNodeInvocationEffectV1)) {
    errors.push(`${where}.effect is not a supported provider-neutral effect.`);
  }
  const compiler = recordOf(fingerprint.argumentCompiler);
  if (
    !compiler
    || !exactKeys(compiler, new Set(['id', 'version']))
    || !exactId(compiler.id)
    || !exactId(compiler.version)
  ) errors.push(`${where}.argumentCompiler is incomplete.`);
  return errors.length === 0;
}

function validateStringSet(value: unknown, where: string, errors: string[], paths = false): string[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length > 0
  ) {
    errors.push(`${where} must be an array.`);
    return [];
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor
    ? lengthDescriptor.value as unknown
    : undefined;
  if (
    !Number.isSafeInteger(length)
    || (length as number) < 0
    || (length as number) > 1_024
    || Object.getOwnPropertyNames(value).some((key) => (
      key !== 'length'
      && (!/^\d+$/.test(key) || Number(key) >= (length as number))
    ))
  ) {
    errors.push(`${where} must be a bounded plain array.`);
    return [];
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      errors.push(`${where} contains a sparse, hidden, or accessor value.`);
      continue;
    }
    const item = descriptor.value;
    const valid = paths ? exactPath(item) : exactId(item);
    if (!valid || seen.has(item)) {
      errors.push(`${where} contains a malformed or duplicated value.`);
      continue;
    }
    seen.add(item);
    output.push(item);
  }
  return output;
}

function withoutBindingDigest(
  plan: Omit<WorkflowNodeInvocationPlanV1, 'bindingDigest'> | WorkflowNodeInvocationPlanV1,
): Omit<WorkflowNodeInvocationPlanV1, 'bindingDigest'> {
  const canonical = canonicalize(plan, { rejectTemplates: false });
  if (!canonical || Array.isArray(canonical) || typeof canonical !== 'object') {
    throw new Error('Invocation plan is not a canonical object.');
  }
  const { bindingDigest: _ignored, ...rest } = canonical as unknown as WorkflowNodeInvocationPlanV1;
  return rest;
}

export function workflowNodeInvocationBindingDigest(
  plan: Omit<WorkflowNodeInvocationPlanV1, 'bindingDigest'> | WorkflowNodeInvocationPlanV1,
): string {
  return sha256(canonicalJson({
    domain: 'workflow-node-invocation-plan',
    version: WORKFLOW_NODE_INVOCATION_PLAN_VERSION,
    plan: withoutBindingDigest(plan),
  }));
}

export function parseWorkflowNodeInvocationPlan(
  value: unknown,
): WorkflowNodeInvocationPlanParseResult {
  const errors: string[] = [];
  const plan = recordOf(value);
  if (!plan || !exactKeys(plan, TOP_KEYS)) {
    return { ok: false, errors: ['Invocation plan must be a closed object.'] };
  }
  if (plan.version !== WORKFLOW_NODE_INVOCATION_PLAN_VERSION) {
    errors.push(`Invocation plan version must be ${WORKFLOW_NODE_INVOCATION_PLAN_VERSION}.`);
  }
  if (!exactId(plan.requirementId)) errors.push('Invocation plan requirementId is invalid.');
  if (!exactId(plan.logicalCapabilityId)) errors.push('Invocation plan logicalCapabilityId is invalid.');
  validateFingerprint(plan.binding, 'Invocation plan binding', errors);
  const literalBudget = { bytes: 0 };

  if (plan.predecessor !== undefined) {
    const predecessor = recordOf(plan.predecessor);
    if (
      !predecessor
      || !exactKeys(predecessor, new Set(['capabilityId', 'manifestId', 'manifestDigest']))
      || !exactId(predecessor.capabilityId)
      || !exactId(predecessor.manifestId)
      || !SHA256_RE.test(String(predecessor.manifestDigest ?? ''))
    ) {
      errors.push('Invocation plan predecessor lineage is malformed.');
    } else {
      const binding = plan.binding as Partial<WorkflowNodeCapabilityFingerprintV1>;
      if (
        predecessor.capabilityId === binding.capabilityId
        || predecessor.manifestId === binding.manifestId
        || predecessor.manifestDigest === binding.manifestDigest
      ) errors.push('Invocation plan predecessor must differ from the effective binding.');
    }
  }

  const argumentsRecord = recordOf(plan.arguments);
  const continuationCursorArgumentNames: string[] = [];
  if (!argumentsRecord || Object.keys(argumentsRecord).length > 256) {
    errors.push('Invocation plan arguments must be a bounded object.');
  } else {
    for (const [argumentName, rawBinding] of Object.entries(argumentsRecord)) {
      const binding = recordOf(rawBinding);
      if (
        !safeArgumentName(argumentName)
        || !binding
        || !exactKeys(binding, new Set(['source', 'required', 'type']))
        || typeof binding.required !== 'boolean'
        || !VALUE_TYPES.has(binding.type as WorkflowNodeInvocationValueTypeV1)
      ) {
        errors.push(`Invocation plan argument "${argumentName}" is malformed.`);
        continue;
      }
      validateArgumentSource(
        binding.source,
        `Invocation plan argument "${argumentName}"`,
        errors,
        literalBudget,
      );
      const source = recordOf(binding.source);
      if (source?.kind === 'continuation_cursor') {
        continuationCursorArgumentNames.push(argumentName);
      }
    }
  }

  const evidence = recordOf(plan.evidence);
  if (!evidence || !exactKeys(evidence, new Set(['requiredPaths', 'nonEmptyPaths', 'minItems']))) {
    errors.push('Invocation plan evidence contract is malformed.');
  } else {
    validateStringSet(evidence.requiredPaths, 'Invocation plan evidence.requiredPaths', errors, true);
    validateStringSet(evidence.nonEmptyPaths, 'Invocation plan evidence.nonEmptyPaths', errors, true);
    const minItems = recordOf(evidence.minItems);
    if (!minItems) {
      errors.push('Invocation plan evidence.minItems must be an object.');
    } else {
      for (const [path, minimum] of Object.entries(minItems)) {
        if (!exactPath(path) || !Number.isSafeInteger(minimum) || (minimum as number) <= 0) {
          errors.push(`Invocation plan evidence.minItems["${path}"] is invalid.`);
        }
      }
    }
  }

  const completeness = recordOf(plan.completeness);
  if (!completeness || typeof completeness.kind !== 'string') {
    errors.push('Invocation plan completeness contract is malformed.');
  } else if (completeness.kind === 'terminal_result') {
    if (!exactKeys(completeness, new Set(['kind', 'evidencePaths']))) {
      errors.push('Invocation plan terminal completeness contract is open or malformed.');
    }
    const paths = validateStringSet(completeness.evidencePaths, 'Invocation plan completeness.evidencePaths', errors, true);
    if (paths.length === 0) errors.push('Invocation plan terminal completeness requires evidence paths.');
  } else if (completeness.kind === 'finite_exhaustive') {
    if (
      !exactKeys(completeness, new Set(['kind', 'exhaustedPath', 'evidencePaths', 'denominator']))
      || !exactPath(completeness.exhaustedPath)
    ) errors.push('Invocation plan finite completeness contract is malformed.');
    const paths = validateStringSet(completeness.evidencePaths, 'Invocation plan completeness.evidencePaths', errors, true);
    if (paths.length === 0) errors.push('Invocation plan finite completeness requires evidence paths.');
    if (completeness.denominator !== undefined) {
      validateArgumentSource(
        completeness.denominator,
        'Invocation plan completeness.denominator',
        errors,
        literalBudget,
      );
    }
  } else if (completeness.kind === 'per_run_boundary') {
    if (
      !exactKeys(completeness, new Set(['kind', 'boundaryPath', 'evidencePaths']))
      || !exactPath(completeness.boundaryPath)
    ) errors.push('Invocation plan boundary completeness contract is malformed.');
    const paths = validateStringSet(completeness.evidencePaths, 'Invocation plan completeness.evidencePaths', errors, true);
    if (paths.length === 0) errors.push('Invocation plan boundary completeness requires evidence paths.');
  } else {
    errors.push(`Invocation plan completeness kind "${completeness.kind}" is unsupported.`);
  }

  const continuation = recordOf(plan.continuation);
  if (!continuation || typeof continuation.kind !== 'string') {
    errors.push('Invocation plan continuation contract is malformed.');
  } else if (continuation.kind === 'none') {
    if (!exactKeys(continuation, new Set(['kind']))) {
      errors.push('Invocation plan none continuation contract is open or malformed.');
    }
    if (completeness?.kind === 'finite_exhaustive') {
      errors.push('Finite exhaustive completeness requires an explicit cursor continuation contract.');
    }
    if (continuationCursorArgumentNames.length > 0) {
      errors.push('A continuation_cursor argument requires an explicit cursor continuation contract.');
    }
  } else if (continuation.kind === 'cursor') {
    if (
      !exactKeys(continuation, new Set([
        'kind',
        'cursorArgument',
        'nextCursorPath',
        'exhaustedPath',
        'maxPages',
      ]))
      || !safeArgumentName(continuation.cursorArgument)
      || !exactPath(continuation.nextCursorPath)
      || !exactPath(continuation.exhaustedPath)
      || !Number.isSafeInteger(continuation.maxPages)
      || (continuation.maxPages as number) <= 0
      || (continuation.maxPages as number) > 10_000
      || (completeness?.kind === 'finite_exhaustive'
        && continuation.exhaustedPath !== completeness.exhaustedPath)
    ) errors.push('Invocation plan cursor continuation contract is malformed or contradicts completeness.');
    const argumentsRecord = recordOf(plan.arguments);
    const cursorBinding = argumentsRecord
      ? recordOf(argumentsRecord[String(continuation.cursorArgument ?? '')])
      : null;
    const cursorSource = cursorBinding ? recordOf(cursorBinding.source) : null;
    if (
      cursorSource?.kind !== 'continuation_cursor'
      || cursorBinding?.required !== false
      || continuationCursorArgumentNames.length !== 1
      || continuationCursorArgumentNames[0] !== continuation.cursorArgument
    ) {
      errors.push(
        'Invocation plan cursorArgument must map one-to-one to an optional host-owned continuation_cursor source.',
      );
    }
  } else {
    errors.push(`Invocation plan continuation kind "${continuation.kind}" is unsupported.`);
  }

  const planEffect = recordOf(plan.binding)?.effect;
  if (planEffect !== 'read' && continuation?.kind !== 'none') {
    errors.push('Only read invocation plans may declare cursor continuation.');
  }

  if (plan.resultProjection !== undefined) {
    const projection = parseWorkflowCanonicalEntityResultProjection(plan.resultProjection);
    if (!projection.ok) {
      errors.push(...projection.errors.map((error) => `Invocation plan resultProjection: ${error}`));
    } else if (
      projection.contract.bounds.maxPages !== (
        continuation?.kind === 'cursor' ? continuation.maxPages : 1
      )
    ) {
      errors.push('Invocation plan resultProjection maxPages must equal its exact continuation ceiling.');
    }
  }

  if (!SHA256_RE.test(String(plan.bindingDigest ?? ''))) {
    errors.push('Invocation plan bindingDigest is not a sha256 digest.');
  } else {
    try {
      if (workflowNodeInvocationBindingDigest(plan as unknown as WorkflowNodeInvocationPlanV1) !== plan.bindingDigest) {
        errors.push('Invocation plan bindingDigest does not recompute from its exact bytes.');
      }
    } catch {
      errors.push('Invocation plan contains non-canonical JSON bytes.');
    }
  }

  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  return {
    ok: true,
    plan: JSON.parse(canonicalJson(plan)) as WorkflowNodeInvocationPlanV1,
  };
}

export function createWorkflowNodeInvocationPlan(
  input: Omit<WorkflowNodeInvocationPlanV1, 'version' | 'bindingDigest'>,
): WorkflowNodeInvocationPlanV1 {
  const withoutDigest: Omit<WorkflowNodeInvocationPlanV1, 'bindingDigest'> = {
    version: WORKFLOW_NODE_INVOCATION_PLAN_VERSION,
    ...JSON.parse(canonicalJson(input)) as Omit<
      WorkflowNodeInvocationPlanV1,
      'version' | 'bindingDigest'
    >,
  };
  const candidate: WorkflowNodeInvocationPlanV1 = {
    ...withoutDigest,
    bindingDigest: workflowNodeInvocationBindingDigest(withoutDigest),
  };
  const parsed = parseWorkflowNodeInvocationPlan(candidate);
  if (!parsed.ok) throw new Error(parsed.errors.join(' '));
  return parsed.plan;
}
