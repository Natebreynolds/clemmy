/**
 * Model ids as a person would say them.
 *
 * Rule-based so no model is special-cased: the route publishes whatever id the
 * provider uses, and every surface names it the same way.
 */

/** A route-published model id, or '' when it is not an id-shaped string.
 *  One namespace segment is allowed (`namespace/model`). */
export function boundedModelId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,95})?$/.test(raw) ? raw : '';
}

const DATE_SUFFIX = /[-_](?:\d{8}|\d{4}-\d{2}-\d{2})$/;
const ROLLING_SUFFIX = /[-_]latest$/i;
const NUMERIC = /^\d+(?:\.\d+)*$/;
const SIZE = /^(\d+(?:\.\d+)?)([bkm])$/i;
const VOWEL = /[aeiouy]/i;

function titleToken(token: string): string {
  if (NUMERIC.test(token)) return token;
  const size = SIZE.exec(token);
  if (size) return `${size[1]}${size[2].toUpperCase()}`;
  // A vendor's own casing is the name; do not flatten it.
  if (/[A-Z]/.test(token)) return token;
  // Short vowel-less words are initialisms, not words.
  if (/^[a-z]{2,4}$/.test(token) && !VOWEL.test(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * A model id as a person would say it. Rule-based so no model is special:
 * the last path segment, without a release date or a rolling alias; separated
 * version digits rejoin ("4-5" → "4.5"); lowercase words get a capital; the
 * vendor's own mixed case survives untouched.
 */
export function modelDisplayName(identity: string): string {
  const raw = identity.trim();
  if (!raw) return '';
  let name = raw.split('/').filter(Boolean).pop() ?? raw;
  name = name.replace(DATE_SUFFIX, '').replace(ROLLING_SUFFIX, '');
  const tokens = name.split(/[-_\s]+/).filter(Boolean);
  const merged: string[] = [];
  for (const token of tokens) {
    const last = merged[merged.length - 1];
    // Only short digit runs are a split version ("4-5"); a long one is a build number.
    if (last !== undefined && /^\d{1,2}$/.test(last) && /^\d{1,2}$/.test(token)) {
      merged[merged.length - 1] = `${last}.${token}`;
    } else {
      merged.push(token);
    }
  }
  const words = merged.map(titleToken).join(' ').trim();
  return words || raw;
}
