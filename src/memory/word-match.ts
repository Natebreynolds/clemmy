/**
 * Word-boundary matcher for a lowercased needle (entity/resource name, file
 * basename). Shared by the memory graph's edge derivation AND the stored
 * fact↔entity / fact↔resource link sync so both apply IDENTICAL matching.
 *
 * Anchors on non-alphanumeric boundaries (rather than \b, which mishandles
 * dotted/hyphenated names) so "acme" matches "at acme corp" / "acme." but NOT
 * "acmestore" / "teamwork" — killing the false-edge class the audit flagged.
 * Compiled once per needle, then tested against many texts. Returns null for
 * needles shorter than `minLen` (too generic to match safely).
 */
export function compileWordMatcher(needleLower: string, minLen = 4): RegExp | null {
  if (!needleLower || needleLower.length < minLen) return null;
  const escaped = needleLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  } catch {
    return null;
  }
}
