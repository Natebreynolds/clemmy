/** Validate known arguments and declared result bindings without inventing values. */
import { collectProviderSchemaFailures, isOpenProviderDataSchema } from '../runtime/harness/proof-provider-args.js';

type JsonObject = Record<string, unknown>;
export interface PreparedDynamicBinding {
  producerStepId: string;
  outputPath: string;
  targetPath: string;
  expectedType?: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'json';
}
const object = (value: unknown): value is JsonObject => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function pointerParts(pointer: string, rootAllowed = false): string[] {
  if (pointer === '' && rootAllowed) return [];
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) throw new Error(`Dynamic binding path ${JSON.stringify(pointer)} must be an exact JSON pointer, for example /content; use a leading slash for a field.`);
  const parts = pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Dynamic binding pointer is unsafe.');
  return parts;
}
function schemasAt(schema: JsonObject, parts: string[], depth = 0): JsonObject[] {
  if (depth > 64) throw new Error('Dynamic target schema exceeds the preparation bound.');
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
  if (alternatives) return alternatives.flatMap(branch => object(branch) ? schemasAt(branch, parts, depth + 1) : []);
  if (!parts.length) return [schema];
  if (schema.type === 'array' && /^(0|[1-9][0-9]*)$/.test(parts[0]!) && object(schema.items)) return schemasAt(schema.items, parts.slice(1), depth + 1);
  if (isOpenProviderDataSchema(schema)) return [{}];
  const child = object(schema.properties) && Object.hasOwn(schema.properties, parts[0]!) ? schema.properties[parts[0]!] : undefined;
  return object(child) ? schemasAt(child, parts.slice(1), depth + 1)
    : schema.additionalProperties === true ? [{}]
    : object(schema.additionalProperties) ? schemasAt(schema.additionalProperties, parts.slice(1), depth + 1) : [];
}

/** Returns exact missing pointers that may be deferred; every other static error stays an error. */
export function validatePlanArgumentPreparation(input: {
  schema: JsonObject;
  staticArguments: JsonObject;
  dynamicBindings: readonly PreparedDynamicBinding[];
  localIssues?: readonly { path: readonly PropertyKey[]; code: string }[];
}): void {
  const targets = new Set<string>();
  for (const binding of input.dynamicBindings) {
    pointerParts(binding.outputPath, true);
    const parts = pointerParts(binding.targetPath);
    if (targets.has(binding.targetPath)) throw new Error('Dynamic targets must be unique.');
    targets.add(binding.targetPath);
    let parent = input.staticArguments;
    for (const [index, part] of parts.slice(0, -1).entries()) {
      if (!Object.hasOwn(parent, part) || (!object(parent[part]) && !Array.isArray(parent[part]))) {
        const path = '/' + parts.slice(0, index + 1).map(key => key.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
        throw new Error(`Dynamic target parent ${path} must be explicitly prepared as its schema requires. Keep the object/array containers and omit only the bound leaf ${binding.targetPath}; do not insert a placeholder value there.`);
      }
      parent = parent[part] as JsonObject;
    }
    if (Object.hasOwn(parent, parts.at(-1)!)) throw new Error(`An argument cannot be both static and dynamically bound: ${binding.targetPath}. Remove only that leaf from staticArguments; preserve its parent containers.`);
    const schemas = schemasAt(input.schema, parts);
    if (!binding.expectedType) {
      const types = [...new Set(schemas.map(schema => isOpenProviderDataSchema(schema) ? 'json' : schema.type === 'integer' ? 'number' : schema.type))];
      binding.expectedType = types.length === 1 && ['string', 'number', 'boolean', 'object', 'array', 'json'].includes(String(types[0]))
        ? types[0] as PreparedDynamicBinding['expectedType'] : 'json';
    }
    if (!schemas.some(schema => isOpenProviderDataSchema(schema) || binding.expectedType === 'json' || schema.type === binding.expectedType || (schema.type === 'integer' && binding.expectedType === 'number'))) {
      throw new Error(`Dynamic target ${binding.targetPath} does not match the discovered schema and declared type.`);
    }
  }
  if (input.localIssues) {
    for (const issue of input.localIssues) {
      const pointer = '/' + issue.path.map(key => String(key).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
      if (issue.code !== 'invalid_type' || !targets.has(pointer)) throw new Error(`Static native argument ${pointer} does not match the discovered schema.`);
    }
    return;
  }
  const failures: Parameters<typeof collectProviderSchemaFailures>[3] = [];
  // More failures than declared bindings necessarily includes an unprepared
  // argument. Reaching the bound cannot hide one behind omitted targets.
  collectProviderSchemaFailures(input.staticArguments, input.schema, '', failures, { maxEntries: targets.size + 1, maxDepth: 64 });
  const unprepared = failures.filter(failure => failure.code !== 'missing_required' || !targets.has(failure.path));
  if (unprepared.length) {
    throw new Error(`Static provider arguments do not match the discovered schema outside declared result bindings: ${JSON.stringify(unprepared)}. Repair these exact fields; declared producer-bound values remain deferred.`);
  }
}
