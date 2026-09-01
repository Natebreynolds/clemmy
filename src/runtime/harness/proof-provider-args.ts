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
      const { required, properties } = schemaShape(schema);
      if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
      // Exact passthrough is deliberately stricter than ordinary provider
      // validation: every key, including nested keys, must be named by the
      // selected schema. Open/extension shapes take the semantic fallback.
      return Object.entries(value).every(([key, child]) => (
        Object.prototype.hasOwnProperty.call(properties, key)
        && providerReadyValueMatchesSchema(child, properties[key])
      ));
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
    };

/**
 * Validate an object that explicitly claims to be provider-ready arguments.
 * The bounded diagnostics intentionally expose only the selected schema's
 * top-level field names. They are enough for an in-turn model repair without
 * copying descriptions, examples, values, account data, or an unbounded
 * provider schema into a tool result.
 */
export function validateProofProviderArguments(input: {
  schema: Record<string, unknown>;
  payload: unknown;
}): ProofProviderArgumentValidation {
  const exact = exactProviderReadyArgs(input.schema, input.payload);
  if (exact) return { ok: true, args: exact };

  const { required, properties } = schemaShape(input.schema);
  const allAllowed = Object.keys(properties);
  const payload = isRecord(input.payload) ? input.payload : {};
  const missingRequiredFields = required.filter((key) => (
    !Object.prototype.hasOwnProperty.call(payload, key)
  ));
  const unknownFields = Object.keys(payload).filter((key) => (
    !Object.prototype.hasOwnProperty.call(properties, key)
  ));
  const invalidFields = Object.entries(payload)
    .filter(([key, value]) => (
      Object.prototype.hasOwnProperty.call(properties, key)
      && !providerReadyValueMatchesSchema(value, properties[key])
    ))
    .map(([key]) => key);
  const fieldsTruncated = [required, allAllowed, missingRequiredFields, unknownFields, invalidFields]
    .some((fields) => fields.length > MAX_REPAIR_FIELDS);
  return {
    ok: false,
    requiredFields: required.slice(0, MAX_REPAIR_FIELDS),
    allowedFields: allAllowed.slice(0, MAX_REPAIR_FIELDS),
    missingRequiredFields: missingRequiredFields.slice(0, MAX_REPAIR_FIELDS),
    unknownFields: unknownFields.slice(0, MAX_REPAIR_FIELDS),
    invalidFields: invalidFields.slice(0, MAX_REPAIR_FIELDS),
    fieldsTruncated,
  };
}

export type ProofProviderForegroundPayloadValidation =
  | { ok: true }
  | { ok: false; repair: string; schemaAvailable: true };

export type ProofProviderForegroundPayloadValidator = (
  payload: unknown,
) => ProofProviderForegroundPayloadValidation;

function boundedRepairFieldList(fields: readonly string[]): string {
  if (fields.length === 0) return '(none)';
  return fields.map((field) => JSON.stringify(field.slice(0, 80))).join(', ');
}

/**
 * Build a denial-only foreground validator over an isolated snapshot of one
 * exact provider schema. The caller remains responsible for proving that the
 * schema digest belongs to its manifest; this helper never selects an
 * operation, account, effect, or capability.
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
  return (payload) => {
    const validation = validateProofProviderArguments({ schema, payload });
    if (validation.ok) return { ok: true };
    const details = [
      `[provider-dispatch:not-started:invalid-args] ${operationId} arguments did not match its exact current schema.`,
      `Required top-level fields: ${boundedRepairFieldList(validation.requiredFields)}.`,
      `Allowed top-level fields: ${boundedRepairFieldList(validation.allowedFields)}.`,
      ...(validation.missingRequiredFields.length > 0
        ? [`Missing required fields: ${boundedRepairFieldList(validation.missingRequiredFields)}.`]
        : []),
      ...(validation.unknownFields.length > 0
        ? [`Remove unknown fields: ${boundedRepairFieldList(validation.unknownFields)}.`]
        : []),
      ...(validation.invalidFields.length > 0
        ? [`Fields with invalid value shapes: ${boundedRepairFieldList(validation.invalidFields)}.`]
        : []),
      ...(validation.fieldsTruncated
        ? ['The displayed field list was bounded; inspect the complete selected schema with the first-class local tool_search control.']
        : []),
      `If any value or nested object shape is unclear, call the first-class local tool_search control directly with query ${JSON.stringify(operationId)}; do not put a local control name inside a provider execution carrier and do not substitute another operation.`,
      'Then retry with one JSON object using the allowed field names. No provider request was sent.',
    ].join(' ');
    return { ok: false, repair: details.slice(0, 2_000), schemaAvailable: true };
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
