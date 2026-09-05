/**
 * Centralized zod → Codex-strict-JSON-schema normalizer.
 *
 * Codex (and OpenAI's Responses API generally) runs in "strict" JSON
 * schema mode for both tool inputs AND structured outputs (Agent
 * outputType). Strict mode requires:
 *
 *   - Every property in `properties` MUST appear in `required`.
 *   - Optional fields can be expressed as `["T", "null"]` (nullable)
 *     but NOT as "absent from required" (optional).
 *
 * In zod terms:
 *   - `.nullable()`   produces `T | null`, field IS in required ✓
 *   - `.optional()`   produces `T | undefined`, field NOT in required ✗
 *   - `.nullish()`    produces `T | null | undefined`, field NOT in required ✗
 *
 * This module recursively walks any zod schema and rewrites optional /
 * nullish nodes into nullable so Codex's strict-mode validator accepts.
 *
 * Migration history:
 *   - Originally lived inside local-runtime-tools.ts as
 *     normalizeZodForResponses, scoped to tool INPUT schemas only.
 *   - v0.5.22: extracted here so AGENT outputType schemas can use the
 *     same transformation. Previously Orchestrator/Planner/Autonomy
 *     agents emitted `reply: z.string().nullish()` which Codex rejected
 *     with "Missing 'reply' in required" under SDK 0.11.5 strict mode.
 *
 * Why this lives at the BOUNDARY (apply once per Agent/tool registration)
 * instead of forcing every schema author to write .nullable() everywhere:
 *
 *   - 175+ tool schemas + 3 agent schemas to retrofit by hand = high
 *     blast radius, easy to miss one, regression-prone forever.
 *   - One centralized normalizer = single source of truth, future
 *     schemas work without thinking about it.
 *   - Matches the [[feedback-code-level-over-prompt]] principle: enforce
 *     compatibility in code at the boundary, not by curating every
 *     downstream caller.
 */

import { z } from 'zod';

function withDescription(source: z.ZodTypeAny, target: z.ZodTypeAny): z.ZodTypeAny {
  return source.description ? target.describe(source.description) : target;
}

/**
 * Recursively normalize a zod schema to Codex-strict-compatible form.
 *
 * Strategy:
 *   - `optional` (T | undefined)        → `nullable` (T | null)
 *   - `nullable` (T | null)             → keep, recurse on inner
 *   - `nullish` (T | null | undefined)  → in zod 4 this IS optional(nullable(T)),
 *                                          so optional case fires and we end up
 *                                          with nullable(T) — correct.
 *   - `object`  recurse over each value in shape
 *   - `array`   recurse on element
 *   - `record`  recurse on valueType and emit object.catchall(valueType)
 *               instead of z.record(...). Zod 4 emits JSON Schema
 *               `propertyNames` for records, and Codex strict tool
 *               schemas reject that keyword.
 *   - `union`   recurse on each option (skip if 0/1, build union if >=2)
 *   - `any/unknown` → string  (the strict schema can't carry unknown shape;
 *                              upstream code is expected to JSON.stringify
 *                              free-form values anyway)
 *   - anything else (string, number, boolean, enum, literal, date, ...)
 *     pass through unchanged
 *
 * Returns a NEW zod schema; the input is never mutated.
 */
