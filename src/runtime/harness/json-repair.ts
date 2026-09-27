/**
 * Tolerant JSON extraction for structured output from OpenAI-compatible
 * backends. Those models often wrap a JSON answer in
 * ```fences``` or surround it with prose even when asked for json_object,
 * which makes the SDK's downstream `JSON.parse` fail the whole run.
 *
 * These helpers recover the JSON value WITHOUT a JSON parser doing the
 * scanning (a regex can't balance braces; `lastIndexOf('}')` breaks on a
 * `}` inside a string). The scan is string-aware and returns only a
 * substring that actually `JSON.parse`s — never a guess.
 *
 * Pure + side-effect free so they're trivially unit-testable.
 */

export function isParseableJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a substring of `raw` that is valid JSON, or null if none can be
 * recovered. Idempotent: already-clean JSON is returned byte-for-byte.
 */
export function extractJsonCandidate(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  // Reasoning models can emit inline <think>…</think> blocks
  // before the JSON — and the reasoning frequently RESTATES the schema, braces
  // and all, which would derail the balanced-brace scan into the thinking
  // instead of the real answer. Strip think blocks first.
  if (/<think\b/i.test(s) || /<\/think\s*>/i.test(s)) {
    s = s.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '').trim();
    // A truncated/unclosed <think> (model hit its token cap mid-reasoning)
    // has no closing tag, so the replace above leaves it. If a leading think
    // tag remains, drop from it to the first JSON opener so the scan starts
    // at real content (and if there's no JSON, fall through to null → re-ask).
    if (/^<think\b/i.test(s)) {
      const opener = s.search(/[{[]/);
      s = opener >= 0 ? s.slice(opener).trim() : '';
    }
    if (!s) return null;
  }

  // Whole-payload fence strip: ```lang\n …json… \n``` (only when fences wrap
  // the entire payload — we don't hunt multiple fenced blocks).
  if (s.startsWith('```')) {
    const firstNl = s.indexOf('\n');
    const closeFence = s.lastIndexOf('```');
    if (firstNl !== -1 && closeFence > firstNl) {
      s = s.slice(firstNl + 1, closeFence).trim();
    }
  }

  // Already valid JSON → return as-is (idempotent).
  if (isParseableJson(s)) return s;

  // String-aware balanced scan from the first top-level `{` or `[`.
  const objIdx = s.indexOf('{');
  const arrIdx = s.indexOf('[');
  let start = -1;
  if (objIdx === -1) start = arrIdx;
  else if (arrIdx === -1) start = objIdx;
  else start = Math.min(objIdx, arrIdx);
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        return isParseableJson(candidate) ? candidate : null;
      }
    }
  }
  return null;
}

/**
 * Recover individually complete JSON objects from an incomplete stream or
 * clipped top-level array. Only balanced objects that independently parse are
 * returned; an unfinished tail is ignored. The scanner is string/escape aware,
 * so braces inside JSON strings cannot terminate a record early.
 *
 * This is intentionally narrower than JSON repair: it never invents a closing
 * bracket or claims the recovered prefix is the complete result.
 */
export function extractCompleteJsonObjects(
  raw: string,
  maxObjects = 200,
): Array<Record<string, unknown>> {
  if (typeof raw !== 'string' || !raw) return [];
  const limit = Math.max(1, Math.min(10_000, Math.trunc(maxObjects) || 200));
  const objects: Array<Record<string, unknown>> = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length && objects.length < limit; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    try {
      const value = JSON.parse(raw.slice(start, index + 1)) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        objects.push(value as Record<string, unknown>);
      }
    } catch {
      // A balanced-looking non-JSON block is prose, not a recoverable record.
    }
    start = -1;
  }
  return objects;
}

/**
 * Best-effort repair: returns `{ text, repaired }`. When no JSON can be
 * recovered, returns the original text untouched with `repaired: false`
 * (preserving whatever fail-open behavior exists downstream).
 */
export function repairToParseableJson(raw: string): { text: string; repaired: boolean } {
  const cand = extractJsonCandidate(raw);
  if (cand === null) return { text: raw, repaired: false };
  if (cand === raw) return { text: raw, repaired: false };
  return { text: cand, repaired: true };
}

