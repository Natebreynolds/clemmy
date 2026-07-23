/**
 * Canonical text-matching primitives for workflow discovery.
 *
 * Matchers score a user's words against saved workflows — fuzzy
 * name resolution (workflow-resolve) and the per-turn "Likely workflows"
 * ranking (context-packet). (The run-guard consumer was deleted 2026-07-23.)
 * Each had its own copy of the same tokenizer loop and (in one case) a
 * stemmer. This module is the single home for those primitives so the
 * matchers can't silently drift in how they split/normalize text.
 *
 * Deliberately NOT unified here (distinct by design, per the consolidation
 * audit): each matcher keeps its OWN stopword set (resolve strips action
 * verbs like "kick off"; run-guard is name-focused) and its OWN scorer
 * (fuzzy containment vs weighted field overlap vs hard presence) — those
 * are policy, not shared mechanism. This module only owns the mechanism:
 * tokenize + stem.
 *
 * Pure leaf module (no imports) — safe to use from any layer.
 */

export interface TokenizeOptions {
  /** Minimum token length to keep (default 3). */
  minLen?: number;
  /** Words to drop (the caller's policy set). Default: none. */
  stopwords?: Set<string>;
  /** Apply the light stemmer (and re-check length/stopword on the stem). */
  stem?: boolean;
}

const NO_STOPWORDS: Set<string> = new Set();

/**
 * Light suffix stemmer (ing/ed/es/plural-s). Conservative — only trims when
 * the remaining stem stays meaningful. Mirrors the original workflow-resolve
 * stemmer byte-for-byte so resolution behavior is unchanged.
 */
export function stemToken(token: string): string {
  let t = token;
  if (t.length > 4 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith('es')) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  return t;
}

/**
 * Split text into normalized content tokens: lowercase → split on
 * non-alphanumeric → drop tokens shorter than `minLen` → drop stopwords →
 * optionally stem (and re-check length + stopword on the stem). Returns an
 * array (callers wrap in a Set when they need uniqueness).
 */
export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
  const minLen = opts.minLen ?? 3;
  const stop = opts.stopwords ?? NO_STOPWORDS;
  const out: string[] = [];
  for (const raw of (text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < minLen) continue;
    if (stop.has(raw)) continue;
    if (opts.stem) {
      const s = stemToken(raw);
      if (s.length >= minLen && !stop.has(s)) out.push(s);
    } else {
      out.push(raw);
    }
  }
  return out;
}
