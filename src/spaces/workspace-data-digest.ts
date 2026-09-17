/**
 * What an author needs to see of a Workspace dataset to build a view on it:
 * for each source, where its records are, how many there are, which fields
 * they carry, and a few trimmed samples. Raw provider envelopes can run to
 * hundreds of kilobytes; an author reading them whole cannot see the shape.
 *
 * The record locator is the same rule the in-view helper `clem.rows` applies,
 * so the path reported here is the path the view will read.
 */

const ROW_KEYS = ['records', 'value', 'items', 'results', 'matches', 'rows', 'entries', 'messages', 'data', 'list'];
const SAMPLE_STRING_MAX = 160;
const RECORD_STRING_MAX = 400;
/** Largest page of records returned at once, kept under the inline tool-result size. */
export const SOURCE_PAGE_MAX_BYTES = 16_000;
const MAX_FIELDS = 60;
const FIELD_SCAN_RECORDS = 25;

type Json = unknown;

function isPlainObject(value: Json): value is Record<string, Json> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Unwrap the stored envelopes a source can carry: the kernel's
 *  `{ complete, result }` and a command-line carrier's stdout text. */
export function unwrapWorkspaceSourceValue(value: Json): { value: Json; path: string[] } {
  let current = value;
  const path: string[] = [];
  for (let step = 0; step < 6; step += 1) {
    if (!isPlainObject(current)) break;
    if (Object.hasOwn(current, 'complete') && Object.hasOwn(current, 'result')) {
      current = current.result;
      path.push('result');
      continue;
    }
    if (typeof current.stdout === 'string') {
      try {
        current = JSON.parse(current.stdout) as Json;
        path.push('stdout(json)');
        continue;
      } catch {
        break;
      }
    }
    break;
  }
  return { value: current, path };
}

/** The record list inside a source value and its dotted path, or null. */
export function locateWorkspaceRecords(value: Json): { records: Json[]; path: string } | null {
  const unwrapped = unwrapWorkspaceSourceValue(value);
  if (Array.isArray(unwrapped.value)) {
    return { records: unwrapped.value, path: unwrapped.path.join('.') };
  }
  const queue: Array<{ value: Json; path: string[]; depth: number }> = [
    { value: unwrapped.value, path: unwrapped.path, depth: 0 },
  ];
  let fallback: { records: Json[]; path: string } | null = null;
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!isPlainObject(node.value)) continue;
    if (node.depth >= 5) continue;
    const keys = Object.keys(node.value);
    const ordered = [
      ...ROW_KEYS.filter((key) => keys.includes(key)),
      ...keys.filter((key) => !ROW_KEYS.includes(key) && !key.startsWith('_')),
    ];
    for (const key of ordered) {
      const child = node.value[key];
      const childPath = [...node.path, key];
      if (Array.isArray(child)) {
        const recordLike = child.length === 0 || isPlainObject(child[0]);
        if (recordLike && ROW_KEYS.includes(key)) return { records: child, path: childPath.join('.') };
        if (recordLike && !fallback) fallback = { records: child, path: childPath.join('.') };
        continue;
      }
      queue.push({ value: child, path: childPath, depth: node.depth + 1 });
    }
  }
  return fallback;
}

/** How many records a source value holds, located by the same rule as the
 *  view helper. An empty list counts only where it is the value itself or sits
 *  under a key that names records; an empty side list such as a warnings array
 *  says nothing about the rows, so the count is unknown (null). */
export function countWorkspaceRecords(value: Json): number | null {
  const located = locateWorkspaceRecords(value);
  if (!located) return null;
  if (located.records.length > 0) return located.records.length;
  const unwrapped = unwrapWorkspaceSourceValue(value);
  if (Array.isArray(unwrapped.value)) return 0;
  const last = located.path.split('.').pop() ?? '';
  return ROW_KEYS.includes(last) ? 0 : null;
}

function fieldPaths(records: readonly Json[]): string[] {
  const counts = new Map<string, number>();
  const visit = (value: Json, prefix: string, depth: number): void => {
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainObject(child) && depth < 2 && Object.keys(child).length > 0) {
        visit(child, path, depth + 1);
      } else {
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    }
  };
  for (const record of records.slice(0, FIELD_SCAN_RECORDS)) visit(record, '', 0);
  return [...counts.keys()].slice(0, MAX_FIELDS);
}

function trimmed(value: Json, stringMax: number, depth = 0): Json {
  if (typeof value === 'string') {
    return value.length > stringMax ? `${value.slice(0, stringMax)}…(${value.length} chars)` : value;
  }
  if (Array.isArray(value)) {
    if (depth >= 3) return `[${value.length} items]`;
    const head = value.slice(0, 3).map((item) => trimmed(item, stringMax, depth + 1));
    return value.length > 3 ? [...head, `…${value.length - 3} more`] : head;
  }
  if (isPlainObject(value)) {
    if (depth >= 4) return '{…}';
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, trimmed(child, stringMax, depth + 1)]));
  }
  return value;
}