export function normalizeZodForCodexStrict(schema: z.ZodTypeAny): z.ZodTypeAny {
  // zod 4 internal field layout (different from zod 3):
  //   ZodObject.shape      via .shape getter (was _def.shape() callable in zod 3)
  //   ZodArray._def.element
  //   ZodRecord._def.valueType / .keyType
  //   ZodUnion._def.options
  //   ZodOptional/Nullable._def.innerType
  // Type values are lowercase without the Zod prefix: 'optional', 'object', etc.
  const def = (schema as unknown as { _def: { type?: string; [key: string]: unknown } })._def;

  switch (def?.type) {
    case 'optional':
      return withDescription(schema, normalizeZodForCodexStrict(def.innerType as z.ZodTypeAny).nullable());
    case 'nullable':
      return withDescription(schema, normalizeZodForCodexStrict(def.innerType as z.ZodTypeAny).nullable());
    case 'object': {
      const anySchema = schema as unknown as { shape: z.ZodRawShape | (() => z.ZodRawShape) };
      const shape = typeof anySchema.shape === 'function' ? anySchema.shape() : anySchema.shape;
      const normalizedShape = Object.fromEntries(
        Object.entries(shape as z.ZodRawShape).map(([key, value]) => [
          key,
          normalizeZodForCodexStrict(value as z.ZodTypeAny),
        ]),
      );
      return withDescription(schema, z.object(normalizedShape));
    }
    case 'array':
      return withDescription(schema, z.array(normalizeZodForCodexStrict(def.element as z.ZodTypeAny)));
    case 'record': {
      const valueType = def.valueType
        ? normalizeZodForCodexStrict(def.valueType as z.ZodTypeAny)
        : z.string();
      return withDescription(schema, z.object({}).catchall(valueType));
    }
    case 'any':
    case 'unknown':
      return withDescription(schema, z.string());
    case 'union': {
      const options = Array.isArray(def.options)
        ? def.options.map((item) => normalizeZodForCodexStrict(item as z.ZodTypeAny))
        : [];
      if (options.length === 0) return withDescription(schema, z.string());
      if (options.length === 1) return withDescription(schema, options[0]);
      return withDescription(
        schema,
        z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]),
      );
    }
    default:
      return schema;
  }
}

/**
 * Apply normalizer to a ZodRawShape (the {key: zodType, ...} object that
 * tool() factories accept directly instead of a wrapped z.object()).
 */
export function normalizeShapeForCodexStrict(shape: z.ZodRawShape): z.ZodRawShape {
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [
      key,
      normalizeZodForCodexStrict(value as z.ZodTypeAny),
    ]),
  );
}

/**
 * Schema used INSIDE `call_tool(args_json)`.
 *
 * The outer provider schema must be Codex-strict, but args_json is ordinary
 * JSON and omission is the natural representation of an optional field. Keep
 * the same recursive type normalization while accepting BOTH omission and the
 * explicit null shown by strict tool_search schemas. This is recursive on
 * purpose: workflow_create/workflow_update contain arrays of objects with many
 * optional fields, and relaxing only the root still forced the model to emit
 * dozens of meaningless nested nulls.
 */
export function normalizeZodForDeferredJson(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = (schema as unknown as { _def: { type?: string; [key: string]: unknown } })._def;

  switch (def?.type) {
    case 'optional':
      return withDescription(
        schema,
        normalizeZodForDeferredJson(def.innerType as z.ZodTypeAny).nullish(),
      );
    case 'nullable':
      return withDescription(
        schema,
        // On the args_json transport a nullable tool field is the strict-mode
        // representation of "optional"; accept omission as well as null.
        normalizeZodForDeferredJson(def.innerType as z.ZodTypeAny).nullish(),
      );
    case 'object': {
      const anySchema = schema as unknown as { shape: z.ZodRawShape | (() => z.ZodRawShape) };
      const shape = typeof anySchema.shape === 'function' ? anySchema.shape() : anySchema.shape;
      const normalizedShape = Object.fromEntries(
        Object.entries(shape as z.ZodRawShape).map(([key, value]) => [
          key,
          normalizeZodForDeferredJson(value as z.ZodTypeAny),
        ]),
      );
      return withDescription(schema, z.strictObject(normalizedShape));
    }
    case 'array':
      return withDescription(schema, z.array(normalizeZodForDeferredJson(def.element as z.ZodTypeAny)));
    case 'record': {
      // A Zod record has already constrained this to a legal JSON-object key
      // schema. Preserve that exact schema; only record VALUES need deferred
      // JSON normalization.
      const keyType = (def.keyType ?? z.string()) as Parameters<typeof z.record>[0];
      const valueType = def.valueType
        ? normalizeZodForDeferredJson(def.valueType as z.ZodTypeAny)
        : z.json();
      // Deferred JSON is not a provider-strict first-class schema, so it may
      // preserve propertyNames/pattern constraints. Dropping the record key
      // schema would widen future maps with enum/regex-constrained keys.
      return withDescription(schema, z.record(keyType, valueType));
    }
    case 'any':
    case 'unknown':
      // args_json is an ordinary JSON carrier, not a provider strict-schema
      // surface. Preserve provider-native numbers, booleans, arrays, objects,
      // and nulls here; the enclosing record/object still owns its key shape.
      return withDescription(schema, z.json());
    case 'union': {
      const options = Array.isArray(def.options)
        ? def.options.map((item) => normalizeZodForDeferredJson(item as z.ZodTypeAny))
        : [];
      if (options.length === 0) return withDescription(schema, z.string());
      if (options.length === 1) return withDescription(schema, options[0]);
      return withDescription(
        schema,
        z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]),
      );
    }
    default:
      return schema;
  }
}

