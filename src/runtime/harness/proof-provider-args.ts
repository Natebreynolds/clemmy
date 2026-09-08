/**
 * Schema-grounded provider-argument compiler for proof-provisioned operations.
 *
 * Leaf module (no catalog/runtime imports) so the graph compiler's host-bind
 * pass can consult it without closing an import cycle. Ordinarily values come
 * from the immutable envelope. A sealed proof-provisioned catalog entry may
 * explicitly opt its already-admitted call payload into the recursively closed
 * provider-schema path; operation, account, effect, and schema remain closure-
 * bound by that entry and cannot be nominated by payload fields.
 */
import { createHash } from 'node:crypto';
import type { GraphNodeInvocationEnvelopeV1 } from './graph-node-envelope.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaShape(schema: Record<string, unknown>): {
  required: string[];
  properties: Record<string, Record<string, unknown>>;
} {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  const properties = isRecord(schema.properties)
    ? Object.fromEntries(
      Object.entries(schema.properties).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
    )
    : {};
  return { required, properties };
}

function propertyType(property: Record<string, unknown> | undefined): string {
  return typeof property?.type === 'string' ? property.type : '';
}

/** The proof path remains closed unless the selected schema explicitly owns
 * an extension shape. Such a shape is provider DATA, not permission to choose
 * an operation/account/effect. Named and patterned constraints both apply. */
function providerPropertySchemas(
  schema: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown> | true> | null {
  const constraints: Array<Record<string, unknown> | true> = [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const add = (child: unknown): boolean => {
    if (child === true) constraints.push(true);
    else if (isRecord(child)) constraints.push(child);
    else return false;
    return true;
  };
  if (Object.prototype.hasOwnProperty.call(properties, key) && !add(properties[key])) return null;
  if (isRecord(schema.patternProperties)) {
    for (const [pattern, child] of Object.entries(schema.patternProperties)) {
      try {
        if (new RegExp(pattern).test(key) && !add(child)) return null;
      } catch { return null; }
    }
  }
  if (constraints.length > 0) return constraints;
  if (schema.additionalProperties === true) return [true];
  if (isRecord(schema.additionalProperties)) return [schema.additionalProperties];
  return null;
}

function isProviderJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isProviderJsonValue);
  return isRecord(value) && Object.values(value).every(isProviderJsonValue);
}

function matchesProviderProperty(value: unknown, schemas: Array<Record<string, unknown> | true>): boolean {
  return schemas.every((schema) => schema === true
    ? isProviderJsonValue(value)
    : Object.keys(schema).length === 0
      ? isProviderJsonValue(value)
      : providerReadyValueMatchesSchema(value, schema));
}

function providerReadyValueMatchesSchema(value: unknown, schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return false;
  if (value === null && schema.nullable === true) return true;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) return false;
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(schema.const, value)) return false;
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (alternatives) {
    return alternatives.some((candidate) => (
      isRecord(candidate) && providerReadyValueMatchesSchema(value, candidate)
    ));
  }
  switch (propertyType(schema)) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': {
      if (!Array.isArray(value)) return false;
      if (schema.items === undefined) return true;
      if (!isRecord(schema.items)) return false;
      return value.every((item) => providerReadyValueMatchesSchema(item, schema.items as Record<string, unknown>));
    }
    case 'object': {
      if (!isRecord(value)) return false;
      const { required } = schemaShape(schema);
      if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
      return Object.entries(value).every(([key, child]) => {
        const constraints = providerPropertySchemas(schema, key);
        return constraints !== null && matchesProviderProperty(child, constraints);
      });
    }
    case '':
      // A declared but untyped scalar can cross; an unresolved object/array
      // schema cannot prove that its nested fields are closed.
      return value !== undefined && !isRecord(value) && !Array.isArray(value);
    default: return false;
  }
}

/** Closed projection for arguments that already match the exact provider
 * schema. The adapter still validates the exact current provider schema; no
 * operation name, role label, description, or id-looking field nominates a
 * capability. */
function exactProviderReadyArgs(
  schema: Record<string, unknown>,
  payload: unknown,
): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (!providerReadyValueMatchesSchema(payload, schema)) return null;
  try {
    return structuredClone(payload);
  } catch {
    return null;
  }
}

