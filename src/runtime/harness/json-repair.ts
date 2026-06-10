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
