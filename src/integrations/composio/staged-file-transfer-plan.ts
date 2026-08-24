type JsonSchema = boolean | Record<string, unknown>;

export type StagedFileAnnotation = 'file_uploadable' | 'file_downloadable';

export interface StagedFileTransferNode {
  /** RFC 6901 pointer into the exact runtime arguments/result. */
  pointer: string;
  annotation: StagedFileAnnotation;
}

export interface StagedFileTransferPlanOptions {
  maxDepth?: number;
  maxSchemaSteps?: number;
  maxFileNodes?: number;
}

export type StagedFileTransferPlanErrorCode =
  | 'invalid_schema'
  | 'unsupported_ref'
  | 'schema_mismatch'
  | 'ambiguous_one_of'
  | 'ambiguous_any_of'
  | 'reserved_pointer_segment'
  | 'unsupported_pattern'
  | 'traversal_limit'
  | 'unsafe_runtime_value';

export class StagedFileTransferPlanError extends Error {
  constructor(
    readonly code: StagedFileTransferPlanErrorCode,
    message: string,
    readonly pointer: string,
  ) {
    super(`${message} at ${pointer || '/'}`);
    this.name = 'StagedFileTransferPlanError';
  }
}

interface PointerToken {
  kind: 'object' | 'array';
  value: string;
}

interface PlannedNode extends StagedFileTransferNode {
  tokens: readonly PointerToken[];
}