const MAX_REPAIR_FIELDS = 24;
const MAX_SCHEMA_FAILURE_DEPTH = 6;
const REPAIR_TEXT_LIMIT = 2_000;
const FAILING_PATHS_TEXT_BUDGET = 600;
const SCHEMA_SUBTREE_TEXT_BUDGET = 900;

export type ProofProviderSchemaFailureCode =
  | 'missing_required'
  | 'unknown_field'
  | 'type_mismatch'
  | 'enum_mismatch'
  | 'const_mismatch'
  | 'items_mismatch'
  | 'unresolved_shape';

/** One exact place where the payload left the selected schema. `path` is an
 * RFC 6901 JSON pointer into the argument object ('' is the root). No
 * argument value is ever carried here. */
export interface ProofProviderSchemaFailure {
  path: string;
  code: ProofProviderSchemaFailureCode;
  /** Bounded shape word the schema expects at this pointer. */
  expected?: string;
}

export interface ProofProviderSchemaFailureBudget {
  /** Maximum failures collected in one walk. */
  maxEntries: number;
  /** Maximum pointer depth descended with per-path detail; deeper subtrees
   * are judged whole by the boolean matcher and reported as one entry. */
  maxDepth: number;
  /**
   * `exact` (default) mirrors the closed proof matcher: every key declared,
   * every type/enum/const satisfied. `required_only` is the open policy of
   * capability gates that must fail OPEN: only missing `required` members
   * (at any depth) and keys under an explicit `additionalProperties: false`
   * node are failures; types, enums and undeclared keys of open objects are
   * left to the provider.
   */
  policy?: 'exact' | 'required_only';
}

/** Open-policy walk (see `policy: 'required_only'`). Never reports a type
 * or enum problem and never descends a value the schema does not declare. */
function collectRequiredOnlyFailures(
  value: unknown,
  schema: Record<string, unknown> | undefined,
  pointer: string,
  out: ProofProviderSchemaFailure[],
  budget: ProofProviderSchemaFailureBudget,
): void {
  if (!schema || out.length >= budget.maxEntries) return;
  if (pointerDepth(pointer) >= budget.maxDepth) return;
  const push = (failure: ProofProviderSchemaFailure): void => {
    if (out.length < budget.maxEntries) out.push(failure);
  };
  switch (propertyType(schema)) {
    case 'array': {
      if (!Array.isArray(value) || !isRecord(schema.items)) return;
      const items = schema.items;
      value.forEach((item, index) => {
        collectRequiredOnlyFailures(item, items, childPointer(pointer, index), out, budget);
      });
      return;
    }
    case 'object': {
      if (!isRecord(value)) return;
      const { required, properties } = schemaShape(schema);
      for (const key of required) {
        if (!hasOwn(value, key)) {
          push({
            path: childPointer(pointer, key),
            code: 'missing_required',
            expected: schemaTypeWord(properties[key]),
          });
        }
      }
      const closed = schema.additionalProperties === false
        && Object.keys(properties).length > 0
        && !(isRecord(schema.patternProperties) && Object.keys(schema.patternProperties).length > 0);
      for (const [key, child] of Object.entries(value)) {
        if (hasOwn(properties, key)) {
          collectRequiredOnlyFailures(child, properties[key], childPointer(pointer, key), out, budget);
        } else if (closed) {
          push({ path: childPointer(pointer, key), code: 'unknown_field' });
        }
      }
      return;
    }
    default:
      return;
  }
}

const DEFAULT_SCHEMA_FAILURE_BUDGET: ProofProviderSchemaFailureBudget = Object.freeze({
  maxEntries: MAX_REPAIR_FIELDS,
  maxDepth: MAX_SCHEMA_FAILURE_DEPTH,
});

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function childPointer(pointer: string, token: string | number): string {
  return `${pointer}/${typeof token === 'number' ? String(token) : escapePointerToken(token)}`;
}

function pointerDepth(pointer: string): number {
  return pointer === '' ? 0 : pointer.split('/').length - 1;
}

function boundedJsonWord(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'undefined';
  } catch {
    text = '?';
  }
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

