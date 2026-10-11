/**
 * An input schema as the model needs it to make a valid call: every top-level
 * field with its type, whether it is required, and its limits, in a few words
 * each. A raw JSON schema clipped to a budget can lose whole fields and their
 * limits behind one long description (live 2026-10-10: a search schema's page
 * size, maximum 25, sat 3,959 characters in, past an 1,800-character clip, so
 * the model asked for 50 and was refused).
 */

/** A field's limits, as short as a person would say them ("1 to 25", "one
 *  of: a, b"), so a call can stay inside them the first time. */
export function contractFieldLimits(spec: Record<string, unknown> | undefined): string {
  if (!spec) return '';
  const number = (key: string) => (typeof spec[key] === 'number' && Number.isFinite(spec[key]) ? spec[key] as number : undefined);
  if (Array.isArray(spec.enum) && spec.enum.length > 0) {
    const shown = spec.enum.slice(0, 8).map((value) => JSON.stringify(value)).join(', ');
    return `one of: ${shown}${spec.enum.length > 8 ? ', …' : ''}`;
  }
  const minimum = number('minimum');
  const maximum = number('maximum');
  if (minimum !== undefined && maximum !== undefined) return `${minimum} to ${maximum}`;
  if (maximum !== undefined) return `at most ${maximum}`;
  if (minimum !== undefined) return `at least ${minimum}`;
  const maxLength = number('maxLength');
  if (maxLength !== undefined) return `up to ${maxLength} characters`;
  const maxItems = number('maxItems');
  if (maxItems !== undefined) return `up to ${maxItems} items`;
  return '';
}

function typeWords(spec: Record<string, unknown>): string {
  const type = Array.isArray(spec.type)
    ? spec.type.filter((entry) => entry !== 'null').join(' or ')
    : typeof spec.type === 'string' ? spec.type : '';
  const keysOf = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).properties && typeof (value as Record<string, unknown>).properties === 'object'
    ? Object.keys((value as { properties: Record<string, unknown> }).properties).slice(0, 8) : []);
  if (type === 'array') {
    const itemKeys = keysOf(spec.items);
    const itemType = spec.items && typeof spec.items === 'object' ? (spec.items as Record<string, unknown>).type : undefined;
    return itemKeys.length > 0 ? `array of {${itemKeys.join(', ')}}` : typeof itemType === 'string' ? `array of ${itemType}` : 'array';
  }
  if (type === 'object') {
    const keys = keysOf(spec);
    return keys.length > 0 ? `object {${keys.join(', ')}}` : 'object';
  }
  return type || 'any';
}

/** The first sentence of a description, at most `max` characters. */
function shortDescription(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/**
 * One line per top-level field: `name*: type (limits; default x) — what it is`.
 * No field is cut to fit a budget; only descriptions are shortened. Returns
 * [] for a schema with no properties.
 */
export function compactContractLines(
  schema: unknown,
  opts: { maxFields?: number; descriptionChars?: number } = {},
): string[] {
  const shape = schema && typeof schema === 'object' ? schema as Record<string, unknown> : null;
  const properties = shape?.properties && typeof shape.properties === 'object'
    ? shape.properties as Record<string, Record<string, unknown>>
    : null;
  if (!properties) return [];
  const required = new Set(Array.isArray(shape?.required) ? shape.required as string[] : []);
  const entries = Object.entries(properties);
  const maxFields = opts.maxFields ?? 40;
  const lines = entries.slice(0, maxFields).map(([name, spec]) => {
    const field = spec && typeof spec === 'object' ? spec : {};
    const qualifiers = [contractFieldLimits(field),
      field.default !== undefined && field.default !== null ? `default ${JSON.stringify(field.default)}` : '']
      .filter(Boolean).join('; ');
    const description = shortDescription(field.description, opts.descriptionChars ?? 80);
    return `${name}${required.has(name) ? '*' : ''}: ${typeWords(field)}${qualifiers ? ` (${qualifiers})` : ''}${description ? ` — ${description}` : ''}`;
  });
  if (entries.length > maxFields) lines.push(`… ${entries.length - maxFields} more fields; tool_search with the exact name returns the whole schema`);
  return lines;
}