export function normalizeShapeForDeferredJson(shape: z.ZodRawShape): z.ZodRawShape {
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [
      key,
      normalizeZodForDeferredJson(value as z.ZodTypeAny),
    ]),
  );
}

export function jsonSchemaAllowsNull(schemaValue: unknown): boolean {
  if (!schemaValue || typeof schemaValue !== 'object' || Array.isArray(schemaValue)) return false;
  const schema = schemaValue as {
    type?: unknown;
    nullable?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
  };
  if (schema.nullable === true || schema.type === 'null') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  for (const branch of [schema.anyOf, schema.oneOf]) {
    if (Array.isArray(branch) && branch.some(jsonSchemaAllowsNull)) return true;
  }
  return false;
}

function jsonSchemaTypeMatches(value: unknown, schemaValue: unknown): boolean {
  if (!schemaValue || typeof schemaValue !== 'object' || Array.isArray(schemaValue)) return false;
  const wrapper = schemaValue as {
    type?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
    const?: unknown;
    enum?: unknown;
    properties?: unknown;
    additionalProperties?: unknown;
  };
  if (Object.prototype.hasOwnProperty.call(wrapper, 'const') && !Object.is(value, wrapper.const)) {
    return false;
  }
  if (Array.isArray(wrapper.enum) && !wrapper.enum.some((candidate) => Object.is(value, candidate))) {
    return false;
  }
  if (wrapper.type === undefined) {
    for (const alternatives of [wrapper.anyOf, wrapper.oneOf]) {
      if (Array.isArray(alternatives)) {
        return alternatives.some((candidate) => jsonSchemaTypeMatches(value, candidate));
      }
    }
  }
  const types = Array.isArray(wrapper.type) ? wrapper.type : [wrapper.type];
  if (value === null) return types.includes('null');
  if (Array.isArray(value)) return types.includes('array');
  if (typeof value === 'object') {
    if (!(types.includes('object') || Boolean(wrapper.properties))) return false;
    const properties = wrapper.properties && typeof wrapper.properties === 'object'
      ? wrapper.properties as Record<string, unknown>
      : {};
    if (
      wrapper.additionalProperties === false
      && Object.keys(value as Record<string, unknown>).some((key) => !(key in properties))
    ) return false;
    return Object.entries(value as Record<string, unknown>).every(([key, nested]) => (
      !(key in properties) || jsonSchemaTypeMatches(nested, properties[key])
    ));
  }
  if (typeof value === 'string') return types.includes('string');
  if (typeof value === 'boolean') return types.includes('boolean');
  if (typeof value === 'number') {
    return types.includes('number') || (Number.isInteger(value) && types.includes('integer'));
  }
  return false;
}

function schemaBranchForValue(schemaValue: unknown, value: unknown): unknown {
  if (!schemaValue || typeof schemaValue !== 'object' || Array.isArray(schemaValue)) return schemaValue;
  const schema = schemaValue as { anyOf?: unknown; oneOf?: unknown };
  for (const alternatives of [schema.anyOf, schema.oneOf]) {
    if (!Array.isArray(alternatives)) continue;
    const exact = alternatives.find((candidate) => jsonSchemaTypeMatches(value, candidate));
    if (exact) return schemaBranchForValue(exact, value);
    const nonNull = alternatives.find((candidate) => !jsonSchemaAllowsNull(candidate));
    if (nonNull) return schemaBranchForValue(nonNull, value);
  }
  return schemaValue;
}

/**
 * Materialize only fields that an exact JSON Schema marks both required and
 * nullable. OpenAI strict schemas use that shape to represent an optional
 * value, while several compatible providers naturally omit the value. Adding
 * JSON null is a transport repair, not a semantic default: real required
 * non-null values remain missing and fail normal validation.
 */
/** Strings a compatible model emits to mean "no value". Exact words only. */
const OMISSION_WORDS = new Set(['null', 'None', 'undefined', 'nil']);

/** Does this schema's ARRAY branch reject an empty array (minItems >= 1)?
 * Scans anyOf/oneOf branches the way schemaBranchForValue does. */