/** Bounded type word for one schema node: `object`, `array<object>`,
 * `enum[ROWS,COLUMNS]`, `const("x")`, `oneOf(string|integer)`, `any`. Reads
 * structural keywords only, so descriptions, titles, examples, defaults and
 * instance values never appear. */
function schemaTypeWord(schema: Record<string, unknown> | undefined, depth = 0): string {
  if (!schema) return 'undeclared';
  let word: string;
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.slice(0, 8).map((candidate) => boundedJsonWord(candidate, 24));
    word = `enum[${values.join(',')}${schema.enum.length > 8 ? ',...' : ''}]`;
  } else if (hasOwn(schema, 'const')) {
    word = `const(${boundedJsonWord(schema.const, 24)})`;
  } else {
    const alternatives = Array.isArray(schema.anyOf)
      ? schema.anyOf
      : Array.isArray(schema.oneOf)
        ? schema.oneOf
        : null;
    if (alternatives) {
      const words = alternatives
        .filter(isRecord)
        .slice(0, 4)
        .map((candidate) => (
          depth < 2 ? schemaTypeWord(candidate, depth + 1) : (propertyType(candidate) || 'any')
        ));
      word = `oneOf(${words.join('|')}${alternatives.length > 4 ? '|...' : ''})`;
    } else {
      const type = propertyType(schema);
      if (type === 'array') {
        const items = isRecord(schema.items) ? schema.items : undefined;
        word = items && depth < 2 ? `array<${schemaTypeWord(items, depth + 1)}>` : 'array';
      } else {
        word = type || 'any';
      }
    }
  }
  return schema.nullable === true ? `${word}|null` : word;
}

/**
 * Path-collecting sibling of `providerReadyValueMatchesSchema`. It walks the
 * same closed-schema rules and records WHERE the payload left the schema
 * instead of only THAT it did: objects report each missing required child and
 * each undeclared key and recurse into declared children; arrays recurse into
 * items; enum/const/anyOf report a mismatch at the pointer. The walk stops at
 * `budget.maxEntries` failures and, past `budget.maxDepth`, judges the subtree
 * whole. Invariant: `out` stays empty exactly when the matcher accepts.
 */
