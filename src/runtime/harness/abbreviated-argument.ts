/**
 * An opaque value a model shortened with an ellipsis.
 *
 * Page tokens, ids and cursors must go back exactly as a result returned
 * them. A model copying a long one sometimes keeps its start, writes "..."
 * and adds a guess, and the provider refuses it; the model then has no way
 * back to the value except reading the whole result again. The host holds the
 * results this turn returned, so it can name the full values that begin the
 * same way. It never picks one: several page tokens share a prefix, so the
 * choice stays the model's.
 *
 * Only an opaque-looking value counts: at least 16 characters before the
 * ellipsis and no whitespace. Text a person would read ("Thanks...") is never
 * matched. Generic over tools: nothing here names an argument or a provider.
 */
import { carrierJsonObject } from './carrier-json.js';

const ABBREVIATED = /^(\S{16,}?)(?:\.\.\.|…)(\S{0,40})$/u;
/** Characters an opaque token is made of (base64, base64url, ids, URLs). */
const TOKEN_CHAR = /[A-Za-z0-9_\-+/=.%~:]/;
const MAX_DEPTH = 5;

export interface AbbreviatedArgument {
  /** Where it sits in the call's arguments (`arguments.page_token`). */
  path: string;
  /** The text before the ellipsis. */
  prefix: string;
}

/** Every opaque-looking string in the arguments that was shortened with an
 *  ellipsis, reading JSON-object strings (a carrier's args_json) as objects. */
export function abbreviatedArguments(args: unknown): AbbreviatedArgument[] {
  const found: AbbreviatedArgument[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || found.length >= 8) return;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{')) {
        const decoded = carrierJsonObject(trimmed);
        if (decoded) { walk(decoded, path, depth + 1); return; }
      }
      const match = ABBREVIATED.exec(trimmed);
      if (match) found.push({ path: path || '(value)', prefix: match[1]! });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        walk(item, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  walk(args, '', 0);
  return found;
}

/** The distinct whole values in these texts that begin with the prefix,
 *  texts read newest first. A value runs to the first character no opaque
 *  token uses (a quote, a space, a comma). */
export function fullValuesStartingWith(prefix: string, textsNewestFirst: readonly string[], max = 3): string[] {
  const values: string[] = [];
  for (const text of textsNewestFirst) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(prefix, from);
      if (at < 0) break;
      from = at + prefix.length;
      // A match inside a longer token is not the start of a value.
      if (at > 0 && TOKEN_CHAR.test(text[at - 1]!)) continue;
      let end = at + prefix.length;
      while (end < text.length && TOKEN_CHAR.test(text[end]!)) end += 1;
      const value = text.slice(at, end);
      if (value.length > prefix.length && !values.includes(value)) values.push(value);
      if (values.length >= max) return values;
    }
  }
  return values;
}

/** The host's note for one call, or undefined when nothing it returned this
 *  turn begins the way the shortened value does. */
export function abbreviatedArgumentNote(input: {
  callId: string;
  args: unknown;
  textsNewestFirst: readonly string[];
  maxChars?: number;
}): string | undefined {
  const maxChars = input.maxChars ?? 1_600;
  const lines: string[] = [];
  for (const shortened of abbreviatedArguments(input.args)) {
    const values = fullValuesStartingWith(shortened.prefix, input.textsNewestFirst);
    if (values.length === 0) continue;
    const head = `Call ${input.callId} passed ${shortened.path} shortened with "...". A value like that goes back whole, exactly as a result returned it. `
      + `This turn's results returned ${values.length === 1 ? 'this value' : 'these values'} beginning the same way, newest first: `;
    const shown: string[] = [];
    let used = head.length;
    for (const value of values) {
      if (used + value.length + 4 > maxChars) break;
      shown.push(JSON.stringify(value));
      used += value.length + 4;
    }
    if (shown.length === 0) continue;
    lines.push(`${head}${shown.join(', ')}.`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}
