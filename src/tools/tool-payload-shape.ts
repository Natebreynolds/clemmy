/**
 * The host completes a shape-wrong exact payload from the tool's own declared
 * schema before that payload is shown on a card.
 *
 * Live 2026-10-07: the brain queued `run_shell_command` with {command,
 * timeout_ms}; the card showed the command; the owner said yes; the stored
 * call was refused before dispatch ("cwd: expected string, received
 * undefined") and the turn ended failed with text addressed to the model.
 * Nothing the owner approved could ever have run. A card promises exactly
 * what will run, so the queued payload must fit the tool it names at queue
 * time: a required field the schema lets be null is completed as null (the
 * tool's own "omit it" value); anything else the schema refuses is named back
 * to the brain, which queues once more with the repair, before any card.
 *
 * Only the tool's declared JSON schema is read — no tool names, no field
 * names, no operation knowledge live here.
 */

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaTypes(property: unknown): string[] {
  if (!isRecord(property)) return [];
  const types: string[] = [];
  const own = property.type;
  if (typeof own === 'string') types.push(own);
  else if (Array.isArray(own)) for (const t of own) if (typeof t === 'string') types.push(t);
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = property[key];
    if (Array.isArray(branches)) for (const branch of branches) types.push(...schemaTypes(branch));
  }
  if (property.nullable === true) types.push('null');
  return types;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeFits(declared: string[], value: unknown): boolean {
  if (declared.length === 0) return true;
  const actual = valueType(value);
  if (declared.includes(actual)) return true;
  if (actual === 'integer' && declared.includes('number')) return true;
  return false;
}

export interface PayloadShapeResult {
  /** The payload with every required-but-nullable field the caller omitted completed as null. */
  payload: Record<string, unknown>;
  /** Fields the schema still refuses, each as `path: reason`; empty when the payload fits. */
  issues: string[];
  /** Fields the host completed as null. */
  completed: string[];
}

/** Complete and check an exact payload against a tool's declared object
 * schema (the SDK's strict JSON schema: every property required, nullable
 * ones as anyOf with null). A schema that declares no properties constrains
 * nothing. Nested shapes stay the dispatch-time validator's job. */
export function completePayloadForToolSchema(schema: unknown, payload: Record<string, unknown>): PayloadShapeResult {
  const completed: string[] = [];
  const issues: string[] = [];
  if (!isRecord(schema) || !isRecord(schema.properties)) return { payload, issues, completed };
  const properties = schema.properties as Record<string, unknown>;
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((key): key is string => typeof key === 'string')
    : [];
  const next: Record<string, unknown> = { ...payload };
  for (const key of required) {
    if (key in next && next[key] !== undefined) continue;
    const declared = schemaTypes(properties[key]);
    if (declared.includes('null')) {
      next[key] = null;
      completed.push(key);
    } else {
      issues.push(`${key}: required`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(next)) {
      if (!(key in properties)) issues.push(`${key}: not a field of this tool`);
    }
  }
  for (const [key, value] of Object.entries(next)) {
    if (!(key in properties) || value === undefined) continue;
    const declared = schemaTypes(properties[key]);
    if (!typeFits(declared, value)) {
      issues.push(`${key}: expected ${declared.filter((t) => t !== 'null').join(' or ') || 'another type'}, received ${valueType(value)}`);
    }
  }
  return { payload: next, issues, completed };
}

/** The sentence the queue tool returns instead of a card when the payload
 * cannot fit the tool it names. Names the repair, not a guess. */
export function payloadShapeRefusal(toolName: string, issues: string[]): string {
  return `pending_action_queue refused: the exact payload does not fit ${toolName}'s schema — ${issues.join('; ')}. `
    + `Call tool_search with the exact query "${toolName}" for its full input schema, then queue once with the corrected payload. Nothing was queued.`;
}