export function collectProviderSchemaFailures(
  value: unknown,
  schema: Record<string, unknown> | undefined,
  pointer: string,
  out: ProofProviderSchemaFailure[],
  budget: ProofProviderSchemaFailureBudget = DEFAULT_SCHEMA_FAILURE_BUDGET,
): void {
  if (budget.policy === 'required_only') {
    collectRequiredOnlyFailures(value, schema, pointer, out, budget);
    return;
  }
  const push = (failure: ProofProviderSchemaFailure): void => {
    if (out.length < budget.maxEntries) out.push(failure);
  };
  if (out.length >= budget.maxEntries) return;
  if (!schema) {
    push({ path: pointer, code: 'unresolved_shape', expected: 'undeclared' });
    return;
  }
  if (value === null && schema.nullable === true) return;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    push({ path: pointer, code: 'enum_mismatch', expected: schemaTypeWord(schema) });
    return;
  }
  if (hasOwn(schema, 'const') && !Object.is(schema.const, value)) {
    push({ path: pointer, code: 'const_mismatch', expected: schemaTypeWord(schema) });
    return;
  }
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (alternatives) {
    const matched = alternatives.some((candidate) => (
      isRecord(candidate) && providerReadyValueMatchesSchema(value, candidate)
    ));
    if (!matched) push({ path: pointer, code: 'type_mismatch', expected: schemaTypeWord(schema) });
    return;
  }
  if (pointerDepth(pointer) >= budget.maxDepth) {
    if (!providerReadyValueMatchesSchema(value, schema)) {
      push({ path: pointer, code: 'unresolved_shape', expected: schemaTypeWord(schema) });
    }
    return;
  }
  switch (propertyType(schema)) {
    case 'string':
      if (typeof value !== 'string') {
        push({ path: pointer, code: 'type_mismatch', expected: schemaTypeWord(schema) });
      }
      return;
    case 'number':
      if (!(typeof value === 'number' && Number.isFinite(value))) {
        push({ path: pointer, code: 'type_mismatch', expected: schemaTypeWord(schema) });
      }
      return;
    case 'integer':
      if (!Number.isSafeInteger(value)) {
        push({ path: pointer, code: 'type_mismatch', expected: schemaTypeWord(schema) });
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        push({ path: pointer, code: 'type_mismatch', expected: schemaTypeWord(schema) });
      }
      return;
    case 'array': {
      if (!Array.isArray(value)) {
        push({ path: pointer, code: 'type_mismatch', expected: schemaTypeWord(schema) });
        return;
      }
      if (schema.items === undefined) return;
      if (!isRecord(schema.items)) {
        push({ path: pointer, code: 'items_mismatch', expected: 'array' });
        return;
      }
      const items = schema.items;
      value.forEach((item, index) => {
        collectProviderSchemaFailures(item, items, childPointer(pointer, index), out, budget);
      });
      return;
    }
    case 'object': {
      if (!isRecord(value)) {
        push({ path: pointer, code: 'type_mismatch', expected: schemaTypeWord(schema) });
        return;
      }
      const { required, properties } = schemaShape(schema);
      for (const key of required) {
        if (!hasOwn(value, key)) {
          push({
            path: childPointer(pointer, key),
            code: 'missing_required',
            expected: schemaTypeWord(properties[key]),
          });
        }
      }
      for (const [key, child] of Object.entries(value)) {
        const constraints = providerPropertySchemas(schema, key);
        if (constraints === null) {
          push({ path: childPointer(pointer, key), code: 'unknown_field' });
          continue;
        }
        for (const constraint of constraints) {
          if (constraint === true || Object.keys(constraint).length === 0) {
            if (!isProviderJsonValue(child)) push({ path: childPointer(pointer, key), code: 'type_mismatch', expected: 'JSON value' });
          } else {
            collectProviderSchemaFailures(child, constraint, childPointer(pointer, key), out, budget);
          }
        }
      }
      return;
    }
    case '':
      if (!(value !== undefined && !isRecord(value) && !Array.isArray(value))) {
        push({ path: pointer, code: 'unresolved_shape', expected: 'scalar' });
      }
      return;
    default:
      push({ path: pointer, code: 'unresolved_shape', expected: schemaTypeWord(schema) });
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Key-sorted JSON so two structurally equal schemas share one digest. This
 * module is a leaf: the digest is computed here, never imported from a store. */
function stableKeyJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableKeyJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableKeyJson(record[key])}`)
    .join(',')}}`;
}

/** Digest of the exact selected schema, computed locally. */
export function proofProviderSchemaDigest(schema: Record<string, unknown>): string {
  return sha256Hex(stableKeyJson(schema));
}

/**
 * Host-authored repair key: sha256 over the schema digest and the sorted
 * (path, code) set only. Argument VALUES are deliberately excluded so a
 * different wrong value at the same failing paths cannot mint a "new"
 * repair, while a genuinely different failing-path set can.
 */
export function proofProviderRepairKey(input: {
  schemaDigest: string;
  failures: readonly ProofProviderSchemaFailure[];
}): string {
  const pairs = [...new Map(
    input.failures.map((failure) => [JSON.stringify([failure.path, failure.code]), [failure.path, failure.code] as const]),
  ).values()].sort((left, right) => (
    left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0])
  ));
  return sha256Hex(JSON.stringify({ v: 1, schema: input.schemaDigest, failures: pairs }));
}

export type ProofProviderArgumentValidation =
  | { ok: true; args: Record<string, unknown> }
  | {
      ok: false;
      requiredFields: string[];
      allowedFields: string[];
      missingRequiredFields: string[];
      unknownFields: string[];
      invalidFields: string[];
      fieldsTruncated: boolean;
      /** Exact failing pointers with a reason each (bounded, value-free). */
      failures: ProofProviderSchemaFailure[];
      /** Sorted unique failing pointers. */
      failingPaths: string[];
      /** Host-owned digest of {schema, sorted (path, code)}; no values. */
      repairKey: string;
    };

