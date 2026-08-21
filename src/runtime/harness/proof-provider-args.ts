/**
 * Schema-grounded provider-argument compiler for proof-provisioned operations.
 *
 * Leaf module (no catalog/runtime imports) so the graph compiler's host-bind
 * pass can consult it without closing an import cycle. The model's args never
 * cross this boundary: values come from the immutable envelope (goal,
 * cardinality, predecessor values) and are placed into the slug's OWN required
 * fields — the exact inversion of the live failure where the model remembered
 * `query` for a schema that requires `q`.
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

/**
 * Schema-grounded argument compiler for a proof-provisioned operation. The
 * model's args never cross this boundary: values come from the immutable
 * envelope (goal, cardinality, predecessor values) and are placed into the
 * slug's OWN required fields — the exact inversion of the live failure where
 * the model remembered `query` for a schema that requires `q`.
 */
export function compileProofProviderArgs(input: {
  schema: Record<string, unknown>;
  role: string;
  effect: 'read' | 'external_write';
  payload: unknown;
  envelope?: GraphNodeInvocationEnvelopeV1;
}): Record<string, unknown> | null {
  const { required, properties } = schemaShape(input.schema);
  const args: Record<string, unknown> = {};
  const predecessorValues = (input.envelope?.predecessors ?? [])
    .map((prior) => prior.value)
    .filter((value): value is Record<string, unknown> | unknown[] => value !== undefined && value !== null);

  if (input.effect === 'read') {
    const requiredStrings = required.filter((key) => propertyType(properties[key]) === 'string');
    if (requiredStrings.length > 1) return null;
    if (requiredStrings.length === 1) {
      const key = requiredStrings[0]!;
      // Readback-style reads take a created-resource id from a predecessor;
      // every other read carries the goal's query text.
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
      if (!value) return null;
      args[key] = value;
    }
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
  const titleKey = ['title', 'name', 'sheet_name'].find((key) => key in properties && propertyType(properties[key]) === 'string');
  if (titleKey && input.envelope?.goal.objective) {
    args[titleKey] = input.envelope.goal.objective.slice(0, 120);
  }
  // Remaining REQUIRED string members are host-owned presentation choices
  // (e.g. GOOGLESHEETS_SHEET_FROM_JSON requires title AND sheet_name — the
  // tab label). Fill them deterministically; any other unmet required type
  // still refuses (never guess business data).
  for (const key of required) {
    if (key in args) continue;
    if (propertyType(properties[key]) !== 'string') continue;
    args[key] = /(^|_)(sheet_)?name$/i.test(key)
      ? 'Data'
      : (input.envelope?.goal.objective?.slice(0, 120) ?? 'Data');
  }
  const unmet = required.filter((key) => !(key in args));
  return unmet.length === 0 ? args : null;
}

