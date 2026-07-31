/**
 * The recall engine explains itself in its own terms — "semantic similarity
 * 0.82", "lexical relevance 0.41". That reads as instrumentation, and a
 * two-decimal score invites you to compare numbers that were never meant to be
 * read that way. Translated here rather than at the source because the desktop
 * console reads the same field and this is a phone-shaped concern.
 *
 * Weak signals are dropped entirely: a 0.06 lexical match is noise, and
 * labelling it "wording match" would be a small lie.
 */
export function humanizeReasons(reasons: string[] | undefined): string[] {
  if (!reasons?.length) return [];
  const out: string[] = [];
  for (const raw of reasons) {
    const score = Number(raw.match(/([0-9]*\.?[0-9]+)\s*$/)?.[1] ?? NaN);
    const weak = Number.isFinite(score) && score < 0.25;
    if (/^semantic similarity/.test(raw)) {
      if (!weak) out.push('related meaning');
    } else if (/^lexical relevance/.test(raw)) {
      if (!weak) out.push('matching words');
    } else {
      // Unrecognised reason: keep it, minus any trailing score.
      const label = raw.replace(/\s*[0-9]*\.?[0-9]+\s*$/, '').trim();
      if (label) out.push(label);
    }
  }
  return [...new Set(out)].slice(0, 3);
}