/**
 * Conservative top-level shape check for a structured response whose JSON Schema
 * was downgraded (json_schema → json_object, or dropped entirely when tools are
 * in scope) for an OpenAI-compatible backend — where the schema is no longer
 * WIRE-enforced. A compatible backend can then return clean, *parseable* JSON
 * of the WRONG shape, which
 * passes the parse-only repair but fails the SDK's downstream Zod validation —
 * forcing an expensive full re-turn. This catches the common cases at the model-
 * call layer so a single cheap re-ask can fix them.
 *
 * NOT a full JSON-Schema validator. It only performs the false-positive-free
 * checks: required top-level keys present, top-level enum membership, and clearly
 * wrong primitive top-level types. Anything it can't be SURE about — no schema,
 * non-object schema, nested/object/array/union/nullable property types, present-
 * but-null values, additional properties — PASSES. So a HEALTHY response is
 * never flagged (no spurious re-asks, no regression). Pure + unit-testable.
 *
 * Returns `{ ok, violations }`; `violations` is a short human-readable list to
 * feed a targeted re-ask. Brain-agnostic: applies to every backend, every
 * structured call site.
 */
export function conformsToJsonSchemaShape(
  value: unknown,
  schema: unknown,
): { ok: boolean; violations: string[] } {
  const s = schema as { type?: unknown; properties?: unknown; required?: unknown } | null | undefined;
  // Only validate object schemas; bail (pass) on anything else.
  const props = (s && typeof s === 'object' ? s.properties : undefined) as
    | Record<string, { type?: unknown; enum?: unknown }>
    | undefined;
  const declaresObject = s?.type === 'object' || (props != null && typeof props === 'object');
  if (!declaresObject) return { ok: true, violations: [] };

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, violations: ['expected a JSON object'] };
  }
  const obj = value as Record<string, unknown>;
  const violations: string[] = [];

  const required = Array.isArray(s?.required) ? (s!.required as unknown[]) : [];
  for (const key of required) {
    if (typeof key === 'string' && !(key in obj)) {
      violations.push(`missing required field "${key}"`);
    }
  }

  const PRIMITIVE = new Set(['string', 'boolean', 'number', 'integer']);
  for (const [key, propSchema] of Object.entries(props ?? {})) {
    if (!(key in obj)) continue; // absence handled by `required` above
    const v = obj[key];
    if (v === null || v === undefined) continue; // present-but-null: too risky to flag (nullable is common)
    const enumVals = Array.isArray(propSchema?.enum) ? propSchema.enum : undefined;
    if (enumVals && enumVals.length > 0) {
      if (!enumVals.includes(v)) {
        violations.push(`field "${key}" must be one of ${JSON.stringify(enumVals)}`);
      }
      continue;
    }
    const rawType = propSchema?.type;
    const types = Array.isArray(rawType) ? rawType : typeof rawType === 'string' ? [rawType] : [];
    // Only type-check when EVERY declared type is a primitive we understand;
    // a union with object/array/null is skipped (can't cheaply validate).
    if (types.length === 0 || !types.every((t) => typeof t === 'string' && PRIMITIVE.has(t))) continue;
    const matches = types.some((t) => {
      if (t === 'string') return typeof v === 'string';
      if (t === 'boolean') return typeof v === 'boolean';
      return typeof v === 'number'; // number | integer
    });
    if (!matches) violations.push(`field "${key}" should be ${types.join('|')}`);
  }

  return { ok: violations.length === 0, violations };
}

/** How a stored tool output's JSON value was recovered. */
export type StoredToolOutputJsonVia = 'exact' | 'shell_stdout' | 'shell_embedded' | 'embedded' | 'shell_objects' | 'host_cli_stdout';

export interface StoredToolOutputJson {
  value: unknown;
  via: StoredToolOutputJsonVia;
  /** Only a complete-object PREFIX of a clipped array was recoverable. */
  partialArrayPrefix?: boolean;
}

export interface StoredToolOutputShell {
  stdout: string;
  stdout_json?: unknown;
}

