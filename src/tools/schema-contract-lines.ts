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
 * line (combinators other than an optional value or a plain type union,
 * references, pattern or dependent rules, nesting deeper than it renders,
 * fields beyond its count, a free-form value whose description is too long
 * to keep whole) makes it incomplete, and the
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
  'unevaluatedProperties', 'unevaluatedItems'] as const;

const MAX_DEPTH = 2;

type Spec = Record<string, unknown>;

const asSpec = (value: unknown): Spec => (value && typeof value === 'object' && !Array.isArray(value) ? value as Spec : {});
const hasStructure = (spec: Spec) => STRUCTURAL_KEYWORDS.some((key) => spec[key] !== undefined);

const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples']);
const PRIMITIVES = new Set(['string', 'integer', 'number', 'boolean', 'null']);
const plainType = (branch: Spec) => typeof branch.type === 'string' && PRIMITIVES.has(branch.type)
  && Object.keys(branch).every((key) => key === 'type' || ANNOTATIONS.has(key));

/**
 * A union a line can state without loss: `anyOf: [T, null]` (or oneOf) is T
 * that may be null, and `anyOf` of bare primitive types is "string or
 * integer". Any other union is left as is, which keeps the summary
 * incomplete.
 */
function normalized(spec: Spec): Spec {
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(spec[key]) || (spec[key] as unknown[]).length === 0) continue;
    const branches = (spec[key] as unknown[]).map(asSpec);
    const others = branches.filter((branch) => !(branch.type === 'null' && plainType(branch)));
    const nullable = others.length < branches.length;
    const { [key]: _union, ...rest } = spec;
    if (STRUCTURAL_KEYWORDS.some((other) => rest[other] !== undefined)) return spec;
    if (others.length === 1) {
      const [only] = others;
      // The outer schema may only annotate; a second set of limits would need both.
      if (Object.keys(rest).some((field) => !ANNOTATIONS.has(field) && field !== 'nullable' && only[field] !== undefined)) return spec;
      return normalized({ ...only, ...rest, ...(nullable || rest.nullable === true ? { nullable: true } : {}) });
    }
    if (key === 'anyOf' && others.every(plainType) && rest.type === undefined) {
      return { ...rest, type: [...new Set(others.map((branch) => branch.type as string)), ...(nullable ? ['null'] : [])] };
    }
    return spec;
  }
  return spec;
}

function propertiesOf(spec: Spec): Record<string, Spec> | null {
  return spec.properties && typeof spec.properties === 'object' && !Array.isArray(spec.properties)
    ? spec.properties as Record<string, Spec> : null;
}

/** Declared types without null; inferred from `items` or `properties` when a
 *  schema leaves `type` out. */
function baseTypes(spec: Spec): string[] {
  const declared = Array.isArray(spec.type)
    ? spec.type.filter((entry): entry is string => typeof entry === 'string')
    : typeof spec.type === 'string' ? [spec.type] : [];
  const base = declared.filter((type) => type !== 'null');
  if (base.length > 0) return base;
  if (spec.items !== undefined) return ['array'];
  if (propertiesOf(spec) || spec.additionalProperties !== undefined) return ['object'];
  return [];
}

function isNullable(spec: Spec): boolean {
  return (Array.isArray(spec.type) && spec.type.includes('null')) || spec.nullable === true
    || (Array.isArray(spec.enum) && spec.enum.includes(null));
}