interface PlanContext {
  rootSchema: JsonSchema;
  annotation: StagedFileAnnotation;
  maxDepth: number;
  maxSchemaSteps: number;
  maxFileNodes: number;
  schemaSteps: number;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_SCHEMA_STEPS = 100_000;
const DEFAULT_MAX_FILE_NODES = 2_000;
const RESERVED_POINTER_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StagedFileTransferPlanError(
      'traversal_limit',
      'file-plan limits must be positive safe integers',
      '',
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asSchema(value: unknown, pointer: string): JsonSchema {
  if (typeof value === 'boolean' || isPlainObject(value)) return value;
  throw new StagedFileTransferPlanError('invalid_schema', 'schema node is not an object or boolean', pointer);
}

function ownDataProperty(
  value: Record<string, unknown> | unknown[],
  key: string,
  pointer: string,
): { present: boolean; value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable) return { present: false };
  if ('get' in descriptor || 'set' in descriptor) {
    throw new StagedFileTransferPlanError(
      'unsafe_runtime_value',
      'runtime value contains an accessor property',
      pointer,
    );
  }
  return { present: true, value: descriptor.value };
}

function schemaProperty(schema: Record<string, unknown>, key: string, pointer: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(schema, key);
  if (!descriptor) return undefined;
  if ('get' in descriptor || 'set' in descriptor) {
    throw new StagedFileTransferPlanError('invalid_schema', 'schema contains an accessor property', pointer);
  }
  return descriptor.value;
}

function bump(context: PlanContext, pointer: string, depth: number): void {
  context.schemaSteps += 1;
  if (depth > context.maxDepth || context.schemaSteps > context.maxSchemaSteps) {
    throw new StagedFileTransferPlanError('traversal_limit', 'file-plan traversal exceeded its budget', pointer);
  }
}

function encodePointer(tokens: readonly PointerToken[]): string {
  return tokens.length === 0
    ? ''
    : `/${tokens.map((token) => token.value.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

function childPointer(pointer: string, segment: string): string {
  const encoded = segment.replace(/~/g, '~0').replace(/\//g, '~1');
  return `${pointer}/${encoded}`;
}

function assertAllowedPointerSegment(segment: string, pointer: string): void {
  if (RESERVED_POINTER_SEGMENTS.has(segment)) {
    throw new StagedFileTransferPlanError(
      'reserved_pointer_segment',
      'reserved prototype pointer segment is forbidden',
      childPointer(pointer, segment),
    );
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareTokens(left: readonly PointerToken[], right: readonly PointerToken[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.kind !== b.kind) return a.kind === 'object' ? -1 : 1;
    const compared = a.kind === 'array'
      ? Number(a.value) - Number(b.value)
      : compareUtf8(a.value, b.value);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function decodeRefToken(token: string, pointer: string): string {
  if (/~(?:[^01]|$)/.test(token)) {
    throw new StagedFileTransferPlanError('invalid_schema', 'schema reference has invalid JSON-pointer escaping', pointer);
  }
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveInternalRef(ref: unknown, context: PlanContext, pointer: string): JsonSchema {
  if (typeof ref !== 'string' || (ref !== '#' && !ref.startsWith('#/'))) {
    throw new StagedFileTransferPlanError(
      'unsupported_ref',
      'only bounded internal JSON-schema references are supported',
      pointer,
    );
  }
  let fragment: string;
  try {
    fragment = decodeURIComponent(ref.slice(1));
  } catch {
    throw new StagedFileTransferPlanError('invalid_schema', 'schema reference is not valid URI encoding', pointer);
  }
  let current: unknown = context.rootSchema;
  if (fragment === '') return context.rootSchema;
  for (const rawToken of fragment.slice(1).split('/')) {
    const token = decodeRefToken(rawToken, pointer);
    assertAllowedPointerSegment(token, pointer);
    if (!isPlainObject(current) && !Array.isArray(current)) {
      throw new StagedFileTransferPlanError('invalid_schema', 'schema reference does not resolve', pointer);
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, token);
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
      throw new StagedFileTransferPlanError('invalid_schema', 'schema reference does not resolve safely', pointer);
    }
    current = descriptor.value;
  }
  return asSchema(current, pointer);
}

function preflightClosedGraph(
  value: unknown,
  context: PlanContext,
  pointer: string,
  depth: number,
  graphKind: 'schema' | 'runtime',
  active: Set<object>,
): void {
  bump(context, pointer, depth);
  if (value === null || typeof value !== 'object') return;
  for (const key of Object.keys(value)) assertAllowedPointerSegment(key, pointer);
  if (graphKind === 'runtime' && typeof Blob !== 'undefined' && value instanceof Blob) return;
  if (active.has(value)) {
    throw new StagedFileTransferPlanError(
      graphKind === 'schema' ? 'invalid_schema' : 'unsafe_runtime_value',
      `${graphKind} graph is cyclic`,
      pointer,
    );
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new StagedFileTransferPlanError(
      graphKind === 'schema' ? 'invalid_schema' : 'unsafe_runtime_value',
      `${graphKind} graph contains a non-JSON object`,
      pointer,
    );
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const names = Object.keys(value);
      for (const name of names) {
        assertAllowedPointerSegment(name, pointer);
        if (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= value.length) {
          throw new StagedFileTransferPlanError(
            graphKind === 'schema' ? 'invalid_schema' : 'unsafe_runtime_value',
            `${graphKind} array has a non-index property`,
            childPointer(pointer, name),
          );
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const nextPointer = childPointer(pointer, String(index));
        const child = ownDataProperty(value, String(index), nextPointer);
        if (!child.present) {
          throw new StagedFileTransferPlanError(
            graphKind === 'schema' ? 'invalid_schema' : 'unsafe_runtime_value',
            `${graphKind} array is sparse`,
            nextPointer,
          );
        }
        preflightClosedGraph(child.value, context, nextPointer, depth + 1, graphKind, active);
      }
      return;
    }

    for (const key of Object.keys(value).sort(compareUtf8)) {
      assertAllowedPointerSegment(key, pointer);
      const nextPointer = childPointer(pointer, key);
      if (graphKind === 'schema' && (key === 'pattern' || key === 'patternProperties')) {
        throw new StagedFileTransferPlanError(
          'unsupported_pattern',
          'provider regular expressions are not accepted for staged file authority',
          nextPointer,
        );
      }
      const child = ownDataProperty(value, key, nextPointer);
      if (!child.present) continue;
      if (graphKind === 'schema' && key === '$ref' && typeof child.value === 'string') {
        let fragment: string;
        try {
          fragment = decodeURIComponent(child.value.startsWith('#') ? child.value.slice(1) : '');
        } catch {
          throw new StagedFileTransferPlanError('invalid_schema', 'schema reference is not valid URI encoding', nextPointer);
        }
        if (fragment === '' || fragment.startsWith('/')) {
          for (const rawToken of fragment === '' ? [] : fragment.slice(1).split('/')) {
            assertAllowedPointerSegment(decodeRefToken(rawToken, nextPointer), nextPointer);
          }
        }
      }
      preflightClosedGraph(child.value, context, nextPointer, depth + 1, graphKind, active);
    }
  } finally {
    active.delete(value);
  }
}

function schemaList(value: unknown, pointer: string): JsonSchema[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new StagedFileTransferPlanError('invalid_schema', 'schema combinator must be an array', pointer);
  }
  return value.map((entry) => asSchema(entry, pointer));
}

function assertNoUnsupportedSchemaAuthority(schema: Record<string, unknown>, pointer: string): void {
  for (const key of [
    '$dynamicRef',
    '$recursiveRef',
    'unevaluatedProperties',
    'unevaluatedItems',
  ]) {
    if (Object.prototype.hasOwnProperty.call(schema, key)) {
      throw new StagedFileTransferPlanError(
        'invalid_schema',
        `${key} is not supported for exact file-authority matching`,
        pointer,
      );
    }
  }
  for (const key of ['pattern', 'patternProperties']) {
    if (Object.prototype.hasOwnProperty.call(schema, key)) {
      throw new StagedFileTransferPlanError(
        'unsupported_pattern',
        'provider regular expressions are not accepted for staged file authority',
        childPointer(pointer, key),
      );
    }
  }
}

function jsonEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > DEFAULT_MAX_DEPTH || left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const a = ownDataProperty(left, String(index), '');
      const b = ownDataProperty(right, String(index), '');
      if (!a.present || !b.present || !jsonEqual(a.value, b.value, depth + 1)) return false;
    }
    return true;
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort(compareUtf8);
  const rightKeys = Object.keys(right).sort(compareUtf8);
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => {
    const a = ownDataProperty(left, key, '');
    const b = ownDataProperty(right, key, '');
    return a.present && b.present && jsonEqual(a.value, b.value, depth + 1);
  });
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    default: return false;
  }
}

function numericKeyword(schema: Record<string, unknown>, key: string, pointer: string): number | undefined {
  const value = schemaProperty(schema, key, pointer);
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StagedFileTransferPlanError('invalid_schema', `${key} must be a finite number`, pointer);
  }
  return value;
}

function integerKeyword(schema: Record<string, unknown>, key: string, pointer: string): number | undefined {
  const value = numericKeyword(schema, key, pointer);
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new StagedFileTransferPlanError('invalid_schema', `${key} must be a non-negative integer`, pointer);
  }
  return value;
}

function matchesSchema(
  schema: JsonSchema,
  value: unknown,
  context: PlanContext,
  pointer: string,
  depth: number,
): boolean {
  bump(context, pointer, depth);
  if (typeof schema === 'boolean') return schema;
  assertNoUnsupportedSchemaAuthority(schema, pointer);

  const ref = schemaProperty(schema, '$ref', pointer);
  if (ref !== undefined && !matchesSchema(resolveInternalRef(ref, context, pointer), value, context, pointer, depth + 1)) {
    return false;
  }

  const nullable = schemaProperty(schema, 'nullable', pointer) === true;
  const declaredType = schemaProperty(schema, 'type', pointer);
  if (value === null && nullable) {
    // OpenAPI nullable extends, rather than replaces, the declared type.
  } else if (typeof declaredType === 'string') {
    if (!typeMatches(declaredType, value)) return false;
  } else if (Array.isArray(declaredType)) {
    if (!declaredType.every((entry) => typeof entry === 'string')) {
      throw new StagedFileTransferPlanError('invalid_schema', 'schema type array contains a non-string', pointer);
    }
    if (!declaredType.some((entry) => typeMatches(entry, value))) return false;
  } else if (declaredType !== undefined) {
    throw new StagedFileTransferPlanError('invalid_schema', 'schema type is malformed', pointer);
  }

  const constant = schemaProperty(schema, 'const', pointer);
  if (constant !== undefined && !jsonEqual(value, constant)) return false;
  const enumeration = schemaProperty(schema, 'enum', pointer);
  if (enumeration !== undefined) {
    if (!Array.isArray(enumeration)) throw new StagedFileTransferPlanError('invalid_schema', 'enum must be an array', pointer);
    if (!enumeration.some((candidate) => jsonEqual(value, candidate))) return false;
  }

  const allOf = schemaList(schemaProperty(schema, 'allOf', pointer), pointer);
  if (!allOf.every((branch) => matchesSchema(branch, value, context, pointer, depth + 1))) return false;
  const anyOf = schemaList(schemaProperty(schema, 'anyOf', pointer), pointer);
  if (anyOf.length > 0 && !anyOf.some((branch) => matchesSchema(branch, value, context, pointer, depth + 1))) return false;
  const oneOf = schemaList(schemaProperty(schema, 'oneOf', pointer), pointer);
  if (oneOf.length > 0) {
    let matches = 0;
    for (const branch of oneOf) {
      if (matchesSchema(branch, value, context, pointer, depth + 1)) matches += 1;
    }
    if (matches !== 1) return false;
  }
  const not = schemaProperty(schema, 'not', pointer);
  if (not !== undefined && matchesSchema(asSchema(not, pointer), value, context, pointer, depth + 1)) return false;
  const conditional = schemaProperty(schema, 'if', pointer);
  if (conditional !== undefined) {
    const conditionMatches = matchesSchema(asSchema(conditional, pointer), value, context, pointer, depth + 1);
    const selected = schemaProperty(schema, conditionMatches ? 'then' : 'else', pointer);
    if (selected !== undefined && !matchesSchema(asSchema(selected, pointer), value, context, pointer, depth + 1)) return false;
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    const minLength = integerKeyword(schema, 'minLength', pointer);
    const maxLength = integerKeyword(schema, 'maxLength', pointer);
    if (minLength !== undefined && length < minLength) return false;
    if (maxLength !== undefined && length > maxLength) return false;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const minimum = numericKeyword(schema, 'minimum', pointer);
    const maximum = numericKeyword(schema, 'maximum', pointer);
    const exclusiveMinimum = numericKeyword(schema, 'exclusiveMinimum', pointer);
    const exclusiveMaximum = numericKeyword(schema, 'exclusiveMaximum', pointer);
    const multipleOf = numericKeyword(schema, 'multipleOf', pointer);
    if (minimum !== undefined && value < minimum) return false;
    if (maximum !== undefined && value > maximum) return false;
    if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) return false;
    if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) return false;
    if (multipleOf !== undefined) {
      if (multipleOf <= 0) throw new StagedFileTransferPlanError('invalid_schema', 'multipleOf must be positive', pointer);
      const quotient = value / multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8) return false;
    }
  }

  if (Array.isArray(value)) {
    const minItems = integerKeyword(schema, 'minItems', pointer);
    const maxItems = integerKeyword(schema, 'maxItems', pointer);
    if (minItems !== undefined && value.length < minItems) return false;
    if (maxItems !== undefined && value.length > maxItems) return false;
    const prefixItems = schemaProperty(schema, 'prefixItems', pointer);
    if (prefixItems !== undefined && !Array.isArray(prefixItems)) {
      throw new StagedFileTransferPlanError('invalid_schema', 'prefixItems must be an array', pointer);
    }
    const legacyItems = schemaProperty(schema, 'items', pointer);
    const additionalItems = schemaProperty(schema, 'additionalItems', pointer);
    for (let index = 0; index < value.length; index += 1) {
      const item = ownDataProperty(value, String(index), `${pointer}/${index}`);
      if (!item.present) throw new StagedFileTransferPlanError('unsafe_runtime_value', 'runtime array is sparse', pointer);
      let itemSchema: JsonSchema | undefined;
      if (Array.isArray(prefixItems) && index < prefixItems.length) itemSchema = asSchema(prefixItems[index], pointer);
      else if (Array.isArray(legacyItems) && index < legacyItems.length) itemSchema = asSchema(legacyItems[index], pointer);
      else if (legacyItems !== undefined && !Array.isArray(legacyItems)) itemSchema = asSchema(legacyItems, pointer);
      else if (Array.isArray(legacyItems) && index >= legacyItems.length) {
        if (additionalItems === false) return false;
        if (additionalItems !== undefined && additionalItems !== true) itemSchema = asSchema(additionalItems, pointer);
      }
      if (itemSchema !== undefined && !matchesSchema(itemSchema, item.value, context, `${pointer}/${index}`, depth + 1)) return false;
    }
    const uniqueItems = schemaProperty(schema, 'uniqueItems', pointer);
    if (uniqueItems !== undefined && typeof uniqueItems !== 'boolean') {
      throw new StagedFileTransferPlanError('invalid_schema', 'uniqueItems must be boolean', pointer);
    }
    if (uniqueItems === true) {
      for (let left = 0; left < value.length; left += 1) {
        for (let right = left + 1; right < value.length; right += 1) {
          const a = ownDataProperty(value, String(left), `${pointer}/${left}`);
          const b = ownDataProperty(value, String(right), `${pointer}/${right}`);
          if (jsonEqual(a.value, b.value)) return false;
        }
      }
    }
    const contains = schemaProperty(schema, 'contains', pointer);
    if (contains !== undefined) {
      const containsSchema = asSchema(contains, pointer);
      let count = 0;
      for (let index = 0; index < value.length; index += 1) {
        const item = ownDataProperty(value, String(index), `${pointer}/${index}`);
        if (matchesSchema(containsSchema, item.value, context, `${pointer}/${index}`, depth + 1)) count += 1;
      }
      const minContains = integerKeyword(schema, 'minContains', pointer) ?? 1;
      const maxContains = integerKeyword(schema, 'maxContains', pointer);
      if (count < minContains || (maxContains !== undefined && count > maxContains)) return false;
    }
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const minProperties = integerKeyword(schema, 'minProperties', pointer);
    const maxProperties = integerKeyword(schema, 'maxProperties', pointer);
    if (minProperties !== undefined && keys.length < minProperties) return false;
    if (maxProperties !== undefined && keys.length > maxProperties) return false;
    const required = schemaProperty(schema, 'required', pointer);
    if (required !== undefined) {
      if (!Array.isArray(required) || !required.every((key) => typeof key === 'string')) {
        throw new StagedFileTransferPlanError('invalid_schema', 'required must be a string array', pointer);
      }
      if (!required.every((key) => ownDataProperty(value, key, pointer).present)) return false;
    }
    const propertyNames = schemaProperty(schema, 'propertyNames', pointer);
    if (propertyNames !== undefined) {
      const nameSchema = asSchema(propertyNames, pointer);
      if (!keys.every((key) => matchesSchema(nameSchema, key, context, pointer, depth + 1))) return false;
    }
    const dependentRequired = schemaProperty(schema, 'dependentRequired', pointer);
    if (dependentRequired !== undefined) {
      if (!isPlainObject(dependentRequired)) {
        throw new StagedFileTransferPlanError('invalid_schema', 'dependentRequired must be an object', pointer);
      }
      for (const [trigger, rawDependencies] of Object.entries(dependentRequired)) {
        if (!ownDataProperty(value, trigger, pointer).present) continue;
        if (!Array.isArray(rawDependencies) || !rawDependencies.every((key) => typeof key === 'string')) {
          throw new StagedFileTransferPlanError('invalid_schema', 'dependentRequired entries must be string arrays', pointer);
        }
        if (!rawDependencies.every((key) => ownDataProperty(value, key, pointer).present)) return false;
      }
    }
    const dependentSchemas = schemaProperty(schema, 'dependentSchemas', pointer);
    if (dependentSchemas !== undefined) {
      if (!isPlainObject(dependentSchemas)) {
        throw new StagedFileTransferPlanError('invalid_schema', 'dependentSchemas must be an object', pointer);
      }
      for (const [trigger, rawDependentSchema] of Object.entries(dependentSchemas)) {
        if (ownDataProperty(value, trigger, pointer).present
          && !matchesSchema(asSchema(rawDependentSchema, pointer), value, context, pointer, depth + 1)) return false;
      }
    }
    const legacyDependencies = schemaProperty(schema, 'dependencies', pointer);
    if (legacyDependencies !== undefined) {
      if (!isPlainObject(legacyDependencies)) {
        throw new StagedFileTransferPlanError('invalid_schema', 'dependencies must be an object', pointer);
      }
      for (const [trigger, dependency] of Object.entries(legacyDependencies)) {
        if (!ownDataProperty(value, trigger, pointer).present) continue;
        if (Array.isArray(dependency)) {
          if (!dependency.every((key) => typeof key === 'string')) {
            throw new StagedFileTransferPlanError('invalid_schema', 'dependency entries must be schemas or string arrays', pointer);
          }
          if (!dependency.every((key) => ownDataProperty(value, key, pointer).present)) return false;
        } else if (!matchesSchema(asSchema(dependency, pointer), value, context, pointer, depth + 1)) {
          return false;
        }
      }
    }
    const propertiesValue = schemaProperty(schema, 'properties', pointer);
    if (propertiesValue !== undefined && !isPlainObject(propertiesValue)) {
      throw new StagedFileTransferPlanError('invalid_schema', 'properties must be an object', pointer);
    }
    const properties = propertiesValue as Record<string, unknown> | undefined;
    const additional = schemaProperty(schema, 'additionalProperties', pointer);
    for (const key of keys) {
      const child = ownDataProperty(value, key, pointer);
      if (!child.present) continue;
      const direct = properties ? Object.getOwnPropertyDescriptor(properties, key)?.value : undefined;
      if (direct !== undefined && !matchesSchema(asSchema(direct, pointer), child.value, context, pointer, depth + 1)) return false;
      if (direct === undefined) {
        if (additional === false) return false;
        if (additional !== undefined && additional !== true
          && !matchesSchema(asSchema(additional, pointer), child.value, context, pointer, depth + 1)) return false;
      }
    }
  }
  return true;
}

function runtimeLooksLikeFile(value: unknown, annotation: StagedFileAnnotation, pointer: string): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (annotation === 'file_uploadable') {
    return typeof Blob !== 'undefined' && value instanceof Blob;
  }
  if (!isPlainObject(value)) return false;
  const s3url = ownDataProperty(value, 's3url', pointer);
  return s3url.present && typeof s3url.value === 'string' && s3url.value.length > 0;
}

function putNode(
  output: Map<string, PlannedNode>,
  tokens: readonly PointerToken[],
  context: PlanContext,
): void {
  const pointer = encodePointer(tokens);
  output.set(pointer, { pointer, annotation: context.annotation, tokens: [...tokens] });
  if (output.size > context.maxFileNodes) {
    throw new StagedFileTransferPlanError('traversal_limit', 'file-plan contains too many transfer nodes', pointer);
  }
}

function nodesEqual(left: Map<string, PlannedNode>, right: Map<string, PlannedNode>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left.keys()) if (!right.has(key)) return false;
  return true;
}

function mergeNodes(target: Map<string, PlannedNode>, source: Map<string, PlannedNode>): void {
  for (const [pointer, node] of source) target.set(pointer, node);
}

function walkSchema(
  schema: JsonSchema,
  value: unknown,
  tokens: readonly PointerToken[],
  output: Map<string, PlannedNode>,
  context: PlanContext,
  depth: number,
): void {
  const pointer = encodePointer(tokens);
  bump(context, pointer, depth);
  if (typeof schema === 'boolean') return;
  assertNoUnsupportedSchemaAuthority(schema, pointer);

  const ref = schemaProperty(schema, '$ref', pointer);
  if (ref !== undefined) {
    walkSchema(resolveInternalRef(ref, context, pointer), value, tokens, output, context, depth + 1);
  }

  const oneOf = schemaList(schemaProperty(schema, 'oneOf', pointer), pointer);
  if (oneOf.length > 0) {
    const matches = oneOf.filter((branch) => matchesSchema(branch, value, context, pointer, depth + 1));
    if (matches.length !== 1) {
      throw new StagedFileTransferPlanError(
        'ambiguous_one_of',
        matches.length === 0 ? 'oneOf has no exact runtime branch' : 'oneOf has multiple runtime branches',
        pointer,
      );
    }
    walkSchema(matches[0]!, value, tokens, output, context, depth + 1);
  }

  const anyOf = schemaList(schemaProperty(schema, 'anyOf', pointer), pointer);
  if (anyOf.length > 0) {
    const matches = anyOf.filter((branch) => matchesSchema(branch, value, context, pointer, depth + 1));
    if (matches.length === 0) {
      throw new StagedFileTransferPlanError('ambiguous_any_of', 'anyOf has no runtime branch', pointer);
    }
    const candidateNodes = matches.map((branch) => {
      const nodes = new Map<string, PlannedNode>();
      walkSchema(branch, value, tokens, nodes, context, depth + 1);
      return nodes;
    });
    if (!candidateNodes.every((nodes) => nodesEqual(candidateNodes[0]!, nodes))) {
      throw new StagedFileTransferPlanError(
        'ambiguous_any_of',
        'matching anyOf branches disagree about file authority',
        pointer,
      );
    }
    mergeNodes(output, candidateNodes[0]!);
  }

  for (const branch of schemaList(schemaProperty(schema, 'allOf', pointer), pointer)) {
    walkSchema(branch, value, tokens, output, context, depth + 1);
  }
  const conditional = schemaProperty(schema, 'if', pointer);
  if (conditional !== undefined) {
    const conditionMatches = matchesSchema(asSchema(conditional, pointer), value, context, pointer, depth + 1);
    const selected = schemaProperty(schema, conditionMatches ? 'then' : 'else', pointer);
    if (selected !== undefined) walkSchema(asSchema(selected, pointer), value, tokens, output, context, depth + 1);
  }

  if (schemaProperty(schema, context.annotation, pointer) === true
    && runtimeLooksLikeFile(value, context.annotation, pointer)) {
    putNode(output, tokens, context);
    return;
  }

  if (Array.isArray(value)) {
    const prefixItems = schemaProperty(schema, 'prefixItems', pointer);
    const legacyItems = schemaProperty(schema, 'items', pointer);
    const additionalItems = schemaProperty(schema, 'additionalItems', pointer);
    const contains = schemaProperty(schema, 'contains', pointer);
    for (let index = 0; index < value.length; index += 1) {
      const childPointer = [...tokens, { kind: 'array' as const, value: String(index) }];
      const child = ownDataProperty(value, String(index), encodePointer(childPointer));
      if (!child.present) throw new StagedFileTransferPlanError('unsafe_runtime_value', 'runtime array is sparse', pointer);
      let childSchema: JsonSchema | undefined;
      if (Array.isArray(prefixItems) && index < prefixItems.length) childSchema = asSchema(prefixItems[index], pointer);
      else if (Array.isArray(legacyItems) && index < legacyItems.length) childSchema = asSchema(legacyItems[index], pointer);
      else if (legacyItems !== undefined && !Array.isArray(legacyItems)) childSchema = asSchema(legacyItems, pointer);
      else if (Array.isArray(legacyItems) && index >= legacyItems.length
        && additionalItems !== undefined && additionalItems !== true && additionalItems !== false) {
        childSchema = asSchema(additionalItems, pointer);
      }
      if (childSchema !== undefined) walkSchema(childSchema, child.value, childPointer, output, context, depth + 1);
      if (contains !== undefined) {
        const containsSchema = asSchema(contains, pointer);
        if (matchesSchema(containsSchema, child.value, context, encodePointer(childPointer), depth + 1)) {
          walkSchema(containsSchema, child.value, childPointer, output, context, depth + 1);
        }
      }
    }
    return;
  }

  if (!isPlainObject(value)) return;
  const propertiesValue = schemaProperty(schema, 'properties', pointer);
  if (propertiesValue !== undefined && !isPlainObject(propertiesValue)) {
    throw new StagedFileTransferPlanError('invalid_schema', 'properties must be an object', pointer);
  }
  const properties = propertiesValue as Record<string, unknown> | undefined;
  const additional = schemaProperty(schema, 'additionalProperties', pointer);
  for (const key of Object.keys(value).sort(compareUtf8)) {
    const childTokens = [...tokens, { kind: 'object' as const, value: key }];
    const childPointer = encodePointer(childTokens);
    const child = ownDataProperty(value, key, childPointer);
    if (!child.present) continue;
    const directDescriptor = properties ? Object.getOwnPropertyDescriptor(properties, key) : undefined;
    if (directDescriptor && ('get' in directDescriptor || 'set' in directDescriptor)) {
      throw new StagedFileTransferPlanError('invalid_schema', 'properties contains an accessor', childPointer);
    }
    if (directDescriptor) {
      walkSchema(asSchema(directDescriptor.value, childPointer), child.value, childTokens, output, context, depth + 1);
    }
    if (!directDescriptor && additional !== undefined && additional !== true && additional !== false) {
      walkSchema(asSchema(additional, childPointer), child.value, childTokens, output, context, depth + 1);
    }
  }
  const dependentSchemas = schemaProperty(schema, 'dependentSchemas', pointer);
  if (dependentSchemas !== undefined) {
    if (!isPlainObject(dependentSchemas)) {
      throw new StagedFileTransferPlanError('invalid_schema', 'dependentSchemas must be an object', pointer);
    }
    for (const trigger of Object.keys(dependentSchemas).sort(compareUtf8)) {
      if (!ownDataProperty(value, trigger, pointer).present) continue;
      const dependentSchema = Object.getOwnPropertyDescriptor(dependentSchemas, trigger)?.value;
      walkSchema(asSchema(dependentSchema, pointer), value, tokens, output, context, depth + 1);
    }
  }
  const legacyDependencies = schemaProperty(schema, 'dependencies', pointer);
  if (legacyDependencies !== undefined) {
    if (!isPlainObject(legacyDependencies)) {
      throw new StagedFileTransferPlanError('invalid_schema', 'dependencies must be an object', pointer);
    }
    for (const trigger of Object.keys(legacyDependencies).sort(compareUtf8)) {
      if (!ownDataProperty(value, trigger, pointer).present) continue;
      const dependency = Object.getOwnPropertyDescriptor(legacyDependencies, trigger)?.value;
      if (!Array.isArray(dependency)) {
        walkSchema(asSchema(dependency, pointer), value, tokens, output, context, depth + 1);
      }
    }
  }
}

function buildPlan(
  annotation: StagedFileAnnotation,
  schemaValue: unknown,
  runtimeValue: unknown,
  options: StagedFileTransferPlanOptions,
): readonly StagedFileTransferNode[] {
  const rootSchema = asSchema(schemaValue, '');
  const context: PlanContext = {
    rootSchema,
    annotation,
    maxDepth: positiveLimit(options.maxDepth, DEFAULT_MAX_DEPTH),
    maxSchemaSteps: positiveLimit(options.maxSchemaSteps, DEFAULT_MAX_SCHEMA_STEPS),
    maxFileNodes: positiveLimit(options.maxFileNodes, DEFAULT_MAX_FILE_NODES),
    schemaSteps: 0,
  };
  preflightClosedGraph(rootSchema, context, '', 0, 'schema', new Set<object>());
  context.schemaSteps = 0;
  preflightClosedGraph(runtimeValue, context, '', 0, 'runtime', new Set<object>());
  context.schemaSteps = 0;
  const output = new Map<string, PlannedNode>();
  walkSchema(rootSchema, runtimeValue, [], output, context, 0);
  if (!matchesSchema(rootSchema, runtimeValue, context, '', 0)) {
    throw new StagedFileTransferPlanError('schema_mismatch', 'runtime value does not satisfy the exact schema', '');
  }
  return Object.freeze(
    [...output.values()]
      .sort((left, right) => compareTokens(left.tokens, right.tokens))
      .map(({ pointer, annotation: nodeAnnotation }) => Object.freeze({ pointer, annotation: nodeAnnotation })),
  );
}

/**
 * Find only runtime-present upload values authorized by `file_uploadable`.
 * Returned nodes contain pointers, never local paths, URLs, Files, or Blobs.
 */
export function planStagedFileUploads(
  inputSchema: unknown,
  runtimeArguments: unknown,
  options: StagedFileTransferPlanOptions = {},
): readonly StagedFileTransferNode[] {
  return buildPlan('file_uploadable', inputSchema, runtimeArguments, options);
}

/**
 * Find only provider-result values authorized by the exact output schema's
 * `file_downloadable` annotation. A coincidental unmarked `s3url` is inert.
 * Returned nodes contain pointers only, preventing signed-URL persistence.
 */
export function planStagedFileDownloads(
  outputSchema: unknown,
  providerResult: unknown,
  options: StagedFileTransferPlanOptions = {},
): readonly StagedFileTransferNode[] {
  return buildPlan('file_downloadable', outputSchema, providerResult, options);
}