/** The host CLI adapter stores its typed execution envelope, including argv,
 * separately from the provider's JSON in stdout. Decode only a complete,
 * successful host-shaped envelope; arbitrary stdout fields and partial or
 * failed executions keep their original shape. This is data extraction, not
 * evidence authority: each reader still applies its own occurrence/settlement
 * checks before using the result to authorize a later action. */
export type HostCliEnvelopeReading =
  /** A clean run whose stdout is JSON: the payload the command produced. */
  | { kind: 'clean'; operationId: string; stdoutJson: unknown }
  /** A clean run whose stdout is not JSON (or was cut): keep the envelope. */
  | { kind: 'clean_text'; operationId: string; stdout: string; stdoutTruncated: boolean }
  /** The command did not complete cleanly; the reason is the envelope's own. */
  | { kind: 'failed'; operationId: string; status: string; exitCode: number | null; stderr: string };

/**
 * Read the host CLI adapter's execution envelope (bare, or wrapped as the
 * kernel's `{complete, result}`) without pretending about it: a clean JSON
 * run yields its payload, a clean non-JSON run keeps its text, and any other
 * exit is reported as the failure it was. Not an envelope → null.
 */
export function readHostCliEnvelope(value: unknown): HostCliEnvelopeReading | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const outer = value as Record<string, unknown>;
  const wrapped = outer.result && typeof outer.result === 'object' && !Array.isArray(outer.result)
    ? outer.result as Record<string, unknown> : null;
  const envelope = wrapped ?? outer;
  if (
    (wrapped !== null && outer.complete !== true)
    || envelope.version !== 1 || typeof envelope.status !== 'string'
    || typeof envelope.operationId !== 'string' || !envelope.operationId
    || typeof envelope.executableRealpath !== 'string' || !envelope.executableRealpath
    || !Array.isArray(envelope.argv) || !envelope.argv.every(arg => typeof arg === 'string')
    || typeof envelope.stdout !== 'string'
  ) return null;
  const operationId = envelope.operationId;
  if (envelope.status !== 'exited' || envelope.exitCode !== 0) {
    return {
      kind: 'failed',
      operationId,
      status: envelope.status,
      exitCode: typeof envelope.exitCode === 'number' ? envelope.exitCode : null,
      stderr: typeof envelope.stderr === 'string' ? envelope.stderr : '',
    };
  }
  const stdoutTruncated = envelope.stdoutTruncated !== false;
  if (!stdoutTruncated) {
    try {
      return { kind: 'clean', operationId, stdoutJson: JSON.parse(envelope.stdout) as unknown };
    } catch { /* not JSON: keep the text */ }
  }
  return { kind: 'clean_text', operationId, stdout: envelope.stdout, stdoutTruncated };
}

function storedJsonValue(value: unknown, via: StoredToolOutputJsonVia): StoredToolOutputJson {
  const envelope = readHostCliEnvelope(value);
  if (envelope?.kind === 'clean') return { value: envelope.stdoutJson, via: 'host_cli_stdout' };
  return { value, via };
}

/** Full balanced scans a stored-output read may spend looking for embedded
 * JSON. Each is linear in the output, so the total stays bounded. */
const STORED_JSON_OPENER_ATTEMPTS = 8;

/** Whether the bytes at `index` can begin a JSON object or array. A prose
 * bracket (`[note]`, `{name:…}`) cannot, and is skipped without a scan. */
function canOpenJsonValue(text: string, index: number): boolean {
  let next = index + 1;
  while (next < text.length && /\s/.test(text[next]!)) next += 1;
  const following = text[next];
  if (following === undefined) return false;
  if (text[index] === '{') return following === '"' || following === '}';
  return following === ']' || following === '"' || following === '{' || following === '['
    || following === '-' || (following >= '0' && following <= '9')
    || text.startsWith('true', next) || text.startsWith('false', next) || text.startsWith('null', next);
}

/** String-aware index of the bracket that closes the one at `start`, or -1. */
function balancedJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Whether a recovered value can be a document's payload: a non-empty object,
 * or an array holding at least one object. A scalar or scalar-only array
 * (`[42]`, `[[1]]`, `[]`) inside prose is a citation, a count or a checkbox,
 * never the data the output was read for. */
function isRecordShapedPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
  }
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
}