/**
 * Validate an object that explicitly claims to be provider-ready arguments.
 * The bounded diagnostics expose the selected schema's top-level field names
 * plus the exact failing pointers and their reasons. They are enough for an
 * in-turn model repair without copying descriptions, examples, values,
 * account data, or an unbounded provider schema into a tool result.
 */
export function validateProofProviderArguments(input: {
  schema: Record<string, unknown>;
  payload: unknown;
  /** Precomputed `proofProviderSchemaDigest(schema)`; computed when absent. */
  schemaDigest?: string;
}): ProofProviderArgumentValidation {
  const exact = exactProviderReadyArgs(input.schema, input.payload);
  if (exact) return { ok: true, args: exact };

  const { required, properties } = schemaShape(input.schema);
  const allAllowed = Object.keys(properties);
  const payload = isRecord(input.payload) ? input.payload : {};
  const missingRequiredFields = required.filter((key) => (
    !Object.prototype.hasOwnProperty.call(payload, key)
  ));
  const unknownFields = Object.keys(payload).filter((key) => providerPropertySchemas(input.schema, key) === null);
  const invalidFields = Object.entries(payload)
    .filter(([key, value]) => {
      const constraints = providerPropertySchemas(input.schema, key);
      return constraints !== null && !matchesProviderProperty(value, constraints);
    })
    .map(([key]) => key);
  const fieldsTruncated = [required, allAllowed, missingRequiredFields, unknownFields, invalidFields]
    .some((fields) => fields.length > MAX_REPAIR_FIELDS);
  const failures: ProofProviderSchemaFailure[] = [];
  collectProviderSchemaFailures(input.payload, input.schema, '', failures);
  if (failures.length === 0) {
    // The exact projection refused (for example a payload that cannot be
    // cloned) but the walk found nothing to name; keep the refusal keyed.
    failures.push({ path: '', code: 'unresolved_shape', expected: schemaTypeWord(input.schema) });
  }
  const failingPaths = [...new Set(failures.map((failure) => failure.path))].sort();
  const schemaDigest = input.schemaDigest ?? proofProviderSchemaDigest(input.schema);
  return {
    ok: false,
    requiredFields: required.slice(0, MAX_REPAIR_FIELDS),
    allowedFields: allAllowed.slice(0, MAX_REPAIR_FIELDS),
    missingRequiredFields: missingRequiredFields.slice(0, MAX_REPAIR_FIELDS),
    unknownFields: unknownFields.slice(0, MAX_REPAIR_FIELDS),
    invalidFields: invalidFields.slice(0, MAX_REPAIR_FIELDS),
    fieldsTruncated,
    failures,
    failingPaths,
    repairKey: proofProviderRepairKey({ schemaDigest, failures }),
  };
}

export type ProofProviderForegroundPayloadValidation =
  | { ok: true }
  | { ok: false; repair: string; schemaAvailable: true; repairKey: string };

export type ProofProviderForegroundPayloadValidator = (
  payload: unknown,
) => ProofProviderForegroundPayloadValidation;

export interface BoundedSchemaSubtreeLimits {
  maxDepth: number;
  maxFields: number;
  maxChars: number;
}

const DEFAULT_SUBTREE_LIMITS: BoundedSchemaSubtreeLimits = Object.freeze({
  maxDepth: 3,
  maxFields: 24,
  maxChars: SCHEMA_SUBTREE_TEXT_BUDGET,
});

function isContainerSchema(node: Record<string, unknown>): boolean {
  const type = propertyType(node);
  return type === 'object' || type === 'array';
}

/** Descend `properties`/`items` along a pointer. Returns the deepest resolved
 * object/array schema node that contains the pointer (the node itself when it
 * is an object/array schema, otherwise its nearest such ancestor). */
