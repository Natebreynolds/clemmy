/**
 * Computed figures over retained records: conditions, ordering and aggregates.
 *
 * A count, total, average or ranking read off rows by eye drifts: a model
 * skims a long list and states a figure the data does not hold. These pure
 * functions compute the figure instead, over every record, so an answer can
 * quote what the data says. Values compare as numbers when both sides are
 * numbers, as dates when both are ISO dates, and otherwise as trimmed,
 * case-insensitive text; a record whose value cannot be compared that way
 * does not match, and the caller is told how many were skipped.
 * Arithmetic uses JavaScript Numbers without additional decimal rounding;
 * results retain the precision and limits of floating-point arithmetic.
 */

export type RecordQueryOp = 'eq' | 'ne' | 'contains' | 'lt' | 'lte' | 'gt' | 'gte';

export interface RecordCondition {
  field: string;
  op: RecordQueryOp;
  value: string | number;
}

export type RecordAggregateOp = 'count' | 'sum' | 'avg' | 'min' | 'max';

type Comparable =
  | { kind: 'number'; n: number }
  | { kind: 'date'; text: string }
  | { kind: 'instant'; n: number }
  | { kind: 'text'; text: string };

// Unlike kinds have no shared numeric/date meaning. Keep each kind together
// instead of treating an incompatible pair as an input-order tie, which makes
// the comparator non-transitive and can leave numeric rankings out of order.
const SORT_KIND_ORDER: Record<Comparable['kind'], number> = { number: 0, date: 1, instant: 2, text: 3 };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;
const GROUPED_NUMBER = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/** A field's steps. Dots separate keys; `[*]`, `[]` and `[n]` after a key are
 *  the same steps as `.*` and `.n`. */
function fieldSteps(field: string): string[] {
  return field.replace(/\[(\*|\d*)\]/g, (_whole, inner: string) => `.${inner || '*'}`).replace(/^\./, '').split('.');
}

/** The value at a field, following a dotted path into nested objects. A step
 *  that meets a list reads it from every item (`*`, or any key) or from one
 *  item (its index), so text inside nested lists is reachable; what several
 *  items hold comes back as one flat list. */
export function fieldValue(record: unknown, field: string): unknown {
  return valueAtSteps(record, fieldSteps(field));
}

function valueAtSteps(current: unknown, steps: readonly string[]): unknown {
  if (steps.length === 0) return current;
  const [step, ...rest] = steps as [string, ...string[]];
  if (Array.isArray(current)) {
    if (/^\d+$/.test(step)) return valueAtSteps(current[Number(step)], rest);
    const each = step === '*' ? rest : steps;
    const found = current.flatMap((item) => {
      const value = valueAtSteps(item, each);
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    });
    return found.length > 0 ? found : undefined;
  }
  // `*` steps through a list only; it never widens to every key of a record.
  if (!current || typeof current !== 'object' || step === '*') return undefined;
  return valueAtSteps((current as Record<string, unknown>)[step], rest);
}

function comparable(value: unknown): Comparable | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'number', n: value } : null;
  if (typeof value === 'boolean') return { kind: 'text', text: String(value) };
  if (typeof value === 'object') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (PLAIN_NUMBER.test(text)) return { kind: 'number', n: Number(text) };
  if (GROUPED_NUMBER.test(text)) return { kind: 'number', n: Number(text.replace(/,/g, '')) };
  if (DATE_ONLY.test(text)) return { kind: 'date', text };
  if (DATE_TIME.test(text)) {
    const n = Date.parse(text);
    if (Number.isFinite(n)) return { kind: 'instant', n };
  }
  return { kind: 'text', text: text.toLowerCase() };
}

/** Order two comparable values of compatible kinds; null when they are not. */
function compare(a: Comparable, b: Comparable): number | null {
  if (a.kind === 'number' && b.kind === 'number') return a.n - b.n;
  if (a.kind === 'date' && b.kind === 'date') return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  if (a.kind === 'instant' && b.kind === 'instant') return a.n - b.n;
  if (a.kind === 'text' && b.kind === 'text') return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  return null;
}

function matches(record: unknown, condition: RecordCondition): boolean | null {
  const raw = fieldValue(record, condition.field);
  // A list of values meets a condition when any item does; `ne` when none
  // equals the value.
  if (Array.isArray(raw) && raw.length > 0 && raw.every((item) => item === null || typeof item !== 'object')) {
    if (condition.op === 'ne') {
      const equal = raw.map((item) => valueMatches(item, { ...condition, op: 'eq' }));
      return equal.some((verdict) => verdict === true) ? false : true;
    }
    const verdicts = raw.map((item) => valueMatches(item, condition));
    return verdicts.some((verdict) => verdict === true) ? true : verdicts.some((verdict) => verdict === false) ? false : null;
  }
  return valueMatches(raw, condition);
}