function jsonSchemaArrayRejectsEmpty(schemaValue: unknown): boolean {
  if (!schemaValue || typeof schemaValue !== 'object' || Array.isArray(schemaValue)) return false;
  const schema = schemaValue as { type?: unknown; minItems?: unknown; anyOf?: unknown; oneOf?: unknown };
  const isArrayBranch = schema.type === 'array'
    || (Array.isArray(schema.type) && (schema.type as unknown[]).includes('array'));
  if (isArrayBranch && typeof schema.minItems === 'number' && schema.minItems >= 1) return true;
  for (const alternatives of [schema.anyOf, schema.oneOf]) {
    if (!Array.isArray(alternatives)) continue;
    if (alternatives.some((candidate) => jsonSchemaArrayRejectsEmpty(candidate))) return true;
  }
  return false;
}

export function materializeStrictNullableFields(value: unknown, schemaValue: unknown): unknown {
  const schema = schemaBranchForValue(schemaValue, value);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return value;
  const record = schema as {
    properties?: unknown;
    required?: unknown;
    items?: unknown;
  };

  if (Array.isArray(value)) {
    return value.map((item) => materializeStrictNullableFields(item, record.items));
  }
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const properties = record.properties && typeof record.properties === 'object'
    ? record.properties as Record<string, unknown>
    : {};
  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter((key): key is string => typeof key === 'string')
      : [],
  );

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in out) || out[key] === undefined) {
      if (required.has(key) && jsonSchemaAllowsNull(propertySchema)) out[key] = null;
      continue;
    }
    // Codex-strict marks optional fields required+nullable. Compatible
    // models still serialize "omitted" as "" (live 2026-08-29: tool_search
    // cursor:"" failed minLength and burned the discovery epoch). Empty is
    // the null the schema already accepts, not a value.
    if (typeof out[key] === 'string' && out[key].trim() === '' && jsonSchemaAllowsNull(propertySchema)) {
      out[key] = null;
      continue;
    }
    // The same omission spelled as a WORD. GLM 5.3 serializes an omitted
    // optional argument as the string "null" (live 2026-09-01: task_list
    // priority:"null" failed its enum and the end-of-day workflow that had run
    // for weeks died on the no-progress governor; workflow_get step:"null"
    // counted as "both section and step"; work_call source_call_ids:"null"
    // read as settled lineage and a reversible local dispatch was refused as
    // plan-bound). A key the schema does not require is simply absent; a
    // required nullable key is JSON null; a required non-nullable key keeps
    // the value so validation can name it.
    if (typeof out[key] === 'string' && OMISSION_WORDS.has(out[key].trim())) {
      if (jsonSchemaAllowsNull(propertySchema)) { out[key] = null; continue; }
      if (!required.has(key)) { delete out[key]; continue; }
    }
    // The same omission spelled as an EMPTY ARRAY. A nullable list field that
    // requires at least one item expresses "none" as null, but a model
    // naturally serializes it as []. Live 2026-09-02 (grok-4.6, the
    // platform-49 sheet cleanup): work_call source_record_ids:[] was correct
    // for a fresh read with no lineage, failed minItems, and the SDK reports
    // EVERY parser failure as "Invalid JSON input for tool" — so the model was
    // told its valid JSON was broken, re-sent the same correct call, and the
    // no-progress governor ended the turn. Coerce ONLY when [] would actually
    // fail (schema accepts null AND requires >=1 item); a list that legitimately
    // accepts [] is untouched.
    if (
      Array.isArray(out[key])
      && (out[key] as readonly unknown[]).length === 0
      && jsonSchemaAllowsNull(propertySchema)
      && jsonSchemaArrayRejectsEmpty(propertySchema)
    ) {
      out[key] = null;
      continue;
    }
    out[key] = materializeStrictNullableFields(out[key], propertySchema);
  }
  return out;
}

// Values of these keywords are maps keyed by user-authored property/schema
// names; a property literally named "anyOf" is data, not a keyword.
const ADVERTISED_SCHEMA_NAMED_MAP_KEYS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

// These keywords carry instance JSON, never nested schema nodes.
const ADVERTISED_SCHEMA_INSTANCE_VALUE_KEYS = new Set(['const', 'enum', 'default', 'examples']);

function isBareNullSchema(value: unknown): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value as object).length === 1
    && (value as { type?: unknown }).type === 'null';
}

