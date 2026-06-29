/**
 * Tolerant JSON extraction for structured output from OpenAI-compatible
 * backends (MiniMax/DeepSeek/…). Those models often wrap a JSON answer in
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

  // Reasoning models (e.g. MiniMax M3) emit inline <think>…</think> blocks
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
 * WIRE-enforced. A compat backend (Together / DeepSeek / MiniMax / OpenRouter /
 * GLM / …) can then return clean, *parseable* JSON of the WRONG shape, which
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