/** The first sentence of a description, at most `max` characters. */
function shortDescription(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** Where the schema leaves a value open, its description is the contract:
 *  kept whole up to FREE_FORM_DESCRIPTION_CHARS, else the summary is
 *  incomplete. */
const FREE_FORM_DESCRIPTION_CHARS = 400;
function wholeDescription(value: unknown, walk: Walk): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= FREE_FORM_DESCRIPTION_CHARS) return flat;
  walk.complete = false;
  return `${flat.slice(0, FREE_FORM_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

/** Object-level rules a line can state: no other fields, field counts. */
function objectRules(spec: Spec, hasFields: boolean): string[] {
  const rules: string[] = [];
  if (spec.additionalProperties === false) rules.push(hasFields ? 'no other fields' : 'must be empty');
  const number = (key: string) => (typeof spec[key] === 'number' ? spec[key] as number : undefined);
  if (number('minProperties') !== undefined) rules.push(`at least ${number('minProperties')} fields`);
  if (number('maxProperties') !== undefined) rules.push(`at most ${number('maxProperties')} fields`);
  return rules;
}

interface Walk {
  lines: string[];
  complete: boolean;
  count: number;
}

/** A value in words ("array of string", "object"), its limits and the rules
 *  each element or entry must meet, and the object whose fields go on the
 *  lines under it. */
interface Value {
  words: string;
  limits: string[];
  nested: Spec | null;
  /** The schema leaves this value's shape open; its description carries it. */
  freeForm?: boolean;
}

/** "each [one of: "a", "b"; up to 20 characters]" for an element's limits. */
const bracket = (label: string, limits: string[]) => (limits.length ? `${label} [${limits.join('; ')}]` : '');

/**
 * What a value must be. Marks the walk incomplete for any shape a line cannot
 * state; `layers` bounds arrays of arrays and map values.
 */
function describeValue(raw: Spec, walk: Walk, layers = 0): Value {
  const spec = normalized(raw);
  if (hasStructure(spec)) walk.complete = false;
  const base = baseTypes(spec);
  const limits = [contractFieldLimits(spec)].filter(Boolean);
  if (layers > 3) { walk.complete = false; return { words: base.join(' or ') || 'any', limits, nested: null }; }
  if (base.includes('array')) {
    const items = asSpec(spec.items);
    if (spec.items === undefined || Object.keys(items).length === 0) return { words: 'array', limits, nested: null, freeForm: true };
    const item = describeValue(items, walk, layers + 1);
    const each = [...item.limits, ...(isNullable(normalized(items)) ? ['may be null'] : [])];
    const withEach = [...limits, bracket('each', each)].filter(Boolean);
    if (item.words === 'object') return { words: 'array of objects', limits: withEach, nested: item.nested, freeForm: item.freeForm };
    // Objects inside an array of arrays: their fields are not rendered.
    if (item.nested) walk.complete = false;
    return { words: `array of ${item.words}`, limits: withEach, nested: null, freeForm: item.freeForm };
  }
  if (base.includes('object')) {
    const fields = propertiesOf(spec);
    const rules = objectRules(spec, Boolean(fields));
    const extra = spec.additionalProperties;
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      // Keys beyond the declared fields, each holding a value of this shape.
      const value = describeValue(asSpec(extra), walk, layers + 1);
      if (value.nested) walk.complete = false;
      const valueWords = `each value ${value.words}${value.limits.length ? ` [${value.limits.join('; ')}]` : ''}`;
      rules.unshift(fields ? `other keys allowed, ${valueWords}` : `any keys, ${valueWords}`);
    } else if (!fields && extra !== false) {
      // Free-form: the schema itself allows any keys; what goes in them is
      // only in the description, which the caller then keeps in full.
      return { words: 'object', limits: [...limits, 'any keys', ...rules], nested: null, freeForm: true };
    }
    return { words: 'object', limits: [...limits, ...rules], nested: fields ? spec : null };
  }
  return { words: base.length ? base.join(' or ') : 'any', limits, nested: null, ...(base.length ? {} : { freeForm: true }) };
}

function walkFields(properties: Record<string, Spec>, required: Set<string>, indent: string, depth: number,
  walk: Walk, opts: { maxFields: number; descriptionChars: number }): void {
  for (const [name, raw] of Object.entries(properties)) {
    if (walk.count >= opts.maxFields) { walk.complete = false; return; }
    walk.count += 1;
    const field = normalized(asSpec(raw));
    const { words, limits, nested, freeForm } = describeValue(field, walk);
    const qualifiers = [...limits,
      field.default !== undefined && field.default !== null ? `default ${JSON.stringify(field.default)}` : '']
      .filter(Boolean).join('; ');
    const description = freeForm ? wholeDescription(field.description, walk) : shortDescription(field.description, opts.descriptionChars);
    walk.lines.push(`${indent}${name}${required.has(name) ? '*' : ''}: ${words}${isNullable(field) ? ' or null' : ''}`
      + `${qualifiers ? ` (${qualifiers})` : ''}${description ? ` — ${description}` : ''}`);
    if (nested) {
      if (depth >= MAX_DEPTH) { walk.complete = false; continue; }
      const nestedRequired = new Set(Array.isArray(nested.required) ? nested.required as string[] : []);
      walkFields(propertiesOf(nested)!, nestedRequired, `${indent}  `, depth + 1, walk, opts);
    }
  }
}

/**
 * One line per field, nested fields indented under their parent:
 * `name*: type or null (limits; default x) — what it is`, with what each
 * array element or map value must be and the object's own rules ("no other
 * fields"). No field is cut to fit; only descriptions are shortened.
 * `complete` is false when the schema holds structure these lines cannot
 * state.
 */
export function compactContract(
  schema: unknown,
  opts: { maxFields?: number; descriptionChars?: number } = {},
): { lines: string[]; complete: boolean } {
  const root = asSpec(schema);
  const properties = propertiesOf(root);
  if (!properties) return { lines: [], complete: false };
  const walk: Walk = { lines: [], complete: !hasStructure(root), count: 0 };
  const required = new Set(Array.isArray(root.required) ? root.required as string[] : []);
  walkFields(properties, required, '', 1, walk, { maxFields: opts.maxFields ?? 40, descriptionChars: opts.descriptionChars ?? 80 });
  // The top level's own rules ("no other fields") on a closing line.
  const top = describeValue({ ...root, properties: {} }, walk);
  const rules = top.limits;
  if (rules.length > 0) walk.lines.push(`(top level: ${rules.join('; ')})`);
  return { lines: walk.lines, complete: walk.complete };
}
