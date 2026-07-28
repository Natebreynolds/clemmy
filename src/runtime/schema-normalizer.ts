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
      const valueType = def.valueType
        ? normalizeZodForDeferredJson(def.valueType as z.ZodTypeAny)
        : z.string();
      return withDescription(schema, z.object({}).catchall(valueType));
    }
    case 'any':
    case 'unknown':
      return withDescription(schema, z.string());
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

function jsonSchemaAllowsNull(schemaValue: unknown): boolean {
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
