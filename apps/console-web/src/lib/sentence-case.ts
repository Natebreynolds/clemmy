/**
 * Sentence case for a machine-shaped string.
 *
 * WHY THIS EXISTS AT ALL. The console had 54 `uppercase tracking-wide` labels,
 * and a good number of them were not styling a written label — they were
 * hiding one. `{change.op}` renders "add", `{r.platform}` renders "zoom", and
 * CSS `text-transform` made both look deliberate. Delete the utility, as the
 * design contract requires, and the underlying string is exposed for what it
 * was: a raw enum value dropped into a sentence.
 *
 * So this is not a cosmetic helper. It is the piece that has to exist BEFORE
 * `uppercase` can be removed from a data-driven label without the label
 * regressing to "add" mid-sentence.
 *
 * Rules, in order:
 *   - Blank in, blank out.
 *   - `_` and `-` are word separators from an enum, never punctuation:
 *     "google_meet" is two words, not one strange one.
 *   - A short all-caps token is an acronym and is left alone: "API", "CLI",
 *     "MCP", "SF". Lowercasing those would be a different bug, not a fix.
 *   - A SHOUTED word is un-shouted: "FAILED" was a styling decision expressed
 *     in the data, and it becomes "Failed".
 *   - Only the first word is capitalised. Sentence case, not Title Case.
 */
export function sentence(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';

  const words = trimmed
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => (isAcronym(word) ? word : word.toLowerCase()));
  if (words.length === 0) return '';

  const [first, ...rest] = words;
  const head = isAcronym(first) ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest].join(' ');
}

/**
 * An acronym is short, all-caps, and has no lowercase to lose. The length cap
 * is what separates "API" from "FAILED"; without it, every shouted word in the
 * app would be preserved as though it meant something.
 */
function isAcronym(word: string): boolean {
  return word.length <= 4 && /^[A-Z0-9]+$/.test(word) && /[A-Z]/.test(word);
}
