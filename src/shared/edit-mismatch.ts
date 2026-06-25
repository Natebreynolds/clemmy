/**
 * Verbatim-find divergence pinpointer — shared by every grounded find/replace
 * edit surface (space view edits, space runner edits, workflow step-prompt
 * edits). When a `find` string is NOT present, it locates the longest prefix of
 * `find` that DOES appear in the haystack and shows what the haystack has at the
 * divergence point — so the model sees the exact whitespace/character mismatch
 * (tabs vs spaces) instead of re-reading the whole file blind.
 *
 * Pure leaf — NO runtime imports — so the deliberately-light workflow-step-edit
 * module can use it without pulling in the agent stack.
 */
export interface MismatchHint {
  /** How many leading chars of `find` matched before divergence. */
  matchedChars: number;
  /** JSON-quoted next chars of `find` (whitespace visible). */
  findHad: string;
  /** JSON-quoted chars the haystack has at the divergence point. */
  haystackHad: string;
}

/** Returns null when `find` is empty or fully present (i.e. not a real miss). */
export function mismatchHint(haystack: string, find: string): MismatchHint | null {
  if (!find) return null;
  // Largest k with haystack.includes(find.slice(0,k)) — monotonic, binary-search it.
  let lo = 0;
  let hi = find.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (haystack.includes(find.slice(0, mid))) lo = mid; else hi = mid - 1;
  }
  const k = lo;
  if (k >= find.length) return null; // fully present (shouldn't happen on a miss)
  const pos = haystack.indexOf(find.slice(0, k));
  const quote = (s: string): string => JSON.stringify(s.slice(0, 24));
  return {
    matchedChars: k,
    findHad: quote(find.slice(k)),
    haystackHad: pos >= 0 ? quote(haystack.slice(pos + k, pos + k + 24)) : '(prefix not located)',
  };
}