/** Character ranges of fenced code blocks (``` or ~~~ lines). A fence that is
 * the whole document is its payload, not an example, so it yields no range.
 * An unclosed fence runs to the end of the text. */
function fencedCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let openAt = -1;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).trimStart();
    if (line.startsWith('```') || line.startsWith('~~~')) {
      if (openAt === -1) openAt = lineStart;
      else {
        ranges.push([openAt, lineEnd]);
        openAt = -1;
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (openAt !== -1) ranges.push([openAt, text.length]);
  if (ranges.length === 1) {
    const [from, to] = ranges[0]!;
    if (text.slice(0, from).trim() === '' && text.slice(to).trim() === '') return [];
  }
  return ranges;
}

function fenceContaining(ranges: ReadonlyArray<[number, number]>, index: number): [number, number] | null {
  for (const range of ranges) {
    if (index >= range[0] && index < range[1]) return range;
  }
  return null;
}

/** A candidate substring that parses, is record-shaped, and lies outside
 * every fenced example; otherwise null. */
function acceptedStoredPayload(
  text: string,
  candidate: string | null,
  fences: ReadonlyArray<[number, number]>,
): string | null {
  if (candidate === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
  if (!isRecordShapedPayload(value)) return null;
  const at = text.indexOf(candidate);
  if (at >= 0 && fenceContaining(fences, at)) return null;
  return candidate;
}

/**
 * The largest complete JSON value embedded in a stored output. A host document
 * can carry prose with its own brackets before its data (a pseudo-call such as
 * `reader({slug:"x"})`, a `[note]`, a reader's `{"call_id":…}` hint), so the
 * first opener is not necessarily the data. Candidates are tried from
 * successive openers, a bounded number of scans, and the largest record-shaped
 * value that parses wins: the payload, not an incidental value beside it.
 *
 * A balanced candidate that does not parse is passed over whole, never looked
 * inside: an invalid document is text, and no fragment of it is the result.
 * A fenced code block is an example, not a result, and is skipped. Only the
 * stored-output reader uses this; parsing a model's own answer keeps the
 * first-candidate rule of `extractJsonCandidate`.
 */
function largestEmbeddedStoredJson(raw: string): string | null {
  const fences = fencedCodeRanges(raw);
  let best = acceptedStoredPayload(raw, extractJsonCandidate(raw), fences);
  let attempts = 0;
  for (let start = 0; start < raw.length && attempts < STORED_JSON_OPENER_ATTEMPTS; start += 1) {
    const ch = raw[start];
    if (ch !== '{' && ch !== '[') continue;
    const fence = fenceContaining(fences, start);
    if (fence) {
      start = fence[1];
      continue;
    }
    if (!canOpenJsonValue(raw, start)) continue;
    attempts += 1;
    const end = balancedJsonEnd(raw, start);
    // Never closed: every later bracket lies inside this clipped value, so a
    // complete element found there is a fragment, not the payload.
    if (end === -1) break;
    const length = end + 1 - start;
    if (best === null || length > best.length) {
      const candidate = acceptedStoredPayload(raw, raw.slice(start, end + 1), []);
      if (candidate !== null) best = candidate;
    }
    // Parsed or not, nothing inside this value is a separate payload.
    start = end;
  }
  return best;
}

/**
 * The leading run of complete objects of an array of objects, in order, and
 * whether it reached the array's closing bracket: in
 * the first `[` whose first element is an object, each element that is a
 * whole, parseable object, stopping at the first element that is not (an
 * invalid row, a non-object value, or the clip). Every returned row sits at
 * its own index, so the rows really are the array's prefix; an invalid row in
 * the middle ends the prefix rather than leaving a gap.
 */
function leadingArrayObjects(
  raw: string,
  maxObjects: number,
): { objects: Array<Record<string, unknown>>; complete: boolean } {
  const isSpace = (char: string | undefined) => char === ' ' || char === '\n' || char === '\r' || char === '\t';
  for (let open = raw.indexOf('['); open >= 0; open = raw.indexOf('[', open + 1)) {
    let index = open + 1;
    while (isSpace(raw[index])) index += 1;
    // A bracket that does not open an array of objects is prose; the first
    // one that does is the array, and a nested array inside its first row is
    // never taken for it.
    if (raw[index] !== '{') continue;
    const objects: Array<Record<string, unknown>> = [];
    while (objects.length < maxObjects) {
      while (isSpace(raw[index])) index += 1;
      if (raw[index] !== '{') break;
      const end = balancedObjectEnd(raw, index);
      if (end < 0) break;
      let value: unknown;
      try {
        value = JSON.parse(raw.slice(index, end + 1));
      } catch {
        break;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) break;
      objects.push(value as Record<string, unknown>);
      index = end + 1;
      while (isSpace(raw[index])) index += 1;
      if (raw[index] === ']') return { objects, complete: true };
      if (raw[index] !== ',') break;
      index += 1;
    }
    return { objects, complete: false };
  }
  return { objects: [], complete: false };
}

function stdoutIsExactJson(stdout: string): boolean {
  try {
    JSON.parse(stdout.trim());
    return true;
  } catch {
    return false;
  }
}

/** Index of the `}` closing the object that opens at `start`, string-aware;
 * -1 when the text ends first. */
function balancedObjectEnd(raw: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return char === '}' ? index : -1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Recover the JSON value from a STORED tool output.
 *
 * The parked record is not always the provider's bare payload: the harness
 * appends its own prose to it on the way in — composio route notes
 * (`[account-route] …`, `[sender-verify] …`), constraint banners, and
 * `recall_tool_result`'s own `Recalled chars A–B of N • tool=… ` preamble.
 * A whole-string `JSON.parse` therefore fails on a payload that IS JSON. A
 * reader that calls data text sends the model paging for bytes it already
 * holds, and a reader that calls prose data answers from a fragment; both are
 * worse than an honest "this is text".
 *
 * Order: the exact parse; for a shell envelope, its stdout parsed exactly (or
 * the shell parser's candidate when record-shaped), then its first
 * record-shaped stdout candidate, then the leading complete objects of a
 * stdout array (marked as a prefix unless the array closed), and only then the
 * embedded scan of stdout; for
 * any other output, the embedded scan of the whole text.
 */
export function parseStoredToolOutputJson(
  raw: string,
  options: { shell?: (raw: string) => StoredToolOutputShell | null | undefined } = {},
): StoredToolOutputJson | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return storedJsonValue(JSON.parse(raw) as unknown, 'exact');
  } catch { /* fall through to recovery */ }

  const shell = options.shell?.(raw) ?? null;
  if (shell) {
    // A run_shell_command wrapper (`exit_code:/stdout:/stderr:`) around a
    // `--json` payload (sf, gh, aws…): the data is structured, the envelope is not.
    // Stdout that is exactly JSON is taken whole; a candidate the shell parser
    // found beside prose must be record-shaped like any embedded payload.
    if (shell.stdout_json !== undefined
      && (stdoutIsExactJson(shell.stdout) || isRecordShapedPayload(shell.stdout_json))) {
      return { value: shell.stdout_json, via: 'shell_stdout' };
    }
    const embeddedStdout = acceptedStoredPayload(
      shell.stdout, extractJsonCandidate(shell.stdout), fencedCodeRanges(shell.stdout),
    );
    if (embeddedStdout !== null) {
      return { value: JSON.parse(embeddedStdout) as unknown, via: 'shell_embedded' };
    }
    // A clipped or partly invalid array: recover the complete objects written
    // so far, and say they are a prefix. An array read to its closing bracket
    // is the whole array, not a prefix.
    const leading = leadingArrayObjects(shell.stdout, 200);
    if (leading.complete) return { value: leading.objects, via: 'shell_embedded' };
    if (leading.objects.length > 0) {
      return { value: leading.objects, via: 'shell_objects', partialArrayPrefix: true };
    }
    const scanned = largestEmbeddedStoredJson(shell.stdout);
    return scanned === null ? null : { value: JSON.parse(scanned) as unknown, via: 'shell_embedded' };
  }

  // A complete JSON value carrying prose before or after it. The string-aware
  // balanced scan lets a leading preamble and a trailing note fall away.
  const embedded = largestEmbeddedStoredJson(raw);
  if (embedded !== null) {
    return storedJsonValue(JSON.parse(embedded) as unknown, 'embedded');
  }
  return null;
}
