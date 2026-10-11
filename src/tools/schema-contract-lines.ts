/**
 * An input schema as the model needs it to make a valid call: every field
 * with its type (including null), whether it is required, and its limits, in
 * a few words each, nested fields included. A raw JSON schema clipped to a
 * budget can lose whole fields and their limits behind one long description
 * (live 2026-10-10: a search schema's page size, maximum 25, sat 3,959
 * characters in, past an 1,800-character clip, so the model asked for 50 and
 * was refused).
 *
 * The summary says whether it is complete. Structure it cannot state in a
 * line (combinators, references, pattern or dependent rules, nesting deeper
 * than it renders, fields beyond its count) makes it incomplete, and the
 * caller must then hand over the full schema or send the model to fetch it,
 * never present the summary as the whole contract.
 */

/** A field's limits, as short as a person would say them ("1 to 25", "one
 *  of: a, b", "format date-time"), so a call can stay inside them the first
 *  time. Several limits join with "; ". */
export function contractFieldLimits(spec: Record<string, unknown> | undefined): string {
  if (!spec) return '';
  const number = (key: string) => (typeof spec[key] === 'number' && Number.isFinite(spec[key]) ? spec[key] as number : undefined);
  const range = (low: number | undefined, high: number | undefined, unit: string) => (
    low !== undefined && high !== undefined ? (low === high ? `exactly ${low}${unit}` : `${low} to ${high}${unit}`)
      : high !== undefined ? (unit ? `up to ${high}${unit}` : `at most ${high}`)
        : low !== undefined ? `at least ${low}${unit}` : '');
  const parts: string[] = [];
  if (spec.const !== undefined) parts.push(`always ${JSON.stringify(spec.const)}`);
  if (Array.isArray(spec.enum) && spec.enum.length > 0) {
    const shown = spec.enum.slice(0, 8).map((value) => JSON.stringify(value)).join(', ');
    parts.push(`one of: ${shown}${spec.enum.length > 8 ? ', …' : ''}`);
  }
  parts.push(range(number('minimum'), number('maximum'), ''));
  if (number('exclusiveMinimum') !== undefined) parts.push(`above ${number('exclusiveMinimum')}`);
  if (number('exclusiveMaximum') !== undefined) parts.push(`below ${number('exclusiveMaximum')}`);
  if (number('multipleOf') !== undefined) parts.push(`a multiple of ${number('multipleOf')}`);
  parts.push(range(number('minLength'), number('maxLength'), ' characters'));
  parts.push(range(number('minItems'), number('maxItems'), ' items'));
  if (spec.uniqueItems === true) parts.push('no repeats');
  if (typeof spec.format === 'string') parts.push(`format ${spec.format}`);
  if (typeof spec.pattern === 'string') parts.push(`matching /${spec.pattern}/`);
  return parts.filter(Boolean).join('; ');
}

/** Keywords whose meaning a one-line field summary cannot carry. */
const STRUCTURAL_KEYWORDS = ['$ref', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'patternProperties',
  'dependentSchemas', 'dependentRequired', 'dependencies', 'propertyNames', 'prefixItems', 'contains',
  'minProperties', 'maxProperties'] as const;

const MAX_DEPTH = 2;

type Spec = Record<string, unknown>;

const asSpec = (value: unknown): Spec => (value && typeof value === 'object' && !Array.isArray(value) ? value as Spec : {});

function propertiesOf(spec: Spec): Record<string, Spec> | null {
  return spec.properties && typeof spec.properties === 'object' && !Array.isArray(spec.properties)
    ? spec.properties as Record<string, Spec> : null;
}

function typeList(spec: Spec): string[] {
  if (Array.isArray(spec.type)) return spec.type.filter((entry): entry is string => typeof entry === 'string');
  return typeof spec.type === 'string' ? [spec.type] : [];
}

/** The first sentence of a description, at most `max` characters. */
function shortDescription(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

interface Walk {
  lines: string[];
  complete: boolean;
  count: number;
}

function walkFields(properties: Record<string, Spec>, required: Set<string>, indent: string, depth: number,
  walk: Walk, opts: { maxFields: number; descriptionChars: number }): void {
  for (const [name, raw] of Object.entries(properties)) {
    if (walk.count >= opts.maxFields) { walk.complete = false; return; }
    walk.count += 1;
    const field = asSpec(raw);
    if (STRUCTURAL_KEYWORDS.some((key) => field[key] !== undefined)) walk.complete = false;
    const types = typeList(field);
    const nullable = types.includes('null') || field.nullable === true;
    const base = types.filter((type) => type !== 'null');
    const items = asSpec(field.items);
    if (base.includes('array') && STRUCTURAL_KEYWORDS.some((key) => items[key] !== undefined)) walk.complete = false;
    const nestedObject = base.includes('object') ? propertiesOf(field) : null;
    const nestedItems = base.includes('array') ? propertiesOf(items) : null;
    const itemTypes = typeList(items).filter((type) => type !== 'null');
    const typeText = base.includes('array')
      ? nestedItems ? 'array of objects' : itemTypes.length ? `array of ${itemTypes.join(' or ')}` : 'array'
      : base.length ? base.join(' or ') : 'any';
    const qualifiers = [contractFieldLimits(field),
      field.default !== undefined && field.default !== null ? `default ${JSON.stringify(field.default)}` : '']
      .filter(Boolean).join('; ');
    const description = shortDescription(field.description, opts.descriptionChars);
    walk.lines.push(`${indent}${name}${required.has(name) ? '*' : ''}: ${typeText}${nullable ? ' or null' : ''}`
      + `${qualifiers ? ` (${qualifiers})` : ''}${description ? ` — ${description}` : ''}`);
    const nested = nestedObject ?? nestedItems;
    if (nested) {
      if (depth >= MAX_DEPTH) { walk.complete = false; continue; }
      const nestedSpec = nestedObject ? field : items;
      const nestedRequired = new Set(Array.isArray(nestedSpec.required) ? nestedSpec.required as string[] : []);
      walkFields(nested, nestedRequired, `${indent}  `, depth + 1, walk, opts);
    } else if ((base.includes('object') && field.additionalProperties !== undefined && field.additionalProperties !== true)
      || (base.includes('array') && itemTypes.includes('object'))) {
      // An object whose shape is declared some other way than its properties.
      walk.complete = false;
    }
  }
}

/**
 * One line per field, nested fields indented under their parent:
 * `name*: type or null (limits; default x) — what it is`. No field is cut to
 * fit; only descriptions are shortened. `complete` is false when the schema
 * holds structure these lines cannot state.
 */
export function compactContract(
  schema: unknown,
  opts: { maxFields?: number; descriptionChars?: number } = {},
): { lines: string[]; complete: boolean } {
  const root = asSpec(schema);
  const properties = propertiesOf(root);
  if (!properties) return { lines: [], complete: false };
  const walk: Walk = { lines: [], complete: !STRUCTURAL_KEYWORDS.some((key) => root[key] !== undefined), count: 0 };
  const required = new Set(Array.isArray(root.required) ? root.required as string[] : []);
  walkFields(properties, required, '', 1, walk, { maxFields: opts.maxFields ?? 40, descriptionChars: opts.descriptionChars ?? 80 });
  return { lines: walk.lines, complete: walk.complete };
}