function valueMatches(raw: unknown, condition: RecordCondition): boolean | null {
  const left = comparable(raw);
  const right = comparable(condition.value);
  if (condition.op === 'ne') {
    if (!left || !right) return left !== right;
    const order = compare(left, right);
    return order === null ? true : order !== 0;
  }
  if (!left || !right) return null;
  if (condition.op === 'contains') {
    return String(raw).toLowerCase().includes(String(condition.value).trim().toLowerCase());
  }
  const order = compare(left, right);
  if (order === null) return null;
  switch (condition.op) {
    case 'eq': return order === 0;
    case 'lt': return order < 0;
    case 'lte': return order <= 0;
    case 'gt': return order > 0;
    case 'gte': return order >= 0;
  }
  return null;
}

export interface WhereResult {
  rows: unknown[];
  /** Records left out because a condition's field held no value that compares
   *  with the condition's value (missing, empty, or a different kind). */
  skipped: number;
}

/** Records meeting every condition. */
export function applyWhere(rows: readonly unknown[], conditions: readonly RecordCondition[]): WhereResult {
  let skipped = 0;
  const kept: unknown[] = [];
  for (const row of rows) {
    let keep = true;
    let incomparable = false;
    for (const condition of conditions) {
      const verdict = matches(row, condition);
      if (verdict === null) { incomparable = true; keep = false; break; }
      if (!verdict) { keep = false; break; }
    }
    if (keep) kept.push(row);
    else if (incomparable) skipped += 1;
  }
  return { rows: kept, skipped };
}

/** Records grouped as numbers, dates, instants, then text, with the requested
 * direction applied within each kind. Missing/unusable values go last in both
 * directions; ties preserve input order. No cross-kind conversion is guessed. */
export function sortRows(rows: readonly unknown[], field: string, order: 'asc' | 'desc'): unknown[] {
  const keyed = rows.map((row, index) => ({ row, index, key: comparable(fieldValue(row, field)) }));
  keyed.sort((a, b) => {
    if (!a.key && !b.key) return a.index - b.index;
    if (!a.key) return 1;
    if (!b.key) return -1;
    const kindOrder = SORT_KIND_ORDER[a.key.kind] - SORT_KIND_ORDER[b.key.kind];
    if (kindOrder !== 0) return kindOrder;
    const result = compare(a.key, b.key);
    if (result === null || result === 0) return a.index - b.index;
    return order === 'asc' ? result : -result;
  });
  return keyed.map((entry) => entry.row);
}

export interface AggregateFigure {
  /** Unrounded JavaScript Number result, or null when no numeric values exist. */
  value: number | null;
  /** Records the figure was computed from. */
  counted: number;
  /** Records that matched but held no number in the value field. */
  lackedNumber: number;
}

function figure(rows: readonly unknown[], op: RecordAggregateOp, valueField?: string): AggregateFigure {
  if (op === 'count') return { value: rows.length, counted: rows.length, lackedNumber: 0 };
  const numbers: number[] = [];
  let lackedNumber = 0;
  for (const row of rows) {
    const key = comparable(fieldValue(row, valueField ?? ''));
    if (key?.kind === 'number') numbers.push(key.n);
    else lackedNumber += 1;
  }
  if (numbers.length === 0) return { value: null, counted: 0, lackedNumber };
  const total = numbers.reduce((sum, n) => sum + n, 0);
  const value = op === 'sum' ? total
    : op === 'avg' ? total / numbers.length
      : op === 'min' ? Math.min(...numbers)
        : Math.max(...numbers);
  return { value, counted: numbers.length, lackedNumber };
}

export interface AggregateResult {
  overall: AggregateFigure;
  /** Per distinct group value, largest figure first, when grouped. */
  groups?: Array<{ group: string; figure: AggregateFigure }>;
}

/** An aggregate over every record, optionally per group, using Number arithmetic. */
export function aggregateRows(
  rows: readonly unknown[],
  op: RecordAggregateOp,
  options: { valueField?: string; groupBy?: string } = {},
): AggregateResult {
  const overall = figure(rows, op, options.valueField);
  if (!options.groupBy) return { overall };
  const buckets = new Map<string, unknown[]>();
  for (const row of rows) {
    const raw = fieldValue(row, options.groupBy);
    const group = raw === null || raw === undefined || String(raw).trim() === '' ? '(none)' : String(raw).trim();
    const bucket = buckets.get(group);
    if (bucket) bucket.push(row);
    else buckets.set(group, [row]);
  }
  const groups = [...buckets.entries()]
    .map(([group, members]) => ({ group, figure: figure(members, op, options.valueField) }))
    .sort((a, b) => (b.figure.value ?? Number.NEGATIVE_INFINITY) - (a.figure.value ?? Number.NEGATIVE_INFINITY)
      || a.group.localeCompare(b.group));
  return { overall, groups };
}