function nearestContainerSchema(
  schema: Record<string, unknown>,
  pointer: string,
): { pointer: string; schema: Record<string, unknown> } | null {
  let node: Record<string, unknown> = schema;
  let nodePointer = '';
  let container = isContainerSchema(node) ? { pointer: nodePointer, schema: node } : null;
  if (pointer === '') return container;
  for (const rawToken of pointer.split('/').slice(1)) {
    const token = unescapePointerToken(rawToken);
    let next: Record<string, unknown> | undefined;
    if (propertyType(node) === 'object') {
      const { properties } = schemaShape(node);
      next = hasOwn(properties, token) ? properties[token] : undefined;
    } else if (propertyType(node) === 'array' && /^\d+$/.test(token) && isRecord(node.items)) {
      next = node.items;
    }
    if (!next) break;
    node = next;
    nodePointer = childPointer(nodePointer, token);
    if (isContainerSchema(node)) container = { pointer: nodePointer, schema: node };
  }
  return container;
}

function renderObjectFields(
  schema: Record<string, unknown>,
  depth: number,
  limits: BoundedSchemaSubtreeLimits,
): string {
  const { required, properties } = schemaShape(schema);
  const requiredSet = new Set(required);
  const names = Object.keys(properties);
  const fields = names.slice(0, limits.maxFields).map((name) => (
    `${name}${requiredSet.has(name) ? '*' : ''}: ${renderNodeWord(properties[name]!, depth + 1, limits)}`
  ));
  if (names.length > limits.maxFields) fields.push(`...(+${names.length - limits.maxFields} more)`);
  return fields.join(', ');
}

/** Type word for a node; object/array children are expanded one level while
 * `depth < limits.maxDepth`, then collapse to their bare type word. */
function renderNodeWord(
  schema: Record<string, unknown>,
  depth: number,
  limits: BoundedSchemaSubtreeLimits,
): string {
  const type = propertyType(schema);
  const nullable = schema.nullable === true ? '|null' : '';
  if (type === 'object' && depth < limits.maxDepth && isRecord(schema.properties)) {
    return `object{${renderObjectFields(schema, depth, limits)}}${nullable}`;
  }
  if (type === 'array' && depth < limits.maxDepth && isRecord(schema.items)) {
    return `array<${renderNodeWord(schema.items, depth + 1, limits)}>${nullable}`;
  }
  return schemaTypeWord(schema);
}

/**
 * Render the required shape around each failing pointer: for every pointer's
 * nearest object/array schema node print `"<path>": <type>; required: [...]`
 * and its child `name*: type` entries (enum values inline, array items and
 * child objects expanded one level). Only structural keywords are read, so
 * description/title/examples/default/deprecated/readOnly/writeOnly never
 * reach the model. Bounded by `limits` (depth, fields per object, chars).
 */
export function renderBoundedSchemaSubtree(
  schema: Record<string, unknown>,
  pointers: readonly string[],
  limits: BoundedSchemaSubtreeLimits = DEFAULT_SUBTREE_LIMITS,
): string {
  const containers = new Map<string, Record<string, unknown>>();
  for (const pointer of pointers) {
    const container = nearestContainerSchema(schema, pointer);
    if (container && !containers.has(container.pointer)) {
      containers.set(container.pointer, container.schema);
    }
  }
  const sections = [...containers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pointer, node]) => {
      const label = JSON.stringify(pointer === '' ? '/' : pointer);
      if (propertyType(node) === 'object') {
        const { required } = schemaShape(node);
        const shownRequired = required.slice(0, limits.maxFields).join(', ');
        const parts = [
          `${label}: object`,
          `required: [${shownRequired}${required.length > limits.maxFields ? ', ...' : ''}]`,
        ];
        const fields = renderObjectFields(node, 1, limits);
        if (fields) parts.push(fields);
        return parts.join('; ');
      }
      const items = isRecord(node.items) ? node.items : undefined;
      return `${label}: array; items: ${items ? renderNodeWord(items, 1, limits) : 'any'}`;
    });
  const text = sections.join(' | ');
  return text.length > limits.maxChars ? `${text.slice(0, limits.maxChars - 3)}...` : text;
}

const FAILURE_CODE_LABEL: Record<ProofProviderSchemaFailureCode, string> = {
  missing_required: 'missing required',
  unknown_field: 'unknown field',
  type_mismatch: 'type mismatch',
  enum_mismatch: 'enum mismatch',
  const_mismatch: 'const mismatch',
  items_mismatch: 'items mismatch',
  unresolved_shape: 'unresolved shape',
};