/** `anyOf[anyOf[T,null],null]` (zod's `.nullable().optional()`) says exactly
 * what `anyOf[T,null]` says. A wrapper whose ONLY keyword is `anyOf` carries
 * no type, description or constraint of its own, so its alternatives are
 * lifted into the parent list and a duplicated bare null branch is dropped. */
function flattenAnyOfAlternatives(alternatives: readonly unknown[]): unknown[] {
  const flat: unknown[] = [];
  for (const alternative of alternatives) {
    const wrapper = alternative && typeof alternative === 'object' && !Array.isArray(alternative)
      ? alternative as Record<string, unknown>
      : null;
    if (wrapper && Object.keys(wrapper).length === 1 && Array.isArray(wrapper.anyOf)) {
      flat.push(...(wrapper.anyOf as unknown[]));
    } else {
      flat.push(alternative);
    }
  }
  let sawNull = false;
  return flat.filter((alternative) => {
    if (!isBareNullSchema(alternative)) return true;
    if (sawNull) return false;
    sawNull = true;
    return true;
  });
}

function compactAdvertisedSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactAdvertisedSchemaNode);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (ADVERTISED_SCHEMA_INSTANCE_VALUE_KEYS.has(key)) {
      out[key] = nested;
      continue;
    }
    // zod spells a bare `.int()` as the full safe-integer range; "any integer"
    // is already what `type: integer` says.
    if (
      (key === 'maximum' && nested === Number.MAX_SAFE_INTEGER)
      || (key === 'minimum' && nested === Number.MIN_SAFE_INTEGER)
    ) continue;
    if (
      ADVERTISED_SCHEMA_NAMED_MAP_KEYS.has(key)
      && nested
      && typeof nested === 'object'
      && !Array.isArray(nested)
    ) {
      out[key] = Object.fromEntries(
        Object.entries(nested as Record<string, unknown>)
          .map(([name, schema]) => [name, compactAdvertisedSchemaNode(schema)]),
      );
      continue;
    }
    if (key === 'anyOf' && Array.isArray(nested)) {
      out[key] = flattenAnyOfAlternatives(nested.map(compactAdvertisedSchemaNode));
      continue;
    }
    out[key] = compactAdvertisedSchemaNode(nested);
  }
  return out;
}

/**
 * The ADVERTISED form of a tool's JSON schema — the bytes every model step
 * carries for every tool on the surface — is a projection of the parser, not
 * the parser itself: the registered zod schema still validates every call.
 * Two converter artifacts ride along without telling the model anything and
 * are removed here, once, for every surface:
 *   - the root `$schema` draft URI (meaningless inside a tool definition);
 *   - `anyOf[anyOf[T,null],null]`, zod's spelling of `.nullable().optional()`,
 *     which is exactly `anyOf[T,null]`;
 *   - the safe-integer `minimum`/`maximum` sentinels zod adds to a bare `.int()`.
 * Nothing the schema accepts or rejects changes; only its byte count does.
 */
export function compactAdvertisedJsonSchema(schemaValue: unknown): unknown {
  const compacted = compactAdvertisedSchemaNode(schemaValue);
  if (!compacted || typeof compacted !== 'object' || Array.isArray(compacted)) return compacted;
  const { $schema: _draft, ...rest } = compacted as Record<string, unknown>;
  return rest;
}

/**
 * Present a truthful, compact schema on the deferred args_json transport.
 * Codex-strict JSON Schema marks optional fields as required+nullable; through
 * call_tool those fields may be omitted. Remove only nullable keys from every
 * nested `required` list while preserving all real required fields and types.
 */
export function relaxJsonSchemaForDeferred(schemaValue: unknown): unknown {
  if (Array.isArray(schemaValue)) return schemaValue.map(relaxJsonSchemaForDeferred);
  if (!schemaValue || typeof schemaValue !== 'object') return schemaValue;
  const source = schemaValue as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = relaxJsonSchemaForDeferred(value);
  }
  if (Array.isArray(source.required) && source.properties && typeof source.properties === 'object') {
    const properties = source.properties as Record<string, unknown>;
    const required = source.required.filter(
      (key): key is string => typeof key === 'string' && !jsonSchemaAllowsNull(properties[key]),
    );
    if (required.length > 0) out.required = required;
    else delete out.required;
  }
  return out;
}