function freshness(meta: Json): string {
  if (!isPlainObject(meta)) return 'no refresh recorded';
  const at = typeof meta.refreshedAt === 'string' ? meta.refreshedAt : null;
  const failed = meta.ok === false;
  const error = typeof meta.error === 'string' ? meta.error : null;
  return [
    failed ? 'last refresh FAILED' : 'ok',
    at ? `refreshed ${at}` : '',
    failed && error ? `error: ${error.slice(0, 240)}` : '',
  ].filter(Boolean).join(', ');
}

/** One compact block per source: freshness, record path and count, fields,
 *  and trimmed samples. Sources the manifest declares but the dataset lacks
 *  are named too. */
export function renderWorkspaceDataDigest(
  dataset: Record<string, Json>,
  declaredSourceIds: readonly string[],
  samplesPerSource = 2,
): string {
  const meta = isPlainObject(dataset._meta) ? dataset._meta : {};
  const ids = [...new Set([...declaredSourceIds, ...Object.keys(dataset).filter((key) => !key.startsWith('_'))])];
  const blocks = ids.map((id) => {
    const lines = [`Source "${id}" — ${freshness(meta[id])}.`];
    if (!Object.hasOwn(dataset, id)) {
      lines.push('  No stored data yet.');
      return lines.join('\n');
    }
    const located = locateWorkspaceRecords(dataset[id]);
    if (located) {
      lines.push(`  ${located.records.length} record${located.records.length === 1 ? '' : 's'} at ${located.path || '(root)'}; in the view: clem.rows(data["${id}"]).`);
      const fields = fieldPaths(located.records);
      if (fields.length > 0) lines.push(`  Fields: ${fields.join(', ')}`);
      const samples = located.records.slice(0, samplesPerSource).map((record) => JSON.stringify(trimmed(record, SAMPLE_STRING_MAX)));
      for (const sample of samples) lines.push(`  Sample: ${sample}`);
    } else {
      const unwrapped = unwrapWorkspaceSourceValue(dataset[id]);
      lines.push(`  No record list; value at ${unwrapped.path.join('.') || '(root)'}: ${JSON.stringify(trimmed(unwrapped.value, SAMPLE_STRING_MAX)).slice(0, 1_200)}`);
    }
    return lines.join('\n');
  });
  const extras = Object.keys(dataset).filter((key) => key.startsWith('_') && key !== '_meta');
  if (extras.length > 0) blocks.push(`Reserved keys present: ${extras.join(', ')}.`);
  return blocks.join('\n');
}

/** Up to `limit` records of one source, trimmed, starting at `offset`. */
export function renderWorkspaceSourceRecords(
  dataset: Record<string, Json>,
  sourceId: string,
  limit: number,
  offset = 0,
): string {
  if (!Object.hasOwn(dataset, sourceId)) return `Source "${sourceId}" has no stored data.`;
  const located = locateWorkspaceRecords(dataset[sourceId]);
  if (!located) {
    const unwrapped = unwrapWorkspaceSourceValue(dataset[sourceId]);
    return `Source "${sourceId}" has no record list. Value at ${unwrapped.path.join('.') || '(root)'}:\n${JSON.stringify(trimmed(unwrapped.value, RECORD_STRING_MAX), null, 1).slice(0, 40_000)}`;
  }
  const start = Math.max(0, Math.min(offset, located.records.length));
  // A page that outgrows what a tool result keeps inline is clipped and then
  // read back in pieces, which costs more than asking for the next page. Stop
  // at the byte budget; the continuation names the exact next offset.
  const body: string[] = [];
  let bytes = 0;
  for (const record of located.records.slice(start, start + limit)) {
    const line = `#${start + body.length + 1} ${JSON.stringify(trimmed(record, RECORD_STRING_MAX))}`;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (body.length > 0 && bytes + lineBytes > SOURCE_PAGE_MAX_BYTES) break;
    body.push(line);
    bytes += lineBytes;
  }
  const page = { length: body.length };
  const header = `Source "${sourceId}": records ${page.length === 0 ? 0 : start + 1}–${start + page.length} of ${located.records.length} at ${located.path || '(root)'}. Fields: ${fieldPaths(located.records).join(', ')}`;
  const more = start + page.length < located.records.length
    ? `More: space_get with source_id "${sourceId}" and offset ${start + page.length}.`
    : '';
  return [header, ...body, more].filter(Boolean).join('\n');
}