function renderFailingPaths(
  failures: readonly ProofProviderSchemaFailure[],
  maxChars: number,
): string {
  const entries = failures.map((failure) => {
    const path = failure.path === '' ? '(root)' : failure.path.slice(0, 80);
    const expected = failure.expected ? `, expected ${failure.expected.slice(0, 80)}` : '';
    return `${JSON.stringify(path)} (${FAILURE_CODE_LABEL[failure.code]}${expected})`;
  });
  const shown: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const next = used + entry.length + (shown.length > 0 ? 2 : 0);
    if (next > maxChars && shown.length > 0) break;
    shown.push(entry);
    used = next;
  }
  const omitted = entries.length - shown.length;
  return `${shown.join(', ')}${omitted > 0 ? ` (+${omitted} more)` : ''}`;
}

/**
 * Build a denial-only foreground validator over an isolated snapshot of one
 * exact provider schema. The caller remains responsible for proving that the
 * schema digest belongs to its manifest; this helper never selects an
 * operation, account, effect, or capability.
 *
 * The refusal names the exact failing pointers and the required shape around
 * them so the model can retry the SAME operation once with one corrected
 * object. It deliberately does not send the model to discovery: the host
 * already holds the exact schema, and the recovery surface the host derives
 * from this refusal contains only the refused carrier.
 */
export function createProofProviderForegroundPayloadValidator(input: {
  operationId: string;
  schema: Record<string, unknown>;
}): ProofProviderForegroundPayloadValidator | null {
  const operationId = input.operationId.trim();
  if (!operationId) return null;
  let schema: Record<string, unknown>;
  try {
    schema = structuredClone(input.schema);
  } catch {
    return null;
  }
  const schemaDigest = proofProviderSchemaDigest(schema);
  return (payload) => {
    const validation = validateProofProviderArguments({ schema, payload, schemaDigest });
    if (validation.ok) return { ok: true };
    const head = `[provider-dispatch:not-started:invalid-args] ${operationId} arguments did not match its exact current schema.`;
    const tail = 'Retry this same operation exactly once with one corrected JSON object; do not call tool_search or substitute another operation. No provider request was sent.';
    const available = Math.max(0, REPAIR_TEXT_LIMIT - head.length - tail.length - 2);
    const pathsText = `Failing paths: ${renderFailingPaths(
      validation.failures,
      Math.min(FAILING_PATHS_TEXT_BUDGET, available),
    )}.`;
    const subtreeBudget = Math.max(
      0,
      Math.min(SCHEMA_SUBTREE_TEXT_BUDGET, available - pathsText.length - 1),
    );
    const subtree = subtreeBudget > 0
      ? renderBoundedSchemaSubtree(schema, validation.failingPaths, {
          ...DEFAULT_SUBTREE_LIMITS,
          maxChars: subtreeBudget,
        })
      : '';
    const details = [
      head,
      pathsText,
      ...(subtree ? [`Required shape at ${subtree}.`] : []),
      tail,
    ].join(' ');
    return {
      ok: false,
      repair: details.slice(0, REPAIR_TEXT_LIMIT),
      schemaAvailable: true,
      repairKey: validation.repairKey,
    };
  };
}

/**
 * Schema-grounded argument compiler for a proof-provisioned operation.
 * Payload passthrough is opt-in because only the sealed catalog invoke owns an
 * admitted operation/account/schema tuple; all other callers retain semantic
 * synthesis (apart from the pre-existing host-verification recipe path).
 */
export function compileProofProviderArgs(input: {
  schema: Record<string, unknown>;
  role: string;
  effect: 'read' | 'external_write';
  payload: unknown;
  envelope?: GraphNodeInvocationEnvelopeV1;
  acceptAuthorityBoundPayload?: boolean;
  /** The trusted caller, never payload content, declares whether this object
   * is already authored against the provider schema or is semantic material
   * from which the host may synthesize provider arguments. */
  authorityBoundPayloadKind?: 'provider_arguments' | 'semantic';
}): Record<string, unknown> | null {
  // Foreground tool_search returns the provider's exact schema and work_call
  // carries arguments authored against that schema. Preserve those bytes when
  // they already satisfy the closed top-level contract. Previously only the
  // host_verification role took this path, so ordinary proof-provisioned
  // operations discarded exact arguments and tried to synthesize replacements
  // from the semantic envelope. That made nested write shapes impossible and
  // erased optional-but-operational identifiers from exact read calls.
  const explicitProviderArguments = input.acceptAuthorityBoundPayload === true
    && (
      input.authorityBoundPayloadKind === 'provider_arguments'
      // Compatibility for current foreground catalog callers while the
      // explicit kind propagates through every registration/recovery path.
      || input.role === 'foreground'
    );
  if (input.role === 'host_verification' || input.acceptAuthorityBoundPayload === true) {
    const validation = validateProofProviderArguments({
      schema: input.schema,
      payload: input.payload,
    });
    if (validation.ok) return validation.args;
    // An explicit provider object that fails its exact selected schema must
    // never fall through to semantic synthesis. In particular, an optional-
    // only read schema used to turn {wrong_id: "..."} into {}, which crossed
    // the provider and produced a misleading business failure.
    if (explicitProviderArguments) return null;
  }
  // A host-instantiated verifier has no semantic fallback: accepting anything
  // other than its exact recipe arguments would change the verification proof.
  if (input.role === 'host_verification') return null;
  const { required, properties } = schemaShape(input.schema);
  const args: Record<string, unknown> = {};
  const predecessorValues = (input.envelope?.predecessors ?? [])
    .map((prior) => prior.value)
    .filter((value): value is Record<string, unknown> | unknown[] => value !== undefined && value !== null);

  if (input.effect === 'read') {
    const requiredStrings = required.filter((key) => propertyType(properties[key]) === 'string');
    const predecessorId = predecessorValues
      .map((value) => (isRecord(value) && typeof value.id === 'string' ? value.id : null))
      .find((value): value is string => Boolean(value));
    const payloadText = typeof input.payload === 'string' && input.payload.trim()
      ? input.payload.trim()
      : isRecord(input.payload) && typeof input.payload.query === 'string'
        ? input.payload.query
        : '';
    const value = input.role === 'readback'
      ? (predecessorId ?? payloadText)
      : (input.envelope?.goal.objective ?? payloadText);
    if (requiredStrings.length > 0 && !value) return null;
    for (const key of requiredStrings) args[key] = value;
    const limitKey = ['limit', 'max_results', 'count'].find(
      (key) => key in properties && (propertyType(properties[key]) === 'integer' || propertyType(properties[key]) === 'number'),
    );
    const count = input.envelope?.cardinality?.count;
    if (limitKey && Number.isSafeInteger(count) && (count as number) > 0) args[limitKey] = count;
    const unmet = required.filter((key) => !(key in args));
    return unmet.length === 0 ? args : null;
  }

  // external_write: the collection lands in the schema's required array (or
  // JSON-string) member; a title-like optional string carries the objective.
  const records = ((): Array<Record<string, unknown>> => {
    if (Array.isArray(input.payload)) return input.payload as Array<Record<string, unknown>>;
    if (isRecord(input.payload) && Array.isArray(input.payload.records)) {
      return input.payload.records as Array<Record<string, unknown>>;
    }
    for (const value of predecessorValues) {
      if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
      if (isRecord(value) && Array.isArray(value.records)) return value.records as Array<Record<string, unknown>>;
    }
    return [];
  })();
  if (records.length === 0) return null;
  const arrayKey = required.find((key) => propertyType(properties[key]) === 'array')
    ?? Object.keys(properties).find((key) => propertyType(properties[key]) === 'array');
  const jsonKey = required.find((key) => /json/i.test(key) && propertyType(properties[key]) === 'string');
  if (arrayKey) args[arrayKey] = records;
  else if (jsonKey) args[jsonKey] = JSON.stringify(records);
  else return null;
  for (const key of required) {
    if (key in args) continue;
    if (propertyType(properties[key]) !== 'string') continue;
    const literal = input.envelope?.goal.objective?.slice(0, 120);
    if (!literal) return null;
    args[key] = literal;
  }
  const unmet = required.filter((key) => !(key in args));
  return unmet.length === 0 ? args : null;
}
